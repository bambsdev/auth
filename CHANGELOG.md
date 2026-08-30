# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.4.1] - 2026-08-30

### Added
- **Wildcard Subdomain Matching in `ALLOWED_ORIGINS`**: Added support for wildcard domain patterns (e.g. `*.web-rakkita-dev.pages.dev` or `https://*.web-rakkita-dev.pages.dev`) in `ALLOWED_ORIGINS` to support dynamic preview deployments (such as Cloudflare Pages commit/branch preview URLs) safely.
- **Domain Boundary & Protocol Hardening**: Strict validation preventing prefix/suffix domain spoofing and enforcing protocol safety on redirect URLs.
- **Safe Fallback Redirect Selection**: Hardened OAuth error fallback redirect to ignore wildcard patterns and pick the first concrete origin or `APP_URL`.

## [1.4.0] - 2026-08-27

### Added
- **Multi-Database Support**: Added support for **Cloudflare D1 (SQLite Edge Database)** alongside **PostgreSQL (Hyperdrive)** in a single repository.
- **Explicit Subpath Exports**:
  - `@bambsdev/auth/pg`: Full auth stack and schema for PostgreSQL consumers.
  - `@bambsdev/auth/d1`: Full auth stack and schema for Cloudflare D1 consumers.
  - `@bambsdev/auth`: Shared core utilities, schemas, and agnostic types.
- **Dialect-Specific Schemas**:
  - `src/db/pg/schema.ts`: Drizzle PostgreSQL schema (`pgTable`, `uuid`, `timestamp`, `jsonb`, `pgEnum`).
  - `src/db/d1/schema.ts`: Drizzle SQLite schema (`sqliteTable`, `text` IDs, `integer` timestamp & boolean, `text` JSON).
- **D1 Specific Middleware & Utilities**:
  - `d1Middleware`: Drizzle per-request middleware for Cloudflare D1 (`c.env.DB`).
  - `cleanupExpiredTokensD1`, `cleanupExpiredPasswordResetsD1`, `cleanupExpiredEmailVerificationsD1`: Cron cleanup functions for D1 databases.
- **Database Adapter Layer**:
  - `AuthDbAdapter`: High-performance database abstraction unifying PostgreSQL and D1 operations while preserving dialect-specific transaction capabilities.
- **Documentation & Testing**:
  - `MIGRATION.md`: Comprehensive migration and configuration guide for development teams.
  - Full unit and integration test suite for D1 SQLite adapter.
- **R2 Avatar Upload & Storage**: Cloudflare R2 avatar upload integration with automatic orphan file cleanup.
- **Workers AI Content Moderation**: Integrated `@cf/microsoft/resnet-50` AI vision moderation filter with configurable blocked labels and confidence threshold to automatically filter inappropriate avatar images.
- **OTP Verification Code Flow**: Added 6-digit numeric OTP email verification flow alongside the existing link-based verification.
- **Rate Limiting Protection**: Added IP-based rate limiting on `POST /auth/refresh`.

