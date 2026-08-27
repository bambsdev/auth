// src/pg/index.ts
//
// PostgreSQL Auth Stack for @bambsdev/auth/pg

// ── DB Schema & Client ────────────────────────────────────────────────────────
export * as schema from "../db/pg/schema";
export * from "../db/pg/schema";
export { createDb, dbMiddleware, dbMiddleware as pgMiddleware } from "../db/pg/client";

// ── Routes ────────────────────────────────────────────────────────────────────
export { authRoutes } from "../routes/pg/index";
export { settingRoutes } from "../routes/pg/setting";

// ── Middleware ────────────────────────────────────────────────────────────────
export { authMiddleware } from "../middleware/auth.middleware";

// ── Services ──────────────────────────────────────────────────────────────────
export {
  cleanupExpiredTokens,
  cleanupExpiredPasswordResets,
  cleanupExpiredEmailVerifications,
} from "../services/token.service";
export { AuthService } from "../services/auth.service";
export { RegisterService } from "../services/register.service";
export { VerificationService } from "../services/verification.service";
export { PasswordResetService } from "../services/password-reset.service";
export { SettingService } from "../services/setting.service";
export { GoogleOAuthService } from "../services/google.service";
export { R2UploadService, extractR2KeyFromUrl } from "../services/r2-upload.service";
export { CacheService } from "../services/cache.service";
export { AuditService } from "../services/audit.service";
export { EmailService } from "../services/email.service";

// ── Utils & Types ─────────────────────────────────────────────────────────────
export { ImageFilterService } from "../utils/image-filter";
export type { ImageFilterConfig, IImageFilterService } from "../utils/image-filter";
export * from "../utils/validation";
export { parseBody } from "../utils/validation";
export type {
  PgDB,
  PgDB as DB,
  PgBindings,
  PgBindings as Bindings,
  PgBindings as AuthBindings,
  PgVariables,
  PgVariables as Variables,
  PgVariables as AuthVariables,
  SharedAuthBindings,
  JWTAccessPayload,
  JWTRefreshPayload,
  AuditEvent,
  EmailConfig,
} from "../types/index";
