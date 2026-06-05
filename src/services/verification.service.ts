// src/services/verification.service.ts
//
// Mengelola pembuatan & verifikasi token email verification.
// Dua mode:
//   - Link: 32-byte random hex token (dipakai di URL verifikasi)
//   - Code: 6-digit OTP (mobile-friendly, autofill support)
// Keduanya disimpan sebagai SHA-256 hash di DB, TTL 15 menit, single-use.

import { eq, and } from "drizzle-orm";
import { users, emailVerifications } from "../db/schema";
import { hashToken } from "../utils/hash";
import { fail } from "../utils/error";
import type { DB } from "../db/client";

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
  // Gunakan random bytes untuk menghindari bias modulo
  const buf = crypto.getRandomValues(new Uint8Array(4));
  const num = new DataView(buf.buffer).getUint32(0, false);
  return String(num % 1_000_000).padStart(6, "0");
}

// ── Service ───────────────────────────────────────────────────────────────────

export class VerificationService {
  constructor(private readonly db: DB) {}

  /**
   * Buat verification token untuk user.
   * Return plain token (untuk dikirim via email).
   */
  async createVerificationToken(userId: string): Promise<string> {
    const token = generateToken();
    const tokenHash = await hashToken(token);
    const expiresAt = new Date(
      Date.now() + VERIFICATION_TTL_MINUTES * 60 * 1000,
    );

    await this.db.insert(emailVerifications).values({
      userId,
      tokenHash,
      expiresAt,
    });

    return token;
  }

  /**
   * Verifikasi email dari plain token.
   * - Cek hash ada di DB, belum dipakai, belum expired
   * - Set user.isEmailVerified = true
   * - Tandai token sebagai used
   */
  async verifyEmail(token: string): Promise<{ userId: string; email: string }> {
    const tokenHash = await hashToken(token);

    // Wrap dalam transaction untuk mencegah race condition
    // (dua request simultaneous verify token yang sama)
    return this.db.transaction(async (tx) => {
      // Cari token yang valid
      const [record] = await tx
        .select({
          id: emailVerifications.id,
          userId: emailVerifications.userId,
          expiresAt: emailVerifications.expiresAt,
          usedAt: emailVerifications.usedAt,
        })
        .from(emailVerifications)
        .where(eq(emailVerifications.tokenHash, tokenHash))
        .for("update")
        .limit(1);

      if (!record) {
        fail("Token verifikasi tidak valid", "INVALID_VERIFICATION_TOKEN", 401);
      }

      if (record.usedAt) {
        fail(
          "Token verifikasi sudah digunakan",
          "VERIFICATION_TOKEN_USED",
          401,
        );
      }

      if (record.expiresAt < new Date()) {
        fail(
          "Token verifikasi sudah expired",
          "VERIFICATION_TOKEN_EXPIRED",
          401,
        );
      }

      // Tandai token sebagai used
      await tx
        .update(emailVerifications)
        .set({ usedAt: new Date() })
        .where(eq(emailVerifications.id, record.id));

      // Set user.isEmailVerified = true
      const [user] = await tx
        .update(users)
        .set({ isEmailVerified: true, updatedAt: new Date() })
        .where(eq(users.id, record.userId))
        .returning({ id: users.id, email: users.email });

      return { userId: user.id, email: user.email };
    });
  }

