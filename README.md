# @bambsdev/auth

> 🔐 **The Complete Authentication Solution** for Hono, Cloudflare Workers (Edge Runtime), and Drizzle ORM.

`@bambsdev/auth` (v1.4.0) is a production-ready, type-safe, multi-database authentication library designed specifically for the Cloudflare Workers ecosystem. It provides everything from standard JWT auth and family-based refresh token rotation to Google OAuth, AI-moderated avatar uploads (Cloudflare R2 + Workers AI), customizable verification flows (OTP / Link), and automated OpenAPI/Swagger documentation.

---

## 🏗 Architecture & Tech Stack

This package follows a **Clean Service Layer Architecture**. Business logic is strictly decoupled from routing and infrastructure, ensuring high testability, modularity, and edge runtime compatibility.

### Core Technologies

- **Framework**: [Hono](https://hono.dev) (powered by `@hono/zod-openapi` for automatic OpenAPI/Swagger documentation)
- **Runtime**: [Cloudflare Workers](https://workers.cloudflare.com/) (Edge Serverless)
- **Multi-Database Support**:
  - **PostgreSQL**: Subpath `@bambsdev/auth/pg` via [Cloudflare Hyperdrive](https://developers.cloudflare.com/hyperdrive/) / `node-postgres`
  - **Cloudflare D1 (SQLite)**: Subpath `@bambsdev/auth/d1` via Cloudflare native D1 Edge Database
  - **Shared Core**: Root `@bambsdev/auth` for shared types, utilities, and schemas
- **ORM**: [Drizzle ORM](https://orm.drizzle.team/)
- **Storage**: Cloudflare R2 (for avatar storage & orphan cleanup)
- **State & Caching**: Two-tier caching (Cloudflare Cache API L1 + Cloudflare KV L2) for rate limiting, blacklisting, and OAuth CSRF states
- **AI Moderation**: Cloudflare Workers AI (`@cf/microsoft/resnet-50` for image safety classification)
- **Observability**: Cloudflare Analytics Engine (for non-blocking audit logging)
- **Email Service**: Resend API via native `fetch` (for OTP codes, verification links, and password resets)

---

## ✨ Key Features

### 🛡️ Core Authentication & Session Management
- **Token Rotation & Grace Period (Leeway Window)**: Refresh token rotation with family-based tracking and a 30-second leeway window (RFC 6749 / Auth0 standard) to handle spam reloads and concurrent requests seamlessly. If an old token is reused outside the grace period, all tokens in the family are automatically revoked.
- **Strict Session Limits (Max 10)**: Prevents session hoarding by automatically revoking the oldest session (FIFO) when a user exceeds 10 active devices/sessions.
- **Session Control**: List active devices, revoke individual sessions, or execute a global "Logout from all devices" command.
- **Robust Rate Limiting (CF KV/Cache)**: Strict rate limits built-in to prevent brute-force attacks on login, registration, OTP verification, and password resets, returning standard `retryAfterSeconds` and `remainingAttempts` payloads.
- **Adaptive Cookie Management**: Configurable cookie name (`COOKIE_NAME`) and domain (`COOKIE_DOMAIN`) with `HttpOnly`, `Secure`, and adaptive `SameSite` (`Lax` for first-party root sharing, `None` for cross-site dev/preview environments).
- **Two-Tier Edge Cache**: L1 Cache API + L2 KV caching with negative caching (`"0"`) reducing KV read costs by up to 99%.

### 📨 Flexible Email Verification & Password Reset
- **Verification Modes**: Choose between **6-digit numeric OTP codes** or **URL verification links** (`verificationMethod: "code" | "link"`).
- **Customizable Templates**: Fully customizable email templates and configurable OTP TTL.
- **Secure Password Reset**: Transactional password reset with 64-character hex tokens and automatic invalidation of old unused tokens.
- **Password Reuse Prevention**: Rejects password changes if the new password is identical to the current one.

### 🌐 Google OAuth 2.0 & RFC 7636 PKCE
- **PKCE Defense**: Full RFC 7636 PKCE (`code_challenge` S256 + `code_verifier`) preventing authorization code interception and injection attacks.
- **Web Flow**: Standard redirect flow with RFC 6750 compliant **URL Fragment delivery** (`#accessToken=...`) preventing token leakage in logs and referrers.
- **Mobile Flow**: Direct Google ID token verification via Native SDKs (Android/iOS).
- **Smart Account Linking**: Atomically links Google logins to existing accounts with matching email addresses.
- **Open Redirect Protection**: Strict fail-closed validation of redirect URLs against `ALLOWED_ORIGINS` (supports wildcard subdomains like `*.example.pages.dev` or `https://*.pages.dev`) and `APP_URL`.

### 👤 Avatar Uploads (Cloudflare R2 + Workers AI Moderation)
- **Built-in AI Moderation**: Uses `@cf/microsoft/resnet-50` to classify uploaded avatars.
- **SSRF Protection**: Strict URL validation blocking private IPs, metadata endpoints (`169.254.169.254`), and localhost before fetching images.
- **Automatic Storage Cleanup**: Deletes old avatar files from R2 automatically upon new upload or deletion.
- **R2 Proxy Endpoint**: Built-in streaming proxy route for R2 files when custom domains are not configured.

---

## 📦 Subpath Package Exports

| Subpath | Dialect / Target | Database Middleware | Primary Use Case |
| :--- | :--- | :--- | :--- |
| `@bambsdev/auth/pg` | PostgreSQL | `dbMiddleware` | Cloudflare Workers using Hyperdrive / PostgreSQL |
| `@bambsdev/auth/d1` | Cloudflare D1 | `dbMiddleware` | Cloudflare Workers using native Cloudflare D1 (SQLite) |
| `@bambsdev/auth` | Core Agnostic | N/A | Shared schemas, types, error utilities, and helpers |

---

## 🚀 Installation & Setup

### 1. Install the Package

```bash
bun add @bambsdev/auth
```

### 2. Peer Dependencies

Install the peer dependencies required for your database choice:

```bash
# For PostgreSQL Workers:
bun add hono @hono/zod-openapi drizzle-orm pg zod

# For Cloudflare D1 Workers (zero pg dependencies needed):
bun add hono @hono/zod-openapi drizzle-orm zod
```

---

## ⚡ Quick Start Examples

### Option A: PostgreSQL Worker (`@bambsdev/auth/pg`)

```typescript
import { Hono } from "hono";
import { authRoutes, settingRoutes, dbMiddleware } from "@bambsdev/auth/pg";
import type { PgBindings, PgVariables } from "@bambsdev/auth/pg";
import type { EmailConfig } from "@bambsdev/auth";

const app = new Hono<{ Bindings: PgBindings; Variables: PgVariables }>();

// Injects Drizzle PostgreSQL client into context
app.use("*", dbMiddleware);

// Optional Email Configuration
const emailConfig: EmailConfig = {
  from: "No-Reply <noreply@myapp.com>",
  verificationMethod: "code", // "code" (OTP) | "link" (URL)
  verificationCodeTtlMinutes: 10,
  resetPasswordBaseUrl: "https://myapp.com",
};

app.use("*", async (c, next) => {
  c.set("emailConfig", emailConfig);
  await next();
});

// Mount routes
app.route("/auth", authRoutes);
app.route("/api/settings", settingRoutes);

export default app;
```

### Option B: Cloudflare D1 Worker (`@bambsdev/auth/d1`)

```typescript
import { Hono } from "hono";
import { authRoutes, settingRoutes, dbMiddleware } from "@bambsdev/auth/d1";
import type { D1Bindings, D1Variables } from "@bambsdev/auth/d1";
import type { EmailConfig } from "@bambsdev/auth";

const app = new Hono<{ Bindings: D1Bindings; Variables: D1Variables }>();

// Injects Drizzle D1 client into context
app.use("*", dbMiddleware);

// Mount routes
app.route("/auth", authRoutes);
app.route("/api/settings", settingRoutes);

export default app;
```

---

## ⚙️ Wrangler Configuration

Example `wrangler.jsonc` configuration:

```jsonc
{
  "name": "my-auth-worker",
  "main": "src/index.ts",
  "compatibility_date": "2024-09-23",
  "vars": {
    "APP_URL": "https://myapp.com",
    "ALLOWED_ORIGINS": "https://myapp.com,https://admin.myapp.com,https://*.pages.dev",
    "COOKIE_NAME": "my_auth_rf", // Optional, defaults to "refresh_token"
    "COOKIE_DOMAIN": ".myapp.com", // Optional, enables first-party root cookie sharing
    "COOKIE_SAME_SITE": "Lax", // Optional, "Lax" | "Strict" | "None"
    "REFRESH_TOKEN_GRACE_PERIOD_SECONDS": "30", // Optional, grace period in seconds (default: 30)
    "EMAIL_FROM": "No-Reply <noreply@myapp.com>",
    "BUCKET_PUBLIC_URL": "https://pub-xxx.r2.dev",
    "GOOGLE_CLIENT_ID": "xxx.apps.googleusercontent.com",
    "GOOGLE_CLIENT_SECRET": "GOCSPX-xxx",
    "GOOGLE_ALLOWED_CLIENT_IDS": "android-client-id,ios-client-id",
    "JWT_SECRET": "your-jwt-access-secret-min-32-chars",
    "JWT_REFRESH_SECRET": "your-jwt-refresh-secret-min-32-chars",
    "RESEND_API_KEY": "re_xxx"
  },
  // For PostgreSQL:
  "hyperdrive": [
    { "binding": "HYPERDRIVE", "id": "<your-hyperdrive-id>" }
  ],
  // For Cloudflare D1:
  "d1_databases": [
    { "binding": "DB", "database_name": "my-auth-db", "database_id": "<your-d1-id>" }
  ],
  "kv_namespaces": [
    { "binding": "KV", "id": "<your-kv-id>" }
  ],
  "r2_buckets": [
    { "binding": "R2_PUBLIC", "bucket_name": "my-avatars" }
  ],
  "ai": { "binding": "AI" },
  "analytics_engine_datasets": [
    { "binding": "ANALYTICS" }
  ]
}
```

---

## 🧹 Scheduled Token Cleanups (Cron Trigger)

Clean up expired refresh tokens, verification tokens, and password reset records periodically:

### PostgreSQL:
```typescript
import {
  cleanupExpiredTokens,
  cleanupExpiredPasswordResets,
  cleanupExpiredEmailVerifications,
} from "@bambsdev/auth/pg";

export default {
  async scheduled(event, env, ctx) {
    const conn = env.LOCAL_DATABASE_URL || env.HYPERDRIVE?.connectionString;
    ctx.waitUntil(cleanupExpiredTokens(conn));
    ctx.waitUntil(cleanupExpiredPasswordResets(conn));
    ctx.waitUntil(cleanupExpiredEmailVerifications(conn));
  },
};
```

### Cloudflare D1:
```typescript
import {
  cleanupExpiredTokensD1,
  cleanupExpiredPasswordResetsD1,
  cleanupExpiredEmailVerificationsD1,
} from "@bambsdev/auth/d1";

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanupExpiredTokensD1(env.DB));
    ctx.waitUntil(cleanupExpiredPasswordResetsD1(env.DB));
    ctx.waitUntil(cleanupExpiredEmailVerificationsD1(env.DB));
  },
};
```

---

## 🗺️ API Reference

### 🔐 Auth Endpoints (`/auth`)

| Method   | Path                        | Access     | Rate Limit | Description                                            |
| :------- | :-------------------------- | :--------- | :--------- | :----------------------------------------------------- |
| `POST`   | `/auth/register`            | Public     | -          | Register new user with email, password, and username   |
| `POST`   | `/auth/login`               | Public     | 5 / 5 min  | Login with email & password, returns JWT token pair    |
| `POST`   | `/auth/refresh`             | Public     | 5 / 5 min  | Rotate refresh token for a new access token            |
| `POST`   | `/auth/logout`              | 🔒 Private | -          | Logout current device session (blacklists JWT)         |
| `POST`   | `/auth/logout-all`          | 🔒 Private | -          | Revoke all active sessions across all devices          |
| `GET`    | `/auth/sessions`            | 🔒 Private | -          | List all active sessions with device info              |
| `DELETE` | `/auth/sessions/:id`        | 🔒 Private | -          | Revoke a specific session ID                           |
| `GET`    | `/auth/verify-email`        | Public     | -          | Verify email via 64-character hex link token           |
| `POST`   | `/auth/verify-email-code`   | Public     | 5 / 5 min  | Verify email via 6-digit numeric OTP code              |
| `POST`   | `/auth/resend-verification` | Public     | 3 / 5 min  | Resend verification code or link                       |
| `GET`    | `/auth/google/login`        | Public     | -          | Redirect to Google OAuth consent screen (Web flow)     |
| `GET`    | `/auth/google/callback`     | Public     | -          | Handle Google redirect, returns token in URL fragment  |
| `POST`   | `/auth/google/token`        | Public     | 5 / 5 min  | Verify Google ID token from Native Mobile SDK          |
| `POST`   | `/auth/forgot-password`     | Public     | 3 / 5 min  | Request password reset link email                      |
| `POST`   | `/auth/reset-password`      | Public     | 10 / 5 min | Reset password using 64-character hex token            |

### 👤 Settings Endpoints (`/api/settings`)

| Method   | Path                            | Access     | Description                                         |
| :------- | :------------------------------ | :--------- | :-------------------------------------------------- |
| `GET`    | `/api/settings/profile`         | 🔒 Private | Get authenticated user profile                      |
| `PUT`    | `/api/settings/profile`         | 🔒 Private | Update username (case-insensitive) or full name     |
| `PUT`    | `/api/settings/password`        | 🔒 Private | Change password (revokes old device sessions)       |
| `PUT`    | `/api/settings/avatar`          | 🔒 Private | Upload avatar file (Multipart, AI safety check, R2) |
| `DELETE` | `/api/settings/avatar`          | 🔒 Private | Delete avatar and clean up physical file from R2    |
| `GET`    | `/api/settings/avatar-file/*`   | Public     | Streaming proxy for avatar images from R2           |

---

## 📜 Documentation Guides

- [MIGRATION.md](file:///d:/project-hono/auth/MIGRATION.md): Comprehensive multi-database migration and configuration guide.
- [CHANGELOG.md](file:///d:/project-hono/auth/CHANGELOG.md): Detailed release notes and breaking changes history.

---

## 📜 License

ISC License

