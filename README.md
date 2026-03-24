# @bambsdev/auth

> 🔐 Drop-in authentication module for **Hono + Cloudflare Workers + Drizzle ORM** apps.

Full-featured auth system yang bisa langsung di-mount ke project Hono manapun — tanpa perlu menulis ulang logic register, login, JWT, OAuth, session management, password reset, atau user settings (termasuk avatar upload ke R2).

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
BUCKET_PUBLIC_URL = "https://pub-xxxx.r2.dev" # (Opsional) URL public bucket R2

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

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "your-bucket-name"
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
| `passwordResets`     | Token reset password             |
| `oauthAccounts`      | Akun OAuth terhubung (Google)    |

---

## Cron Jobs (Cleanup)

Library ini menyediakan fungsi utilitas untuk menghapus expired tokens secara berkala. Tambahkan cron ini pada worker-mu:

```typescript
// src/index.ts
import { cleanupExpiredTokens, cleanupExpiredPasswordResets } from "@bambsdev/auth";

export default {
  // ... handler fetch
  async scheduled(event, env, ctx) {
    if (event.cron === "0 0 * * *") { // Setiap hari jam 00:00
      ctx.waitUntil(cleanupExpiredTokens(env.DATABASE_URL));
      ctx.waitUntil(cleanupExpiredPasswordResets(env.DATABASE_URL));
    }
  }
}
```

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
| `POST`   | `/auth/forgot-password`     | Public | Request email reset password     |
| `POST`   | `/auth/reset-password`      | Public | Reset password dengan token      |
| `GET`    | `/auth/google/login`        | Public | Redirect ke Google consent (web) |
| `GET`    | `/auth/google/callback`     | Public | Handle callback dari Google      |
| `POST`   | `/auth/google/token`        | Public | Verify Google ID token (mobile)  |

## Settings Endpoints

Setelah di-mount ke `/api/settings`:

| Method | Path                        | Auth | Deskripsi                         |
| ------ | --------------------------- | ---- | --------------------------------- |
| `GET`  | `/api/settings/profile`     | 🔒   | Get user profile                  |
| `PUT`  | `/api/settings/profile`     | 🔒   | Update username/name              |
| `PUT`  | `/api/settings/password`    | 🔒   | Change password                   |
| `PUT`  | `/api/settings/avatar`      | 🔒   | Update avatar (form-data or JSON) |
| `GET`  | `/api/settings/avatar-file/*`| Public| Proxy avatar file (fallback jika tak ada BUCKET_PUBLIC_URL) |

---

## Validasi & Keamanan Endpoint Avatar

Endpoint `/api/settings/avatar` dapat menerima body dengan 2 macam format:

1. **`multipart/form-data`**: Avatar diupload langsung dengan R2 Bucket. 
   - File divalidasi dengan AI Cloudflare.
   - User secara otomatis tervalidasi sebelum image masuk ke bucket R2.
   - File avatar lama di R2 dihapus otomatis setelah update berhasil.
2. **`application/json`**: Hanya mengirimkan Field `{ "avatarUrl": "https://..." }` atau `null` (menghapus avatar). File lama di R2 akan dihapus otomatis jika URL diubah. Image juga akan otomatis terverifikasi via Cloudflare AI.

---

## Exports

### Routes & Middleware

```typescript
import { authRoutes, settingRoutes } from "@bambsdev/auth";
import { dbMiddleware, customLogger, authMiddleware } from "@bambsdev/auth";
import type { AuthBindings, AuthVariables, DB } from "@bambsdev/auth";
import type { JWTAccessPayload, JWTRefreshPayload } from "@bambsdev/auth";
```

### Schema & Validation

```typescript
import { schema, users, refreshTokens, passwordResets } from "@bambsdev/auth";

// Zod schemas
import { 
  registerSchema, loginSchema, refreshSchema,
  forgotPasswordSchema, resetPasswordSchema, parseBody 
} from "@bambsdev/auth";
```

### Services (Reusable untuk Consumer App)

Kompilasi paket ini mengekspor service yang bisa digunakan kembali oleh consumer app:

#### 1. ImageFilterService (Cloudflare Worker AI Image Filtering)
Filter gambar mengandung unsur tak beradab / tak layak dengan AI:
```typescript
import { ImageFilterService } from "@bambsdev/auth";

const filter = new ImageFilterService(c.env.AI);
// { allowed: false, reason: "NSFW content" }
const result = await filter.isImageAllowed("https://example.com/image.jpg"); 
```

#### 2. R2UploadService (R2 File Bucket Service)
Kamu bisa menggunakan fungsi yang sama persis seperti Avatar Upload untuk resource lain misalnya Foto Produk / Thumbnail Artikel:
```typescript
import { R2UploadService, extractR2KeyFromUrl } from "@bambsdev/auth";

const r2 = new R2UploadService(c.env.BUCKET, c.env.BUCKET_PUBLIC_URL);

// Upload dari tipe arrayBuffer (biasanya parse form-data)
const { key, url } = await r2.upload(buffer, "image/png", "products/thumbnails");

// Menghapus data secara atomic by URL lama
await r2.deleteByUrl(oldUrl, "/api/products/thumbnail-file/");
```

---

## Security Features

- ✅ JWT access + refresh token rotation
- ✅ Refresh token family tracking (deteksi reuse attack)
- ✅ Access token blacklisting via KV
- ✅ Rate limiting (login, forget password, resend verification, Google token)
- ✅ CSRF protection untuk Google OAuth (state parameter)
- ✅ Password hashing (bcrypt-compatible)
- ✅ Email verification flow & Password Reset
- ✅ Cloudflare Workers AI integration for Image filtering
- ✅ Audit logging via Analytics Engine

---

## License

ISC
