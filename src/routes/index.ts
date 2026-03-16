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
//   GET  /auth/google/login         (web: redirect ke Google consent)
//   GET  /auth/google/callback      (web: handle callback dari Google)
//   POST /auth/google/token         (mobile: verify ID token dari Google Sign-In SDK)

import { Hono } from "hono";
import { verify } from "hono/jwt";
import type { Context } from "hono";
import { CacheService } from "../services/cache.service";
import { AuthService } from "../services/auth.service";
import { RegisterService } from "../services/register.service";
import { AuditService } from "../services/audit.service";
import { EmailService } from "../services/email.service";
import { VerificationService } from "../services/verification.service";
import { GoogleOAuthService } from "../services/google.service";
import { ImageFilterService } from "../utils/image-filter";
import { authMiddleware } from "../middleware/auth.middleware";
import { RATE_LIMIT_MAX } from "../config/token.config";
import {
  parseBody,
  registerSchema,
  loginSchema,
  refreshSchema,
  logoutSchema,
  resendVerificationSchema,
  googleTokenSchema,
  clientTypeSchema,
} from "../utils/validation";
import type { Bindings, Variables, JWTAccessPayload } from "../types/index";

export const authRoutes = new Hono<{
  Bindings: Bindings;
  Variables: Variables;
}>();

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
  const emailService = new EmailService(c.env.RESEND_API_KEY, c.env.APP_URL);
  const verificationService = new VerificationService(db);
  const imageFilter = new ImageFilterService(c.env.AI);
  const googleService = new GoogleOAuthService(
    db,
    authService,
    imageFilter,
    c.env.GOOGLE_CLIENT_ID,
    c.env.GOOGLE_CLIENT_SECRET,
  );
  return {
    db,
    cacheService,
    authService,
    audit,
    emailService,
    verificationService,
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
  const isAppError = typeof err.status === "number" && typeof err.code === "string";
  let status = isAppError ? err.status : 500;
  let code = isAppError ? err.code : "INTERNAL_ERROR";
  let message = isAppError ? err.message : "Terjadi kesalahan pada server";

  if (!isAppError && (err.code === "23505" || String(err.message).includes("duplicate key") || String(err.message).includes("unique constraint") || String(err.message).includes("Failed query"))) {
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
authRoutes.post("/register", async (c) => {
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

  const validated = parseBody(registerSchema, body);
  const { db, audit, emailService, verificationService } = makeServices(c);

  try {
    const registerService = new RegisterService(db);
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
        data: { id: user.id, email: user.email, createdAt: user.createdAt },
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
authRoutes.post("/login", async (c) => {
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

  const { email, password, clientType } = parseBody(loginSchema, body);
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

    return c.json({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      tokenType: "Bearer",
    });
  } catch (err: any) {
    await cacheService.incrementRateLimit(ip);
    audit.log({
      event: "login_failed",
      ip,
      metadata: { email, reason: err.code },
    });
    return errorResponse(c, err);
  }
});

// ╔══════════════════════════════════════════════════════════════╗
// ║  POST /auth/refresh                                          ║
// ╚══════════════════════════════════════════════════════════════╝
authRoutes.post("/refresh", async (c) => {
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

  const { refreshToken } = parseBody(refreshSchema, body);
  const { authService, audit } = makeServices(c);

  try {
    const tokens = await authService.rotateRefreshToken(refreshToken);
    audit.log({ event: "token_refresh", ip: getIp(c) });

    return c.json({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      tokenType: "Bearer",
    });
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
authRoutes.post("/logout", authMiddleware, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const { refreshToken } = parseBody(logoutSchema, body);
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

  return c.json({ message: "Logout berhasil" });
});

// ╔══════════════════════════════════════════════════════════════╗
// ║  POST /auth/logout-all                      🔒 Protected     ║
// ╚══════════════════════════════════════════════════════════════╝
authRoutes.post("/logout-all", authMiddleware, async (c) => {
  const { authService, audit } = makeServices(c);

  await authService.logoutAll(c.var.userId);
  audit.log({ event: "logout_all", userId: c.var.userId, ip: getIp(c) });

  return c.json({ message: "Semua sesi berhasil dicabut" });
});

// ╔══════════════════════════════════════════════════════════════╗
// ║  GET /auth/sessions                         🔒 Protected     ║
// ╚══════════════════════════════════════════════════════════════╝
authRoutes.get("/sessions", authMiddleware, async (c) => {
  const { authService } = makeServices(c);
  const sessions = await authService.getSessions(c.var.userId);

  return c.json({ data: sessions });
});

// ╔══════════════════════════════════════════════════════════════╗
// ║  DELETE /auth/sessions/:id                  🔒 Protected     ║
// ╚══════════════════════════════════════════════════════════════╝
authRoutes.delete("/sessions/:id", authMiddleware, async (c) => {
  const sessionId = c.req.param("id");
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
  return c.json({ message: "Sesi berhasil dicabut" });
});

// ╔══════════════════════════════════════════════════════════════╗
// ║  GET /auth/verify-email?token=...                             ║
// ╚══════════════════════════════════════════════════════════════╝
authRoutes.get("/verify-email", async (c) => {
  const token = c.req.query("token");

  if (!token) {
    return c.json(
      {
        error: {
          code: "MISSING_TOKEN",
          message: "Token verifikasi wajib diisi",
        },
      },
      400,
    );
  }

  const { verificationService, audit } = makeServices(c);

  try {
    const result = await verificationService.verifyEmail(token);

    audit.log({
      event: "email_verified",
      userId: result.userId,
      ip: getIp(c),
      metadata: { email: result.email },
    });

    return c.json({
      message: "Email berhasil diverifikasi. Silakan login.",
    });
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
authRoutes.post("/resend-verification", async (c) => {
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

  const { email } = parseBody(resendVerificationSchema, body);

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

    return c.json({
      message: "Email verifikasi dikirim ulang. Silakan cek inbox Anda.",
    });
  } catch (err: any) {
    // Untuk keamanan: jika user tidak ditemukan / sudah verified,
    // tetap return 200 yang sama (mencegah email enumeration)
    if (err.code === "USER_NOT_FOUND" || err.code === "ALREADY_VERIFIED") {
      return c.json({
        message: "Email verifikasi dikirim ulang. Silakan cek inbox Anda.",
      });
    }
    return errorResponse(c, err);
  }
});

// ╔══════════════════════════════════════════════════════════════╗
// ║  GET /auth/google/login                                      ║
// ║  Web flow: redirect ke Google consent screen                 ║
// ╚══════════════════════════════════════════════════════════════╝
authRoutes.get("/google/login", async (c) => {
  const rawClientType = c.req.query("clientType");
  const clientType = clientTypeSchema.safeParse(rawClientType).data ?? "web";
  const { googleService, cacheService } = makeServices(c);

  // Generate CSRF state token dan simpan di KV (TTL 10 menit)
  const state = crypto.randomUUID();
  const statePayload = JSON.stringify({ clientType, ts: Date.now() });
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
authRoutes.get("/google/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const error = c.req.query("error");
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

    // Return JSON response dengan token
    return c.json({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
      tokenType: "Bearer",
      isNewUser: result.isNewUser,
      linked: result.linked,
    });
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
authRoutes.post("/google/token", async (c) => {
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

  const { idToken, clientType } = parseBody(googleTokenSchema, body);

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

    return c.json({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
      tokenType: "Bearer",
      isNewUser: result.isNewUser,
      linked: result.linked,
    });
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
