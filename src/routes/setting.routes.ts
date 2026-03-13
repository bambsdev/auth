// src/routes/setting.routes.ts
//
// Setting routes (semua 🔒 Protected):
//   GET  /api/settings/profile   — ambil profil user
//   PUT  /api/settings/profile   — update username / fullName
//   PUT  /api/settings/password  — change password (force re-login)
//   PUT  /api/settings/avatar    — update avatar URL (AI filtered)

import { Hono } from "hono";
import { verify } from "hono/jwt";
import type { Context } from "hono";
import { CacheService } from "../services/cache.service";
import { AuthService } from "../services/auth.service";
import { AuditService } from "../services/audit.service";
import { SettingService } from "../services/setting.service";
import { ImageFilterService } from "../utils/image-filter";
import { authMiddleware } from "../middleware/auth.middleware";
import {
  parseBody,
  updateProfileSchema,
  changePasswordSchema,
  updateAvatarSchema,
} from "../utils/validation";
import type { Bindings, Variables, JWTAccessPayload } from "../types/index";

export const settingRoutes = new Hono<{
  Bindings: Bindings;
  Variables: Variables;
}>();

// ── Types ─────────────────────────────────────────────────────────────────────
type AppContext = Context<{ Bindings: Bindings; Variables: Variables }>;

// ── Helper: service instances ─────────────────────────────────────────────────
function makeServices(c: AppContext) {
  const db = c.var.db;
  const cacheService = new CacheService(c.env.KV, caches.default);
  const authService = new AuthService(
    db,
    cacheService,
    c.env.JWT_SECRET,
    c.env.JWT_REFRESH_SECRET,
  );
  const imageFilter = new ImageFilterService(c.env.AI);
  const settingService = new SettingService(db, authService, imageFilter);
  const audit = new AuditService(c.env.ANALYTICS);
  return { settingService, cacheService, imageFilter, audit };
}

function getIp(c: AppContext): string {
  return (
    c.req.header("CF-Connecting-IP") ??
    c.req.header("X-Forwarded-For") ??
    "unknown"
  );
}

function errorResponse(c: AppContext, err: any) {
  const status = err.status ?? 500;
  const code = err.code ?? "INTERNAL_ERROR";
  return c.json({ error: { code, message: err.message } }, status);
}

// ── Semua route butuh auth ────────────────────────────────────────────────────
settingRoutes.use("*", authMiddleware);

// ╔══════════════════════════════════════════════════════════════╗
// ║  GET /api/settings/profile                  🔒 Protected     ║
// ╚══════════════════════════════════════════════════════════════╝
settingRoutes.get("/profile", async (c) => {
  const { settingService } = makeServices(c);

  try {
    const profile = await settingService.getProfile(c.var.userId);
    return c.json({ data: profile });
  } catch (err: any) {
    return errorResponse(c, err);
  }
});

// ╔══════════════════════════════════════════════════════════════╗
// ║  PUT /api/settings/profile                  🔒 Protected     ║
// ╚══════════════════════════════════════════════════════════════╝
settingRoutes.put("/profile", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      {
        error: {
          code: "INVALID_JSON",
          message: "Request body bukan JSON valid",
        },
      },
      400,
    );
  }

  const validated = parseBody(updateProfileSchema, body);
  const { settingService, audit } = makeServices(c);

  try {
    const updated = await settingService.updateProfile(c.var.userId, validated);

    audit.log({
      event: "profile_updated",
      userId: c.var.userId,
      ip: getIp(c),
      metadata: {
        username: validated.username,
        fullName: validated.fullName,
      },
    });

    return c.json({
      message: "Profil berhasil diperbarui",
      data: updated,
    });
  } catch (err: any) {
    return errorResponse(c, err);
  }
});

// ╔══════════════════════════════════════════════════════════════╗
// ║  PUT /api/settings/password                 🔒 Protected     ║
// ║  → Revoke semua sesi, return token pair baru                ║
// ╚══════════════════════════════════════════════════════════════╝
settingRoutes.put("/password", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      {
        error: {
          code: "INVALID_JSON",
          message: "Request body bukan JSON valid",
        },
      },
      400,
    );
  }

  const { currentPassword, newPassword, clientType } = parseBody(
    changePasswordSchema,
    body,
  );
  const { settingService, cacheService, audit } = makeServices(c);
  const ip = getIp(c);
  const ua = c.req.header("User-Agent") ?? "";

  try {
    const tokens = await settingService.changePassword(
      c.var.userId,
      { currentPassword, newPassword },
      clientType,
      { ua, ip },
    );

    // Blacklist access token saat ini agar langsung tidak bisa dipakai lagi
    const rawToken = c.req.header("Authorization")!.slice(7);
    const payload = (await verify(
      rawToken,
      c.env.JWT_SECRET,
      "HS256",
    )) as unknown as JWTAccessPayload;
    const remaining = payload.exp - Math.floor(Date.now() / 1000);
    if (remaining > 0) {
      await cacheService.blacklistToken(c.var.jti, remaining);
    }

    audit.log({
      event: "password_changed",
      userId: c.var.userId,
      ip,
    });

    return c.json({
      message:
        "Password berhasil diubah. Semua sesi lama dicabut, silakan login ulang di device lain.",
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      tokenType: "Bearer",
    });
  } catch (err: any) {
    return errorResponse(c, err);
  }
});

// ╔══════════════════════════════════════════════════════════════╗
// ║  PUT /api/settings/avatar                   🔒 Protected     ║
// ║  → AI filter sebelum menyimpan                               ║
// ╚══════════════════════════════════════════════════════════════╝
settingRoutes.put("/avatar", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      {
        error: {
          code: "INVALID_JSON",
          message: "Request body bukan JSON valid",
        },
      },
      400,
    );
  }

  const { avatarUrl } = parseBody(updateAvatarSchema, body);
  const { settingService, audit } = makeServices(c);
  const ip = getIp(c);

  try {
    const result = await settingService.updateAvatar(c.var.userId, avatarUrl);

    if (result.blocked) {
      // Avatar di-block AI → pertahankan avatar lama, beri warning
      audit.log({
        event: "avatar_blocked",
        userId: c.var.userId,
        ip,
        metadata: { reason: result.blockedReason },
      });

      return c.json(
        {
          error: {
            code: "AVATAR_BLOCKED",
            message:
              result.blockedReason ??
              "Avatar mengandung konten yang tidak diizinkan. Avatar lama dipertahankan.",
          },
          data: {
            id: result.id,
            avatarUrl: result.avatarUrl,
            updatedAt: result.updatedAt,
          },
        },
        400,
      );
    }

    audit.log({
      event: "avatar_updated",
      userId: c.var.userId,
      ip,
      metadata: { avatarUrl: result.avatarUrl },
    });

    return c.json({
      message: "Avatar berhasil diperbarui",
      data: {
        id: result.id,
        avatarUrl: result.avatarUrl,
        updatedAt: result.updatedAt,
      },
    });
  } catch (err: any) {
    return errorResponse(c, err);
  }
});
