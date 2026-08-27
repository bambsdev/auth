// src/d1/index.ts
//
// Cloudflare D1 (SQLite) Auth Stack for @bambsdev/auth/d1

// ── DB Schema & Client ────────────────────────────────────────────────────────
export * as schema from "../db/d1/schema";
export * from "../db/d1/schema";
export { createD1Db, d1Middleware as dbMiddleware, d1Middleware } from "../db/d1/client";

// ── Routes ────────────────────────────────────────────────────────────────────
export { authRoutes } from "../routes/d1/index";
export { settingRoutes } from "../routes/d1/setting";

// ── Middleware ────────────────────────────────────────────────────────────────
export { authMiddleware } from "../middleware/auth.middleware";

// ── Services ──────────────────────────────────────────────────────────────────
export {
  cleanupExpiredTokensD1,
  cleanupExpiredPasswordResetsD1,
  cleanupExpiredEmailVerificationsD1,
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
  D1DB,
  D1DB as DB,
  D1Bindings,
  D1Bindings as Bindings,
  D1Bindings as AuthBindings,
  D1Variables,
  D1Variables as Variables,
  D1Variables as AuthVariables,
  SharedAuthBindings,
  JWTAccessPayload,
  JWTRefreshPayload,
  AuditEvent,
  EmailConfig,
} from "../types/index";
