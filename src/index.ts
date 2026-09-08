// src/index.ts
//
// Root barrel export — @bambsdev/auth
// Shared utilities, types, and backward-compatible exports.

// ── Utils & Services ──────────────────────────────────────────────────────────
export { ImageFilterService } from "./utils/image-filter";
export type { ImageFilterConfig, IImageFilterService } from "./utils/image-filter";
export * from "./utils/validation";
export { generateCodeVerifier, generateCodeChallenge, base64UrlEncode } from "./utils/pkce";
export { R2UploadService, extractR2KeyFromUrl } from "./services/r2-upload.service";
export { CacheService } from "./services/cache.service";
export { AuditService } from "./services/audit.service";
export { EmailService } from "./services/email.service";
export { AuthService } from "./services/auth.service";
export { RegisterService } from "./services/register.service";
export { VerificationService } from "./services/verification.service";
export { PasswordResetService } from "./services/password-reset.service";
export { SettingService } from "./services/setting.service";
export { GoogleOAuthService } from "./services/google.service";
export { DeleteAccountService } from "./services/delete-account.service";
export type { DeleteAccountHook } from "./services/delete-account.service";
export type { SettingRoutesOptions } from "./routes/factory/setting.factory";
export {
  cleanupExpiredTokens,
  cleanupExpiredPasswordResets,
  cleanupExpiredEmailVerifications,
  cleanupExpiredTokensD1,
  cleanupExpiredPasswordResetsD1,
  cleanupExpiredEmailVerificationsD1,
} from "./services/token.service";

// ── DB Adapters & Types ───────────────────────────────────────────────────────
export { createAuthDbAdapter, PgAuthDbAdapter, D1AuthDbAdapter } from "./db/adapter";
export type { AuthDbAdapter, AuthDbDialect, AnyTableSchema } from "./db/adapter";

export type {
  SharedAuthBindings,
  PgBindings,
  D1Bindings,
  PgBindings as AuthBindings,
  PgVariables as AuthVariables,
  Bindings,
  Variables,
  PgDB,
  D1DB,
  AnyAuthDB,
  PgDB as DB,
  JWTAccessPayload,
  JWTRefreshPayload,
  AuditEvent,
  EmailConfig,
} from "./types/index";

// ── Backward Compatible Re-exports (PostgreSQL default) ───────────────────────
export * as schema from "./db/pg/schema";
export * from "./db/pg/schema";
export { createDb, dbMiddleware } from "./db/pg/client";
export { authMiddleware } from "./middleware/auth.middleware";
export { authRoutes } from "./routes/pg/index";
export { settingRoutes } from "./routes/pg/setting";
