// src/services/verification.service.ts
//
// Mengelola pembuatan & verifikasi token email verification.
// Token: 32-byte random hex, disimpan sebagai SHA-256 hash di DB.
// TTL: 15 menit, single-use.

import { eq } from "drizzle-orm";
import { users, emailVerifications } from "../db/schema";
import { hashToken } from "../utils/hash";
import { fail } from "../utils/error";
import type { DB } from "../db/client";

// ── Config ────────────────────────────────────────────────────────────────────
const VERIFICATION_TTL_MINUTES = 15;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Generate 32-byte random hex token */
function generateToken(): string {
  const buf = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
}