  /**
   * Resend verification token untuk user yang belum terverifikasi.
   * Return plain token + userId.
   */
  async resendVerification(
    email: string,
  ): Promise<{ token: string; userId: string }> {
    const normalizedEmail = email.toLowerCase().trim();

    // Cari user
    const user = await this.db.query.users.findFirst({
      where: eq(users.email, normalizedEmail),
      columns: { id: true, isEmailVerified: true, isActive: true },
    });

    // Untuk keamanan, selalu return sukses meski email tidak ditemukan
    // (mencegah email enumeration). Tapi tetap throw internal agar
    // route handler bisa membedakan.
    if (!user || !user.isActive) {
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
   * Return plain code (untuk dikirim via email).
   * Hash disimpan di tabel `emailVerifications` — tabel yang sama dengan link flow.
   * @param ttlMinutes - TTL dalam menit (default: VERIFICATION_TTL_MINUTES = 15)
   */
  async createVerificationCode(
    userId: string,
    ttlMinutes: number = VERIFICATION_TTL_MINUTES,
  ): Promise<string> {
    const code = generateOtpCode();
    const codeHash = await hashToken(code);
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

    await this.db.insert(emailVerifications).values({
      userId,
      tokenHash: codeHash,
      expiresAt,
    });

    return code;
  }

  /**
   * Verifikasi email dari kode OTP + email.
   * - Cari user berdasarkan email
   * - Hash kode, cari di emailVerifications milik userId tersebut
   * - Validasi: ada, belum dipakai, belum expired
   * - Set isEmailVerified = true
   * - Tandai token sebagai used
   */
  async verifyEmailCode(
    email: string,
    code: string,
  ): Promise<{ userId: string; email: string }> {
    const normalizedEmail = email.toLowerCase().trim();

    // Cari user berdasarkan email
    const user = await this.db.query.users.findFirst({
      where: eq(users.email, normalizedEmail),
      columns: { id: true, isEmailVerified: true, isActive: true },
    });

    if (!user || !user.isActive) {
      fail("Email atau kode tidak valid", "INVALID_VERIFICATION_CODE", 401);
    }

    if (user.isEmailVerified) {
      fail("Email sudah terverifikasi", "ALREADY_VERIFIED", 400);
    }

    const codeHash = await hashToken(code);

    return this.db.transaction(async (tx) => {
      // Cari record berdasarkan userId + codeHash (bukan hanya hash)
      // agar satu kode tidak bisa dipakai untuk verifikasi user lain
      const [record] = await tx
        .select({
          id: emailVerifications.id,
          expiresAt: emailVerifications.expiresAt,
          usedAt: emailVerifications.usedAt,
        })
        .from(emailVerifications)
        .where(
          and(
            eq(emailVerifications.userId, user.id),
            eq(emailVerifications.tokenHash, codeHash),
          ),
        )
        .for("update")
        .limit(1);

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

      if (record.expiresAt < new Date()) {
        fail(
          "Kode verifikasi sudah expired",
          "VERIFICATION_CODE_EXPIRED",
          401,
        );
      }

      // Tandai kode sebagai used
      await tx
        .update(emailVerifications)
        .set({ usedAt: new Date() })
        .where(eq(emailVerifications.id, record.id));

      // Set user.isEmailVerified = true
      const [updatedUser] = await tx
        .update(users)
        .set({ isEmailVerified: true, updatedAt: new Date() })
        .where(eq(users.id, user.id))
        .returning({ id: users.id, email: users.email });

      return { userId: updatedUser.id, email: updatedUser.email };
    });
  }

  /**
   * Resend OTP code untuk user yang belum terverifikasi.
   * Return plain code + userId.
   * @param ttlMinutes - TTL dalam menit (default: VERIFICATION_TTL_MINUTES = 15)
   */
  async resendVerificationCode(
    email: string,
    ttlMinutes?: number,
  ): Promise<{ code: string; userId: string }> {
    const normalizedEmail = email.toLowerCase().trim();

    const user = await this.db.query.users.findFirst({
      where: eq(users.email, normalizedEmail),
      columns: { id: true, isEmailVerified: true, isActive: true },
    });

    if (!user || !user.isActive) {
      fail("Email tidak ditemukan", "USER_NOT_FOUND", 404);
    }

    if (user.isEmailVerified) {
      fail("Email sudah terverifikasi", "ALREADY_VERIFIED", 400);
    }

    const code = await this.createVerificationCode(user.id, ttlMinutes);
    return { code, userId: user.id };
  }
}
