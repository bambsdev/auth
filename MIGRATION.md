# 🚀 Panduan Migrasi: Multi-Database Support (v1.4.0)

Dokumen ini ditujukan untuk seluruh pengembang / consumer worker yang menggunakan library **`@bambsdev/auth`**.

Mulai versi **`v1.4.0`**, library ini mendukung dua dialek database secara berdampingan dalam satu repository:
1. **PostgreSQL** (via Hyperdrive / Node-Postgres) di subpath `@bambsdev/auth/pg`
2. **Cloudflare D1 (SQLite)** di subpath `@bambsdev/auth/d1`
3. **Shared Core Utilities & Schemas** di root `@bambsdev/auth`

---

## 📌 Ringkasan Perubahan Penting

| Fitur | PostgreSQL Consumer | Cloudflare D1 Consumer |
| :--- | :--- | :--- |
| **Import Path** | `@bambsdev/auth/pg` | `@bambsdev/auth/d1` |
| **Database Middleware** | `dbMiddleware` (alias `pgMiddleware`) | `dbMiddleware` (alias `d1Middleware`) |
| **Wrangler Binding Database** | `HYPERDRIVE` (Hyperdrive) | `DB` (d1_databases) |
| **Drizzle Dialect Schema** | `drizzle-orm/pg-core` | `drizzle-orm/sqlite-core` |
| **Avatar Storage (R2)** | `R2_PUBLIC` (Didukung) | `R2_PUBLIC` (Didukung) |
| **Workers AI Curation** | `AI` (Didukung) | `AI` (Didukung) |

---

## 🛠️ 1. Migrasi Consumer Worker Eksisting (PostgreSQL)

Jika project worker Anda saat ini menggunakan PostgreSQL / Hyperdrive, Anda cukup mengubah baris import ke subpath `@bambsdev/auth/pg`.

### Perubahan Kode di Worker:

```diff
- import { authRoutes, settingRoutes, dbMiddleware } from "@bambsdev/auth";
- import type { AuthBindings, AuthVariables } from "@bambsdev/auth";
+ import { authRoutes, settingRoutes, dbMiddleware } from "@bambsdev/auth/pg";
+ import type { PgBindings as AuthBindings, PgVariables as AuthVariables } from "@bambsdev/auth/pg";
```

### Konfigurasi `wrangler.jsonc` (PostgreSQL):
```jsonc
{
  "name": "my-pg-auth-worker",
  "hyperdrive": [
    {
      "binding": "HYPERDRIVE",
      "id": "<your-hyperdrive-id>"
    }
  ],
  "kv_namespaces": [
    {
      "binding": "KV",
      "id": "<your-kv-id>"
    }
  ],
  "ai": {
    "binding": "AI"
  },
  "r2_buckets": [
    {
      "binding": "R2_PUBLIC",
      "bucket_name": "my-avatars"
    }
  ]
}
```

---

## ⚡ 2. Menggunakan Library di Consumer Worker Baru (Cloudflare D1)

Jika Anda membuat worker baru atau ingin menggunakan database Cloudflare D1 (SQLite Edge Database):

### Contoh Implementasi di `src/index.ts`:

```ts
import { Hono } from "hono";
import { authRoutes, settingRoutes, dbMiddleware } from "@bambsdev/auth/d1";
import type { D1Bindings, D1Variables } from "@bambsdev/auth/d1";

const app = new Hono<{
  Bindings: D1Bindings;
  Variables: D1Variables;
}>();

// Injeksi middleware D1 per-request
app.use("*", dbMiddleware);

// Pasang routes autentikasi dan pengaturan akun
app.route("/auth", authRoutes);
app.route("/api/settings", settingRoutes);

export default app;
```

### Konfigurasi `wrangler.jsonc` (Cloudflare D1):
```jsonc
{
  "name": "my-d1-auth-worker",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "my-auth-db",
      "database_id": "<your-d1-database-id>"
    }
  ],
  "kv_namespaces": [
    {
      "binding": "KV",
      "id": "<your-kv-id>"
    }
  ],
  "ai": {
    "binding": "AI"
  },
  "r2_buckets": [
    {
      "binding": "R2_PUBLIC",
      "bucket_name": "my-avatars"
    }
  ]
}
```

