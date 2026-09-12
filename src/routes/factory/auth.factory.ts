// src/routes/factory/auth.factory.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { sign, verify } from "hono/jwt";
import type { Context } from "hono";
import { CacheService } from "../../services/cache.service";
import { AuthService } from "../../services/auth.service";
import { RegisterService } from "../../services/register.service";
import { AuditService } from "../../services/audit.service";
import { EmailService } from "../../services/email.service";
import { VerificationService } from "../../services/verification.service";
import { PasswordResetService } from "../../services/password-reset.service";
import { GoogleOAuthService } from "../../services/google.service";
import { ImageFilterService } from "../../utils/image-filter";
import { authMiddleware } from "../../middleware/auth.middleware";
import {
  TOKEN_POLICY,
  RATE_LIMIT_MAX,
  FORGOT_PASSWORD_RATE_LIMIT_MAX,
  FORGOT_PASSWORD_RATE_LIMIT_WINDOW,
  OTP_VERIFY_RATE_LIMIT_MAX,
  OTP_VERIFY_RATE_LIMIT_WINDOW,
} from "../../config/token.config";
import {
  registerSchema,
  loginSchema,
  refreshSchema,
  logoutSchema,
  resendVerificationSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  googleTokenSchema,
  clientTypeSchema,
  verifyEmailSchema,
  verifyEmailCodeSchema,
  createHandoffTokenSchema,
  exchangeHandoffTokenSchema,
} from "../../utils/validation";
import {
  ErrorResponseSchema,
  TokenResponseSchema,
  BasicMessageSchema,
  HandoffTokenResponseSchema,
  ExchangeHandoffResponseSchema,
} from "../../utils/openapi-schemas";
import type { SharedAuthBindings, JWTAccessPayload } from "../../types/index";
import type { AuthDbDialect } from "../../db/adapter";
import {
  type AppContext,
  isAllowedRedirectUrl,
  getIp,
  errorResponse,
} from "./shared";
import { generateCodeVerifier, generateCodeChallenge } from "../../utils/pkce";

/**
 * Mendapatkan konfigurasi cookie refresh_token yang adaptif dan sepenuhnya universal.
 * - Mengambil konfigurasi dari environment c.env (COOKIE_DOMAIN, COOKIE_SAME_SITE, COOKIE_SECURE).
 * - Jika COOKIE_DOMAIN dikonfigurasi (misal di production: ".example.com"):
 *   Menggunakan domain tersebut dengan SameSite="Lax" (atau sesuai COOKIE_SAME_SITE).
 * - Jika COOKIE_DOMAIN tidak dikonfigurasi (misal di dev / staging / localhost):
 *   Tanpa atribut domain dan SameSite="None" (atau sesuai COOKIE_SAME_SITE).
 * Bebas dari hardcode domain proyek tertentu agar paket tetap reusable secara universal.
 */
export function getAuthCookieOptions(
  c: any,
  maxAge?: number,
): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Lax" | "Strict" | "None";
  path: string;
  domain?: string;
  maxAge?: number;
} {
  const rawDomain = c.env?.COOKIE_DOMAIN;
  const cookieDomain = typeof rawDomain === "string" && rawDomain.trim().length > 0 ? rawDomain.trim() : undefined;
  const configuredSameSite = c.env?.COOKIE_SAME_SITE as "Lax" | "Strict" | "None" | undefined;
  const secure = c.env?.COOKIE_SECURE === false || c.env?.COOKIE_SECURE === "false" ? false : true;

  if (cookieDomain) {
    return {
      httpOnly: true,
      secure,
      sameSite: configuredSameSite || "Lax",
      path: "/",
      domain: cookieDomain,
      ...(maxAge !== undefined ? { maxAge } : {}),
    };
  }

  return {
    httpOnly: true,
    secure,
    sameSite: configuredSameSite || "None",
    path: "/",
    ...(maxAge !== undefined ? { maxAge } : {}),
  };
}

/**
 * Mendapatkan nama cookie refresh token (default: "refresh_token", dapat di-override via COOKIE_NAME).
 */
export function getAuthCookieName(c: any): string {
  const custom = c.env?.COOKIE_NAME;
  return typeof custom === "string" && custom.trim().length > 0
    ? custom.trim()
    : "refresh_token";
}

/**
 * Menghapus cookie autentikasi secara bersih di semua kemungkinan scope (domain dan host-only).
 */
export function clearAuthCookies(c: any) {
  const opts = getAuthCookieOptions(c);
  const cookieName = getAuthCookieName(c);

  if (opts.domain) {
    deleteCookie(c, cookieName, { path: "/", domain: opts.domain });
    deleteCookie(c, cookieName, { path: "/auth", domain: opts.domain });
    if (cookieName !== "refresh_token") {
      deleteCookie(c, "refresh_token", { path: "/", domain: opts.domain });
      deleteCookie(c, "refresh_token", { path: "/auth", domain: opts.domain });
    }
  }
  deleteCookie(c, cookieName, { path: "/" });
  deleteCookie(c, cookieName, { path: "/auth" });
  if (cookieName !== "refresh_token") {
    deleteCookie(c, "refresh_token", { path: "/" });
    deleteCookie(c, "refresh_token", { path: "/auth" });
  }
}


function handleRateLimit(c: any, rl: { count: number, resetAt: number }, max: number, msg: string) {
  if (rl.count >= max) {
    const retryAfter = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
    c.header("Retry-After", String(retryAfter));
    return c.json({
      error: { code: "RATE_LIMITED", message: msg, remainingAttempts: 0, retryAfterSeconds: retryAfter }
    }, 429);
  }
  return null;
}

