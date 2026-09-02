// src/types/index.ts
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { ClientType } from "../config/token.config";
import type * as pgSchema from "../db/pg/schema";
import type * as d1Schema from "../db/d1/schema";
import type { ImageFilterConfig } from "../utils/image-filter";

// ── Cloudflare Worker Shared Bindings ─────────────────────────────────────────
export type SharedAuthBindings = {
  KV: KVNamespace;
  ANALYTICS: AnalyticsEngineDataset;
  JWT_SECRET: string;
  JWT_REFRESH_SECRET: string;
  RESEND_API_KEY: string;
  APP_URL: string; // base URL untuk verification link
  EMAIL_FROM?: string; // (Opsional) email pengirim default
  COOKIE_NAME?: string; // (Opsional) Custom cookie name (default: "refresh_token") untuk isolasi multi-environment
  COOKIE_DOMAIN?: string; // (Opsional) Root cookie domain (contoh: .example.com) untuk first-party cookie sharing
  COOKIE_SAME_SITE?: "Lax" | "Strict" | "None"; // (Opsional) SameSite policy override
  COOKIE_SECURE?: string | boolean; // (Opsional) Secure flag override (default true)
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_ALLOWED_CLIENT_IDS?: string; // Comma-separated extra client IDs (mobile Android/iOS)
  ALLOWED_ORIGINS?: string; // Comma-separated allowed frontend origins for OAuth redirect
  AI: Ai; // Cloudflare Workers AI binding
  R2_PUBLIC?: R2Bucket; // R2 Bucket untuk upload public files
  BUCKET_PUBLIC_URL?: string; // Base URL public bucket (opsional)
};

// ── Dialect Specific Bindings ────────────────────────────────────────────────
export type PgBindings = SharedAuthBindings & {
  HYPERDRIVE: Hyperdrive;
  LOCAL_DATABASE_URL?: string; // used to bypass local hyperdrive proxy
};

export type D1Bindings = SharedAuthBindings & {
  DB: D1Database; // Cloudflare D1 binding
};

// Backward-compatible alias
export type Bindings = PgBindings;

// ── Database Types ────────────────────────────────────────────────────────────
export type PgDB = NodePgDatabase<typeof pgSchema>;
export type D1DB = DrizzleD1Database<typeof d1Schema>;
export type AnyAuthDB = PgDB | D1DB;

// Backward-compatible alias
export type DB = PgDB;

// ── Hono Context Variables (injected per-request) ─────────────────────────────
export type PgVariables = {
  userId: string;
  jti: string;
  exp: number;
  clientType: ClientType;
  db: PgDB;
  emailConfig?: EmailConfig; // Injeksi config email dari consumer
  imageFilterConfig?: ImageFilterConfig; // Injeksi config image filter dari consumer
};

export type D1Variables = {
  userId: string;
  jti: string;
  exp: number;
  clientType: ClientType;
  db: D1DB;
  emailConfig?: EmailConfig;
  imageFilterConfig?: ImageFilterConfig;
};

// Backward-compatible alias
export type Variables = PgVariables;

export interface EmailConfig {
  from: string;
  verificationMethod?: "link" | "code";
  verificationCodeTtlMinutes?: number;
  verificationBaseUrl?: string;
  resetPasswordBaseUrl?: string;
  templates?: {
    verification?: (urlOrCode: string) => string;
    forgotPassword?: (url: string) => string;
  };
}

// ── JWT Payloads ──────────────────────────────────────────────────────────────
export interface JWTAccessPayload {
  sub: string; // userId
  jti: string; // unique id → dipakai untuk blacklist
  type: "access";
  client: ClientType;
  iat: number;
  exp: number;
}

export interface JWTRefreshPayload {
  sub: string;
  jti: string;
  familyId: string; // token rotation family → detect reuse attack
  type: "refresh";
  client: ClientType;
  iat: number;
  exp: number;
}

// ── Audit Events ──────────────────────────────────────────────────────────────
export type AuditEvent =
  // Auth
  | "register"
  | "login_success"
  | "login_failed"
  | "logout"
  | "logout_all"
  | "token_refresh"
  | "token_reuse_detected"
  | "session_revoked"
  | "rate_limit_hit"
  | "verification_sent"
  | "email_verified"
  | "verification_failed"
  | "google_login"
  | "google_login_failed"
  | "google_account_linked"
  | "google_register"
  // Settings
  | "profile_updated"
  | "password_changed"
  | "avatar_updated"
  | "avatar_deleted"
  | "avatar_blocked"
  // Password Reset
  | "forgot_password_requested"
  | "password_reset_success";
