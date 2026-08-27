// src/services/setting.service.ts

import { eq, and } from "drizzle-orm";
import { hashPassword, verifyPassword } from "../utils/password";
import { fail } from "../utils/error";
import { extractR2KeyFromUrl } from "./r2-upload.service";
import type { AnyAuthDB } from "../types/index";
import { AuthDbAdapter, createAuthDbAdapter, type AuthDbDialect } from "../db/adapter";
import type { IImageFilterService } from "../utils/image-filter";
import type { AuthService } from "./auth.service";
import type { ClientType } from "../config/token.config";

// ── Service ───────────────────────────────────────────────────────────────────

export class SettingService {
  private readonly adapter: AuthDbAdapter;

  constructor(
    dbOrAdapter: AnyAuthDB | AuthDbAdapter,
    private readonly authService: AuthService,
    private readonly imageFilter: IImageFilterService,
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

  // ── Get Profile ──────────────────────────────────────────────────────────

  async getProfile(userId: string) {
    const usersTable = this.adapter.tables.users;
    const user = await (this.db as any).query.users.findFirst({
      where: eq(usersTable.id, userId),
      columns: {
        id: true,
        email: true,
        username: true,
        fullName: true,
        avatarUrl: true,
        isEmailVerified: true,
        password: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) fail("User tidak ditemukan", "USER_NOT_FOUND", 404);

    const { password, ...rest } = user;
    return {
      ...rest,
      hasPassword: !!password,
    };
  }

  // ── Update Profile (username, fullName) ──────────────────────────────────

  async updateProfile(
    userId: string,
    data: { username?: string; fullName?: string },
  ) {
    const usersTable = this.adapter.tables.users;
    const updates: Record<string, any> = { updatedAt: new Date() };

    // Validasi username uniqueness (case-insensitive)
    if (data.username !== undefined) {
      const normalizedUsername = data.username.toLowerCase().trim();
      const existing = await this.db.query.users.findFirst({
        where: eq(usersTable.username, normalizedUsername),
        columns: { id: true },
      });

      if (existing && existing.id !== userId) {
        fail("Username sudah dipakai", "USERNAME_TAKEN", 409);
      }

      updates.username = normalizedUsername;
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
      .update(usersTable)
      .set(updates)
      .where(eq(usersTable.id, userId))
      .returning({
        id: usersTable.id,
        username: usersTable.username,
        fullName: usersTable.fullName,
        updatedAt: usersTable.updatedAt,
      });

    return updated;
  }

  // ── Change Password ──────────────────────────────────────────────────────

  async changePassword(
    userId: string,
    data: { currentPassword?: string; newPassword: string },
    clientType: ClientType,
    deviceInfo?: Record<string, string>,
  ) {
    const hashedPassword = await hashPassword(data.newPassword);
    const usersTable = this.adapter.tables.users;
    const refreshTokensTable = this.adapter.tables.refreshTokens;

    const result = await this.db.transaction(async (tx: any) => {
      const [user] = await this.adapter.selectWithLock(
        tx,
        usersTable,
        eq(usersTable.id, userId),
        { id: usersTable.id, password: usersTable.password },
        1,
      );

      if (!user) return { error: "USER_NOT_FOUND" as const };

      if (user.password) {
        if (!data.currentPassword) {
          return { error: "CURRENT_PASSWORD_REQUIRED" as const };
        }

        const valid = await verifyPassword(data.currentPassword, user.password);
        if (!valid) {
          return { error: "INVALID_CURRENT_PASSWORD" as const };
        }

        if (data.currentPassword === data.newPassword) {
          return { error: "PASSWORD_UNCHANGED" as const };
        }
      }

      await tx
        .update(usersTable)
        .set({ password: hashedPassword, updatedAt: new Date() })
        .where(eq(usersTable.id, userId));

      await tx
        .update(refreshTokensTable)
        .set({ isRevoked: true })
        .where(
          and(
            eq(refreshTokensTable.userId, userId),
            eq(refreshTokensTable.isRevoked, false),
          ),
        );

      return { ok: true as const };
    });

    if ("error" in result) {
      switch (result.error) {
        case "USER_NOT_FOUND":
          fail("User tidak ditemukan", "USER_NOT_FOUND", 404);
        case "CURRENT_PASSWORD_REQUIRED":
          fail("Password lama wajib diisi", "CURRENT_PASSWORD_REQUIRED", 400);
        case "INVALID_CURRENT_PASSWORD":
          fail("Password lama salah", "INVALID_CURRENT_PASSWORD");
        case "PASSWORD_UNCHANGED":
          fail("Password baru tidak boleh sama dengan password lama", "PASSWORD_UNCHANGED", 400);
      }
    }

    const tokens = await this.authService.generateTokenPair(
      userId,
      clientType,
      undefined,
      deviceInfo,
    );

    return tokens;
  }

  // ── Check User Exists ───────────────────────────────────────────────────

  async checkUserExists(userId: string): Promise<{ avatarUrl: string | null }> {
    const usersTable = this.adapter.tables.users;
    const user = await this.db.query.users.findFirst({
      where: eq(usersTable.id, userId),
      columns: { id: true, avatarUrl: true },
    });

    if (!user) {
      fail("User tidak ditemukan", "USER_NOT_FOUND", 404);
    }

    return { avatarUrl: user.avatarUrl };
  }

  // ── Update Avatar URL in DB ─────────────────────────────────────────────

  async updateAvatarUrl(userId: string, avatarUrl: string | null) {
    const usersTable = this.adapter.tables.users;

    return await this.db.transaction(async (tx: any) => {
      const existing = await tx.query.users.findFirst({
        where: eq(usersTable.id, userId),
        columns: { avatarUrl: true },
      });

      if (!existing) {
        fail("User tidak ditemukan", "USER_NOT_FOUND", 404);
      }

      const [updated] = await tx
        .update(usersTable)
        .set({ avatarUrl, updatedAt: new Date() })
        .where(eq(usersTable.id, userId))
        .returning({
          id: usersTable.id,
          avatarUrl: usersTable.avatarUrl,
          updatedAt: usersTable.updatedAt,
        });

      if (!updated) {
        fail("Gagal memperbarui avatar", "UPDATE_AVATAR_FAILED", 500);
      }

      return { updated, oldAvatarUrl: existing.avatarUrl };
    });
  }

  // ── Update Avatar from URL (JSON mode) ──────────────────────────────────

  async updateAvatarFromUrl(
    userId: string,
    avatarUrl: string | null,
    bucket?: R2Bucket,
    bucketPublicUrl?: string,
  ) {
    const usersTable = this.adapter.tables.users;

    if (avatarUrl === null) {
      const { updated, oldAvatarUrl } = await this.updateAvatarUrl(userId, null);
      const oldKey = extractR2KeyFromUrl(oldAvatarUrl, bucketPublicUrl);
      if (oldKey && bucket) {
        bucket.delete(oldKey).catch((err) =>
          console.error(`[setting] Gagal hapus R2 lama: ${oldKey}`, err)
        );
      }
      return { ...updated, blocked: false };
    }

    const result = await this.imageFilter.isImageAllowed(avatarUrl);

    if (!result.allowed) {
      const currentUser = await this.db.query.users.findFirst({
        where: eq(usersTable.id, userId),
        columns: { id: true, avatarUrl: true, updatedAt: true },
      });

      if (!currentUser) {
        fail("User tidak ditemukan", "USER_NOT_FOUND", 404);
      }

      return {
        id: currentUser.id,
        avatarUrl: currentUser.avatarUrl,
        updatedAt: currentUser.updatedAt,
        blocked: true,
        blockedReason: result.reason,
      };
    }

    const { updated, oldAvatarUrl } = await this.updateAvatarUrl(userId, avatarUrl);
    const oldKey = extractR2KeyFromUrl(oldAvatarUrl, bucketPublicUrl);
    if (oldKey && bucket) {
      bucket.delete(oldKey).catch((err) =>
        console.error(`[setting] Gagal hapus R2 lama: ${oldKey}`, err)
      );
    }

    return { ...updated, blocked: false };
  }
}
