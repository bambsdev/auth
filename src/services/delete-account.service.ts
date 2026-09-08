// src/services/delete-account.service.ts
//
// Menangani penghapusan akun pengguna dengan strategi anonymization.
// Data identitas pribadi (email, nama, password, avatar) dianonimkan,
// sedangkan relasi transaksi/keuangan tetap utuh untuk keperluan audit.
//
// Pola Hook:
//   onBeforeDelete(userId, db) dipanggil di dalam transaksi SEBELUM anonymization.
//   Consumer dapat mendefinisikan cleanup logic mereka sendiri (hapus store, dll.).
//   Jika hook throw error, seluruh transaksi dibatalkan (rollback otomatis).

import { eq } from "drizzle-orm";
import { fail } from "../utils/error";
import { AuthDbAdapter, createAuthDbAdapter, type AuthDbDialect } from "../db/adapter";
import type { AnyAuthDB } from "../types/index";
import type { AuthService } from "./auth.service";

// ── Hook Type ─────────────────────────────────────────────────────────────────

/**
 * Callback yang dipanggil **di dalam transaksi DB** sesaat sebelum data user dianonimkan.
 * Consumer menggunakannya untuk cleanup data terkait (misal: suspend toko, batalkan sewa, dll.).
 *
 * @param userId  - UUID user yang akan dihapus
 * @param db      - Koneksi DB aktif (di dalam transaksi) — gunakan ini untuk query consumer
 *
 * @example
 * // Di api/ (consumer Rakkita):
 * createSettingRoutes("pg", {
 *   onBeforeDeleteAccount: async (userId, db) => {
 *     // Suspend semua toko milik user
 *     await db.update(stores).set({ status: "suspended" }).where(eq(stores.userId, userId));
 *     // Tolak withdrawal yang masih pending
 *     await db.update(withdrawals).set({ status: "rejected" }).where(
 *       and(eq(withdrawals.userId, userId), eq(withdrawals.status, "pending"))
 *     );
 *   }
 * });
 */
export type DeleteAccountHook = (
  userId: string,
  db: AnyAuthDB,
) => Promise<void>;

// ── Service ───────────────────────────────────────────────────────────────────

export class DeleteAccountService {
  private readonly adapter: AuthDbAdapter;

  constructor(
    dbOrAdapter: AnyAuthDB | AuthDbAdapter,
    private readonly authService: AuthService,
    dialect: AuthDbDialect = "pg",
  ) {
    if ("dialect" in dbOrAdapter && "tables" in dbOrAdapter) {
      this.adapter = dbOrAdapter as AuthDbAdapter;
    } else {
      this.adapter = createAuthDbAdapter(dbOrAdapter as AnyAuthDB, dialect);
    }
  }

  get db(): any {
    return this.adapter.db;
  }

  /**
   * Menghapus akun pengguna dengan strategi anonymization.
   *
   * Urutan operasi (semua dalam satu transaksi DB):
   *   1. Verifikasi user ada dan belum dihapus sebelumnya
   *   2. Panggil `onBeforeDelete` hook milik consumer (jika ada)
   *   3. Revoke semua refresh token aktif di database
   *   4. Anonymize data user di tabel `users` (email, nama, password, avatar, dll.)
   *   5. Hapus baris `oauth_accounts` terkait
   *
   * @param userId         - UUID user yang akan dihapus
   * @param onBeforeDelete - (opsional) Hook callback dari consumer
   */
  async deleteAccount(
    userId: string,
    onBeforeDelete?: DeleteAccountHook,
  ): Promise<void> {
    const usersTable = this.adapter.tables.users;
    const refreshTokensTable = this.adapter.tables.refreshTokens;
    const oauthAccountsTable = this.adapter.tables.oauthAccounts;

    // Jalankan dalam satu transaksi untuk atomicity
    await this.db.transaction(async (tx: any) => {
      // 1. Verifikasi user ada dan belum dianonimkan
      const [user] = await tx
        .select({
          id: usersTable.id,
          isDeleted: usersTable.isDeleted,
          isAnonymized: usersTable.isAnonymized,
          deletedAt: usersTable.deletedAt,
        })
        .from(usersTable)
        .where(eq(usersTable.id, userId))
        .limit(1);

      if (!user) {
        fail("Akun tidak ditemukan", "USER_NOT_FOUND", 404);
      }

      if (user.deletedAt || user.isDeleted || user.isAnonymized) {
        fail("Akun sudah dihapus sebelumnya", "ACCOUNT_ALREADY_DELETED", 409);
      }

      // 2. Panggil hook consumer (jika ada) — di dalam transaksi yang sama
      if (onBeforeDelete) {
        await onBeforeDelete(userId, tx);
      }

      // 3. Revoke semua refresh token (di dalam transaksi)
      await tx
        .update(refreshTokensTable)
        .set({ isRevoked: true })
        .where(eq(refreshTokensTable.userId, userId));

      // 4. Anonymize data user
      //    - email unik: "deleted_<userId>@rakkita.deleted" (tetap unik per user)
      //    - username unik: "deleted_<userId_8char>"
      const shortId = userId.replace(/-/g, "").slice(0, 8);
      await tx
        .update(usersTable)
        .set({
          email: `deleted_${userId}@rakkita.deleted`,
          fullName: "Pengguna Dihapus",
          username: `deleted_${shortId}`,
          password: null,
          avatarUrl: null,
          isActive: false,
          isDeleted: true,
          isAnonymized: true,
          deletedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(usersTable.id, userId));

      // 5. Hapus oauth_accounts — tidak diperlukan untuk audit keuangan
      await tx
        .delete(oauthAccountsTable)
        .where(eq(oauthAccountsTable.userId, userId));
    });
  }
}