function makeServices(c: AppContext, dialect: AuthDbDialect) {
  const db = c.var.db;
  let cacheService: CacheService | undefined;
  let authService: AuthService | undefined;
  let audit: AuditService | undefined;
  let emailService: EmailService | undefined;
  let verificationService: VerificationService | undefined;
  let passwordResetService: PasswordResetService | undefined;
  let imageFilter: ImageFilterService | undefined;
  let googleService: GoogleOAuthService | undefined;

  return {
    get db() {
      return db;
    },
    get cacheService() {
      if (!cacheService) cacheService = new CacheService(c.env.KV, caches.default);
      return cacheService;
    },
    get authService() {
      if (!authService) {
        const grace = c.env?.REFRESH_TOKEN_GRACE_PERIOD_SECONDS !== undefined
          ? Number(c.env.REFRESH_TOKEN_GRACE_PERIOD_SECONDS)
          : undefined;
        authService = new AuthService(
          db,
          this.cacheService,
          c.env.JWT_SECRET,
          c.env.JWT_REFRESH_SECRET,
          dialect,
          grace,
        );
      }
      return authService;
    },
    get audit() {
      if (!audit) audit = new AuditService(c.env.ANALYTICS);
      return audit;
    },
    get emailService() {
      if (!emailService) {
        const emailFrom =
          c.var.emailConfig?.from ??
          c.env.EMAIL_FROM ??
          "No-Reply <noreply@example.com>";
        emailService = new EmailService(
          c.env.RESEND_API_KEY,
          c.env.APP_URL,
          emailFrom,
          c.var.emailConfig?.templates,
          c.var.emailConfig?.resetPasswordBaseUrl,
        );
      }
      return emailService;
    },
    get verificationService() {
      if (!verificationService) verificationService = new VerificationService(db, dialect);
      return verificationService;
    },
    get passwordResetService() {
      if (!passwordResetService) passwordResetService = new PasswordResetService(db, dialect);
      return passwordResetService;
    },
    get imageFilter() {
      if (!imageFilter) imageFilter = new ImageFilterService(c.env.AI, c.var.imageFilterConfig);
      return imageFilter;
    },
    get googleService() {
      if (!googleService) {
        googleService = new GoogleOAuthService(
          db,
          this.authService,
          this.imageFilter,
          c.env.GOOGLE_CLIENT_ID,
          c.env.GOOGLE_CLIENT_SECRET,
          c.env.BUCKET_PUBLIC_URL,
          c.env.GOOGLE_ALLOWED_CLIENT_IDS,
          dialect,
        );
      }
      return googleService;
    },
  };
}

export function createAuthRoutes<
  TBindings extends SharedAuthBindings = any,
  TVariables extends Record<string, any> = any,