### Konfigurasi Drizzle Migrations untuk D1 (`drizzle.config.ts` di Consumer):
```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "node_modules/@bambsdev/auth/dist/d1/index.d.ts", // atau import schema langsung
  out: "./drizzle",
  dialect: "sqlite",
});
```

---

## 🧹 3. Cron Cleanup Tokens (Scheduled Event)

Untuk membersihkan refresh token dan verification token yang sudah kadaluarsa secara berkala:

### Untuk PostgreSQL Worker:
```ts
import {
  cleanupExpiredTokens,
  cleanupExpiredPasswordResets,
  cleanupExpiredEmailVerifications,
} from "@bambsdev/auth/pg";

export default {
  async scheduled(event, env, ctx) {
    const connStr = env.LOCAL_DATABASE_URL || env.HYPERDRIVE?.connectionString;
    ctx.waitUntil(cleanupExpiredTokens(connStr));
    ctx.waitUntil(cleanupExpiredPasswordResets(connStr));
    ctx.waitUntil(cleanupExpiredEmailVerifications(connStr));
  },
};
```

### Untuk Cloudflare D1 Worker:
```ts
import {
  cleanupExpiredTokensD1,
  cleanupExpiredPasswordResetsD1,
  cleanupExpiredEmailVerificationsD1,
} from "@bambsdev/auth/d1";

export default {
  async scheduled(event, env, ctx) {
    // Berikan binding env.DB langsung
    ctx.waitUntil(cleanupExpiredTokensD1(env.DB));
    ctx.waitUntil(cleanupExpiredPasswordResetsD1(env.DB));
    ctx.waitUntil(cleanupExpiredEmailVerificationsD1(env.DB));
  },
};
```

---

## 🔒 4. Hardening Keamanan & Validasi (v1.4.0)

Pada versi **`v1.4.0`**, terdapat beberapa hardening dan validasi penting yang perlu diperhatikan:

1. **Format Reset Password Token**:
   - Schema `resetPasswordSchema` kini memvalidasi bahwa token reset wajib berupa string hex 64-karakter (`/^[a-f0-9]+$/`).
   - Jika frontend Anda membuat mock token untuk pengujian lokal, pastikan panjangnya 64 karakter hex.
2. **Rate Limiting Baru**:
   - Endpoint `POST /auth/refresh` kini dilindungi rate limit (maksimal 5 percobaan gagal per 5 menit per IP).
   - Endpoint `POST /auth/resend-verification` kini hanya menaikkan counter rate limit jika akun user valid (mencegah lockout prematur).
3. **Penyelarasan Username Case-Insensitive**:
   - Endpoint `PUT /api/settings/profile` otomatis menormalisasi username menjadi huruf kecil (lowercase) untuk mencegah collision atau duplikasi username dengan variasi kapitalisasi.
4. **Google OAuth Open Redirect Protection**:
   - Parameter `redirectUrl` pada flow Google Login selalu diverifikasi secara *fail-closed* terhadap daftar `ALLOWED_ORIGINS` atau `APP_URL`.

---

## ❓ FAQ & Troubleshooting

1. **Apakah tipe UUID tetap digunakan di D1?**
   - Ya! Di level aplikasi, `id` tetap berupa UUID v4 string yang digenerate oleh `crypto.randomUUID()`. Di level schema SQLite, tipe datanya disimpan sebagai `TEXT`.
2. **Apakah driver `pg` akan ikut ter-bundle di worker D1 saya?**
   - **Tidak.** Subpath export dan tree-shaking memastikan worker D1 tidak memuat paket `pg` atau `node-postgres`, sehingga ukuran bundle worker Anda tetap sangat kecil (< 1MB).

---