### Fixed & Hardened (Security & Quality)
- **Automatic Reset Token Invalidation**: `PasswordResetService.createResetToken` now automatically invalidates previous unused reset tokens for the user before creating a new one.
- **Resend Verification Rate Limit Fix**: Rate limit counter for `/resend-verification` is now only incremented after successful code/token generation.
- **Google OAuth Open Redirect Prevention**: Strict `isAllowedRedirectUrl` validation is now enforced in the Google OAuth callback error handler.
- **Eliminated N+1 Queries on Google Login**: Replaced multiple sequential queries with an atomic single `INNER JOIN` query between `oauth_accounts` and `users`.
- **Google Login Avatar Moderation**: User avatar from Google is now properly passed through `ImageFilterService` on subsequent logins.
- **Consolidated Avatar Update Transactions**: Refactored `SettingService.updateAvatarFromUrl` to execute within a single database transaction.
- **Strict Reset Token Validation**: Enforced 64-character lowercase hex format validation (`/^[a-f0-9]+$/`) in `resetPasswordSchema`.
- **Constant-Time Comparison**: Hardened `timingSafeEqual` in `password.ts` to avoid early returns on mismatched string lengths.
- **Atomic Verification Status Checks**: Moved user verification and account status checks inside database transaction locks in `VerificationService.verifyEmailCode`.
- **Sanitized Settings Error Responses**: Server error responses in `setting.factory.ts` now sanitize 500 error messages.
- **Null Safety in AuditService**: Added null-safe guard in `AuditService.log` when Cloudflare `ANALYTICS` dataset binding is not configured.
- **Case-Insensitive Username Uniqueness**: `updateProfile` now normalizes and checks usernames in lowercase to avoid casing collision ambiguities.
- **SSRF Protection on Image Filter**: Added `isSafeUrl()` validation in `ImageFilterService.isImageAllowed()` to block requests to private IP ranges, localhost, cloud metadata endpoints (`169.254.169.254`), and non-HTTP(S) protocols before fetching user-supplied avatar URLs.
- **Atomic Google Account Linking**: INSERT `oauth_accounts` + UPDATE `users` + INSERT `refresh_tokens` on the account-linking path of `GoogleOAuthService.handleGoogleLogin` are now wrapped in a single database transaction to prevent partial writes.
- **Race-Condition-Safe Google Register**: `resolveUniqueUsername` is now called inside the `db.transaction()` block when creating a new Google user to eliminate TOCTOU race conditions on username uniqueness.
- **Safe `deviceInfo` Parsing in `getSessions`**: `JSON.parse` in `AuthService.getSessions` is now wrapped in `try/catch`; a corrupt `deviceInfo` field returns `null` instead of crashing the entire endpoint.
- **Null Guard in `updateAvatarFromUrl`**: Added explicit null-check after `findFirst` in `SettingService.updateAvatarFromUrl` before accessing `currentUser` to prevent `TypeError` on deleted accounts.
- **Rate Limit on `POST /reset-password`**: Added IP-based rate limiting (10 attempts / 5 minutes) on the reset-password endpoint to prevent CPU and database abuse.
- **Google OAuth State Timestamp Validation**: Added explicit age check on the `ts` field inside OAuth state payload; states older than 10 minutes are rejected even if KV TTL has not yet propagated.
- **Refresh Token Cookie `maxAge` Aligned with Token Policy**: Cookie `maxAge` for `refresh_token` is now derived from `TOKEN_POLICY[clientType].refreshToken.expiresInSeconds` instead of a hardcoded 30-day value.
- **Strict Email Verification Token Format**: Query param `token` on `GET /auth/verify-email` now validated as a 64-character lowercase hex string, consistent with `resetPasswordSchema`.
- **Password Reuse Prevention**: `SettingService.changePassword` now rejects `newPassword` that is identical to `currentPassword`.
- **Removed Dead Imports**: Removed unused `verify` import from `hono/jwt` in both `auth.factory.ts` and `setting.factory.ts`.
- **Deduplicated Google Callback Error Redirect Logic**: The catch-block inline redirect logic in the Google OAuth callback handler now delegates to the existing `handleErrorRedirect()` helper, eliminating ~40 lines of duplicate code.
- **Database Index on `refresh_tokens.family_id`**: Added `index("refresh_tokens_family_idx")` on the `familyId` column in both PG and D1 schemas to eliminate full table scans during token reuse detection and family-wide revocation.

### Changed
- Refactored `AuthService`, `RegisterService`, `VerificationService`, `PasswordResetService`, `SettingService`, and `GoogleOAuthService` to be database-agnostic.
- Made `pg` peer dependency optional (`peerDependenciesMeta`) so Cloudflare D1 workers do not require or bundle PostgreSQL drivers.
- Enabled code splitting in `tsup.config.ts` for minimal worker bundle sizes.

### ⚠️ Breaking Changes
- **[BREAKING] Google OAuth Callback — `accessToken` no longer in query string**: The `accessToken` is now passed via **URL fragment** (`#accessToken=...&expiresIn=...`) instead of a query parameter (`?accessToken=...`) when redirecting to the frontend after a successful Google OAuth login. This change prevents token leakage in server logs, browser history, and `Referer` headers (RFC 6750 compliance). **Consumer frontend code that reads `accessToken` from `window.location.search` (query params) must be updated to read from `window.location.hash` (URL fragment).** See `MIGRATION.md` Section 5 for details.
