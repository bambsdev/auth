// src/routes/factory/shared.ts
import type { Context } from "hono";
import type { SharedAuthBindings } from "../../types/index";

export type AppContext = Context<{ Bindings: any; Variables: any }>;

/**
 * Validasi apakah URL redirect diizinkan (fail-closed).
 */
export function isAllowedRedirectUrl(
  redirectUrl: string | undefined,
  env: SharedAuthBindings,
): boolean {
  if (!redirectUrl) return false;
  try {
    const parsed = new URL(redirectUrl);
    const allowedRaw = env.ALLOWED_ORIGINS ?? "";
    const allowedOrigins = allowedRaw
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);

    if (env.APP_URL) {
      try {
        allowedOrigins.push(new URL(env.APP_URL).origin);
      } catch {}
    }

    // Fail-closed: jika tidak ada origin yang terdaftar, tolak redirect URL eksternal
    if (allowedOrigins.length === 0) {
      return false;
    }

    return allowedOrigins.some((origin) => {
      try {
        return new URL(origin).origin === parsed.origin;
      } catch {
        return origin === parsed.origin || origin === redirectUrl;
      }
    });
  } catch {
    return false;
  }
}

/**
 * Mengambil IP klien dari header CF-Connecting-IP terpercaya.
 */
export function getIp(c: AppContext): string {
  return c.req.header("CF-Connecting-IP") ?? "127.0.0.1";
}

/**
 * Standarisasi error response dengan penanganan AppError dan database constraint errors.
 */
export function errorResponse(c: AppContext, err: any) {
  const isAppError =
    typeof err.status === "number" && typeof err.code === "string";
  let status = isAppError ? err.status : 500;
  let code = isAppError ? err.code : "INTERNAL_ERROR";
  let message = isAppError ? err.message : "Terjadi kesalahan pada server";

  if (
    !isAppError &&
    (err.code === "23505" ||
      String(err.message).includes("duplicate key") ||
      String(err.message).includes("unique constraint") ||
      String(err.message).includes("UNIQUE constraint") ||
      String(err.message).includes("Failed query"))
  ) {
    status = 409;
    code = "CONFLICT";
    message = "Data sudah terdaftar atau terjadi duplikasi";
  }

  if (status >= 500) {
    console.error("[Internal Error]", err);
  }

  return c.json({ error: { code, message } }, status as any);
}
