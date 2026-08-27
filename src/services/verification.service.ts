// src/services/verification.service.ts

import { eq, and, isNull } from "drizzle-orm";
import { hashToken } from "../utils/hash";
import { fail } from "../utils/error";
import type { AnyAuthDB } from "../types/index";
import { AuthDbAdapter, createAuthDbAdapter, type AuthDbDialect } from "../db/adapter";

// ── Config ────────────────────────────────────────────────────────────────────
const VERIFICATION_TTL_MINUTES = 15;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Generate 32-byte random hex token (untuk link-based) */
function generateToken(): string {
  const buf = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Generate 6-digit numeric OTP (untuk code-based) */
function generateOtpCode(): string {
  const maxUnbiased = 4294000000;
  for (let attempt = 0; attempt < 100; attempt++) {
    const buf = crypto.getRandomValues(new Uint8Array(4));
    const num = new DataView(buf.buffer).getUint32(0, false);
    if (num < maxUnbiased) {
      return String(num % 1_000_000).padStart(6, "0");
    }
  }
  const fallbackBuf = crypto.getRandomValues(new Uint32Array(1));
  return String(fallbackBuf[0] % 1_000_000).padStart(6, "0");
}

// ── Service ───────────────────────────────────────────────────────────────────

export class VerificationService {
  private readonly adapter: AuthDbAdapter;

  constructor(
    dbOrAdapter: AnyAuthDB | AuthDbAdapter,
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

  /**
   * Buat verification token untuk user.
   * Return plain token (untuk dikirim via email).
   */
  async createVerificationToken(userId: string): Promise<string> {
    const emailVerificationsTable = this.adapter.tables.emailVerifications;
    const token = generateToken();
    const tokenHash = await hashToken(token);
    const expiresAt = new Date(
      Date.now() + VERIFICATION_TTL_MINUTES * 60 * 1000,
    );

    // Invalidate/hapus token verifikasi lama yang belum digunakan untuk user ini
    await (this.db as any)
      .delete(emailVerificationsTable)
      .where(
        and(
          eq(emailVerificationsTable.userId, userId),
          isNull(emailVerificationsTable.usedAt),
        ),
      );

    await (this.db as any).insert(emailVerificationsTable).values({
      userId,
      tokenHash,
      expiresAt,
    });

    return token;
  }

  /**
   * Verifikasi email dari plain token.
   */
  async verifyEmail(token: string): Promise<{ userId: string; email: string }> {
    const tokenHash = await hashToken(token);
    const emailVerificationsTable = this.adapter.tables.emailVerifications;
    const usersTable = this.adapter.tables.users;

    return (this.db as any).transaction(async (tx: any) => {
      const [record] = await this.adapter.selectWithLock(
        tx,
        emailVerificationsTable,
        eq(emailVerificationsTable.tokenHash, tokenHash),
        {
          id: emailVerificationsTable.id,
          userId: emailVerificationsTable.userId,
          expiresAt: emailVerificationsTable.expiresAt,
          usedAt: emailVerificationsTable.usedAt,
        },
        1,
      );

      if (!record) {
        fail("Token verifikasi tidak valid", "INVALID_VERIFICATION_TOKEN", 401);
      }

      const [user] = await this.adapter.selectWithLock(
        tx,
        usersTable,
        eq(usersTable.id, record.userId),
        { id: usersTable.id, isActive: usersTable.isActive, deletedAt: usersTable.deletedAt },
        1,
      );

      if (!user || user.isActive === false || user.deletedAt) {
        fail("Akun tidak aktif atau telah dinonaktifkan", "ACCOUNT_DISABLED", 403);
      }

      if (record.usedAt) {
        fail(
          "Token verifikasi sudah digunakan",
          "VERIFICATION_TOKEN_USED",
          401,
        );
      }

      const expiresAt = record.expiresAt instanceof Date ? record.expiresAt : new Date(record.expiresAt);
      if (expiresAt < new Date()) {
        fail(
          "Token verifikasi sudah expired",
          "VERIFICATION_TOKEN_EXPIRED",
          401,
        );
      }

      // Tandai token sebagai used
      await tx
        .update(emailVerificationsTable)
        .set({ usedAt: new Date() })
        .where(eq(emailVerificationsTable.id, record.id));

      // Set user.isEmailVerified = true
      const [updatedUser] = await tx
        .update(usersTable)
        .set({ isEmailVerified: true, updatedAt: new Date() })
        .where(eq(usersTable.id, record.userId))
        .returning({ id: usersTable.id, email: usersTable.email });

      return { userId: updatedUser.id, email: updatedUser.email };
    });
  }

  /**
   * Resend verification token untuk user yang belum terverifikasi.
   */
  async resendVerification(
    email: string,
  ): Promise<{ token: string; userId: string }> {
    const normalizedEmail = email.toLowerCase().trim();
    const usersTable = this.adapter.tables.users;

    const user = await this.db.query.users.findFirst({
      where: eq(usersTable.email, normalizedEmail),
      columns: { id: true, isEmailVerified: true, isActive: true, deletedAt: true },
    });

    if (!user || user.isActive === false || user.deletedAt) {
      fail("Email tidak ditemukan", "USER_NOT_FOUND", 404);
    }

    if (user.isEmailVerified) {
      fail("Email sudah terverifikasi", "ALREADY_VERIFIED", 400);
    }

    const token = await this.createVerificationToken(user.id);
    return { token, userId: user.id };
  }

  // ── OTP / Code-based Verification ────────────────────────────────────────

  /**
   * Buat kode OTP 6-digit untuk user (code-based flow).
   */
  async createVerificationCode(
    userId: string,
    ttlMinutes: number = VERIFICATION_TTL_MINUTES,
  ): Promise<string> {
    const emailVerificationsTable = this.adapter.tables.emailVerifications;
    const code = generateOtpCode();
    const codeHash = await hashToken(code);
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

    // Invalidate/hapus kode verifikasi lama yang belum digunakan untuk user ini
    await (this.db as any)
      .delete(emailVerificationsTable)
      .where(
        and(
          eq(emailVerificationsTable.userId, userId),
          isNull(emailVerificationsTable.usedAt),
        ),
      );

    await (this.db as any).insert(emailVerificationsTable).values({
      userId,
      tokenHash: codeHash,
      expiresAt,
    });

    return code;
  }

  /**
   * Verifikasi email dari kode OTP + email.
   */
  async verifyEmailCode(
    email: string,
    code: string,
  ): Promise<{ userId: string; email: string }> {
    const normalizedEmail = email.toLowerCase().trim();
    const usersTable = this.adapter.tables.users;
    const emailVerificationsTable = this.adapter.tables.emailVerifications;
    const codeHash = await hashToken(code);

    return (this.db as any).transaction(async (tx: any) => {
      const [user] = await this.adapter.selectWithLock(
        tx,
        usersTable,
        eq(usersTable.email, normalizedEmail),
        { id: usersTable.id, isEmailVerified: usersTable.isEmailVerified, isActive: usersTable.isActive, deletedAt: usersTable.deletedAt },
        1,
      );

      if (!user || user.isActive === false || user.deletedAt) {
        fail("Email atau kode tidak valid", "INVALID_VERIFICATION_CODE", 401);
      }

      if (user.isEmailVerified) {
        fail("Email sudah terverifikasi", "ALREADY_VERIFIED", 400);
      }

      const [record] = await this.adapter.selectWithLock(
        tx,
        emailVerificationsTable,
        and(
          eq(emailVerificationsTable.userId, user.id),
          eq(emailVerificationsTable.tokenHash, codeHash),
        ),
        {
          id: emailVerificationsTable.id,
          expiresAt: emailVerificationsTable.expiresAt,
          usedAt: emailVerificationsTable.usedAt,
        },
        1,
      );

      if (!record) {
        fail("Email atau kode tidak valid", "INVALID_VERIFICATION_CODE", 401);
      }

      if (record.usedAt) {
        fail(
          "Kode verifikasi sudah digunakan",
          "VERIFICATION_CODE_USED",
          401,
        );
      }

      const expiresAt = record.expiresAt instanceof Date ? record.expiresAt : new Date(record.expiresAt);
      if (expiresAt < new Date()) {
        fail(
          "Kode verifikasi sudah expired",
          "VERIFICATION_CODE_EXPIRED",
          401,
        );
      }

      // Tandai kode sebagai used
      await tx
        .update(emailVerificationsTable)
        .set({ usedAt: new Date() })
        .where(eq(emailVerificationsTable.id, record.id));

      // Set user.isEmailVerified = true
      const [updatedUser] = await tx
        .update(usersTable)
        .set({ isEmailVerified: true, updatedAt: new Date() })
        .where(eq(usersTable.id, user.id))
        .returning({ id: usersTable.id, email: usersTable.email });

      return { userId: updatedUser.id, email: updatedUser.email };
    });
  }

  /**
   * Resend OTP code untuk user yang belum terverifikasi.
   */
  async resendVerificationCode(
    email: string,
    ttlMinutes?: number,
  ): Promise<{ code: string; userId: string }> {
    const normalizedEmail = email.toLowerCase().trim();
    const usersTable = this.adapter.tables.users;

    const user = await this.db.query.users.findFirst({
      where: eq(usersTable.email, normalizedEmail),
      columns: { id: true, isEmailVerified: true, isActive: true, deletedAt: true },
    });

    if (!user || user.isActive === false || user.deletedAt) {
      fail("Email tidak ditemukan", "USER_NOT_FOUND", 404);
    }

    if (user.isEmailVerified) {
      fail("Email sudah terverifikasi", "ALREADY_VERIFIED", 400);
    }

    const code = await this.createVerificationCode(user.id, ttlMinutes);
    return { code, userId: user.id };
  }
}