## ⚠️ 5. Breaking Change: Google OAuth Callback — Perubahan Delivery `accessToken` (v1.4.0)

> [!CAUTION]
> Jika Anda menggunakan flow **Google OAuth Web** (bukan Mobile ID Token), perubahan ini **wajib** diterapkan di sisi frontend/consumer.

### Perubahan

Sebelum versi ini, setelah pengguna berhasil login via Google OAuth (`GET /auth/google/callback`), library akan me-redirect frontend dengan `accessToken` di **query string URL**:

```
# SEBELUM (tidak aman — deprecated)
https://yourdomain.com/google-callback?accessToken=eyJhbGc...&expiresIn=900&...
```

Mulai versi `v1.4.0`, `accessToken` dikirim via **URL fragment** (`#`):

```
# SESUDAH (aman — RFC 6750 compliant)
https://yourdomain.com/google-callback#accessToken=eyJhbGc...&expiresIn=900&...
```

> **Mengapa ini lebih aman?**
> URL fragment tidak dikirim ke server (tidak masuk di access log, CDN log, atau `Referer` header), sehingga token tidak bocor ke infrastruktur pihak ketiga.

### Cara Update Frontend Consumer

```typescript
// SEBELUM — membaca dari query param (tidak aman)
const params = new URLSearchParams(window.location.search);
const accessToken = params.get("accessToken");
const expiresIn = params.get("expiresIn");

// SESUDAH — membaca dari URL fragment (aman)
const hash = window.location.hash.slice(1); // hapus '#'
const params = new URLSearchParams(hash);
const accessToken = params.get("accessToken");
const expiresIn = params.get("expiresIn");
const isNewUser = params.get("isNewUser") === "true";
const linked = params.get("linked") === "true";
const state = params.get("state");

// Bersihkan fragment dari URL setelah token dibaca
history.replaceState(null, "", window.location.pathname);
```

### Parameter yang Tersedia di Fragment

| Parameter | Tipe | Deskripsi |
| :--- | :--- | :--- |
| `accessToken` | `string` | JWT access token |
| `expiresIn` | `string` (number) | Masa berlaku access token dalam detik |
| `isNewUser` | `string` (`"true"/"false"`) | `true` jika ini registrasi pertama |
| `linked` | `string` (`"true"/"false"`) | `true` jika Google ditautkan ke akun existing |
| `state` | `string` | CSRF state yang dikirim saat memulai OAuth |

> **Catatan:** `refreshToken` tetap dikirim via HttpOnly cookie (`refresh_token`) — tidak berubah sejak versi sebelumnya.

---

## 🗄️ 6. Migrasi Database: Index Baru pada `refresh_tokens` (v1.4.0)

Versi `v1.4.0` menambahkan index baru pada kolom `family_id` di tabel `refresh_tokens` untuk meningkatkan performa saat deteksi reuse attack dan revokasi token seluruh keluarga.

### Untuk PostgreSQL Consumer

Jalankan query berikut sekali pada database Anda:

```sql
-- Tambahkan index pada family_id di refresh_tokens
CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx
  ON refresh_tokens (family_id);
```

Atau jika menggunakan Drizzle Kit dengan consumer schema custom:

```bash
# Generate migration baru dari schema yang diupdate
npx drizzle-kit generate

# Jalankan migration
npx drizzle-kit migrate
```

### Untuk Cloudflare D1 Consumer

```bash
# Generate migration file baru
npx wrangler d1 migrations create my-auth-db add_family_id_index

# Isi file migration yang dibuat dengan:
# CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx
#   ON refresh_tokens (family_id);

# Terapkan ke D1 remote
npx wrangler d1 migrations apply my-auth-db --remote
```

### Dampak Jika Tidak Dijalankan

Tanpa index ini, query revokasi token saat **reuse attack terdeteksi** (mencari semua token dalam satu family) akan melakukan full table scan. Pada table dengan banyak sesi, ini dapat menyebabkan **query lambat**. Sangat disarankan untuk menjalankan migration ini sesegera mungkin.

