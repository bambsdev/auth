# Changelog

Semua perubahan penting pada paket `@bambsdev/auth` didokumentasikan dalam berkas ini.

Format berkas ini mengacu pada [Keep a Changelog](https://keepachangelog.com/id/1.0.0/),
dan proyek ini mematuhi [Semantic Versioning](https://semver.org/lang/id/).

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
