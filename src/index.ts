// src/index.ts
//
// Barrel export — @bambsdev/auth
// Consumer apps import everything from this single entry point.

// ── Routes ────────────────────────────────────────────────────────────────────
export { authRoutes } from "./routes/index";
export { settingRoutes } from "./routes/setting.routes";

// ── Middleware ─────────────────────────────────────────────────────────────────
export { dbMiddleware } from "./db/client";
export { customLogger } from "./utils/logger";
export { authMiddleware } from "./middleware/auth.middleware";

// ── DB Schema (consumer needs this for drizzle migrations) ────────────────────
export * as schema from "./db/schema";
export * from "./db/schema";
export { createDb } from "./db/client";
export type { DB } from "./db/client";

// ── Types ─────────────────────────────────────────────────────────────────────
export type {
  Bindings as AuthBindings,
  Variables as AuthVariables,
  JWTAccessPayload,
  JWTRefreshPayload,
  AuditEvent,
} from "./types/index";

// ── Utils (reusable) ──────────────────────────────────────────────────────────
export { ImageFilterService } from "./utils/image-filter";
export * from "./utils/validation";
export { parseBody } from "./utils/validation";

// ── Services ──────────────────────────────────────────────────────────────────
export { cleanupExpiredTokens, cleanupExpiredPasswordResets } from "./services/token.service";
export { R2UploadService, extractR2KeyFromUrl } from "./services/r2-upload.service";
