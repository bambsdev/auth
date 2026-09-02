// src/routes/factory/shared.ts
import type { Context } from "hono";
import type { SharedAuthBindings } from "../../types/index";

export type AppContext = Context<{ Bindings: any; Variables: any }>;

/**
 * Memeriksa apakah URL target cocok dengan pola origin yang diizinkan (mendukung exact match & wildcard domain).
 */
export function isOriginMatching(pattern: string, parsedTarget: URL): boolean {
  if (!pattern) return false;
  const trimmed = pattern.trim();
  if (!trimmed) return false;

  // 1. Direct exact match dengan parsedTarget.origin
  if (trimmed === parsedTarget.origin) {
    return true;
  }

  // 2. Ekstrak protocol dan host dari pattern
  let patternProtocol = "";
  let patternHost = trimmed;

  if (trimmed.includes("://")) {
    const splitIndex = trimmed.indexOf("://");
    patternProtocol = trimmed.slice(0, splitIndex + 1); // contoh: "https:" atau "http:"
    patternHost = trimmed.slice(splitIndex + 3);
  }

  // Jika pattern menyertakan protokol, harus cocok dengan target URL
  if (patternProtocol && parsedTarget.protocol !== patternProtocol) {
    return false;
  }

  // Hilangkan path atau trailing slash jika ada
  const slashIdx = patternHost.indexOf("/");
  if (slashIdx !== -1) {
    patternHost = patternHost.slice(0, slashIdx);
  }

  // Ekstrak port jika ada
  let patternPort: string | undefined;
  if (patternHost.includes(":")) {
    const parts = patternHost.split(":");
    patternHost = parts[0]!;
    patternPort = parts[1];
  }

  // Validasi port jika ditentukan dalam pattern
  if (patternPort !== undefined && patternPort !== "*") {
    const targetPort = parsedTarget.port || (parsedTarget.protocol === "https:" ? "443" : "80");
    const expectedPort = patternPort || (patternProtocol === "https:" ? "443" : "80");
    if (parsedTarget.port !== patternPort && targetPort !== expectedPort) {
      return false;
    }
  }

  const targetHost = parsedTarget.hostname.toLowerCase();
  const patHost = patternHost.toLowerCase();

  // Exact hostname match
  if (patHost === targetHost) {
    return true;
  }

  // Wildcard hostname match (contoh: *.example.pages.dev)
  if (patHost.startsWith("*.")) {
    const rootDomain = patHost.slice(2);
    if (targetHost === rootDomain || targetHost.endsWith(`.${rootDomain}`)) {
      return true;
    }
  }

  return false;
}

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
    // Hanya izinkan protokol http dan https untuk redirect aman
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }

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

    return allowedOrigins.some((origin) => isOriginMatching(origin, parsed));
  } catch {
    return false;
  }
}

/**
 * Mengambil IP klien dari header edge terpercaya (CF-Connecting-IP, X-Real-IP, X-Forwarded-For).
 */
export function getIp(c: AppContext): string {
  return (
    c.req.header("CF-Connecting-IP") ||
    c.req.header("X-Real-IP") ||
    c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "127.0.0.1"
  );
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
