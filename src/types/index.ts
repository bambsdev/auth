// src/types/index.ts
import type { ClientType } from "../config/token.config";

// ── Cloudflare Worker Bindings ────────────────────────────────────────────────
export type Bindings = {
  HYPERDRIVE: Hyperdrive;
  KV: KVNamespace;
  ANALYTICS: AnalyticsEngineDataset;
  JWT_SECRET: string;
  JWT_REFRESH_SECRET: string;
  RESEND_API_KEY: string;
  APP_URL: string; // base URL untuk verification link
  EMAIL_FROM?: string; // (Opsional) email pengirim default
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  AI: Ai; // Cloudflare Workers AI binding
  LOCAL_DATABASE_URL?: string; // used to bypass local hyperdrive proxy
  BUCKET?: R2Bucket; // R2 Bucket untuk upload public files
  BUCKET_PUBLIC_URL?: string; // Base URL public bucket (opsional)
};

// ── Hono Context Variables (injected per-request) ─────────────────────────────
export type Variables = {
  userId: string;
  jti: string;
  clientType: ClientType;
  db: import("../db/client").DB;
  emailConfig?: EmailConfig; // Injeksi config email dari consumer
};

export interface EmailConfig {
  from: string;
  templates?: {
    verification?: (url: string) => string;
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
  | "avatar_blocked"
  // Password Reset
  | "forgot_password_requested"
  | "password_reset_success";
