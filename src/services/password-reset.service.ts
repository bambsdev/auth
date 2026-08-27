// src/services/password-reset.service.ts

import { eq, and, isNull } from "drizzle-orm";
import { hashPassword } from "../utils/password";
import { hashToken } from "../utils/hash";
import { fail } from "../utils/error";
import type { AnyAuthDB } from "../types/index";
import { AuthDbAdapter, createAuthDbAdapter, type AuthDbDialect } from "../db/adapter";

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
   * Buat reset token untuk user.
   * Return plain token (untuk dikirim via email).
   */
  async createResetToken(userId: string): Promise<string> {
    const passwordResetsTable = this.adapter.tables.passwordResets;
    const token = generateToken();
    const tokenHash = await hashToken(token);
    const expiresAt = new Date(
      Date.now() + RESET_TTL_MINUTES * 60 * 1000,
    );

    // Invalidate/hapus reset token lama yang belum digunakan untuk user ini
    await (this.db as any)
      .delete(passwordResetsTable)
      .where(
        and(
          eq(passwordResetsTable.userId, userId),
          isNull(passwordResetsTable.usedAt),
        ),
      );

    await (this.db as any).insert(passwordResetsTable).values({
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
    const usersTable = this.adapter.tables.users;
    const user = await this.db.query.users.findFirst({
      where: eq(usersTable.email, normalizedEmail),
      columns: { id: true, isActive: true, deletedAt: true },
    });

    if (!user || !user.isActive || user.deletedAt) return null;
    return user.id;
  }

  /**
   * Reset password menggunakan token.
   */
  async resetPassword(
    token: string,
    newPassword: string,
  ): Promise<{ userId: string; email: string }> {
    const tokenHash = await hashToken(token);
    const hashedPassword = await hashPassword(newPassword);
    const passwordResetsTable = this.adapter.tables.passwordResets;
    const usersTable = this.adapter.tables.users;
    const refreshTokensTable = this.adapter.tables.refreshTokens;

    return this.db.transaction(async (tx: any) => {
      const [record] = await this.adapter.selectWithLock(
        tx,
        passwordResetsTable,
        eq(passwordResetsTable.tokenHash, tokenHash),
        {
          id: passwordResetsTable.id,
          userId: passwordResetsTable.userId,
          expiresAt: passwordResetsTable.expiresAt,
          usedAt: passwordResetsTable.usedAt,
        },
        1,
      );

      if (!record) {
        fail("Token reset tidak valid", "INVALID_RESET_TOKEN", 401);
      }

      if (record.usedAt) {
        fail("Token reset sudah digunakan", "RESET_TOKEN_USED", 401);
      }

      const expiresAt = record.expiresAt instanceof Date ? record.expiresAt : new Date(record.expiresAt);
      if (expiresAt < new Date()) {
        fail("Token reset sudah expired", "RESET_TOKEN_EXPIRED", 401);
      }

      // Tandai token sebagai used
      await tx
        .update(passwordResetsTable)
        .set({ usedAt: new Date() })
        .where(eq(passwordResetsTable.id, record.id));

      // Update password user
      await tx
        .update(usersTable)
        .set({ password: hashedPassword, updatedAt: new Date() })
        .where(eq(usersTable.id, record.userId));

      // Revoke semua refresh token (force re-login di semua device)
      await tx
        .update(refreshTokensTable)
        .set({ isRevoked: true })
        .where(
          and(
            eq(refreshTokensTable.userId, record.userId),
            eq(refreshTokensTable.isRevoked, false),
          ),
        );

      // Ambil email user untuk response / audit
      const [user] = await tx
        .select({ id: usersTable.id, email: usersTable.email })
        .from(usersTable)
        .where(eq(usersTable.id, record.userId))
        .limit(1);

      return { userId: user.id, email: user.email };
    });
  }
}
