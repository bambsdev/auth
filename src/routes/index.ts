// src/routes/index.ts
//
// Semua route auth:
//   POST /auth/register
//   POST /auth/login
//   POST /auth/refresh
//   POST /auth/logout
//   POST /auth/logout-all
//   GET  /auth/sessions
//   DELETE /auth/sessions/:id
//   GET  /auth/verify-email
//   POST /auth/resend-verification
//   POST /auth/forgot-password
//   POST /auth/reset-password
//   GET  /auth/google/login         (web: redirect ke Google consent)
//   GET  /auth/google/callback      (web: handle callback dari Google)
//   POST /auth/google/token         (mobile: verify ID token dari Google Sign-In SDK)

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { verify } from "hono/jwt";
import type { Context } from "hono";
import { CacheService } from "../services/cache.service";
import { AuthService } from "../services/auth.service";
import { RegisterService } from "../services/register.service";
import { AuditService } from "../services/audit.service";
import { EmailService } from "../services/email.service";
import { VerificationService } from "../services/verification.service";
import { PasswordResetService } from "../services/password-reset.service";
import { GoogleOAuthService } from "../services/google.service";
import { ImageFilterService } from "../utils/image-filter";
import { authMiddleware } from "../middleware/auth.middleware";
import {
  RATE_LIMIT_MAX,
  FORGOT_PASSWORD_RATE_LIMIT_MAX,
} from "../config/token.config";
import {
  parseBody,
  registerSchema,
  loginSchema,
  refreshSchema,
  logoutSchema,
  resendVerificationSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  googleTokenSchema,
  clientTypeSchema,
} from "../utils/validation";
import {
  ErrorResponseSchema,
  TokenResponseSchema,
  BasicMessageSchema,
} from "../utils/openapi-schemas";
import type { Bindings, Variables, JWTAccessPayload } from "../types/index";

export const authRoutes = new OpenAPIHono<{
  Bindings: Bindings;
  Variables: Variables;
}>({
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: result.error.issues[0]?.message || "Input tidak valid",
          },
        },
        400,
      );
    }
  },
});

// ── Types untuk Hono Context ─────────────────────────────────────────────────
type AppContext = Context<{ Bindings: Bindings; Variables: Variables }>;

// ── Helper: buat semua service instances ─────────────────────────────────────
// DB sudah di-inject ke c.var.db oleh dbMiddleware di index.ts,
// jadi di sini tinggal pakai — tidak perlu createDb lagi.
function makeServices(c: AppContext) {
  const db = c.var.db;
  const cacheService = new CacheService(c.env.KV, caches.default);
  const authService = new AuthService(
    db,
    cacheService,
    c.env.JWT_SECRET,
    c.env.JWT_REFRESH_SECRET,
  );
  const audit = new AuditService(c.env.ANALYTICS);
  const emailFrom =
    c.var.emailConfig?.from ??
    c.env.EMAIL_FROM ??
    "No-Reply <noreply@example.com>";
  const emailService = new EmailService(
    c.env.RESEND_API_KEY,
    c.env.APP_URL,
    emailFrom,
    c.var.emailConfig?.templates,
  );
  const verificationService = new VerificationService(db);
  const passwordResetService = new PasswordResetService(db);
  const imageFilter = new ImageFilterService(c.env.AI);
  const googleService = new GoogleOAuthService(
    db,
    authService,
    imageFilter,
    c.env.GOOGLE_CLIENT_ID,
    c.env.GOOGLE_CLIENT_SECRET,
    c.env.BUCKET_PUBLIC_URL,
  );
  return {
    db,
    cacheService,
    authService,
    audit,
    emailService,
    verificationService,
    passwordResetService,
    googleService,
  };
}

function getIp(c: AppContext): string {
  return (
    c.req.header("CF-Connecting-IP") ??
    c.req.header("X-Forwarded-For") ??
    "unknown"
  );
}

