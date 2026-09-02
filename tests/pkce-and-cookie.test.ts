import { describe, expect, test } from "bun:test";
import { generateCodeVerifier, generateCodeChallenge, base64UrlEncode } from "../src/utils/pkce";
import { getAuthCookieOptions, clearAuthCookies } from "../src/routes/factory/auth.factory";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createAuthRoutes } from "../src/routes/factory/auth.factory";

describe("RFC 7636 PKCE Utilities & Google OAuth PKCE", () => {
  test("generateCodeVerifier produces RFC 7636 compliant string (43-128 chars, URL-safe)", () => {
    const verifier = generateCodeVerifier(64);
    expect(typeof verifier).toBe("string");
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    // URL-safe unreserved characters only
    expect(verifier).toMatch(/^[A-Za-z0-9\-_.~]+$/);
  });

  test("generateCodeChallenge produces deterministic SHA-256 base64url challenge", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge1 = await generateCodeChallenge(verifier);
    const challenge2 = await generateCodeChallenge(verifier);

    expect(challenge1).toBe(challenge2);
    expect(challenge1.length).toBeGreaterThanOrEqual(43);
    // Base64url without padding (=)
    expect(challenge1).not.toContain("=");
    expect(challenge1).not.toContain("+");
    expect(challenge1).not.toContain("/");
  });

  test("base64UrlEncode handles arbitrary binary data correctly", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    const encoded = base64UrlEncode(bytes);
    expect(encoded).not.toContain("=");
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
  });
});

describe("Adaptive Auth Cookie Options (Universal & Configurable)", () => {
  test("returns SameSite=None and no domain when COOKIE_DOMAIN is not set (dev/staging/localhost)", () => {
    const mockContext = {
      env: {},
    };

    const opts = getAuthCookieOptions(mockContext, 86400);
    expect(opts.sameSite).toBe("None");
    expect(opts.secure).toBe(true);
    expect(opts.httpOnly).toBe(true);
    expect(opts.path).toBe("/");
    expect(opts.domain).toBeUndefined();
    expect(opts.maxAge).toBe(86400);
  });

  test("uses configured COOKIE_DOMAIN with default SameSite=Lax when provided", () => {
    const mockContext = {
      env: { COOKIE_DOMAIN: ".example.com" },
    };

    const opts = getAuthCookieOptions(mockContext, 86400);
    expect(opts.sameSite).toBe("Lax");
    expect(opts.secure).toBe(true);
    expect(opts.httpOnly).toBe(true);
    expect(opts.path).toBe("/");
    expect(opts.domain).toBe(".example.com");
    expect(opts.maxAge).toBe(86400);
  });

  test("respects explicit COOKIE_SAME_SITE and COOKIE_SECURE overrides", () => {
    const mockContext = {
      env: {
        COOKIE_DOMAIN: ".custom-domain.com",
        COOKIE_SAME_SITE: "Strict",
        COOKIE_SECURE: "false",
      },
    };

    const opts = getAuthCookieOptions(mockContext);
    expect(opts.sameSite).toBe("Strict");
    expect(opts.domain).toBe(".custom-domain.com");
    expect(opts.secure).toBe(false);
  });

  test("clearAuthCookies executes cookie deletion with domain and path safely", async () => {
    const app = new OpenAPIHono();
    app.post("/test-logout", (c) => {
      (c as any).env = { COOKIE_DOMAIN: ".example.com" };
      clearAuthCookies(c);
      return c.json({ ok: true });
    });

    const res = await app.request("/test-logout", {
      method: "POST",
      headers: { host: "api.example.com" },
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("Set-Cookie");
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain("refresh_token=");
    expect(setCookie).toContain("Domain=.example.com");
  });
});
