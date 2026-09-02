# Changelog

Semua perubahan penting pada paket `@bambsdev/auth` didokumentasikan dalam berkas ini.

Format berkas ini mengacu pada [Keep a Changelog](https://keepachangelog.com/id/1.0.0/),
dan proyek ini mematuhi [Semantic Versioning](https://semver.org/lang/id/).

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
