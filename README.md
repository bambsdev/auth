# @bambsdev/auth

> 🔐 **The Complete Authentication Solution** for Hono, Cloudflare Workers, and Drizzle ORM.

`@bambsdev/auth` is a production-ready, type-safe authentication package designed specifically for the Cloudflare ecosystem. It provides everything from standard JWT auth and session management to Google OAuth, customizable AI-filtered avatar uploads, customizable verification email flows (OTP / Link), and automated OpenAPI/Swagger documentation.

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
- **AI Integration**: Cloudflare Workers AI (utilizing `@cf/microsoft/resnet-50` for image safety classification)
- **Observability**: Cloudflare Analytics Engine (for standard Audit Logging)

---

## ✨ Key Features

### 🛡️ Core Authentication & Customizable OTP/Link Flow
- **Flexible Verification Methods**: Choose between standard verification **links** or **6-digit OTP codes** (`verificationMethod: "code" | "link"`).
- **Security & Session Management**:
  - JWT Access tokens combined with secure Refresh token rotation.
  - Refresh token family tracking (automatically detects and revokes reused/stolen tokens).
  - List active sessions, revoke specific sessions, or execute a global "Logout all devices" command.
- **Configurable TTL & Templates**: Set custom verification code TTL (`verificationCodeTtlMinutes`) and custom email templates.

### 🌐 Google OAuth Integration
- **Web Flow**: Standard redirect-based authentication.
- **Mobile Flow**: Direct Google ID Token validation tailored for Native SDKs (Android/iOS).
- **Smart Account Linking**: Automatically links new Google logins to existing email/password registrations while intelligently preserving custom user data.

### 👤 User Settings & Avatar Uploads (R2 + AI-Filtered)
- **Built-in Safety Filter**: Powered by Cloudflare Workers AI using `@cf/microsoft/resnet-50` model.
- **Independent & Decoupled**: The library is 100% independent. No external image-filter package needed.
- **Flexible Rules**: By default, it allows humans and pets but blocks swimwear, underwear, and offensive content (`bikini`, `brassiere`, `miniskirt`, `maillot`, `diaper`, `sex`, `sexy`, `vulgar`).
- **Customizable rules**: Consumers can inject custom labels and confidence thresholds directly via Hono context variable `imageFilterConfig` (no code changes or library recompilation needed).

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
  type EmailConfig,
} from "@bambsdev/auth";
import type { AuthBindings, AuthVariables } from "@bambsdev/auth";

const app = new Hono<{ Bindings: AuthBindings; Variables: AuthVariables }>();

// Logger — Format: [ISO_TIMESTAMP] METHOD /path - STATUS (TIMINGms) IP:xxx
app.use("*", customLogger());

// DB Middleware — Injects the Drizzle DB instance into every request
app.use("/auth/*", dbMiddleware);
app.use("/api/*", dbMiddleware);

// ─── Verification Flow Configuration ───
const emailConfig: EmailConfig = {
  from: "No-Reply <noreply@myapp.com>",
  verificationMethod: "code", // "code" (OTP) atau "link" (URL)
  verificationCodeTtlMinutes: 10,
  resetPasswordBaseUrl: "https://myapp.com",
  templates: {
    verification: (codeOrUrl) => `Kode verifikasi Anda adalah: ${codeOrUrl}`,
  }
};

// ─── Image Filter Configuration ───
const imageFilterConfig = {
  enabled: true,
  blockedLabels: ["bikini", "brassiere", "sex", "sexy", "vulgar"],
  confidenceThreshold: 0.15
};

app.use("*", async (c, next) => {
  c.set("emailConfig", emailConfig);
  c.set("imageFilterConfig", imageFilterConfig); // Inject custom image rules
  await next();
});

// Mount the routes
app.route("/auth", authRoutes);
app.route("/api/settings", settingRoutes);

export default app;
```

---

## ⚙️ Configuration (Wrangler Bindings)

Define the following bindings in your `wrangler.toml`:

```toml
[vars]
BUCKET_PUBLIC_URL = "https://xxx.r2.dev"
EMAIL_FROM = "No reply <noreply@xxxxx.com>"

# Secrets (Set these via `wrangler secret put`)
# JWT_SECRET, JWT_REFRESH_SECRET, RESEND_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET

