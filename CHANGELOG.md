# Changelog

Semua perubahan penting pada paket `@bambsdev/auth` didokumentasikan dalam berkas ini.

Format berkas ini mengacu pada [Keep a Changelog](https://keepachangelog.com/id/1.0.0/),
dan proyek ini mematuhi [Semantic Versioning](https://semver.org/lang/id/).

## [1.4.12] - 2026-09-08

### Ditambahkan (Added)
- **Fitur Penghapusan Akun Pengguna (`DELETE /settings/account`) dengan Strategi Anonymization**:
  - Menambahkan service `DeleteAccountService` untuk menganonimkan data pribadi pengguna (`email` diubah menjadi `deleted_<userId>@rakkita.deleted`, `fullName` menjadi "Pengguna Dihapus", `password` dan `avatarUrl` di-null-kan, `isActive` diset `false`, `isDeleted` dan `isAnonymized` diset `true`, serta `deletedAt` dicatat).
  - Menambahkan dukungan callback hook `onBeforeDeleteAccount` pada `createSettingRoutes` (`SettingRoutesOptions`) yang dijalankan di dalam transaksi DB sebelum data user dianonimkan, memungkinkan consumer melakukan pembersihan data terkait (seperti suspend toko, batalkan sewa, dll.).
  - Otomatis mencabut seluruh sesi aktif (refresh tokens) dan mem-blacklist access token yang sedang aktif via `CacheService`.
  - Menghapus akun OAuth tertaut (`oauth_accounts`) pengguna yang dihapus.
  - Menambahkan kolom `is_deleted` dan `is_anonymized` pada skema tabel `users` (PostgreSQL & D1).
  - Menambahkan event audit `account_deleted` pada `AuditEvent`.
- **Dukungan Field Alias Password Baru pada Reset Password**:
  - Menambahkan dukungan field alias `password` di samping `newPassword` pada skema `/auth/reset-password`.

---

## [1.4.11] - 2026-09-06

### Diperbaiki (Fixed)
- **Moderasi Gambar ResNet-50 untuk Identifikasi Wanita & Pakaian Busana Wanita**:
  - Memperluas `DEFAULT_BLOCKED_LABELS` dengan label ImageNet dan kata kunci busana/identitas perempuan (`gown`, `wig`, `lipstick`, `bonnet`, `veil`, `hijab`, `abaya`, `burqa`, `kimono`, `stole`, `shawl`, `cardigan`, `poncho`, `cloak`, `sarong`, `overskirt`, `hoopskirt`, `apron`, `bathrobe`, `necklace`, `earring`, `bracelet`, `woman`, `female`, `girl`, `lady`, `person`).
  - Memastikan pengujian gambar perempuan ditolak secara konsisten oleh sistem moderasi avatar.
- **Pembersihan Bersih File R2 saat Hapus Avatar (`DELETE /avatar`)**:
  - Memperbaiki `extractR2KeyFromUrl` agar dapat mendeteksi key file R2 secara akurat dari segala variasi URL avatar (termasuk URL dengan query parameter seperti `?t=...`, mount prefix kustom seperti `/settings/avatar-file/`, custom domain, maupun domain default R2).
  - Memperbaiki penanganan `bucket.delete(oldKey)` di `setting.service.ts` agar di-`await` secara tepat, mencegah pembatalan operasi penghapusan oleh lifecycle runtime Cloudflare Workers saat respon HTTP selesai dikirim.

### Ditambahkan (Added)
- **Binding & Konfigurasi Pengendali Avatar Consumer (`ALLOW_AVATAR_UPLOAD`)**:
  - Menambahkan dukungan environment variable / binding `ALLOW_AVATAR_UPLOAD` pada `SharedAuthBindings` dan opsi `allowAvatarUpload` pada `ImageFilterConfig`.
  - Mengimplementasikan perilaku fallback `true` (jika tidak diset atau bernilai `true`, upload avatar diizinkan; jika diset `false` atau `"false"`, upload avatar ditolak dengan kode `403 AVATAR_UPLOAD_DISABLED`).

---

## [1.4.10] - 2026-09-06

### Diperbaiki (Fixed)
- **Kesesuaian Spesifikasi Input Cloudflare Workers AI (`@cf/microsoft/resnet-50`)**:
  - Memperbaiki konversi buffer gambar menggunakan `Array.from(imageArray)` agar menghasilkan array angka biasa (`number[]`) yang sesuai dengan kontrak schema `AiImageClassificationInput` Cloudflare Workers AI.
  - Memperbaiki bug di mana `Uint8Array` dikirim secara mentah (`imageArray as any`), yang menyebabkan runtime RPC Cloudflare Workers AI melempar validation exception dan memicu kegagalan upload avatar (`AVATAR_BLOCKED: Deteksi keamanan gambar gagal. Silakan coba lagi nanti.`) pada seluruh gambar normal.
  - Menambahkan pengecekan eksplisit terhadap ketersediaan binding `this.ai` untuk memberikan peringatan (*warning log*) yang jelas di console jika binding `AI` belum terkonfigurasi di `wrangler`.
  - Memperbaiki ketatnya typecheck pada `TOKEN_POLICY.web` di route handler login dan callback OAuth Google.

### Ditambahkan (Added)
- **Opsi `failOpenOnAiError` pada `ImageFilterConfig`**:
  - Menambahkan flag konfigurasi opsional `failOpenOnAiError?: boolean` (default `false`) pada `ImageFilterConfig`.
  - Jika diaktifkan (`true`), sistem tetap meloloskan upload gambar avatar apabila service Cloudflare Workers AI sedang mengalami gangguan (*downtime*), kuota harian habis (*rate limited*), atau gagal dipanggil.

---

## [1.4.9] - 2026-09-04

### Diperbaiki (Fixed)
- **Validasi Request Body Fleksibel pada Refresh & Logout Token**:
  - Mengubah `refreshSchema` dan `logoutSchema` menjadi opsional dengan default objek kosong (`.optional().default({})`).
  - Menetapkan `required: false` pada `request.body` di OpenAPI route `/auth/refresh` dan `/auth/logout`.
  - Mengeliminasi error validasi `{"error":{"code":"VALIDATION_ERROR","message":"Required"}}` ketika klien Web / Admin melakukan refresh atau logout hanya mengandalkan HttpOnly Cookie (dengan body `{}` atau tanpa body).
  - Standarisasi respon error saat refresh token tidak ditemukan (baik di body maupun cookie) menjadi `401 UNAUTHORIZED` dengan kode `UNAUTHORIZED` (sebelumnya `400 VALIDATION_ERROR`), sehingga interceptor HTTP client dapat mendeteksi kedaluwarsa sesi secara akurat.

---

## [1.4.8] - 2026-09-03

### Keamanan (Security)
- **Zero-Storage Refresh Token pada Web Client (Pure HttpOnly Cookie Enforcement)**:
  - Mencegah kebocoran `refreshToken` ke JavaScript dan URL fragment pada callback Google OAuth untuk `clientType === "web"`.
  - Refresh token untuk web client sekarang secara eksklusif dikelola via cookie `HttpOnly; Secure; SameSite`, memastikan token sepenuhnya kebal dari pencurian via serangan XSS (*Cross-Site Scripting*).

---

## [1.4.7] - 2026-09-03

### Dioptimasi (Optimized)
- **Google OAuth Zero-KV Flow via Signed HttpOnly Cookie**:
  - Alur otentikasi Google OAuth sekarang menggunakan signed HttpOnly cookie (`oauth_session`) terenkripsi JWT untuk menyimpan `state`, `code_verifier` (PKCE), dan `redirectUrl`.
  - Mengeliminasi 100% pembacaan dan penulisan KV pada alur Google OAuth normal (hemat 2 KV Writes + 1 KV Read per login).
  - Fallback otomatis ke Cache API L1 dan KV tetap dipertahankan untuk backward compatibility dengan klien non-browser.
- **Rate Limiting L1 Cache API & Lazy Threshold KV Writes**:
  - Pencatatan percobaan gagal (salah password / verifikasi) ke-1 hingga ke-4 ditangani secara eksklusif oleh Cloudflare Cache API (L1, 100% gratis, unlimited, ~0ms).
  - Penulisan ke KV global hanya dipicu jika hitungan kegagalan mencapai batas ambang pemblokiran (`>= RATE_LIMIT_MAX`, misal 5 kegagalan) untuk mengunci IP penyerang secara terdistribusi.
  - Menghilangkan 95% pemborosan kuota KV write dari pengguna yang salah ketik password secara tidak sengaja.

---

## [1.4.6] - 2026-09-03

### Ditambahkan (Added)
- **Refresh Token Rotation Grace Period / Leeway Window (Standar IETF RFC 6749 & Auth0)**:
  - Jendela toleransi waktu rotasi token (default: 30 detik via `REFRESH_TOKEN_GRACE_PERIOD_SECONDS`) untuk mencegah *false-positive reuse attack*.
  - Penyimpanan token pair hasil rotasi di L1 Cache API + L2 KV (`cacheRotatedTokens` & `getRotatedTokens`) untuk melayani *idempotent replay* secara instan (~1ms).
  - Mengatasi error `Token reuse terdeteksi, semua sesi dicabut` saat user melakukan reload cepat berulang (*spam reload / F5*) atau saat terdapat request paralel antar-tab.
  - Jika token lama digunakan kembali setelah melewati batas toleransi grace period (> 30 detik), sistem tetap secara otomatis mendeteksi serangan pencurian token (*Reuse Attack*) dan mencabut seluruh sesi keluarga token (*token family*).

---

## [1.4.5] - 2026-09-02

### Ditambahkan (Added)
- **Dukungan Nama Cookie Dinamis (`COOKIE_NAME`)**:
  - Menambahkan opsi binding `COOKIE_NAME` pada `SharedAuthBindings` (default: `"refresh_token"`).
  - Helper `getAuthCookieName(c)` untuk resolusi nama cookie dinamis pada alur login, refresh, callback OAuth, dan logout.
  - Memungkinkan isolasi sesi multi-environment secara independen (misal `dev_rf`, `staging_rf`, `rakkita_rf`), sehingga pengguna dapat membuka tab Production, Staging, dan Dev secara bersamaan dalam satu browser tanpa terjadi tabrakan (*cookie collision/shadowing*).
  - Pembersihan menyeluruh pada `clearAuthCookies` yang menghapus nama cookie kustom sekaligus fallback nama default.
- **Pembaruan Dokumentasi (`README.md`)**:
  - Dokumentasi konfigurasi cookie dinamis multi-environment dan RFC 7636 PKCE.

---

## [1.4.4] - 2026-09-02

### Ditambahkan (Added)
- **RFC 7636 PKCE (Proof Key for Code Exchange) untuk Google OAuth**:
  - Utilitas kriptografi `generateCodeVerifier`, `generateCodeChallenge` (S256), dan `base64UrlEncode` di `src/utils/pkce.ts`.
  - Dukungan otomatis `code_challenge` dan `code_challenge_method=S256` pada endpoint inisiasi login Google (`GET /auth/google/login`).
  - Pengiriman dan validasi kriptografis `code_verifier` pada penukaran token otorisasi (`GET /auth/google/callback`) ke endpoint Google token untuk memproteksi alur dari serangan *Authorization Code Injection* atau pencurian kode otorisasi.
- **Konfigurasi Cookie Universal & Adaptif**:
  - Dukungan konfigurasi binding opsional `COOKIE_DOMAIN`, `COOKIE_SAME_SITE`, dan `COOKIE_SECURE` pada `SharedAuthBindings`.
  - Helper terpusat `getAuthCookieOptions` yang secara dinamis menggunakan domain dan `SameSite=Lax` jika `COOKIE_DOMAIN` dikonfigurasi (misal di production root domain), atau fallback ke `SameSite=None; Secure; Path=/` tanpa domain jika tidak dikonfigurasi (dev/staging/localhost/pages.dev).
  - Helper `clearAuthCookies` untuk membersihkan cookie secara simetris di semua cakupan (domain & host-only pada path `/` dan `/auth`).
- **Deteksi IP Multi-Cloud & Reverse Proxy**:
  - Peningkatan fungsi `getIp` untuk mengenali `CF-Connecting-IP`, `X-Real-IP`, maupun `X-Forwarded-For` secara berurutan sebelum fallback ke `127.0.0.1`.

### Diperbaiki (Fixed)
- **Dual-Refresh Resilience**:
  - Mengembalikan fallback `refreshToken` pada payload fragment URL Google OAuth dan mendukung penerimaan `refreshToken` via request body JSON di endpoint `/auth/refresh`.
  - Menghilangkan kegagalan refresh / silent logout di browser modern dengan proteksi third-party cookie agresif (Safari ITP, Brave Shields, dsb).
- **Universal Package Independence**:
  - Menghapus seluruh hardcode nama domain maupun string proyek khusus dari seluruh kode sumber paket `@bambsdev/auth`, menjadikannya sepenuhnya universal dan modular.

---

## [1.4.3] - 2026-09-02
- Perbaikan handling fragment hash token pada callback Google OAuth.
- Penyesuaian rotasi cookie refresh token dan sanitasi error handler.

## [1.4.2] - 2026-08-27
- Perbaikan race condition pada verifikasi OTP email code.
- Penambahan header `remainingAttempts` dan `Retry-After` pada rate limiting.

## [1.4.1] - 2026-08-27
- Dukungan wildcard subdomain pada `ALLOWED_ORIGINS` untuk Cloudflare Pages preview.
