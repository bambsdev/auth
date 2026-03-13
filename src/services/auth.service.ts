// src/services/auth.service.ts

import { sign, verify } from "hono/jwt";
import { eq, and, gt } from "drizzle-orm";
import { users, refreshTokens } from "../db/schema";
import { verifyPassword } from "../utils/password";
import { hashToken } from "../utils/hash";
import { fail } from "../utils/error";
import { TOKEN_POLICY } from "../config/token.config";
import type { DB } from "../db/client";
import type { CacheService } from "./cache.service";
import type { ClientType } from "../config/token.config";
import type { JWTAccessPayload, JWTRefreshPayload } from "../types/index";

// crypto.randomUUID() tersedia di CF Workers runtime
const uuid = () => crypto.randomUUID();

// ── Service ───────────────────────────────────────────────────────────────────

export class AuthService {
  constructor(
    private readonly db: DB,
    private readonly cacheService: CacheService,
    private readonly jwtSecret: string,
    private readonly jwtRefresh: string,
  ) {}

  // ── Login ─────────────────────────────────────────────────────────────────

  async login(
    email: string,
    password: string,
    clientType: ClientType,
    deviceInfo?: Record<string, string>,
  ) {
    const user = await this.db.query.users.findFirst({
      where: eq(users.email, email.toLowerCase().trim()),
    });

    if (!user || !user.isActive)
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
      const updates: Record<string, string> = {};
      if (!user.fullName) updates.fullName = derived;
      if (!user.username) {
        updates.username = await this.resolveUniqueUsername(derived);
      }
      if (Object.keys(updates).length > 0) {
        await this.db
          .update(users)
          .set({ ...updates, updatedAt: new Date() })
          .where(eq(users.id, user.id));
      }
    }

    return this.generateTokenPair(user.id, clientType, undefined, deviceInfo);
  }

  // ── Generate Token Pair ───────────────────────────────────────────────────
  // Parameter `txOrDb` opsional: jika dipanggil dari dalam transaction,
  // gunakan `tx` agar INSERT masuk dalam transaksi yang sama.

  async generateTokenPair(
    userId: string,
    clientType: ClientType,
    familyId?: string,
    deviceInfo?: Record<string, string>,
    txOrDb?: DB,
  ) {
    const conn = txOrDb ?? this.db;
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

    // Simpan hash refresh token ke PostgreSQL
    await conn.insert(refreshTokens).values({
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
  // Dibungkus dalam transaction atomic + SELECT FOR UPDATE untuk mencegah
  // race condition saat request concurrent spam rotate token.

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

    // ── Transaction atomic ─────────────────────────────────────────────────
    // SELECT FOR UPDATE mengunci row sehingga request concurrent harus antri.
    // Ini mencegah dua request membaca token sebagai "belum revoked" bersamaan.
    //
    // PENTING: Jangan throw error di dalam transaction callback!
    // Drizzle akan ROLLBACK transaksi jika callback throw, sehingga
    // UPDATE revoke-family akan dibatalkan. Gunakan return value sebagai sinyal.

    const result = await this.db.transaction(async (tx) => {
      // Cari token dengan row-level lock
      const [existing] = await tx
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, hash))
        .for("update");

      if (!existing) {
        // Hash tidak ditemukan — cek apakah family masih ada
        const [familyExists] = await tx
          .select({ id: refreshTokens.id })
          .from(refreshTokens)
          .where(eq(refreshTokens.familyId, payload!.familyId))
          .for("update")
          .limit(1);

        if (familyExists) {
          // Family ada tapi token ini tidak dikenal → REUSE ATTACK
          await tx
            .update(refreshTokens)
            .set({ isRevoked: true })
            .where(eq(refreshTokens.familyId, payload!.familyId));
          return { reuse: true as const };
        }
        return { notFound: true as const };
      }

      if (existing.isRevoked) {
        // Token sudah di-revoke sebelumnya → REUSE ATTACK
        await tx
          .update(refreshTokens)
          .set({ isRevoked: true })
          .where(eq(refreshTokens.familyId, existing.familyId));
        return { reuse: true as const };
      }

      if (existing.expiresAt < new Date()) return { expired: true as const };

      // Revoke token lama (di dalam transaksi)
      await tx
        .update(refreshTokens)
        .set({ isRevoked: true, lastUsedAt: new Date() })
        .where(eq(refreshTokens.id, existing.id));

      // Generate token pair baru — INSERT juga di dalam transaksi
      const tokens = await this.generateTokenPair(
        existing.userId,
        existing.clientType as ClientType,
        existing.familyId,
        undefined,
        tx as unknown as DB,
      );

      return { tokens };
    });

    // ── Post-transaction: throw errors SETELAH commit ─────────────────────
    // Dengan begini, UPDATE revoke-family sudah ter-commit dan tidak rollback.

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

    // Revoke refresh token di PostgreSQL
    if (rawRefreshToken) {
      const hash = await hashToken(rawRefreshToken);
      await this.db
        .update(refreshTokens)
        .set({ isRevoked: true })
        .where(
          and(
            eq(refreshTokens.tokenHash, hash),
            eq(refreshTokens.isRevoked, false),
          ),
        );
    }
  }

  // ── Logout All Devices ────────────────────────────────────────────────────

  async logoutAll(userId: string): Promise<void> {
    // Revoke semua refresh token milik user ini di PostgreSQL.
    // Access token aktif akan expire sendiri (max 1 jam).
    await this.db
      .update(refreshTokens)
      .set({ isRevoked: true })
      .where(
        and(
          eq(refreshTokens.userId, userId),
          eq(refreshTokens.isRevoked, false),
        ),
      );
  }

  // ── List Active Sessions ──────────────────────────────────────────────────

  async getSessions(userId: string) {
    return this.db.query.refreshTokens.findMany({
      where: and(
        eq(refreshTokens.userId, userId),
        eq(refreshTokens.isRevoked, false),
        gt(refreshTokens.expiresAt, new Date()),
      ),
      columns: {
        id: true,
        clientType: true,
        deviceInfo: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
        familyId: false, // jangan ekspos ke client
        tokenHash: false,
      },
    });
  }

  // ── Revoke Specific Session ───────────────────────────────────────────────

  async revokeSession(sessionId: string, userId: string): Promise<boolean> {
    const result = await this.db
      .update(refreshTokens)
      .set({ isRevoked: true })
      .where(
        and(
          eq(refreshTokens.id, sessionId),
          eq(refreshTokens.userId, userId), // pastikan milik user ini
          eq(refreshTokens.isRevoked, false),
        ),
      )
      .returning({ id: refreshTokens.id });

    return result.length > 0;
  }

  // ── Resolve Unique Username ──────────────────────────────────────────────
  // Jika username sudah dipakai, kurangi 1 karakter dari belakang sampai unik.

  async resolveUniqueUsername(base: string): Promise<string> {
    let candidate = base;
    while (candidate.length > 0) {
      const existing = await this.db.query.users.findFirst({
        where: eq(users.username, candidate),
        columns: { id: true },
      });
      if (!existing) return candidate;
      candidate = candidate.slice(0, -1);
    }
    // Fallback: gunakan UUID jika semua trimmed versions sudah terpakai
    return crypto.randomUUID().slice(0, 8);
  }
}
