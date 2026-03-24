// src/services/setting.service.ts
//
// Setting service — update profile, change password, update avatar.
// Password change → revoke semua refresh token (force re-login).

import { eq, and } from "drizzle-orm";
import { users, refreshTokens } from "../db/schema";
import { hashPassword, verifyPassword } from "../utils/password";
import { fail } from "../utils/error";
import { extractR2KeyFromUrl } from "./r2-upload.service";
import type { DB } from "../db/client";
import type { ImageFilterService } from "../utils/image-filter";
import type { AuthService } from "./auth.service";
import type { ClientType } from "../config/token.config";

// ── Service ───────────────────────────────────────────────────────────────────

export class SettingService {
  constructor(
    private readonly db: DB,
    private readonly authService: AuthService,
    private readonly imageFilter: ImageFilterService,
  ) {}

  // ── Get Profile ──────────────────────────────────────────────────────────

  async getProfile(userId: string) {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: {
        id: true,
        email: true,
        username: true,
        fullName: true,
        avatarUrl: true,
        isEmailVerified: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) fail("User tidak ditemukan", "USER_NOT_FOUND", 404);

    // Cek apakah user punya password (untuk UI: show/hide current password field)
    const fullUser = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { password: true },
    });

    return {
      ...user,
      hasPassword: !!fullUser?.password,
    };
  }

  // ── Update Profile (username, fullName) ──────────────────────────────────

  async updateProfile(
    userId: string,
    data: { username?: string; fullName?: string },
  ) {
    const updates: Record<string, any> = { updatedAt: new Date() };

    // Validasi username uniqueness
    if (data.username !== undefined) {
      const existing = await this.db.query.users.findFirst({
        where: eq(users.username, data.username),
        columns: { id: true },
      });

      if (existing && existing.id !== userId) {
        fail("Username sudah dipakai", "USERNAME_TAKEN", 409);
      }

      updates.username = data.username;
    }

    if (data.fullName !== undefined) {
      updates.fullName = data.fullName;
    }

    // Pastikan ada sesuatu yang diupdate selain updatedAt
    if (Object.keys(updates).length <= 1) {
      fail(
        "Tidak ada data yang diubah",
        "NO_CHANGES",
        400,
      );
    }

    const [updated] = await this.db
      .update(users)
      .set(updates)
      .where(eq(users.id, userId))
      .returning({
        id: users.id,
        username: users.username,
        fullName: users.fullName,
        updatedAt: users.updatedAt,
      });

    return updated;
  }

  // ── Change Password ──────────────────────────────────────────────────────
  // Setelah password berubah, revoke semua refresh token → force re-login.
  // Return token pair baru untuk sesi saat ini.

  async changePassword(
    userId: string,
    data: { currentPassword?: string; newPassword: string },
    clientType: ClientType,
    deviceInfo?: Record<string, string>,
  ) {
    // Hash password baru SEBELUM transaction (CPU-intensive, jangan di dalam lock)
    const hashedPassword = await hashPassword(data.newPassword);

    // ── Transaction atomic + SELECT FOR UPDATE ──────────────────────────────
    // Lock row user untuk mencegah race condition saat spam endpoint.
    // Semua validasi password dilakukan DI DALAM lock sehingga request concurrent
    // harus antri dan tidak bisa mem-bypass verifikasi.
    const result = await this.db.transaction(async (tx) => {
      // Lock row user
      const [user] = await tx
        .select({ id: users.id, password: users.password })
        .from(users)
        .where(eq(users.id, userId))
        .for("update");

      if (!user) return { error: "USER_NOT_FOUND" as const };

      // Jika user sudah punya password, wajib verify current password
      if (user.password) {
        if (!data.currentPassword) {
          return { error: "CURRENT_PASSWORD_REQUIRED" as const };
        }

        const valid = await verifyPassword(data.currentPassword, user.password);
        if (!valid) {
          return { error: "INVALID_CURRENT_PASSWORD" as const };
        }
      }
      // Jika user OAuth-only (password null), bisa langsung set password baru

      // Update password
      await tx
        .update(users)
        .set({ password: hashedPassword, updatedAt: new Date() })
        .where(eq(users.id, userId));

      // Revoke semua refresh token
      await tx
        .update(refreshTokens)
        .set({ isRevoked: true })
        .where(
          and(
            eq(refreshTokens.userId, userId),
            eq(refreshTokens.isRevoked, false),
          ),
        );

      return { ok: true as const };
    });

    // ── Post-transaction: throw errors SETELAH commit ─────────────────────
    if ("error" in result) {
      switch (result.error) {
        case "USER_NOT_FOUND":
          fail("User tidak ditemukan", "USER_NOT_FOUND", 404);
        case "CURRENT_PASSWORD_REQUIRED":
          fail("Password lama wajib diisi", "CURRENT_PASSWORD_REQUIRED", 400);
        case "INVALID_CURRENT_PASSWORD":
          fail("Password lama salah", "INVALID_CURRENT_PASSWORD");
      }
    }

    // Generate token pair baru untuk sesi saat ini
    const tokens = await this.authService.generateTokenPair(
      userId,
      clientType,
      undefined,
      deviceInfo,
    );

    return tokens;
  }

  // ── Check User Exists ───────────────────────────────────────────────────
  // Dipakai untuk validasi user sebelum upload ke R2.

  async checkUserExists(userId: string): Promise<{ avatarUrl: string | null }> {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { id: true, avatarUrl: true },
    });

    if (!user) {
      fail("User tidak ditemukan", "USER_NOT_FOUND", 404);
    }

    return { avatarUrl: user.avatarUrl };
  }

  // ── Update Avatar URL in DB ─────────────────────────────────────────────
  // Simpan avatar URL baru ke database. Dipanggil SETELAH upload ke R2 sukses.

  async updateAvatarUrl(userId: string, avatarUrl: string | null) {
    return await this.db.transaction(async (tx) => {
      // 1. Ambil URL avatar lama secara fresh tanpa cache Hyperdrive
      const existing = await tx.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { avatarUrl: true },
      });

      if (!existing) {
        fail("User tidak ditemukan", "USER_NOT_FOUND", 404);
      }

      // 2. Lakukan update URL avatar baru
      const [updated] = await tx
        .update(users)
        .set({ avatarUrl, updatedAt: new Date() })
        .where(eq(users.id, userId))
        .returning({
          id: users.id,
          avatarUrl: users.avatarUrl,
          updatedAt: users.updatedAt,
        });

      if (!updated) {
        fail("Gagal memperbarui avatar", "UPDATE_AVATAR_FAILED", 500);
      }

      return { updated, oldAvatarUrl: existing.avatarUrl };
    });
  }

  // ── Update Avatar from URL (JSON mode) ──────────────────────────────────
  // Mode lama: user kirim URL avatar sebagai JSON body.

  async updateAvatarFromUrl(
    userId: string,
    avatarUrl: string | null,
    bucket?: R2Bucket,
    bucketPublicUrl?: string,
  ) {
    // Jika user ingin menghapus avatar (null), langsung set null
    if (avatarUrl === null) {
      // Cek avatar lama dulu untuk dihapus (karena diset null)
      const currentUser = await this.db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { avatarUrl: true },
      });

      const oldKey = extractR2KeyFromUrl(currentUser?.avatarUrl ?? null, bucketPublicUrl);
      if (oldKey && bucket) {
        bucket.delete(oldKey).catch((err) =>
          console.error(`[setting] Gagal hapus R2 lama: ${oldKey}`, err)
        );
      }

      const [updated] = await this.db
        .update(users)
        .set({ avatarUrl: null, updatedAt: new Date() })
        .where(eq(users.id, userId))
        .returning({
          id: users.id,
          avatarUrl: users.avatarUrl,
          updatedAt: users.updatedAt,
        });

      return { ...updated, blocked: false };
    }

    // Jalankan AI filter
    const result = await this.imageFilter.isImageAllowed(avatarUrl);

    if (!result.allowed) {
      // Ambil avatar lama — jangan ubah ke null, pertahankan avatar lama
      const currentUser = await this.db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { id: true, avatarUrl: true, updatedAt: true },
      });

      return {
        id: currentUser!.id,
        avatarUrl: currentUser!.avatarUrl,
        updatedAt: currentUser!.updatedAt,
        blocked: true,
        blockedReason: result.reason,
      };
    }

    // Ambil URL lama dari DB untuk nantinya dihapus jika ada di r2 kita
    const currentUser = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { avatarUrl: true },
    });

    const [updated] = await this.db
      .update(users)
      .set({ avatarUrl, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning({
        id: users.id,
        avatarUrl: users.avatarUrl,
        updatedAt: users.updatedAt,
      });
      
    // Hapus data lama yang ada di R2 jika berganti dengan url eksternal
    const oldKey = extractR2KeyFromUrl(currentUser?.avatarUrl ?? null, bucketPublicUrl);
    if (oldKey && bucket) {
      bucket.delete(oldKey).catch((err) =>
        console.error(`[setting] Gagal hapus R2 lama: ${oldKey}`, err)
      );
    }

    return { ...updated, blocked: false };
  }
}
