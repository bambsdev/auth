// src/services/auth.service.ts

import { sign, verify } from "hono/jwt";
import { eq, and, gt } from "drizzle-orm";
import { verifyPassword } from "../utils/password";
import { hashToken } from "../utils/hash";
import { resolveUniqueUsername } from "../utils/username";
import { fail } from "../utils/error";
import { TOKEN_POLICY } from "../config/token.config";
import type { AnyAuthDB } from "../types/index";
import { AuthDbAdapter, createAuthDbAdapter, type AuthDbDialect } from "../db/adapter";
import type { CacheService } from "./cache.service";
import type { ClientType } from "../config/token.config";
import type { JWTAccessPayload, JWTRefreshPayload } from "../types/index";

// crypto.randomUUID() tersedia di CF Workers runtime
const uuid = () => crypto.randomUUID();

// ── Service ───────────────────────────────────────────────────────────────────

export class AuthService {
  readonly adapter: AuthDbAdapter;

  constructor(
    dbOrAdapter: AnyAuthDB | AuthDbAdapter,
    private readonly cacheService: CacheService,
    private readonly jwtSecret: string,
    private readonly jwtRefresh: string,
    dialect: AuthDbDialect = "pg",
  ) {
    if ("dialect" in dbOrAdapter && "tables" in dbOrAdapter) {
      this.adapter = dbOrAdapter;
    } else {
      this.adapter = createAuthDbAdapter(dbOrAdapter, dialect);
    }
  }

  get db(): any {
    return this.adapter.db;
  }

  // ── Login ─────────────────────────────────────────────────────────────────

  async login(
    email: string,
    password: string,
    clientType: ClientType,
    deviceInfo?: Record<string, string>,
  ) {
    const usersTable = this.adapter.tables.users;
    const user = await this.db.query.users.findFirst({
      where: eq(usersTable.email, email.toLowerCase().trim()),
    });

    if (!user || !user.isActive || user.deletedAt)
      fail("Email atau password salah", "INVALID_CREDENTIALS");

    // Cek email sudah diverifikasi
    if (!user.isEmailVerified)
      fail(
        "Silakan verifikasi email Anda terlebih dahulu",
        "EMAIL_NOT_VERIFIED",
        403,
      );

    // Cek apakah user punya password (OAuth-only users tidak punya)
    if (!user.password)
      fail("Gunakan Login with Google untuk akun ini", "PASSWORD_NOT_SET", 400);

    const valid = await verifyPassword(password, user.password);
    if (!valid) fail("Email atau password salah", "INVALID_CREDENTIALS");

    // Auto-populate username & fullName dari email jika masih kosong
    if (!user.username || !user.fullName) {
      const derived = email.split("@")[0];
      const updates: Record<string, any> = {};
      if (!user.fullName) updates.fullName = derived;
      if (!user.username) {
        updates.username = await this.resolveUniqueUsername(derived);
      }
      if (Object.keys(updates).length > 0) {
        await this.db
          .update(usersTable)
          .set({ ...updates, updatedAt: new Date() })
          .where(eq(usersTable.id, user.id));
      }
    }

    return this.generateTokenPair(user.id, clientType, undefined, deviceInfo);
  }

  // ── Generate Token Pair ───────────────────────────────────────────────────

