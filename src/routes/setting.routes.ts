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
import { R2UploadService } from "../services/r2-upload.service";
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
// ║                                                              ║
// ║  Flow (multipart):                                           ║
// ║  1. Validasi file (type, size)                               ║
// ║  2. Cek user exists → ambil avatar lama                      ║
// ║  3. AI image filter                                          ║
// ║  4. Upload ke R2                                             ║
// ║  5. Update DB (avatar_url)                                   ║
// ║  6. Hapus file lama dari R2 (jika ada)                       ║
// ╚══════════════════════════════════════════════════════════════╝
settingRoutes.put("/avatar", async (c) => {
  const { settingService, imageFilter, audit } = makeServices(c);
  const ip = getIp(c);
  const userId = c.var.userId;

  const contentType = c.req.header("content-type") ?? "";

  // 1. Mode baru: Multipart Form Data
  if (contentType.includes("multipart/form-data")) {
    if (!c.env.BUCKET) {
      return c.json(
        { error: { code: "R2_NOT_CONFIGURED", message: "R2 bucket tidak dikonfigurasi" } },
        500,
      );
    }

    let formData: FormData;
    try {
      formData = await c.req.formData();
    } catch {
      return c.json(
        { error: { code: "INVALID_FORM_DATA", message: "Form data tidak valid" } },
        400,
      );
    }

    const rawFile = formData.get("avatar");
    if (!rawFile || typeof rawFile === "string") {
      return c.json(
        { error: { code: "MISSING_FILE", message: "File avatar wajib diisi" } },
        400,
      );
    }
    const file = rawFile as unknown as File;

    // Validasi ukuran max 1MB
    const MAX_SIZE = 1 * 1024 * 1024;
    if (file.size > MAX_SIZE) {
      return c.json(
        { error: { code: "FILE_TOO_LARGE", message: "Ukuran file maksimal 1MB" } },
        400,
      );
    }

    // Validasi tipe file
    const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (!allowedTypes.includes(file.type)) {
      return c.json(
        { error: { code: "INVALID_FILE_TYPE", message: "Format file harus JPEG, PNG, WebP, atau GIF" } },
        400,
      );
    }

    // ── STEP 2: Cek user exists SEBELUM upload ──────────────────────────
    // Fix Bug #1: file tidak boleh masuk R2 jika user not found
    let currentAvatarUrl: string | null;
    try {
      const userCheck = await settingService.checkUserExists(userId);
      currentAvatarUrl = userCheck.avatarUrl;
    } catch (err: any) {
      return errorResponse(c, err);
    }

    const arrayBuffer = await file.arrayBuffer();

    // ── STEP 3: AI image filter ─────────────────────────────────────────
    const filterResult = await imageFilter.isImageBufferAllowed(arrayBuffer, file.type);
    if (!filterResult.allowed) {
      audit.log({
        event: "avatar_blocked",
        userId,
        ip,
        metadata: { reason: filterResult.reason, source: "upload" },
      });

      return c.json(
        {
          error: {
            code: "AVATAR_BLOCKED",
            message: filterResult.reason ?? "Avatar mengandung konten yang tidak diizinkan",
          },
        },
        400,
      );
    }

    // ── STEP 4: Upload ke R2 ────────────────────────────────────────────
    const r2 = new R2UploadService(c.env.BUCKET, c.env.BUCKET_PUBLIC_URL);
    const uploaded = await r2.upload(arrayBuffer, file.type, "auth/avatars");

    // ── STEP 5: Update DB ───────────────────────────────────────────────
    try {
      const { updated: result, oldAvatarUrl } = await settingService.updateAvatarUrl(userId, uploaded.url);

      // ── STEP 6: Hapus file avatar lama dari R2 ────────────────────────
      // Await secara eksplisit agar isolate tidak mati sebelum hapus selesai
      const deletedKey = await r2.deleteByUrl(oldAvatarUrl);

      audit.log({
        event: "avatar_updated",
        userId,
        ip,
        metadata: { avatarUrl: uploaded.url, source: "upload" },
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
      // Jika DB update gagal, hapus file yang baru diupload (rollback R2)
      await r2.deleteByUrl(uploaded.url);
      return errorResponse(c, err);
    }
  }

  // 2. Mode Lama: via URL (JSON) - DISABLED
  return c.json(
    {
      error: {
        code: "METHOD_NOT_ALLOWED",
        message: "Update avatar via URL tidak lagi didukung. Silakan gunakan upload file.",
      },
    },
    400,
  );
});

// ╔══════════════════════════════════════════════════════════════╗
// ║  GET /api/settings/avatar-file/*             Proxy           ║
// ╚══════════════════════════════════════════════════════════════╝
settingRoutes.get("/avatar-file/*", async (c) => {
  if (!c.env.BUCKET) {
    return c.json({ error: { code: "NOT_FOUND", message: "File tidak ditemukan" } }, 404);
  }

  const key = c.req.path.replace("/api/settings/avatar-file/", "");
  const object = await c.env.BUCKET.get(key);

  if (!object) {
    return c.json({ error: { code: "NOT_FOUND", message: "File tidak ditemukan" } }, 404);
  }

  // Set the response
  const headers = new Headers();
  headers.set("Content-Type", object.httpMetadata?.contentType ?? "image/jpeg");
  headers.set("Cache-Control", "public, max-age=31536000"); // 1 year cache
  if (object.etag) headers.set("ETag", object.etag);

  return new Response(object.body, { headers });
});
