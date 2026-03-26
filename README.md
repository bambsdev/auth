# @bambsdev/auth

> 🔐 **The Complete Authentication Solution** for Hono, Cloudflare Workers, and Drizzle ORM.

`@bambsdev/auth` is a production-ready, type-safe authentication package designed specifically for the Cloudflare ecosystem. It provides everything from standard JWT auth and session management to Google OAuth, AI-filtered avatar uploads (R2), and automated OpenAPI/Swagger documentation.

---

## 🏗 Architecture & Tech Stack

This package is built on a **Clean Service Layer Architecture**. Business logic is strictly separated from routing and infrastructure, making it highly testable and maintainable.

### Core Technologies

- **Framework**: [Hono](https://hono.dev) (specifically utilizing `OpenAPIHono` for auto-documentation)
- **Runtime**: [Cloudflare Workers](https://workers.cloudflare.com/)
- **Database**: PostgreSQL (connected via [Cloudflare Hyperdrive](https://developers.cloudflare.com/hyperdrive/) for connection pooling)
- **ORM**: [Drizzle ORM](https://orm.drizzle.team/)
- **Storage**: Cloudflare R2 (for Profiles & Avatar management)
- **State & Caching**: Cloudflare KV (for OAuth state, token blacklisting, and rate limiting)
- **AI Integration**: Cloudflare Workers AI (utilizing `detr-resnet-50` for automated image safety filtering)
- **Observability**: Cloudflare Analytics Engine (for standard Audit Logging)

---

## ✨ Key Features

### 🛡️ Core Authentication

- **Standard Flows**: Register, Login, Email Verification, and Password Reset.
- **Advanced Session Management**:
  - JWT Access tokens combined with secure Refresh token rotation.
  - Refresh token family tracking (automatically detects and revokes reused/stolen tokens).
  - Ability to list active sessions, revoke specific sessions, or execute a global "Logout all device" command.

### 🌐 Google OAuth Integration

- **Web Flow**: Standard redirect-based authentication.
- **Mobile Flow**: Direct Google ID Token validation tailored for Native SDKs (Android/iOS).
- **Smart Account Linking**: Automatically links new Google logins to existing email/password registrations.

### 👤 User Settings & Profiles

- **Profile Management**: Update user metadata securely.
- **Avatar Uploads (R2 + AI)**:
  - **Transactional Safety**: Atomic process involving AI-filtering, Cloudflare R2 upload, Database URI update, and old file cleanup. All while intelligently bypassing Hyperdrive's cache layer to ensure absolute data consistency.

### 🛠️ Developer Experience (DX)

- **Auto-Swagger**: Built-in OpenAPI specification generation out of the box.
- **Clean Logger**: Beautiful, human-readable audit trails for development and production.
- **Drop-in Middlewares**: Effortless Database and Context injection for consumer applications.

---

## 🚀 Installation & Setup

### 1. Install the Package

```bash
bun add @bambsdev/auth
```

### 2. Peer Dependencies

This package requires the following dependencies in your consumer application:

```bash
bun add hono @hono/zod-openapi drizzle-orm pg zod
```

### 3. Quick Start (Hono App)

Mounting the authentication system is incredibly straightforward:

```typescript
import { Hono } from "hono";
import {
  authRoutes,
  settingRoutes,
  dbMiddleware,
  customLogger,
} from "@bambsdev/auth";
import type { AuthBindings, AuthVariables } from "@bambsdev/auth";

const app = new Hono<{ Bindings: AuthBindings; Variables: AuthVariables }>();

// Logger — Format: [ISO_TIMESTAMP] METHOD /path - STATUS (TIMINGms) IP:xxx
app.use("*", customLogger());

// DB Middleware — Injects the Drizzle DB instance into every request
app.use("/auth/*", dbMiddleware);
app.use("/api/*", dbMiddleware);

// Mount the routes
app.route("/auth", authRoutes);
app.route("/api/settings", settingRoutes);

export default app;
```

_That's it! All secure authentication endpoints are instantly available._ ✅

---

## ⚙️ Configuration (Wrangler Bindings)

The library automatically reads configuration from Hono's `c.env`. The consumer application **must** define the following bindings in its `wrangler.toml`:

```toml
name = "my-app"
main = "src/index.ts"
compatibility_date = "2024-12-01"

[vars]
BUCKET_PUBLIC_URL = "https://xxx.r2.dev" # Ganti dengan URL public R2 milikmu
EMAIL_FROM = "No reply <noreply@xxxxx.com>"



# Secrets (Set these via `wrangler secret put`)
# JWT_SECRET
# JWT_REFRESH_SECRET
# RESEND_API_KEY
# GOOGLE_CLIENT_ID
# GOOGLE_CLIENT_SECRET

[[hyperdrive]]
binding = "HYPERDRIVE"
id = "your-hyperdrive-id"

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "your-bucket-name"

[[kv_namespaces]]
binding = "KV"
id = "your-kv-id"

[observability.logs]
enabled = false
invocation_logs = true

[[analytics_engine_datasets]]
binding = "ANALYTICS"

[ai]
binding = "AI"
```

### Setting up Environment Secrets

Run these commands in your CLI to set the required secrets:

```bash
wrangler secret put JWT_SECRET
wrangler secret put JWT_REFRESH_SECRET
wrangler secret put RESEND_API_KEY
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
```

---

## 🗄️ Database Schema & Migrations

This library exports a ready-to-use Drizzle schema. To run migrations in your consumer app, update your `drizzle.config.ts`:

```typescript
// drizzle.config.ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: [
    "./node_modules/@bambsdev/auth/dist/index.js", // Auth schemas
    "./src/db/schema.ts", // Your local app schemas
  ],
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

### Provided Tables

| Table Name           | Description                                                         |
| :------------------- | :------------------------------------------------------------------ |
| `users`              | Primary user data (email, password hash, metadata, etc.)            |
| `refreshTokens`      | Tracks active refresh tokens per device/session                     |
| `emailVerifications` | Stores tokens for email verification workflows                      |
| `oauthAccounts`      | Links third-party accounts (e.g., Google) to the main `users` table |

---

## 🗺️ API Reference

### Auth Endpoints (`/auth`)

These routes handle all core authentication flows.

| Method   | Path                        | Access     | Description                                           |
| :------- | :-------------------------- | :--------- | :---------------------------------------------------- |
| `POST`   | `/auth/register`            | Public     | Register a new user account                           |
| `POST`   | `/auth/login`               | Public     | Login via email & password                            |
| `POST`   | `/auth/refresh`             | Public     | Rotate refresh token to get a new access token        |
| `POST`   | `/auth/logout`              | 🔒 Private | Logout (revokes the current session)                  |
| `POST`   | `/auth/logout-all`          | 🔒 Private | Security: Logout from all devices simultaneously      |
| `GET`    | `/auth/sessions`            | 🔒 Private | List all active sessions for the user                 |
| `DELETE` | `/auth/sessions/:id`        | 🔒 Private | Revoke a specific active session                      |
| `GET`    | `/auth/verify-email`        | Public     | Verify email ownership via token                      |
| `POST`   | `/auth/resend-verification` | Public     | Resend the email verification link                    |
| `GET`    | `/auth/google/login`        | Public     | Redirects user to the Google Consent screen (Web)     |
| `GET`    | `/auth/google/callback`     | Public     | Handles the callback code from Google                 |
| `POST`   | `/auth/google/token`        | Public     | Verifies a Google ID token directly (Mobile/SDK flow) |

### User Settings Endpoints (`/api/settings`)

These routes manage user profile data.

| Method | Path                     | Access     | Description                                    |
| :----- | :----------------------- | :--------- | :--------------------------------------------- |
| `GET`  | `/api/settings/profile`  | 🔒 Private | Retrieve the current user's profile            |
| `PUT`  | `/api/settings/profile`  | 🔒 Private | Update basic info (username, full name)        |
| `PUT`  | `/api/settings/password` | 🔒 Private | Authenticated password change                  |
| `PUT`  | `/api/settings/avatar`   | 🔒 Private | Upload and update avatar (Multipart form-data) |

---

## 📦 Exported Modules

The package exports everything you need to build on top of its foundation.

### Routers & Middleware

```typescript
import {
  authRoutes,
  settingRoutes,
  dbMiddleware,
  customLogger,
  authMiddleware,
} from "@bambsdev/auth";
```

### Database Schema & TypeScript Interfaces

```typescript
import { schema, users, refreshTokens } from "@bambsdev/auth";
import type { AuthBindings, AuthVariables, DB } from "@bambsdev/auth";
import type {
  JWTAccessPayload,
  JWTRefreshPayload,
  AuditEvent,
} from "@bambsdev/auth";
```

### Validation Utilities & Services

```typescript
import {
  ImageFilterService,
  parseBody,
  cleanupExpiredTokens,
  cleanupExpiredPasswordResets,
  cleanupExpiredEmailVerifications,
} from "@bambsdev/auth";

import { registerSchema, loginSchema, refreshSchema } from "@bambsdev/auth";
```

### Highlight: `ImageFilterService`

A powerful utility to automatically filter images using Cloudflare AI, preventing inappropriate content uploads.

```typescript
import { ImageFilterService } from "@bambsdev/auth";

const filter = new ImageFilterService(c.env.AI);

// Check if an image is appropriate
const result = await filter.isImageAllowed("https://example.com/image.jpg");
// → { allowed: true } OR { allowed: false, reason: "Inappropriate content detected" }

// Automatic Filtering — returns URL if safe, null if rejected
const safeUrl = await filter.filterImageUrl("https://example.com/image.jpg");
```

---

## 🔐 Security Standards Implemented

- ✅ **JWT Security**: Short-lived Access Tokens + Secure Refresh Token Rotation.
- ✅ **Token Family Tracking**: Automatically detects Token Reuse Attacks and revokes the entire family.
- ✅ **KV Blacklisting**: Immediate invalidation of access tokens upon logout.
- ✅ **Rate Limiting**: Throttling for sensitive routes (Login, Password Reset, Resend Verification, Google Token validation).
- ✅ **OAuth Protection**: CSRF protection via state parameters for Google Web flows.
- ✅ **Hash Standards**: Strict bcrypt-compatible password hashing algorithms.
- ✅ **Mandatory Email Verification**: Prevents unverified accounts from accessing sensitive areas.
- ✅ **AI Content Moderation**: Cloudflare Workers AI prevents malicious or inappropriate avatar uploads.
- ✅ **Audit Trails**: Extensive security logging via Cloudflare Analytics Engine.

---

## 📜 License

ISC License