  async generateTokenPair(
    userId: string,
    clientType: ClientType,
    familyId?: string,
    deviceInfo?: Record<string, string>,
    txOrDb?: any,
  ) {
    const conn = txOrDb ?? this.db;
    const refreshTokensTable = this.adapter.tables.refreshTokens;
    const policy = TOKEN_POLICY[clientType];
    const now = Math.floor(Date.now() / 1000);
    const family = familyId ?? uuid();
    const accessJti = uuid();

    // Sign access token
    const accessToken = await sign(
      {
        sub: userId,
        jti: accessJti,
        type: "access",
        client: clientType,
        iat: now,
        exp: now + policy.accessToken.expiresInSeconds,
      } satisfies JWTAccessPayload,
      this.jwtSecret,
    );

    // Sign refresh token
    const refreshToken = await sign(
      {
        sub: userId,
        jti: uuid(),
        familyId: family,
        type: "refresh",
        client: clientType,
        iat: now,
        exp: now + policy.refreshToken.expiresInSeconds,
      } satisfies JWTRefreshPayload,
      this.jwtRefresh,
    );

    // Limit active sessions (max 10)
    const activeSessions = await conn.query.refreshTokens.findMany({
      where: and(
        eq(refreshTokensTable.userId, userId),
        eq(refreshTokensTable.isRevoked, false)
      ),
      orderBy: (rt: any, { asc }: any) => [asc(rt.createdAt)],
    });

    if (activeSessions.length >= 10) {
      const sessionsToDelete = activeSessions.slice(0, activeSessions.length - 9);
      for (const session of sessionsToDelete) {
        await conn.update(refreshTokensTable)
          .set({ isRevoked: true })
          .where(eq(refreshTokensTable.id, session.id));
      }
    }

    // Simpan hash refresh token ke database
    await conn.insert(refreshTokensTable).values({
      userId,
      tokenHash: await hashToken(refreshToken),
      clientType,
      familyId: family,
      deviceInfo: deviceInfo ?? null,
      expiresAt: new Date(
        Date.now() + policy.refreshToken.expiresInSeconds * 1000,
      ),
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: policy.accessToken.expiresInSeconds,
    };
  }

  // ── Validate Access Token (dipanggil di middleware) ───────────────────────

  async validateAccessToken(token: string): Promise<JWTAccessPayload> {
    let payload: JWTAccessPayload;

    try {
      payload = (await verify(
        token,
        this.jwtSecret,
        "HS256",
      )) as unknown as JWTAccessPayload;
    } catch {
      fail("Token tidak valid", "INVALID_TOKEN");
    }

    if (payload!.type !== "access")
      fail("Tipe token salah", "INVALID_TOKEN_TYPE");

    // Cek blacklist: Cache API (L1) → KV (L2)
    const blacklisted = await this.cacheService.isTokenBlacklisted(
      payload!.jti,
    );
    if (blacklisted) fail("Token sudah di-revoke", "TOKEN_REVOKED");

    return payload!;
  }

  // ── Rotate Refresh Token ──────────────────────────────────────────────────

  async rotateRefreshToken(rawRefreshToken: string) {
    let payload: JWTRefreshPayload;

    try {
      payload = (await verify(
        rawRefreshToken,
        this.jwtRefresh,
        "HS256",
      )) as unknown as JWTRefreshPayload;
    } catch {
      fail("Refresh token tidak valid", "INVALID_TOKEN");
    }

    if (payload!.type !== "refresh")
      fail("Tipe token salah", "INVALID_TOKEN_TYPE");

    const hash = await hashToken(rawRefreshToken);
    const refreshTokensTable = this.adapter.tables.refreshTokens;

    const result = await this.db.transaction(async (tx: any) => {
      // Cari token dengan lock jika didukung dialek
      const [existing] = await this.adapter.selectWithLock(
        tx,
        refreshTokensTable,
        eq(refreshTokensTable.tokenHash, hash),
      );

      if (!existing) {
        // Hash tidak ditemukan — cek apakah family masih ada
        const [familyExists] = await this.adapter.selectWithLock(
          tx,
          refreshTokensTable,
          eq(refreshTokensTable.familyId, payload!.familyId),
          { id: refreshTokensTable.id },
          1,
        );

        if (familyExists) {
          // Family ada tapi token ini tidak dikenal → REUSE ATTACK
          await tx
            .update(refreshTokensTable)
            .set({ isRevoked: true })
            .where(eq(refreshTokensTable.familyId, payload!.familyId));
          return { reuse: true as const };
        }
        return { notFound: true as const };
      }

      if (existing.isRevoked) {
        // Token sudah di-revoke sebelumnya → REUSE ATTACK
        await tx
          .update(refreshTokensTable)
          .set({ isRevoked: true })
          .where(eq(refreshTokensTable.familyId, existing.familyId));
        return { reuse: true as const };
      }

      const expiresAt = existing.expiresAt instanceof Date ? existing.expiresAt : new Date(existing.expiresAt);
      if (expiresAt < new Date()) return { expired: true as const };

      // Revoke token lama (di dalam transaksi)
      await tx
        .update(refreshTokensTable)
        .set({ isRevoked: true, lastUsedAt: new Date() })
        .where(eq(refreshTokensTable.id, existing.id));

      // Generate token pair baru — INSERT juga di dalam transaksi
      const tokens = await this.generateTokenPair(
        existing.userId,
        existing.clientType as ClientType,
        existing.familyId,
        undefined,
        tx,
      );

      return { tokens };
    });

    if ("reuse" in result)
      fail(
        "Token reuse terdeteksi, semua sesi dicabut",
        "TOKEN_REUSE_DETECTED",
      );
    if ("notFound" in result) fail("Token tidak ditemukan", "TOKEN_NOT_FOUND");
    if ("expired" in result)
      fail("Refresh token sudah expired", "TOKEN_EXPIRED");

    return result.tokens;
  }

  // ── Logout ────────────────────────────────────────────────────────────────

  async logout(
    jti: string,
    accessTokenExp: number,
    rawRefreshToken?: string,
  ): Promise<void> {
    const remaining = accessTokenExp - Math.floor(Date.now() / 1000);

    // Blacklist access token: Cache API + KV
    if (remaining > 0) {
      await this.cacheService.blacklistToken(jti, remaining);
    }

    // Revoke refresh token di database
    if (rawRefreshToken) {
      const hash = await hashToken(rawRefreshToken);
      const refreshTokensTable = this.adapter.tables.refreshTokens;
      await this.db
        .update(refreshTokensTable)
        .set({ isRevoked: true })
        .where(
          and(
            eq(refreshTokensTable.tokenHash, hash),
            eq(refreshTokensTable.isRevoked, false),
          ),
        );
    }
  }

  // ── Logout All Devices ────────────────────────────────────────────────────

  async logoutAll(userId: string): Promise<void> {
    const refreshTokensTable = this.adapter.tables.refreshTokens;
    await this.db
      .update(refreshTokensTable)
      .set({ isRevoked: true })
      .where(
        and(
          eq(refreshTokensTable.userId, userId),
          eq(refreshTokensTable.isRevoked, false),
        ),
      );
  }

  // ── List Active Sessions ──────────────────────────────────────────────────

  async getSessions(userId: string, currentFamilyId?: string) {
    const refreshTokensTable = this.adapter.tables.refreshTokens;
    const sessions = await this.db.query.refreshTokens.findMany({
      where: and(
        eq(refreshTokensTable.userId, userId),
        eq(refreshTokensTable.isRevoked, false),
        gt(refreshTokensTable.expiresAt, new Date()),
      ),
      columns: {
        id: true,
        clientType: true,
        deviceInfo: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
        familyId: true,
        tokenHash: false,
      },
    });

    return sessions.map((s: any) => {
      let parsedDeviceInfo = s.deviceInfo ?? null;
      if (typeof s.deviceInfo === "string") {
        try {
          parsedDeviceInfo = JSON.parse(s.deviceInfo);
        } catch {
          parsedDeviceInfo = null;
        }
      }

      return {
        id: s.id,
        clientType: s.clientType,
        deviceInfo: parsedDeviceInfo,
        createdAt: s.createdAt,
        lastUsedAt: s.lastUsedAt,
        expiresAt: s.expiresAt,
        isCurrent: currentFamilyId ? s.familyId === currentFamilyId : false,
      };
    });
  }

  // ── Revoke Specific Session ───────────────────────────────────────────────

  async revokeSession(sessionId: string, userId: string): Promise<boolean> {
    const refreshTokensTable = this.adapter.tables.refreshTokens;
    const result = await this.db
      .update(refreshTokensTable)
      .set({ isRevoked: true })
      .where(
        and(
          eq(refreshTokensTable.id, sessionId),
          eq(refreshTokensTable.userId, userId),
          eq(refreshTokensTable.isRevoked, false),
        ),
      )
      .returning({ id: refreshTokensTable.id });

    return result.length > 0;
  }

  async resolveUniqueUsername(base: string): Promise<string> {
    return resolveUniqueUsername(this.adapter, base);
  }
}
