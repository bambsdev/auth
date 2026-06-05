// src/index.ts
//
// Barrel export — @bambsdev/auth
// Consumer apps import everything from this single entry point.

// ── Utils (reusable) ──────────────────────────────────────────────────────────
export { ImageFilterService } from "./utils/image-filter";
export type { ImageFilterConfig, IImageFilterService } from "./utils/image-filter";
export * from "./utils/validation";
export { parseBody } from "./utils/validation";

// ── Types ─────────────────────────────────────────────────────────────────────
export type {
  Bindings as AuthBindings,
  Variables as AuthVariables,
  JWTAccessPayload,
  JWTRefreshPayload,
  AuditEvent,
  EmailConfig,
} from "./types/index";

// ── DB Schema (consumer needs this for drizzle migrations) ────────────────────
export * as schema from "./db/schema";
export * from "./db/schema";
export { createDb } from "./db/client";
export type { DB } from "./db/client";

// ── Middleware ─────────────────────────────────────────────────────────────────
export { dbMiddleware } from "./db/client";
export { customLogger } from "./utils/logger";
export { authMiddleware } from "./middleware/auth.middleware";

// ── Services ──────────────────────────────────────────────────────────────────
export { cleanupExpiredTokens, cleanupExpiredPasswordResets, cleanupExpiredEmailVerifications } from "./services/token.service";
export { R2UploadService, extractR2KeyFromUrl } from "./services/r2-upload.service";

// ── Routes ────────────────────────────────────────────────────────────────────
export { authRoutes } from "./routes/index";
export { settingRoutes } from "./routes/setting.routes";