[[hyperdrive]]
binding = "HYPERDRIVE"
id = "your-hyperdrive-id"

[[r2_buckets]]
binding = "R2_PUBLIC"
bucket_name = "your-bucket-name"

[[kv_namespaces]]
binding = "KV"
id = "your-kv-id"

[[analytics_engine_datasets]]
binding = "ANALYTICS"

[ai]
binding = "AI"
```

---

## 🗄️ Database Schema & Migrations

Drizzle migrations config `drizzle.config.ts`:

```typescript
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: [
    "./node_modules/@bambsdev/auth/dist/index.js",
    "./src/db/schema.ts",
  ],
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

---

## 🗺️ API Reference

### Auth Endpoints (`/auth`)

| Method   | Path                        | Access     | Description                                           |
| :------- | :-------------------------- | :--------- | :---------------------------------------------------- |
| `POST`   | `/auth/register`            | Public     | Register a new user account                           |
| `POST`   | `/auth/login`               | Public     | Login via email & password                            |
| `POST`   | `/auth/refresh`             | Public     | Rotate refresh token to get a new access token        |
| `POST`   | `/auth/logout`              | 🔒 Private | Logout (revokes the current session)                  |
| `POST`   | `/auth/logout-all`          | 🔒 Private | Security: Logout from all devices simultaneously      |
| `GET`    | `/auth/sessions`            | 🔒 Private | List all active sessions for the user                 |
| `DELETE` | `/auth/sessions/:id`        | 🔒 Private | Revoke a specific active session                      |
| `GET`    | `/auth/verify-email`        | Public     | Link Flow: Verify email ownership via token           |
| `POST`   | `/auth/verify-email-code`   | Public     | Code Flow (OTP): Verify email via 6-digit OTP code    |
| `POST`   | `/auth/resend-verification` | Public     | Resend the email verification OTP code or link        |
| `GET`    | `/auth/google/login`        | Public     | Redirects user to the Google Consent screen (Web)     |
| `GET`    | `/auth/google/callback`     | Public     | Handles the callback code from Google                 |
| `POST`   | `/auth/google/token`        | Public     | Verifies a Google ID token directly (Mobile/SDK flow) |

### User Settings Endpoints (`/api/settings`)

| Method | Path                     | Access     | Description                                    |
| :----- | :----------------------- | :--------- | :--------------------------------------------- |
| `GET`  | `/api/settings/profile`  | 🔒 Private | Retrieve the current user's profile            |
| `PUT`  | `/api/settings/profile`  | 🔒 Private | Update basic info (username, full name)        |
| `PUT`  | `/api/settings/password` | 🔒 Private | Authenticated password change                  |
| `PUT`  | `/api/settings/avatar`   | 🔒 Private | Upload and update avatar (Multipart form-data) |

---

## Highlight: `ImageFilterService`

A powerful utility to automatically filter images using Cloudflare Workers AI.

```typescript
import { ImageFilterService } from "@bambsdev/auth";

const filter = new ImageFilterService(c.env.AI, c.var.imageFilterConfig);

// Check if an image is appropriate
const result = await filter.isImageAllowed("https://example.com/image.jpg");
// → { allowed: true } OR { allowed: false, reason: "Terdeteksi konten tidak pantas (bikini) ..." }
```

---

## 📜 Changelog

### v1.3.9
- **🛠️ AI Safety Classification**: Switched from object detection model to `@cf/microsoft/resnet-50` (1000 categories) for more granular swimwear and underwear detection.
- **👤 Looser Default Filtering**: By default, human faces and pets are allowed. Swimwear, underwear, and offensive content keywords (e.g. `sex`, `sexy`, `vulgar`) are blocked.
- **⚙️ Consumer Configuration**: Added `imageFilterConfig` context variables, allowing consumers to fully customize rules (blocked labels and confidence thresholds) directly without recompiling the library.
- **📨 OTP Verification**: Added support for 6-digit OTP codes via `verify-email-code` endpoint and configurable TTL.

### v1.3.4
- **🛡️ Security & UX**: Refined `avatarUrl` synchronization logic. The system now strictly preserves existing custom avatars and only pulls from Google for new account creations.

---

## 📜 License

ISC License