>(dialect: AuthDbDialect = "pg") {
  const authRoutes = new OpenAPIHono<{
    Bindings: TBindings;
    Variables: TVariables;
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

  authRoutes.use("/logout", authMiddleware as any);
  authRoutes.use("/logout-all", authMiddleware as any);
  authRoutes.use("/sessions", authMiddleware as any);
  authRoutes.use("/sessions/*", authMiddleware as any);
  authRoutes.use("/handoff/token", authMiddleware as any);
  authRoutes.use("/handoff-token", authMiddleware as any);

  // ── Register ─────────────────────────────────────────────────────────────
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
              data: z.object({
                message: z.string(),
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

  authRoutes.openapi(registerRoute, async (c: any) => {
    const validated = c.req.valid("json");
    const { db, audit, emailService, verificationService, cacheService } = makeServices(c, dialect);
    const verificationMethod = c.var.emailConfig?.verificationMethod ?? "link";
    const ip = getIp(c);
    
    const rl = await cacheService.getRateLimit(`register:${ip}`);
    const limitRes = handleRateLimit(c, rl, 5, "Terlalu banyak percobaan registrasi. Coba lagi dalam beberapa saat.");
    if (limitRes) {
      audit.log({ event: "rate_limit_hit", ip, metadata: { endpoint: "register" } });
      return limitRes;
    }

    try {
      await cacheService.incrementRateLimit(`register:${ip}`, 60 * 5); // 5 menit
      const registerService = new RegisterService(db, dialect);
      const user = await registerService.register(validated);

      try {
        const ttl = c.var.emailConfig?.verificationCodeTtlMinutes;
        if (verificationMethod === "code") {
          const code = await verificationService.createVerificationCode(user.id, ttl);
          await emailService.sendVerificationCodeEmail(user.email, code);
        } else {
          const token = await verificationService.createVerificationToken(user.id);
          await emailService.sendVerificationEmail(user.email, token);
        }
        audit.log({
          event: "verification_sent",
          userId: user.id,
          ip: getIp(c),
          metadata: { email: user.email, method: verificationMethod },
        });
      } catch (err: any) {
        console.error("[register] Failed to send verification email:", err);
      }

      audit.log({ event: "register", userId: user.id, ip: getIp(c) });

      return c.json(
        {
          data: {
            message: "Registrasi berhasil. Silakan cek email untuk verifikasi.",
          },
        },
        201,
      );
    } catch (err: any) {
      return errorResponse(c, err);
    }
  });

  // ── Login ────────────────────────────────────────────────────────────────
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

  authRoutes.openapi(loginRoute, async (c: any) => {
    const { email, password, clientType } = c.req.valid("json");
    const { authService, cacheService, audit } = makeServices(c, dialect);
    const ip = getIp(c);
    const ua = c.req.header("User-Agent") ?? "";

    const rl = await cacheService.getRateLimit(ip);
    const limitRes = handleRateLimit(c, rl, RATE_LIMIT_MAX, "Terlalu banyak percobaan login. Coba lagi dalam beberapa saat.");
    if (limitRes) {
      audit.log({ event: "rate_limit_hit", ip, metadata: { email } });
      return limitRes;
    }

    try {
      const tokens = await authService.login(email, password, clientType, {
        ua,
        ip,
      });

      await cacheService.clearRateLimit(ip);
      audit.log({ event: "login_success", clientType, ip, metadata: { email } });

      if (clientType === "web") {
        const policy = TOKEN_POLICY.web;
        const cookieOpts = getAuthCookieOptions(c, policy.refreshToken.expiresInSeconds);
        const cookieName = getAuthCookieName(c);
        setCookie(c, cookieName, tokens.refreshToken, cookieOpts);
      }

      return c.json(
        {
          data: {
            message: "Login berhasil",
            accessToken: tokens.accessToken,
            ...(clientType !== "web" ? { refreshToken: tokens.refreshToken } : {}),
            expiresIn: tokens.expiresIn,
            tokenType: "Bearer",
          },
        },
        200,
      );
    } catch (err: any) {
      if (err.status === 401 || err.code === "INVALID_CREDENTIALS") {
        const result = await cacheService.incrementRateLimit(ip);
        audit.log({ event: "login_failed", ip, metadata: { email } });
        return c.json({
          error: {
             code: err.code || "INVALID_CREDENTIALS",
             message: err.message,
             remainingAttempts: Math.max(0, RATE_LIMIT_MAX - result.count)
          }
        }, err.status || 401);
      }
      return errorResponse(c, err);
    }
  });

  // ── Refresh ──────────────────────────────────────────────────────────────
  const refreshRoute = createRoute({
    method: "post",
    path: "/refresh",
    tags: ["Authentication"],
    summary: "Refresh Token",
    description: "Mendapatkan JWT Akses baru menggunakan Refresh Token yang valid",
    request: {
      body: {
        content: { "application/json": { schema: refreshSchema } },
        required: false,
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

  authRoutes.openapi(refreshRoute, async (c: any) => {
    let { refreshToken } = c.req.valid("json") || {};
    let fromCookie = false;
    const cookieName = getAuthCookieName(c);
    if (!refreshToken) {
      refreshToken = getCookie(c, cookieName) || (cookieName !== "refresh_token" ? getCookie(c, "refresh_token") : undefined);
      if (refreshToken) fromCookie = true;
    }
    if (!refreshToken) {
      return c.json(
        { error: { code: "UNAUTHORIZED", message: "Refresh token wajib diisi" } },
        401
      );
    }
    const { authService, cacheService, audit } = makeServices(c, dialect);
    const ip = getIp(c);

    const rateLimitKey = `refresh:${ip}`;
    const rl = await cacheService.getRateLimit(rateLimitKey);
    const limitRes = handleRateLimit(c, rl, RATE_LIMIT_MAX, "Terlalu banyak percobaan. Coba lagi dalam beberapa saat.");
    if (limitRes) {
      audit.log({ event: "rate_limit_hit", ip, metadata: { endpoint: "refresh" } });
      return limitRes;
    }

    try {
      const tokens = await authService.rotateRefreshToken(refreshToken);
      audit.log({ event: "token_refresh", ip });

      let returnRefreshToken = tokens.refreshToken;

      // Jika dari awal dikirim via cookie, asumsikan web client dan set via cookie
      if (fromCookie) {
        const cookieOpts = getAuthCookieOptions(c, 30 * 24 * 60 * 60);
        setCookie(c, cookieName, tokens.refreshToken, cookieOpts);
        returnRefreshToken = undefined;
      }

      return c.json(
        {
          data: {
            message: "Token berhasil diperbarui",
            accessToken: tokens.accessToken,
            ...(returnRefreshToken ? { refreshToken: returnRefreshToken } : {}),
            expiresIn: tokens.expiresIn,
            tokenType: "Bearer",
          },
        },
        200,
      );
    } catch (err: any) {
      await cacheService.incrementRateLimit(rateLimitKey);
      if (err.code === "TOKEN_REUSE_DETECTED") {
        audit.log({ event: "token_reuse_detected", ip });
      }
      return errorResponse(c, err);
    }
  });

  // ── Logout ───────────────────────────────────────────────────────────────
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
        required: false,
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

  authRoutes.openapi(logoutRoute, async (c: any) => {
    let { refreshToken } = c.req.valid("json") || {};
    if (!refreshToken) {
      const cookieName = getAuthCookieName(c);
      refreshToken = getCookie(c, cookieName) || (cookieName !== "refresh_token" ? getCookie(c, "refresh_token") : undefined);
    }
    const { authService, audit } = makeServices(c, dialect);

    const exp = c.var.exp ?? Math.floor(Date.now() / 1000) + 900;
    await authService.logout(c.var.jti, exp, refreshToken);
    audit.log({
      event: "logout",
      userId: c.var.userId,
      clientType: c.var.clientType,
      ip: getIp(c),
    });
    
    clearAuthCookies(c);

    return c.json({ data: { message: "Logout berhasil" } }, 200);
  });

  // ── Logout All ───────────────────────────────────────────────────────────
  const logoutAllRoute = createRoute({
    method: "post",
    path: "/logout-all",
    tags: ["Authentication"],
    summary: "Logout All Sessions",
    description: "Mencabut semua sesi / refresh token pengguna di semua perangkat",
    security: [{ Bearer: [] }],
    responses: {
      200: {
        description: "Logout semua sesi berhasil",
        content: { "application/json": { schema: BasicMessageSchema } },
      },
    },
  });

  authRoutes.openapi(logoutAllRoute, async (c: any) => {
    const { authService, audit } = makeServices(c, dialect);

    await authService.logoutAll(c.var.userId);
    audit.log({ event: "logout_all", userId: c.var.userId, ip: getIp(c) });
    
    clearAuthCookies(c);

    return c.json({ data: { message: "Semua sesi berhasil dicabut" } }, 200);
  });

  // ── Sessions ─────────────────────────────────────────────────────────────
  const getSessionsRoute = createRoute({
    method: "get",
    path: "/sessions",
    tags: ["Session Management"],
    summary: "Get Active Sessions",
    description: "Menampilkan daftar semua sesi perangkat (refresh token) yang aktif saat ini",
    security: [{ Bearer: [] }],
    request: {
      query: z.object({}),
    },
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
                  isCurrent: z.boolean().default(false),
                }),
              ),
            }),
          },
        },
      },
    },
  });

  authRoutes.openapi(getSessionsRoute, async (c: any) => {
    const { authService } = makeServices(c, dialect);
    const sessions = await authService.getSessions(c.var.userId);

    const formatted = sessions.map((s: any) => ({
      ...s,
      createdAt: s.createdAt ? (s.createdAt instanceof Date ? s.createdAt.toISOString() : new Date(s.createdAt).toISOString()) : null,
      expiresAt: s.expiresAt instanceof Date ? s.expiresAt.toISOString() : new Date(s.expiresAt).toISOString(),
      lastUsedAt: s.lastUsedAt ? (s.lastUsedAt instanceof Date ? s.lastUsedAt.toISOString() : new Date(s.lastUsedAt).toISOString()) : null,
    }));

    return c.json({ data: formatted }, 200);
  });

  // ── Delete Session ───────────────────────────────────────────────────────
  const deleteSessionRoute = createRoute({
    method: "delete",
    path: "/sessions/{id}",
    tags: ["Session Management"],
    summary: "Revoke Specific Session",
    description: "Mencabut sesi (refresh token) dari ID tertentu",
    security: [{ Bearer: [] }],
    request: {
      params: z.object({
        id: z.string().openapi({
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

  authRoutes.openapi(deleteSessionRoute, async (c: any) => {
    const { id: sessionId } = c.req.valid("param");
    const { authService, audit } = makeServices(c, dialect);

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
    return c.json({ data: { message: "Sesi berhasil dicabut" } }, 200);
  });

  // ── Verify Email (Link) ──────────────────────────────────────────────────
  const verifyEmailRoute = createRoute({
    method: "get",
    path: "/verify-email",
    tags: ["Authentication"],
    summary: "Verify Email",
    description: "Memverifikasi alamat email pengguna menggunakan token yang dikirim via email.",
    request: {
      query: verifyEmailSchema,
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

  authRoutes.openapi(verifyEmailRoute, async (c: any) => {
    const { token } = c.req.valid("query");
    const { verificationService, audit } = makeServices(c, dialect);

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
          data: {
            message: "Email berhasil diverifikasi. Silakan login.",
          },
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

  // ── Resend Verification ──────────────────────────────────────────────────
  const resendVerificationRoute = createRoute({
    method: "post",
    path: "/resend-verification",
    tags: ["Authentication"],
    summary: "Resend Verification",
    description: "Mengirim ulang email verifikasi jika belum kadaluarsa. Rate-limited.",
    request: {
      body: {
        content: { "application/json": { schema: resendVerificationSchema } },
      },
    },
    responses: {
      200: {
        description: "Email berhasil dikirim ulang (atau email sudah diverifikasi)",
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

  authRoutes.openapi(resendVerificationRoute, async (c: any) => {
    const { email } = c.req.valid("json");
    const { verificationService, emailService, cacheService, audit } =
      makeServices(c, dialect);
    const ip = getIp(c);
    const verificationMethod = c.var.emailConfig?.verificationMethod ?? "link";

    const rateLimitKey = `resend-verify:${email}`;
    const rl = await cacheService.getRateLimit(rateLimitKey);
    const limitRes = handleRateLimit(c, rl, 3, "Terlalu banyak permintaan. Coba lagi dalam beberapa saat.");
    if (limitRes) return limitRes;

    try {
      const ttl = c.var.emailConfig?.verificationCodeTtlMinutes;
      if (verificationMethod === "code") {
        const { code, userId } =
          await verificationService.resendVerificationCode(email, ttl);

        await cacheService.incrementRateLimit(rateLimitKey);

        c.executionCtx.waitUntil(
          emailService
            .sendVerificationCodeEmail(email, code)
            .then(() =>
              audit.log({
                event: "verification_sent",
                userId,
                ip,
                metadata: { email, method: "code" },
              }),
            )
            .catch((err: any) =>
              console.error("[resend-verification] Code email send failed:", err),
            ),
        );
      } else {
        const { token, userId } =
          await verificationService.resendVerification(email);

        await cacheService.incrementRateLimit(rateLimitKey);

        c.executionCtx.waitUntil(
          emailService
            .sendVerificationEmail(email, token)
            .then(() =>
              audit.log({
                event: "verification_sent",
                userId,
                ip,
                metadata: { email, method: "link" },
              }),
            )
            .catch((err: any) =>
              console.error("[resend-verification] Link email send failed:", err),
            ),
        );
      }

      return c.json(
        {
          data: {
            message: "Email verifikasi dikirim ulang. Silakan cek inbox Anda.",
          },
        },
        200,
      );
    } catch (err: any) {
      if (err.code === "USER_NOT_FOUND" || err.code === "ALREADY_VERIFIED") {
        return c.json(
          {
            data: {
              message: "Email verifikasi dikirim ulang. Silakan cek inbox Anda.",
            },
          },
          200,
        );
      }
      return errorResponse(c, err);
    }
  });

  // ── Verify Email Code (OTP) ──────────────────────────────────────────────
  const verifyEmailCodeRoute = createRoute({
    method: "post",
    path: "/verify-email-code",
    tags: ["Authentication"],
    summary: "Verify Email via OTP Code",
    description: "Memverifikasi email menggunakan kode OTP 6-digit yang dikirim via email (Code Flow).",
    request: {
      body: {
        content: { "application/json": { schema: verifyEmailCodeSchema } },
      },
    },
    responses: {
      200: {
        description: "Email berhasil diverifikasi",
        content: { "application/json": { schema: BasicMessageSchema } },
      },
      400: {
        description: "Kode tidak valid, sudah dipakai, atau sudah expired",
        content: { "application/json": { schema: ErrorResponseSchema } },
      },
      401: {
        description: "Email atau kode tidak dikenali",
        content: { "application/json": { schema: ErrorResponseSchema } },
      },
      429: {
        description: "Too Many Requests (Rate Limited)",
        content: { "application/json": { schema: ErrorResponseSchema } },
      },
    },
  });

  authRoutes.openapi(verifyEmailCodeRoute, async (c: any) => {
    const { email, code } = c.req.valid("json");
    const { verificationService, cacheService, audit } = makeServices(c, dialect);
    const ip = getIp(c);

    const rateLimitKey = `verify-otp:${email}`;
    const rl = await cacheService.getRateLimit(rateLimitKey);
    const limitRes = handleRateLimit(c, rl, OTP_VERIFY_RATE_LIMIT_MAX, "Terlalu banyak percobaan verifikasi kode. Coba lagi dalam beberapa saat.");
    if (limitRes) {
      audit.log({ event: "rate_limit_hit", ip, metadata: { email, endpoint: "verify-email-code" } });
      return limitRes;
    }

    // Increment SEBELUM verifikasi untuk mencegah race condition akibat concurrent requests.
    // Jika sukses, counter akan di-clear. Jika gagal, counter tetap naik.
    const newRl = await cacheService.incrementRateLimit(rateLimitKey, OTP_VERIFY_RATE_LIMIT_WINDOW);

    try {
      const result = await verificationService.verifyEmailCode(email, code);
      await cacheService.clearRateLimit(rateLimitKey);

      audit.log({
        event: "email_verified",
        userId: result.userId,
        ip,
        metadata: { email: result.email, method: "code" },
      });

      return c.json(
        {
          data: {
            message: "Email berhasil diverifikasi. Silakan login.",
          },
        },
        200,
      );
    } catch (err: any) {
      audit.log({
        event: "verification_failed",
        ip,
        metadata: { reason: err.code, method: "code" },
      });
      const remaining = Math.max(0, OTP_VERIFY_RATE_LIMIT_MAX - newRl.count);
      const retryAfterSeconds = newRl.count >= OTP_VERIFY_RATE_LIMIT_MAX
        ? Math.max(1, Math.ceil((newRl.resetAt - Date.now()) / 1000))
        : undefined;
      return c.json({
        error: {
          code: err.code || "VERIFICATION_FAILED",
          message: err.message || "Kode verifikasi tidak valid.",
          remainingAttempts: remaining,
          ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
        }
      }, err.status || 400);
    }
  });


  // ── Google Login ─────────────────────────────────────────────────────────
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
        state: z.string().optional().openapi({
          description: "CSRF state token dari frontend",
        }),
      }),
    },
    responses: {
      302: {
        description: "Redirect ke halaman otorisasi Google",
      },
    },
  });

  authRoutes.openapi(googleLoginRoute, async (c: any) => {
    const querySchema = c.req.valid("query");
    const clientType = querySchema.clientType ?? "web";
    let redirectUrl = querySchema.redirectUrl;

    if (redirectUrl && !isAllowedRedirectUrl(redirectUrl, c.env)) {
      console.warn(`[google-oauth] Untrusted redirectUrl rejected: ${redirectUrl}`);
      redirectUrl = undefined;
    }

    const { googleService, cacheService } = makeServices(c, dialect);
    const state = querySchema.state || crypto.randomUUID();

    // PKCE (RFC 7636): Generate code_verifier dan code_challenge (S256)
    const codeVerifier = generateCodeVerifier(64);
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    const statePayload = JSON.stringify({
      clientType,
      redirectUrl,
      codeVerifier,
      ts: Date.now(),
    });
    await cacheService.setOAuthState(state, statePayload);

    // Optimasi zero-KV: Simpan state dan PKCE verifier di signed HttpOnly cookie (Lax)
    if (c.env?.JWT_SECRET) {
      try {
        const oauthSessionToken = await sign(
          {
            state,
            clientType,
            redirectUrl,
            codeVerifier,
            exp: Math.floor(Date.now() / 1000) + 600, // 10 menit
          },
          c.env.JWT_SECRET,
          "HS256",
        );
        setCookie(c, "oauth_session", oauthSessionToken, {
          path: "/auth/google",
          maxAge: 600,
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        });
      } catch {}
    }

    const url = new URL(c.req.url);
    const redirectUri = `${url.origin}/auth/google/callback`;

    if (redirectUrl) {
      setCookie(c, "oauth_redirect_url", redirectUrl, {
        path: "/auth/google/callback",
        maxAge: 600,
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      });
    }

    const authorizationUrl = googleService.getAuthorizationUrl(
      state,
      redirectUri,
      codeChallenge,
      "S256",
    );

    return c.redirect(authorizationUrl, 302);
  });

  // ── Google Callback ──────────────────────────────────────────────────────
  const googleCallbackRoute = createRoute({
    method: "get",
    path: "/google/callback",
    tags: ["Google OAuth"],
    summary: "Google Callback",
    description: "Menangani redirect setelah pengguna login via Google (Web Flow).",
    request: {
      query: z.object({
        code: z.string().optional().openapi({ description: "Otorisasi code dari Google" }),
        state: z.string().optional().openapi({ description: "CSRF state token" }),
        error: z.string().optional().openapi({ description: "Pesan error jika user menolak" }),
      }),
    },
    responses: {
      200: {
        description: "Login via Google berhasil",
        content: {
          "application/json": {
            schema: z.object({
              data: TokenResponseSchema.shape.data.extend({
                message: z.string().openapi({ example: "Login via Google berhasil" }),
                isNewUser: z.boolean().openapi({ description: "Benar jika ini adalah register pertama kalinya" }),
                linked: z.boolean().openapi({ description: "Benar jika akun Google ditautkan ke akun yang sudah ada" }),
              }),
            }),
          },
        },
      },
      302: {
        description: "Redirect ke frontend setelah login berhasil (Web Flow)",
      },
      400: {
        description: "Bad Request",
        content: { "application/json": { schema: ErrorResponseSchema } },
      },
    },
  });

  authRoutes.openapi(googleCallbackRoute, async (c: any) => {
    const { code, state, error } = c.req.valid("query");
    const ip = getIp(c);
    const { googleService, cacheService, audit } = makeServices(c, dialect);

    const handleErrorRedirect = async (errorMessage: string, stateValue?: string) => {
      let redirectUrl = "";
      if (stateValue) {
        const kvState = await cacheService.getOAuthState(stateValue);
        if (kvState) {
          try {
            const parsed = JSON.parse(kvState);
            if (parsed.redirectUrl && isAllowedRedirectUrl(parsed.redirectUrl, c.env)) {
              redirectUrl = parsed.redirectUrl;
            }
          } catch {}
        }
      }
      
      if (!redirectUrl) {
        const cookieUrl = getCookie(c, "oauth_redirect_url");
        if (cookieUrl && isAllowedRedirectUrl(cookieUrl, c.env)) {
          redirectUrl = cookieUrl;
        }
      }
      
      if (!redirectUrl) {
        const allowedRaw = (c.env as any).ALLOWED_ORIGINS ?? "";
        const allowedOrigins = allowedRaw
          .split(",")
          .map((o: string) => o.trim())
          .filter(Boolean);
        const concreteOrigin = allowedOrigins.find((o: string) => !o.includes("*"));
        if (concreteOrigin) {
          const base = concreteOrigin.startsWith("http") ? concreteOrigin : `https://${concreteOrigin}`;
          try {
            redirectUrl = `${new URL(base).origin}/google-callback`;
          } catch {}
        } else if (c.env.APP_URL) {
          try {
            redirectUrl = `${new URL(c.env.APP_URL).origin}/google-callback`;
          } catch {}
        }
      }
      
      deleteCookie(c, "oauth_redirect_url", { path: "/auth/google/callback" });
      if (stateValue) {
        await cacheService.deleteOAuthState(stateValue);
      }

      if (!redirectUrl) {
        return c.json({ error: { code: "OAUTH_ERROR", message: errorMessage } }, 400);
      }
      
      const targetUrl = new URL(redirectUrl);
      targetUrl.searchParams.set("error", errorMessage);
      if (stateValue) {
        targetUrl.searchParams.set("state", stateValue);
      }
      return c.redirect(targetUrl.toString(), 302);
    };

    if (error) {
      audit.log({
        event: "google_login_failed",
        ip,
        metadata: { reason: error },
      });
      return handleErrorRedirect(error === "access_denied" ? "access_denied" : error, state);
    }

    if (!code || !state) {
      return handleErrorRedirect("Parameter code dan state wajib ada", state);
    }

    let parsed: {
      clientType: string;
      redirectUrl?: string;
      codeVerifier?: string;
      ts?: number;
    } | null = null;

    // Prioritas 1: Ambil dari signed HttpOnly cookie (Zero KV Read/Write)
    const oauthCookie = getCookie(c, "oauth_session");
    if (oauthCookie && c.env?.JWT_SECRET) {
      deleteCookie(c, "oauth_session", { path: "/auth/google" });
      try {
        const payload = (await verify(oauthCookie, c.env.JWT_SECRET, "HS256")) as any;
        if (payload && payload.state === state) {
          parsed = {
            clientType: payload.clientType,
            redirectUrl: payload.redirectUrl,
            codeVerifier: payload.codeVerifier,
            ts: payload.exp ? payload.exp * 1000 - 600000 : Date.now(),
          };
        }
      } catch {}
    }

    // Prioritas 2: Fallback ke cacheService jika cookie tidak ada (misal test runner / client non-browser)
    if (!parsed) {
      const stateData = await cacheService.getOAuthState(state);
      if (stateData) {
        try {
          parsed = JSON.parse(stateData);
        } catch {}
      }
    }

    await cacheService.deleteOAuthState(state);

    if (!parsed) {
      audit.log({
        event: "google_login_failed",
        ip,
        metadata: { reason: "INVALID_STATE" },
      });
      return handleErrorRedirect("State tidak valid atau sudah expired", state);
    }

    const MAX_STATE_AGE_MS = 10 * 60 * 1000; // 10 menit
    if (parsed.ts && Date.now() - parsed.ts > MAX_STATE_AGE_MS) {
      audit.log({
        event: "google_login_failed",
        ip,
        metadata: { reason: "STATE_EXPIRED" },
      });
      return handleErrorRedirect("State tidak valid atau sudah expired", state);
    }

    const clientType = clientTypeSchema.safeParse(parsed.clientType).data ?? "web";
    const ua = c.req.header("User-Agent") ?? "";

    try {
      const url = new URL(c.req.url);
      const redirectUri = `${url.origin}/auth/google/callback`;
      const tokenResponse = await googleService.exchangeCode(
        code,
        redirectUri,
        parsed.codeVerifier,
      );
      const googleUser = await googleService.getUserInfo(tokenResponse.access_token);
      const result = await googleService.handleGoogleLogin(
        googleUser,
        clientType,
        { ua, ip },
      );

      if (result.isNewUser) {
        audit.log({ event: "google_register", ip, metadata: { email: googleUser.email } });
      } else if (result.linked) {
        audit.log({ event: "google_account_linked", ip, metadata: { email: googleUser.email } });
      } else {
        audit.log({ event: "google_login", ip, metadata: { email: googleUser.email } });
      }

      deleteCookie(c, "oauth_redirect_url", { path: "/auth/google/callback" });

      if (clientType === "web") {
        const policy = TOKEN_POLICY[clientType] ?? TOKEN_POLICY.web;
        const cookieOpts = getAuthCookieOptions(c, policy.refreshToken.expiresInSeconds);
        const cookieName = getAuthCookieName(c);
        setCookie(c, cookieName, result.refreshToken, cookieOpts);
      }

      const validRedirect = isAllowedRedirectUrl(parsed.redirectUrl, c.env) ? parsed.redirectUrl : undefined;
      if (validRedirect) {
        const targetUrl = new URL(validRedirect);
        const fragmentParams: Record<string, string> = {
          accessToken: result.accessToken,
          expiresIn: result.expiresIn.toString(),
          isNewUser: result.isNewUser.toString(),
          linked: result.linked.toString(),
          state: state,
        };
        if (clientType !== "web") {
          fragmentParams.refreshToken = result.refreshToken;
        }
        const fragment = new URLSearchParams(fragmentParams);
        targetUrl.hash = fragment.toString();

        return c.redirect(targetUrl.toString(), 302);
      }

      return c.json(
        {
          data: {
            message: "Login via Google berhasil",
            accessToken: result.accessToken,
            ...(clientType !== "web" ? { refreshToken: result.refreshToken } : {}),
            expiresIn: result.expiresIn,
            tokenType: "Bearer",
            isNewUser: result.isNewUser,
            linked: result.linked,
          },
        },
        200,
      );
    } catch (err: any) {
      audit.log({
        event: "google_login_failed",
        ip,
        metadata: { reason: err.code ?? err.message },
      });
      return handleErrorRedirect(
        err.message || "Gagal memproses autentikasi Google",
        state,
      );
    }
  });

  // ── Google Token (Mobile) ────────────────────────────────────────────────
  const googleTokenRoute = createRoute({
    method: "post",
    path: "/google/token",
    tags: ["Google OAuth"],
    summary: "Google SDK ID Token Validation",
    description: "Memverifikasi token Google OAuth secara independen dari SDK Native (Mobile Flow).",
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
            schema: z.object({
              data: TokenResponseSchema.shape.data.extend({
                message: z.string().openapi({ example: "Login via Google ID Token berhasil" }),
                isNewUser: z.boolean().openapi({ description: "Benar jika ini adalah register pertama kalinya" }),
                linked: z.boolean().openapi({ description: "Benar jika akun Google ditautkan ke akun yang sudah ada" }),
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

  authRoutes.openapi(googleTokenRoute, async (c: any) => {
    const { idToken, clientType } = c.req.valid("json");
    const { googleService, cacheService, audit } = makeServices(c, dialect);
    const ip = getIp(c);
    const ua = c.req.header("User-Agent") ?? "";

    const rateLimitKey = `google-token:${ip}`;
    const rl = await cacheService.getRateLimit(rateLimitKey);
    const limitRes = handleRateLimit(c, rl, RATE_LIMIT_MAX, "Terlalu banyak percobaan. Coba lagi dalam beberapa saat.");
    if (limitRes) {
      audit.log({ event: "rate_limit_hit", ip, metadata: { endpoint: "google-token" } });
      return limitRes;
    }

    try {
      const googleUser = await googleService.verifyIdToken(idToken);
      const result = await googleService.handleGoogleLogin(
        googleUser,
        clientType,
        { ua, ip },
      );

      if (result.isNewUser) {
        audit.log({ event: "google_register", ip, metadata: { email: googleUser.email, flow: "mobile" } });
      } else if (result.linked) {
        audit.log({ event: "google_account_linked", ip, metadata: { email: googleUser.email, flow: "mobile" } });
      } else {
        audit.log({ event: "google_login", ip, metadata: { email: googleUser.email, flow: "mobile" } });
      }

      const responsePayload = {
        data: {
          message: "Login via Google ID Token berhasil",
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          expiresIn: result.expiresIn,
          tokenType: "Bearer",
          isNewUser: result.isNewUser,
          linked: result.linked,
        },
      };

      if (clientType === "web") {
        const policy = TOKEN_POLICY.web;
        const cookieOpts = getAuthCookieOptions(c, policy.refreshToken.expiresInSeconds);
        const cookieName = getAuthCookieName(c);
        setCookie(c, cookieName, result.refreshToken, cookieOpts);
      }

      return c.json(responsePayload, 200);
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

  // ── Forgot Password ──────────────────────────────────────────────────────
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

  authRoutes.openapi(forgotPasswordRoute, async (c: any) => {
    const { email } = c.req.valid("json");
    const { passwordResetService, emailService, cacheService, audit } =
      makeServices(c, dialect);
    const ip = getIp(c);

    const rateLimitKey = `forgot-password:${email}`;
    const rl = await cacheService.getRateLimit(rateLimitKey);
    const limitRes = handleRateLimit(c, rl, FORGOT_PASSWORD_RATE_LIMIT_MAX, "Terlalu banyak permintaan. Coba lagi dalam beberapa saat.");
    if (limitRes) {
      audit.log({ event: "rate_limit_hit", ip, metadata: { email, endpoint: "forgot-password" } });
      return limitRes;
    }

    const newRl = await cacheService.incrementRateLimit(rateLimitKey, FORGOT_PASSWORD_RATE_LIMIT_WINDOW);
    const userId = await passwordResetService.findUserByEmail(email);


    if (userId) {
      try {
        const token = await passwordResetService.createResetToken(userId);
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

    return c.json(
      {
        data: {
          message: "Jika email terdaftar, link reset password akan dikirim.",
          remainingAttempts: Math.max(0, FORGOT_PASSWORD_RATE_LIMIT_MAX - newRl.count),
        },
      },
      200,
    );
  });

  // ── Reset Password ───────────────────────────────────────────────────────
  const resetPasswordRoute = createRoute({
    method: "post",
    path: "/reset-password",
    tags: ["Authentication"],
    summary: "Reset Password",
    description: "Mengganti password menggunakan token reset password yang dikirim via email",
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
      429: {
        description: "Too Many Requests (Rate Limited)",
        content: { "application/json": { schema: ErrorResponseSchema } },
      },
    },
  });

  authRoutes.openapi(resetPasswordRoute, async (c: any) => {
    const { token, newPassword, password } = c.req.valid("json");
    const targetPassword = newPassword || password;
    if (!targetPassword) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "Password baru wajib diisi" } },
        400,
      );
    }
    const { passwordResetService, cacheService, audit } = makeServices(c, dialect);
    const ip = getIp(c);

    const rateLimitKey = `reset-password:${ip}`;
    const rl = await cacheService.getRateLimit(rateLimitKey);
    const limitRes = handleRateLimit(c, rl, 10, "Terlalu banyak percobaan. Coba lagi dalam beberapa saat.");
    if (limitRes) {
      audit.log({ event: "rate_limit_hit", ip, metadata: { endpoint: "reset-password" } });
      return limitRes;
    }

    try {
      const result = await passwordResetService.resetPassword(token, targetPassword);
      await cacheService.clearRateLimit(rateLimitKey);

      audit.log({
        event: "password_reset_success",
        userId: result.userId,
        ip,
        metadata: { email: result.email },
      });

      return c.json(
        {
          data: {
            message: "Password berhasil direset. Silakan login dengan password baru.",
          },
        },
        200,
      );
    } catch (err: any) {
      await cacheService.incrementRateLimit(rateLimitKey, 60 * 5);
      return errorResponse(c, err);
    }
  });

  // ── Handoff Token (Mobile-to-Web SSO) ─────────────────────────────────────
  const createHandoffTokenRoute = createRoute({
    method: "post",
    path: "/handoff/token",
    tags: ["Handoff"],
    summary: "Buat one-time handoff token",
    description:
      "Membuat tiket sementara sekali pakai untuk mentransfer sesi pengguna yang sudah terautentikasi (misalnya dari aplikasi Mobile ke browser Web) tanpa perlu memasukkan kata sandi ulang.",
    security: [{ BearerAuth: [] }],
    request: {
      body: {
        content: { "application/json": { schema: createHandoffTokenSchema } },
      },
    },
    responses: {
      200: {
        description: "Token handoff berhasil dibuat",
        content: { "application/json": { schema: HandoffTokenResponseSchema } },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: ErrorResponseSchema } },
      },
    },
  });

  const handleCreateHandoffToken = async (c: any) => {
    const userId = c.get("userId");
    if (!userId) {
      return c.json(
        {
          error: {
            code: "UNAUTHORIZED",
            message: "Token autentikasi tidak valid atau telah kedaluwarsa",
          },
        },
        401,
      );
    }

    const { redirectUrl, expiresInSeconds = 180 } = c.req.valid("json") || {};
    const { authService, audit } = makeServices(c, dialect);
    const ip = getIp(c);

    const token = await authService.createHandoffToken(
      userId,
      redirectUrl,
      expiresInSeconds,
    );

    const expiresAt = new Date(
      Date.now() + expiresInSeconds * 1000,
    ).toISOString();

    audit.log({
      event: "handoff_token_created",
      userId,
      ip,
      metadata: { redirectUrl, expiresIn: expiresInSeconds },
    });

    return c.json(
      {
        data: {
          token,
          expiresIn: expiresInSeconds,
          expiresAt,
          ...(redirectUrl ? { redirectUrl } : {}),
        },
      },
      200,
    );
  };

  authRoutes.openapi(createHandoffTokenRoute, handleCreateHandoffToken);

  const createHandoffTokenAliasRoute = createRoute({
    method: "post",
    path: "/handoff-token",
    tags: ["Handoff"],
    summary: "Buat one-time handoff token (alias)",
    description: "Alias rute untuk /handoff/token.",
    security: [{ BearerAuth: [] }],
    request: {
      body: {
        content: { "application/json": { schema: createHandoffTokenSchema } },
      },
    },
    responses: {
      200: {
        description: "Token handoff berhasil dibuat",
        content: { "application/json": { schema: HandoffTokenResponseSchema } },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: ErrorResponseSchema } },
      },
    },
  });
  authRoutes.openapi(createHandoffTokenAliasRoute, handleCreateHandoffToken);

  const exchangeHandoffRoute = createRoute({
    method: "post",
    path: "/handoff/exchange",
    tags: ["Handoff"],
    summary: "Tukarkan handoff token menjadi sesi Web",
    description:
      "Menukarkan one-time handoff token menjadi sesi Web baru (access token & httpOnly refresh cookie). Token akan langsung hangus setelah ditukarkan.",
    request: {
      body: {
        content: { "application/json": { schema: exchangeHandoffTokenSchema } },
      },
    },
    responses: {
      200: {
        description: "Penukaran handoff berhasil",
        content: {
          "application/json": { schema: ExchangeHandoffResponseSchema },
        },
      },
      400: {
        description: "Bad Request (Validation Error)",
        content: { "application/json": { schema: ErrorResponseSchema } },
      },
      401: {
        description: "Token transfer tidak valid atau telah kedaluwarsa",
        content: { "application/json": { schema: ErrorResponseSchema } },
      },
      429: {
        description: "Terlalu banyak percobaan",
        content: { "application/json": { schema: ErrorResponseSchema } },
      },
    },
  });

  authRoutes.openapi(exchangeHandoffRoute, async (c: any) => {
    const { token } = c.req.valid("json");
    const { authService, cacheService, audit } = makeServices(c, dialect);
    const ip = getIp(c);
    const ua = c.req.header("User-Agent") ?? "";

    const rl = await cacheService.getRateLimit(ip);
    const limitRes = handleRateLimit(
      c,
      rl,
      RATE_LIMIT_MAX,
      "Terlalu banyak percobaan penukaran sesi. Coba lagi dalam beberapa saat.",
    );
    if (limitRes) {
      audit.log({ event: "rate_limit_hit", ip });
      return limitRes;
    }

    try {
      const result = await authService.exchangeHandoff(token, {
        ua,
        ip,
        client: "handoff",
      });

      await cacheService.clearRateLimit(ip);
      audit.log({
        event: "handoff_success",
        clientType: "web",
        ip,
        userId: result.user.id,
        metadata: { email: result.user.email },
      });

      // Pasang cookie refresh token untuk web client
      const policy = TOKEN_POLICY.web;
      const cookieOpts = getAuthCookieOptions(
        c,
        policy.refreshToken.expiresInSeconds,
      );
      const cookieName = getAuthCookieName(c);
      setCookie(c, cookieName, result.tokens.refreshToken, cookieOpts);

      return c.json(
        {
          data: {
            message: "Handoff berhasil",
            accessToken: result.tokens.accessToken,
            expiresIn: result.tokens.expiresIn,
            tokenType: "Bearer",
            ...(result.redirectUrl ? { redirectUrl: result.redirectUrl } : {}),
            user: result.user,
          },
        },
        200,
      );
    } catch (err: any) {
      if (
        err.status === 401 ||
        err.code === "INVALID_HANDOFF_TOKEN" ||
        err.code === "USER_INACTIVE"
      ) {
        await cacheService.incrementRateLimit(ip);
        audit.log({ event: "handoff_failed", ip });
        return c.json(
          {
            error: {
              code: err.code || "INVALID_HANDOFF_TOKEN",
              message: err.message,
            },
          },
          err.status || 401,
        );
      }
      return errorResponse(c, err);
    }
  });

  return authRoutes;
}
