# @bambsdev/auth

> 🔐 Drop-in authentication module for **Hono + Cloudflare Workers + Drizzle ORM** apps.

Full-featured auth system yang bisa langsung di-mount ke project Hono manapun — tanpa perlu menulis ulang logic register, login, JWT, OAuth, session management, atau user settings.

## Install

```bash
bun add @bambsdev/auth
```

## Peer Dependencies

Package ini membutuhkan dependensi berikut di consumer app:

```bash
bun add hono drizzle-orm pg zod
```

## Quick Start

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

// Logger — format: [ISO_TIMESTAMP] METHOD /path - STATUS (TIMINGms) IP:xxx
app.use("*", customLogger());

// DB Middleware — inject Drizzle instance ke setiap request
app.use("/auth/*", dbMiddleware);
app.use("/api/*", dbMiddleware);

// Mount auth routes
app.route("/auth", authRoutes);
app.route("/api/settings", settingRoutes);

export default app;
```

Itu saja. Semua endpoint auth langsung tersedia. ✅

---

## Cloudflare Bindings (wrangler.toml)

Library ini membaca konfigurasi dari `c.env` secara otomatis. Consumer app wajib mendefinisikan binding berikut di `wrangler.toml`:

```toml
name = "my-app"
main = "src/index.ts"
compatibility_date = "2024-12-01"

[vars]
APP_URL = "https://myapp.com"

# Secrets (set via `wrangler secret put`)
# JWT_SECRET
# JWT_REFRESH_SECRET
# RESEND_API_KEY
# GOOGLE_CLIENT_ID
# GOOGLE_CLIENT_SECRET

[[hyperdrive]]
binding = "HYPERDRIVE"
id = "your-hyperdrive-id"

[[kv_namespaces]]
binding = "KV"
id = "your-kv-id"

[[analytics_engine_datasets]]
binding = "ANALYTICS"

[ai]
binding = "AI"
```

### Environment Secrets

Set via CLI:

```bash
wrangler secret put JWT_SECRET
wrangler secret put JWT_REFRESH_SECRET
wrangler secret put RESEND_API_KEY
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
```

---

## Database Schema (Drizzle Migrations)

Library ini meng-export Drizzle schema yang siap pakai. Untuk menjalankan migrasi di consumer app:

```typescript
// drizzle.config.ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./node_modules/@bambsdev/auth/dist/index.js",
  // atau import langsung:
  // schema: "./src/db/schema.ts" (jika kamu re-export)
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

Atau re-export schema di project-mu:

```typescript
// src/db/schema.ts (di consumer app)
export * from "@bambsdev/auth"; // re-export semua auth tables
// Tambahkan table khusus app-mu di sini
```

### Tables yang tersedia:

| Table                | Deskripsi                        |
| -------------------- | -------------------------------- |
| `users`              | Data user (email, password, dll) |
| `refreshTokens`      | Refresh token per device/session |
| `emailVerifications` | Token verifikasi email           |
| `oauthAccounts`      | Akun OAuth terhubung (Google)    |

---

## Auth Endpoints

Setelah di-mount ke `/auth`, endpoint berikut tersedia:

| Method   | Path                        | Auth   | Deskripsi                        |
| -------- | --------------------------- | ------ | -------------------------------- |
| `POST`   | `/auth/register`            | Public | Registrasi user baru             |
| `POST`   | `/auth/login`               | Public | Login dengan email & password    |
| `POST`   | `/auth/refresh`             | Public | Rotate refresh token             |
| `POST`   | `/auth/logout`              | 🔒     | Logout (revoke current session)  |
| `POST`   | `/auth/logout-all`          | 🔒     | Logout dari semua device         |
| `GET`    | `/auth/sessions`            | 🔒     | Lihat semua sesi aktif           |
| `DELETE` | `/auth/sessions/:id`        | 🔒     | Revoke sesi tertentu             |
| `GET`    | `/auth/verify-email`        | Public | Verifikasi email via token       |
| `POST`   | `/auth/resend-verification` | Public | Kirim ulang email verifikasi     |
| `GET`    | `/auth/google/login`        | Public | Redirect ke Google consent (web) |
| `GET`    | `/auth/google/callback`     | Public | Handle callback dari Google      |
| `POST`   | `/auth/google/token`        | Public | Verify Google ID token (mobile)  |

## Settings Endpoints

Setelah di-mount ke `/api/settings`:

| Method | Path                     | Auth | Deskripsi            |
| ------ | ------------------------ | ---- | -------------------- |
| `GET`  | `/api/settings/profile`  | 🔒   | Get user profile     |
| `PUT`  | `/api/settings/profile`  | 🔒   | Update username/name |
| `PUT`  | `/api/settings/password` | 🔒   | Change password      |
| `PUT`  | `/api/settings/avatar`   | 🔒   | Update avatar URL    |

---

## Exports

### Routes

```typescript
import { authRoutes, settingRoutes } from "@bambsdev/auth";
```

### Middleware

```typescript
import { dbMiddleware, customLogger, authMiddleware } from "@bambsdev/auth";
```

### DB Schema & Types

```typescript
import { schema, users, refreshTokens } from "@bambsdev/auth";
import type { AuthBindings, AuthVariables, DB } from "@bambsdev/auth";
import type { JWTAccessPayload, JWTRefreshPayload } from "@bambsdev/auth";
```

### Utilities

```typescript
import { ImageFilterService, parseBody } from "@bambsdev/auth";
import { registerSchema, loginSchema, refreshSchema } from "@bambsdev/auth";
```

### ImageFilterService

Utility untuk memfilter gambar (avatar, cover, dll) menggunakan Cloudflare AI:

```typescript
import { ImageFilterService } from "@bambsdev/auth";

const filter = new ImageFilterService(c.env.AI);

// Cek apakah gambar diizinkan
const result = await filter.isImageAllowed("https://example.com/image.jpg");
// → { allowed: true } atau { allowed: false, reason: "..." }

// Filter otomatis — return URL jika lolos, null jika ditolak
const url = await filter.filterImageUrl("https://example.com/image.jpg");
// → "https://example.com/image.jpg" atau null
```

---

## Security Features

- ✅ JWT access + refresh token rotation
- ✅ Refresh token family tracking (deteksi reuse attack)
- ✅ Access token blacklisting via KV
- ✅ Rate limiting (login, resend verification, Google token)
- ✅ CSRF protection untuk Google OAuth (state parameter)
- ✅ Password hashing (bcrypt-compatible)
- ✅ Email verification flow
- ✅ AI-powered image filtering (Cloudflare Workers AI)
- ✅ Audit logging via Analytics Engine

---

## License

ISC
