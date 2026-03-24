// src/services/password-reset.service.ts
//
// Mengelola pembuatan & verifikasi token reset password.
// Token: 32-byte random hex, disimpan sebagai SHA-256 hash di DB.
// TTL: 15 menit, single-use.
// Setelah password direset → semua refresh token di-revoke (force re-login).

import { eq, and } from "drizzle-orm";
import { users, refreshTokens, passwordResets } from "../db/schema";
import { hashPassword } from "../utils/password";
import { hashToken } from "../utils/hash";
import { fail } from "../utils/error";
import type { DB } from "../db/client";

// ── Config ────────────────────────────────────────────────────────────────────
const RESET_TTL_MINUTES = 15;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Generate 32-byte random hex token */
function generateToken(): string {
  const buf = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Service ───────────────────────────────────────────────────────────────────

export class PasswordResetService {
  constructor(private readonly db: DB) {}

  /**
   * Buat reset token untuk user.
   * Return plain token (untuk dikirim via email).
   */
  async createResetToken(userId: string): Promise<string> {
    const token = generateToken();
    const tokenHash = await hashToken(token);
    const expiresAt = new Date(
      Date.now() + RESET_TTL_MINUTES * 60 * 1000,
    );

    await this.db.insert(passwordResets).values({
      userId,
      tokenHash,
      expiresAt,
    });

    return token;
  }

  /**
   * Cari user berdasarkan email untuk forgot-password.
   * Return userId jika ditemukan dan aktif, null jika tidak.
   */
  async findUserByEmail(email: string): Promise<string | null> {
    const normalizedEmail = email.toLowerCase().trim();
    const user = await this.db.query.users.findFirst({
      where: eq(users.email, normalizedEmail),
      columns: { id: true, isActive: true },
    });

    if (!user || !user.isActive) return null;
    return user.id;
  }

  /**
   * Reset password menggunakan token.
   * - Verify token valid, belum dipakai, belum expired
   * - Hash password baru
   * - Update user password
   * - Revoke semua refresh token (force re-login)
   * - Tandai token sebagai used
   */
  async resetPassword(
    token: string,
    newPassword: string,
  ): Promise<{ userId: string; email: string }> {
    const tokenHash = await hashToken(token);
    const hashedPassword = await hashPassword(newPassword);

    return this.db.transaction(async (tx) => {
      // Cari token yang valid dengan row lock
      const [record] = await tx
        .select({
          id: passwordResets.id,
          userId: passwordResets.userId,
          expiresAt: passwordResets.expiresAt,
          usedAt: passwordResets.usedAt,
        })
        .from(passwordResets)
        .where(eq(passwordResets.tokenHash, tokenHash))
        .for("update")
        .limit(1);

      if (!record) {
        fail("Token reset tidak valid", "INVALID_RESET_TOKEN", 401);
      }

      if (record.usedAt) {
        fail("Token reset sudah digunakan", "RESET_TOKEN_USED", 401);
      }

      if (record.expiresAt < new Date()) {
        fail("Token reset sudah expired", "RESET_TOKEN_EXPIRED", 401);
      }

      // Tandai token sebagai used
      await tx
        .update(passwordResets)
        .set({ usedAt: new Date() })
        .where(eq(passwordResets.id, record.id));

      // Update password user
      await tx
        .update(users)
        .set({ password: hashedPassword, updatedAt: new Date() })
        .where(eq(users.id, record.userId));

      // Revoke semua refresh token (force re-login di semua device)
      await tx
        .update(refreshTokens)
        .set({ isRevoked: true })
        .where(
          and(
            eq(refreshTokens.userId, record.userId),
            eq(refreshTokens.isRevoked, false),
          ),
        );

      // Ambil email user untuk response / audit
      const [user] = await tx
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.id, record.userId))
        .limit(1);

      return { userId: user.id, email: user.email };
    });
  }
}