// ── Standarisasi response error ───────────────────────────────────────────────
function errorResponse(c: AppContext, err: any) {
  const isAppError =
    typeof err.status === "number" && typeof err.code === "string";
  let status = isAppError ? err.status : 500;
  let code = isAppError ? err.code : "INTERNAL_ERROR";
  let message = isAppError ? err.message : "Terjadi kesalahan pada server";

  if (
    !isAppError &&
    (err.code === "23505" ||
      String(err.message).includes("duplicate key") ||
      String(err.message).includes("unique constraint") ||
      String(err.message).includes("Failed query"))
  ) {
    status = 409;
    code = "CONFLICT";
    message = "Data sudah terdaftar atau terjadi duplikasi";
  }

  if (status >= 500) {
    console.error("[Internal Error]", err);
  }

  return c.json({ error: { code, message } }, status as any);
}

// ╔══════════════════════════════════════════════════════════════╗
// ║  POST /auth/register                                         ║
// ╚══════════════════════════════════════════════════════════════╝

const registerRoute = createRoute({
  method: "post",
  path: "/register",
  tags: ["Authentication"],
  summary: "Daftar pengguna baru",
  description: "Mendaftarkan pengguna baru dengan email dan kata sandi.",
  request: {
    body: {
      content: { "application/json": { schema: registerSchema } },
    },
  },
  responses: {
    201: {
      description: "Registrasi berhasil",
      content: {
        "application/json": {
          schema: z.object({
            message: z.string(),
            data: z.object({
              id: z.string(),
              email: z.string(),
              createdAt: z.string(),
            }),
          }),
        },
      },
    },
    400: {
      description: "Bad Request (Validation Error)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    409: {
      description: "Conflict (Email sudah terdaftar)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

authRoutes.openapi(registerRoute, async (c) => {
  const validated = c.req.valid("json");
  const { db, audit, emailService, verificationService } = makeServices(c);

  try {
    const registerService = new RegisterService(db);
    // TypeScript knows validated is RegisterInput
    const user = await registerService.register(validated);

    // Generate verification token & kirim email (tunggu hingga selesai)
    const token = await verificationService.createVerificationToken(user.id);
    try {
      await emailService.sendVerificationEmail(user.email, token);
      audit.log({
        event: "verification_sent",
        userId: user.id,
        ip: getIp(c),
        metadata: { email: user.email },
      });
    } catch (err: any) {
      console.error("[register] Failed to send verification email:", err);
    }

    audit.log({ event: "register", userId: user.id, ip: getIp(c) });

    return c.json(
      {
        message: "Registrasi berhasil. Silakan cek email untuk verifikasi.",
        data: {
          id: user.id,
          email: user.email,
          createdAt: (user.createdAt as Date).toISOString(),
        },
      },
      201,
    );
  } catch (err: any) {
    return errorResponse(c, err);
  }
});

// ╔══════════════════════════════════════════════════════════════╗
// ║  POST /auth/login                                            ║
// ╚══════════════════════════════════════════════════════════════╝

const loginRoute = createRoute({
  method: "post",
  path: "/login",
  tags: ["Authentication"],
  summary: "User Login",
  description: "Melakukan otentikasi dan mendapatkan token (Akses & Refresh)",
  request: {
    body: {
      content: { "application/json": { schema: loginSchema } },
    },
  },
  responses: {
    200: {
      description: "Login berhasil",
      content: { "application/json": { schema: TokenResponseSchema } },
    },
    400: {
      description: "Bad Request (Validation Error)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized (Kredensial salah)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    429: {
      description: "Too Many Requests (Rate Limited)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

authRoutes.openapi(loginRoute, async (c) => {
  const { email, password, clientType } = c.req.valid("json");
  const { authService, cacheService, audit } = makeServices(c);
  const ip = getIp(c);
  const ua = c.req.header("User-Agent") ?? "";

  // Rate limit check
  const attempts = await cacheService.getRateLimit(ip);
  if (attempts >= RATE_LIMIT_MAX) {
    audit.log({ event: "rate_limit_hit", ip, metadata: { email } });
    return c.json(
      {
        error: {
          code: "RATE_LIMITED",
          message: "Terlalu banyak percobaan login. Coba lagi dalam 5 menit.",
        },
      },
      429,
    );
  }

  try {
    const tokens = await authService.login(email, password, clientType, {
      ua,
      ip,
    });

    await cacheService.clearRateLimit(ip); // reset counter saat login sukses
    audit.log({ event: "login_success", clientType, ip, metadata: { email } });

    return c.json(
      {
        message: "Login berhasil",
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
        tokenType: "Bearer",
      },
      200,
    );
  } catch (err: any) {
    if (err.status === 401 || err.code === "INVALID_CREDENTIALS") {
      await cacheService.incrementRateLimit(ip);
      audit.log({ event: "login_failed", ip, metadata: { email } });
    }
    return errorResponse(c, err);
  }
});

// ╔══════════════════════════════════════════════════════════════╗
// ║  POST /auth/refresh                                          ║
// ╚══════════════════════════════════════════════════════════════╝

const refreshRoute = createRoute({
  method: "post",
  path: "/refresh",
  tags: ["Authentication"],
  summary: "Refresh Token",
  description:
    "Mendapatkan JWT Akses baru menggunakan Refresh Token yang valid",
  request: {
    body: {
      content: { "application/json": { schema: refreshSchema } },
    },
  },
  responses: {
    200: {
      description: "Token berhasil diperbarui",
      content: { "application/json": { schema: TokenResponseSchema } },
    },
    400: {
      description: "Bad Request (Validation Error)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized (Refresh Token tidak valid/kadaluarsa)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    403: {
      description: "Forbidden (Token reuse terdeteksi)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

authRoutes.openapi(refreshRoute, async (c) => {
  const { refreshToken } = c.req.valid("json");
  const { authService, audit } = makeServices(c);

  try {
    const tokens = await authService.rotateRefreshToken(refreshToken);
    audit.log({ event: "token_refresh", ip: getIp(c) });

    return c.json(
      {
        message: "Token berhasil diperbarui",
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
        tokenType: "Bearer",
      },
      200,
    );
  } catch (err: any) {
    if (err.code === "TOKEN_REUSE_DETECTED") {
      audit.log({ event: "token_reuse_detected", ip: getIp(c) });
    }
    return errorResponse(c, err);
  }
});

// ╔══════════════════════════════════════════════════════════════╗
// ║  POST /auth/logout                          🔒 Protected     ║
// ╚══════════════════════════════════════════════════════════════╝

const logoutRoute = createRoute({
  method: "post",
  path: "/logout",
  tags: ["Authentication"],
  summary: "User Logout",
  description: "Mencabut refresh token saat ini",
  security: [{ Bearer: [] }],
  request: {
    body: {
      content: { "application/json": { schema: logoutSchema } },
    },
  },
  responses: {
    200: {
      description: "Logout berhasil",
      content: { "application/json": { schema: BasicMessageSchema } },
    },
    400: {
      description: "Bad Request",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

authRoutes.openapi(logoutRoute, async (c) => {
  const { refreshToken } = c.req.valid("json");
  const { authService, audit } = makeServices(c);

  // Ambil exp dari access token untuk set TTL blacklist
  const rawToken = c.req.header("Authorization")!.slice(7);
  const payload = (await verify(
    rawToken,
    c.env.JWT_SECRET,
    "HS256",
  )) as unknown as JWTAccessPayload;

  await authService.logout(c.var.jti, payload.exp, refreshToken);
  audit.log({
    event: "logout",
    userId: c.var.userId,
    clientType: c.var.clientType,
    ip: getIp(c),
  });

  return c.json({ message: "Logout berhasil" }, 200);
});

// ╔══════════════════════════════════════════════════════════════╗
// ║  POST /auth/logout-all                      🔒 Protected     ║
// ╚══════════════════════════════════════════════════════════════╝

const logoutAllRoute = createRoute({
  method: "post",
  path: "/logout-all",
  tags: ["Authentication"],
  summary: "Logout All Sessions",
  description:
    "Mencabut semua sesi / refresh token pengguna di semua perangkat",
  security: [{ Bearer: [] }],
  responses: {
    200: {
      description: "Logout semua sesi berhasil",
      content: { "application/json": { schema: BasicMessageSchema } },
    },
  },
});

authRoutes.openapi(logoutAllRoute, async (c) => {
  const { authService, audit } = makeServices(c);

  await authService.logoutAll(c.var.userId);
  audit.log({ event: "logout_all", userId: c.var.userId, ip: getIp(c) });

  return c.json({ message: "Semua sesi berhasil dicabut" }, 200);
});

// ╔══════════════════════════════════════════════════════════════╗
// ║  GET /auth/sessions                         🔒 Protected     ║
// ╚══════════════════════════════════════════════════════════════╝

const getSessionsRoute = createRoute({
  method: "get",
  path: "/sessions",
  tags: ["Session Management"],
  summary: "Get Active Sessions",
  description:
    "Menampilkan daftar semua sesi perangkat (refresh token) yang aktif saat ini",
  security: [{ Bearer: [] }],
  responses: {
    200: {
      description: "Daftar sesi berhasil diambil",
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(
              z.object({
                id: z.string(),
                createdAt: z.string().nullable(),
                clientType: z.union([
                  z.literal("web"),
                  z.literal("mobile"),
                  z.literal("desktop"),
                ]),
                deviceInfo: z.any().nullable(),
                expiresAt: z.string(),
                lastUsedAt: z.string().nullable(),
              }),
            ),
          }),
        },
      },
    },
  },
});

authRoutes.openapi(getSessionsRoute, async (c) => {
  const { authService } = makeServices(c);
  const sessions = await authService.getSessions(c.var.userId);

  const formatted = sessions.map((s) => ({
    ...s,
    createdAt: s.createdAt ? (s.createdAt as Date).toISOString() : null,
    expiresAt: (s.expiresAt as Date).toISOString(),
    lastUsedAt: s.lastUsedAt ? (s.lastUsedAt as Date).toISOString() : null,
  }));

  return c.json({ data: formatted }, 200);
});

// ╔══════════════════════════════════════════════════════════════╗
// ║  DELETE /auth/sessions/:id                  🔒 Protected     ║
// ╚══════════════════════════════════════════════════════════════╝

const deleteSessionRoute = createRoute({
  method: "delete",
  path: "/sessions/{id}",
  tags: ["Session Management"],
  summary: "Revoke Specific Session",
  description: "Mencabut sesi (refresh token) dari ID tertentu",
  security: [{ Bearer: [] }],
  request: {
    params: z.object({
      id: z.string().uuid("ID sesi harus UUID yang valid").openapi({
        example: "a1b2c3d4-e5f6-7890-1234-567890abcdef",
        description: "ID Refresh Token",
      }),
    }),
  },
  responses: {
    200: {
      description: "Sesi berhasil dicabut",
      content: { "application/json": { schema: BasicMessageSchema } },
    },
    404: {
      description: "Sesi tidak ditemukan",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

authRoutes.openapi(deleteSessionRoute, async (c) => {
  // Extract id normally from req.param (validated by z)
  const { id: sessionId } = c.req.valid("param");
  const { authService, audit } = makeServices(c);

  const revoked = await authService.revokeSession(sessionId, c.var.userId);

  if (!revoked) {
    return c.json(
      {
        error: { code: "SESSION_NOT_FOUND", message: "Sesi tidak ditemukan" },
      },
      404,
    );
  }

  audit.log({
    event: "session_revoked",
    userId: c.var.userId,
    ip: getIp(c),
    metadata: { sessionId },
  });
  return c.json({ message: "Sesi berhasil dicabut" }, 200);
});

// ╔══════════════════════════════════════════════════════════════╗
// ║  GET /auth/verify-email?token=...                             ║
// ╚══════════════════════════════════════════════════════════════╝

const verifyEmailRoute = createRoute({
  method: "get",
  path: "/verify-email",
  tags: ["Authentication"],
  summary: "Verify Email",
  description:
    "Memverifikasi alamat email pengguna menggunakan token yang dikirim via email.",
  request: {
    query: z.object({
      token: z.string().min(1, "Token verifikasi wajib diisi").openapi({
        example: "abc123def456",
        description: "Token verifikasi yang didapat dari email",
      }),
    }),
  },
  responses: {
    200: {
      description: "Email berhasil diverifikasi",
      content: { "application/json": { schema: BasicMessageSchema } },
    },
    400: {
      description: "Token tidak valid atau missing",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

authRoutes.openapi(verifyEmailRoute, async (c) => {
  const { token } = c.req.valid("query");
  const { verificationService, audit } = makeServices(c);

  try {
    const result = await verificationService.verifyEmail(token);

    audit.log({
      event: "email_verified",
      userId: result.userId,
      ip: getIp(c),
      metadata: { email: result.email },
    });

    return c.json(
      {
        message: "Email berhasil diverifikasi. Silakan login.",
      },
      200,
    );
  } catch (err: any) {
    audit.log({
      event: "verification_failed",
      ip: getIp(c),
      metadata: { reason: err.code },
    });
    return errorResponse(c, err);
  }
});

// ╔══════════════════════════════════════════════════════════════╗
// ║  POST /auth/resend-verification                              ║
// ╚══════════════════════════════════════════════════════════════╝

const resendVerificationRoute = createRoute({
  method: "post",
  path: "/resend-verification",
  tags: ["Authentication"],
  summary: "Resend Verification",
  description:
    "Mengirim ulang email verifikasi jika belum kadaluarsa. Rate-limited.",
  request: {
    body: {
      content: { "application/json": { schema: resendVerificationSchema } },
    },
  },
  responses: {
    200: {
      description:
        "Email berhasil dikirim ulang (atau email sudah diverifikasi)",
      content: { "application/json": { schema: BasicMessageSchema } },
    },
    429: {
      description: "Too Many Requests",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    400: {
      description: "Validation Error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

authRoutes.openapi(resendVerificationRoute, async (c) => {
  const { email } = c.req.valid("json");
  const { verificationService, emailService, cacheService, audit } =
    makeServices(c);
  const ip = getIp(c);

  // Rate limit: max 3 resend per email per 15 menit
  const rateLimitKey = `resend-verify:${email}`;
  const attempts = await cacheService.getRateLimit(rateLimitKey);
  if (attempts >= 3) {
    return c.json(
      {
        error: {
          code: "RATE_LIMITED",
          message: "Terlalu banyak permintaan. Coba lagi dalam beberapa menit.",
        },
      },
      429,
    );
  }

  try {
    const { token, userId } =
      await verificationService.resendVerification(email);

    await cacheService.incrementRateLimit(rateLimitKey);

    // Kirim email (non-blocking)
    c.executionCtx.waitUntil(
      emailService
        .sendVerificationEmail(email, token)
        .then(() =>
          audit.log({
            event: "verification_sent",
            userId,
            ip,
            metadata: { email },
          }),
        )
        .catch((err: any) =>
          console.error("[resend-verification] Email send failed:", err),
        ),
    );

    return c.json(
      {
        message: "Email verifikasi dikirim ulang. Silakan cek inbox Anda.",
      },
      200,
    );
  } catch (err: any) {
    // Untuk keamanan: jika user tidak ditemukan / sudah verified,
    // tetap return 200 yang sama (mencegah email enumeration)
    if (err.code === "USER_NOT_FOUND" || err.code === "ALREADY_VERIFIED") {
      return c.json(
        {
          message: "Email verifikasi dikirim ulang. Silakan cek inbox Anda.",
        },
        200,
      );
    }
    return errorResponse(c, err);
  }
});

// ╔══════════════════════════════════════════════════════════════╗
// ║  GET /auth/google/login                                      ║
// ║  Web flow: redirect ke Google consent screen                 ║
// ╚══════════════════════════════════════════════════════════════╝

const googleLoginRoute = createRoute({
  method: "get",
  path: "/google/login",
  tags: ["Google OAuth"],
  summary: "Google Login Redirect",
  description: "Redirect pengguna ke halaman persetujuan Google (Web Flow).",
  request: {
    query: z.object({
      clientType: clientTypeSchema
        .optional()
        .openapi({ description: "Platform klien (web, mobile, desktop)" }),
      redirectUrl: z.string().url().optional().openapi({
        description: "URL frontend untuk redirect setelah login (Web Flow)",
      }),
    }),
  },
  responses: {
    302: {
      description: "Redirect ke halaman otorisasi Google",
    },
  },
});

authRoutes.openapi(googleLoginRoute, async (c) => {
  const querySchema = c.req.valid("query");
  const clientType = querySchema.clientType ?? "web";
  const redirectUrl = querySchema.redirectUrl;
  const { googleService, cacheService } = makeServices(c);

  // Generate CSRF state token dan simpan di KV (TTL 10 menit)
  const state = crypto.randomUUID();
  const statePayload = JSON.stringify({
    clientType,
    redirectUrl,
    ts: Date.now(),
  });
  await cacheService.setOAuthState(state, statePayload);

  // Redirect URI = URL callback endpoint kita
  const url = new URL(c.req.url);
  const redirectUri = `${url.origin}/auth/google/callback`;

  const authorizationUrl = googleService.getAuthorizationUrl(
    state,
    redirectUri,
  );

  return c.redirect(authorizationUrl, 302);
});

// ╔══════════════════════════════════════════════════════════════╗
// ║  GET /auth/google/callback                                   ║
// ║  Web flow: handle redirect dari Google                       ║
// ╚══════════════════════════════════════════════════════════════╝

const googleCallbackRoute = createRoute({
  method: "get",
  path: "/google/callback",
  tags: ["Google OAuth"],
  summary: "Google Callback",
  description:
    "Menangani redirect setelah pengguna login via Google (Web Flow).",
  request: {
    query: z.object({
      code: z
        .string()
        .optional()
        .openapi({ description: "Otorisasi code dari Google" }),
      state: z.string().optional().openapi({ description: "CSRF state token" }),
      error: z
        .string()
        .optional()
        .openapi({ description: "Pesan error jika user menolak" }),
    }),
  },
  responses: {
    200: {
      description: "Login via Google berhasil",
      content: {
        "application/json": {
          schema: TokenResponseSchema.extend({
            message: z
              .string()
              .openapi({ example: "Login via Google berhasil" }),
            isNewUser: z.boolean().openapi({
              description: "Benar jika ini adalah register pertama kalinya",
            }),
            linked: z.boolean().openapi({
              description:
                "Benar jika akun Google ditautkan ke akun email/password yang sudah ada",
            }),
          }),
        },
      },
    },
    302: {
      description: "Redirect ke frontend setelah login berhasil (Web Flow)",
    },
    400: {
      description: "Bad Request (Akses Ditolak, Missing Params, Invalid State)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

authRoutes.openapi(googleCallbackRoute, async (c) => {
  const { code, state, error } = c.req.valid("query");
  const ip = getIp(c);

  const { googleService, cacheService, audit } = makeServices(c);

  // Google mengirim error jika user menolak consent
  if (error) {
    audit.log({
      event: "google_login_failed",
      ip,
      metadata: { reason: error },
    });
    return c.json(
      {
        error: {
          code: "GOOGLE_AUTH_DENIED",
          message: "Akses Google ditolak oleh user",
        },
      },
      400,
    );
  }

  if (!code || !state) {
    return c.json(
      {
        error: {
          code: "MISSING_PARAMS",
          message: "Parameter code dan state wajib ada",
        },
      },
      400,
    );
  }

  // Validasi state dari KV (anti-CSRF), one-time use
  const stateData = await cacheService.getOAuthState(state);
  if (!stateData) {
    audit.log({
      event: "google_login_failed",
      ip,
      metadata: { reason: "INVALID_STATE" },
    });
    return c.json(
      {
        error: {
          code: "INVALID_STATE",
          message: "State tidak valid atau sudah expired",
        },
      },
      400,
    );
  }

  // Hapus state setelah dipakai (one-time use)
  await cacheService.deleteOAuthState(state);

  const parsed = JSON.parse(stateData) as {
    clientType: string;
    redirectUrl?: string;
    ts: number;
  };
  const clientType =
    clientTypeSchema.safeParse(parsed.clientType).data ?? "web";
  const ua = c.req.header("User-Agent") ?? "";

  try {
    // Tukar authorization code → access token
    const url = new URL(c.req.url);
    const redirectUri = `${url.origin}/auth/google/callback`;
    const tokenResponse = await googleService.exchangeCode(code, redirectUri);

    // Ambil profil user dari Google
    const googleUser = await googleService.getUserInfo(
      tokenResponse.access_token,
    );

    // Account linking logic
    const result = await googleService.handleGoogleLogin(
      googleUser,
      clientType,
      { ua, ip },
    );

    // Audit logging
    if (result.isNewUser) {
      audit.log({
        event: "google_register",
        ip,
        metadata: { email: googleUser.email },
      });
    } else if (result.linked) {
      audit.log({
        event: "google_account_linked",
        ip,
        metadata: { email: googleUser.email },
      });
    } else {
      audit.log({
        event: "google_login",
        ip,
        metadata: { email: googleUser.email },
      });
    }

    // Jika client web app meminta redirect, kembalikan parameter via redirect (untuk frontend callback)
    if (parsed.redirectUrl) {
      const targetUrl = new URL(parsed.redirectUrl);
      targetUrl.searchParams.set("accessToken", result.accessToken);
      targetUrl.searchParams.set("refreshToken", result.refreshToken);
      targetUrl.searchParams.set("expiresIn", result.expiresIn.toString());
      targetUrl.searchParams.set("isNewUser", result.isNewUser.toString());
      targetUrl.searchParams.set("linked", result.linked.toString());

      return c.redirect(targetUrl.toString(), 302);
    }

    // Return JSON response dengan token (untuk client mobile/desktop)
    return c.json(
      {
        message: "Login via Google berhasil",
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresIn: result.expiresIn,
        tokenType: "Bearer",
        isNewUser: result.isNewUser,
        linked: result.linked,
      },
      200,
    );
  } catch (err: any) {
    audit.log({
      event: "google_login_failed",
      ip,
      metadata: { reason: err.code ?? err.message },
    });
    return errorResponse(c, err);
  }
});

// ╔══════════════════════════════════════════════════════════════╗
// ║  POST /auth/google/token                                     ║
// ║  Mobile flow: verify Google ID token dari Sign-In SDK        ║
// ╚══════════════════════════════════════════════════════════════╝

const googleTokenRoute = createRoute({
  method: "post",
  path: "/google/token",
  tags: ["Google OAuth"],
  summary: "Google SDK ID Token Validation",
  description:
    "Memverifikasi token Google OAuth secara independen dari SDK Native (Mobile Flow).",
  request: {
    body: {
      content: { "application/json": { schema: googleTokenSchema } },
    },
  },
  responses: {
    200: {
      description: "Login via Google ID Token berhasil",
      content: {
        "application/json": {
          schema: TokenResponseSchema.extend({
            message: z
              .string()
              .openapi({ example: "Login via Google ID Token berhasil" }),
            isNewUser: z.boolean().openapi({
              description: "Benar jika ini adalah register pertama kalinya",
            }),
            linked: z.boolean().openapi({
              description:
                "Benar jika akun Google ditautkan ke akun yang sudah ada",
            }),
          }),
        },
      },
    },
    400: {
      description: "Bad Request (Token tidak valid)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    429: {
      description: "Too Many Requests (Rate Limited)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

authRoutes.openapi(googleTokenRoute, async (c) => {
  const { idToken, clientType } = c.req.valid("json");
  const { googleService, cacheService, audit } = makeServices(c);
  const ip = getIp(c);
  const ua = c.req.header("User-Agent") ?? "";

  // Rate limit: sama seperti login biasa
  const rateLimitKey = `google-token:${ip}`;
  const attempts = await cacheService.getRateLimit(rateLimitKey);
  if (attempts >= RATE_LIMIT_MAX) {
    audit.log({
      event: "rate_limit_hit",
      ip,
      metadata: { endpoint: "google/token" },
    });
    return c.json(
      {
        error: {
          code: "RATE_LIMITED",
          message: "Terlalu banyak percobaan. Coba lagi dalam 5 menit.",
        },
      },
      429,
    );
  }

  try {
    // Verify ID token via Google tokeninfo endpoint
    const googleUser = await googleService.verifyIdToken(idToken);

    // Account linking logic (sama untuk web & mobile)
    const result = await googleService.handleGoogleLogin(
      googleUser,
      clientType,
      { ua, ip },
    );

    // Audit logging
    if (result.isNewUser) {
      audit.log({
        event: "google_register",
        ip,
        metadata: { email: googleUser.email, flow: "mobile" },
      });
    } else if (result.linked) {
      audit.log({
        event: "google_account_linked",
        ip,
        metadata: { email: googleUser.email, flow: "mobile" },
      });
    } else {
      audit.log({
        event: "google_login",
        ip,
        metadata: { email: googleUser.email, flow: "mobile" },
      });
    }

    return c.json(
      {
        message: "Login via Google ID Token berhasil",
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresIn: result.expiresIn,
        tokenType: "Bearer",
        isNewUser: result.isNewUser,
        linked: result.linked,
      },
      200,
    );
  } catch (err: any) {
    await cacheService.incrementRateLimit(rateLimitKey);
    audit.log({
      event: "google_login_failed",
      ip,
      metadata: { reason: err.code ?? err.message, flow: "mobile" },
    });
    return errorResponse(c, err);
  }
});

// ╔══════════════════════════════════════════════════════════════╗
// ║  POST /auth/forgot-password                                  ║
// ║  Rate-limited per email via Cache API                        ║
// ╚══════════════════════════════════════════════════════════════╝

const forgotPasswordRoute = createRoute({
  method: "post",
  path: "/forgot-password",
  tags: ["Authentication"],
  summary: "Forgot Password",
  description: "Meminta link reset password dikirimkan ke email",
  request: {
    body: {
      content: { "application/json": { schema: forgotPasswordSchema } },
    },
  },
  responses: {
    200: {
      description: "Permintaan reset password diterima",
      content: { "application/json": { schema: BasicMessageSchema } },
    },
    429: {
      description: "Too Many Requests",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    400: {
      description: "Validation Error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

authRoutes.openapi(forgotPasswordRoute, async (c) => {
  const { email } = c.req.valid("json");
  const { passwordResetService, emailService, cacheService, audit } =
    makeServices(c);
  const ip = getIp(c);

  // Rate limit: max 3 request per email per 15 menit
  const rateLimitKey = `forgot-password:${email}`;
  const attempts = await cacheService.getRateLimit(rateLimitKey);
  if (attempts >= FORGOT_PASSWORD_RATE_LIMIT_MAX) {
    return c.json(
      {
        error: {
          code: "RATE_LIMITED",
          message:
            "Terlalu banyak permintaan reset password. Coba lagi dalam 15 menit.",
        },
      },
      429,
    );
  }

  // Selalu increment rate limit (bahkan jika email tidak ditemukan)
  await cacheService.incrementRateLimit(rateLimitKey);

  // Cari user — jika tidak ditemukan, tetap return 200 (anti email enumeration)
  const userId = await passwordResetService.findUserByEmail(email);

  if (userId) {
    try {
      const token = await passwordResetService.createResetToken(userId);

      // Kirim email non-blocking
      c.executionCtx.waitUntil(
        emailService
          .sendForgotPasswordEmail(email, token)
          .then(() =>
            audit.log({
              event: "forgot_password_requested",
              userId,
              ip,
              metadata: { email },
            }),
          )
          .catch((err: any) =>
            console.error("[forgot-password] Email send failed:", err),
          ),
      );
    } catch (err: any) {
      console.error("[forgot-password] Error creating reset token:", err);
    }
  }

  // Selalu return 200 — user tidak boleh tahu apakah email terdaftar atau tidak
  return c.json(
    {
      message: "Jika email terdaftar, link reset password akan dikirim.",
    },
    200,
  );
});

// ╔══════════════════════════════════════════════════════════════╗
// ║  POST /auth/reset-password                                   ║
// ║  Verify token → update password → revoke sessions            ║
// ╚══════════════════════════════════════════════════════════════╝

const resetPasswordRoute = createRoute({
  method: "post",
  path: "/reset-password",
  tags: ["Authentication"],
  summary: "Reset Password",
  description:
    "Mengganti password menggunakan token reset password yang dikirim via email",
  request: {
    body: {
      content: { "application/json": { schema: resetPasswordSchema } },
    },
  },
  responses: {
    200: {
      description: "Password berhasil direset",
      content: { "application/json": { schema: BasicMessageSchema } },
    },
    400: {
      description: "Bad Request (Token tidak valid/Expired)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

authRoutes.openapi(resetPasswordRoute, async (c) => {
  const { token, newPassword } = c.req.valid("json");
  const { passwordResetService, audit } = makeServices(c);
  const ip = getIp(c);

  try {
    const result = await passwordResetService.resetPassword(token, newPassword);

    audit.log({
      event: "password_reset_success",
      userId: result.userId,
      ip,
      metadata: { email: result.email },
    });

    return c.json(
      {
        message:
          "Password berhasil direset. Silakan login dengan password baru.",
      },
      200,
    );
  } catch (err: any) {
    return errorResponse(c, err);
  }
});
