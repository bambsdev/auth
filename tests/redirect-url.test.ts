// tests/redirect-url.test.ts
import { describe, test, expect } from "bun:test";
import { isAllowedRedirectUrl, isOriginMatching } from "../src/routes/factory/shared";

describe("isOriginMatching & isAllowedRedirectUrl", () => {
  test("exact matches work as expected", () => {
    const target = new URL("https://myapp.com/dashboard");
    expect(isOriginMatching("https://myapp.com", target)).toBe(true);
    expect(isOriginMatching("myapp.com", target)).toBe(true);
    expect(isOriginMatching("https://otherapp.com", target)).toBe(false);
  });

  test("wildcard matches Cloudflare Pages subdomains (*.web-rakkita-dev.pages.dev)", () => {
    const target1 = new URL("https://commit-123abc.web-rakkita-dev.pages.dev/auth/callback");
    const target2 = new URL("https://web-rakkita-dev.pages.dev/auth/callback");
    const target3 = new URL("https://sub.nested.web-rakkita-dev.pages.dev/login");

    // With protocol in pattern
    expect(isOriginMatching("https://*.web-rakkita-dev.pages.dev", target1)).toBe(true);
    expect(isOriginMatching("https://*.web-rakkita-dev.pages.dev", target2)).toBe(true);
    expect(isOriginMatching("https://*.web-rakkita-dev.pages.dev", target3)).toBe(true);

    // Without protocol in pattern
    expect(isOriginMatching("*.web-rakkita-dev.pages.dev", target1)).toBe(true);
    expect(isOriginMatching("*.web-rakkita-dev.pages.dev", target2)).toBe(true);
  });

  test("rejects spoofed domains with prefix or different suffix", () => {
    const malicious1 = new URL("https://evil-web-rakkita-dev.pages.dev/callback");
    const malicious2 = new URL("https://web-rakkita-dev.pages.dev.evil.com/callback");
    const malicious3 = new URL("https://notweb-rakkita-dev.pages.dev/callback");

    expect(isOriginMatching("https://*.web-rakkita-dev.pages.dev", malicious1)).toBe(false);
    expect(isOriginMatching("https://*.web-rakkita-dev.pages.dev", malicious2)).toBe(false);
    expect(isOriginMatching("https://*.web-rakkita-dev.pages.dev", malicious3)).toBe(false);
  });

  test("enforces protocol if specified in pattern", () => {
    const httpTarget = new URL("http://commit-123abc.web-rakkita-dev.pages.dev/callback");
    expect(isOriginMatching("https://*.web-rakkita-dev.pages.dev", httpTarget)).toBe(false);
  });

  test("isAllowedRedirectUrl with ALLOWED_ORIGINS comma-separated", () => {
    const env = {
      ALLOWED_ORIGINS: "https://myapp.com, https://*.web-rakkita-dev.pages.dev, *.preview.pages.dev",
      APP_URL: "https://api.myapp.com",
    };

    expect(isAllowedRedirectUrl("https://myapp.com/dashboard", env)).toBe(true);
    expect(isAllowedRedirectUrl("https://abc123.web-rakkita-dev.pages.dev/google-callback", env)).toBe(true);
    expect(isAllowedRedirectUrl("https://pr-45.preview.pages.dev/oauth", env)).toBe(true);
    expect(isAllowedRedirectUrl("https://api.myapp.com/callback", env)).toBe(true);

    // Reject non-allowed origins
    expect(isAllowedRedirectUrl("https://evil.com/phishing", env)).toBe(false);
    expect(isAllowedRedirectUrl("https://evil-web-rakkita-dev.pages.dev/callback", env)).toBe(false);
    expect(isAllowedRedirectUrl("javascript:alert(1)", env)).toBe(false);
    expect(isAllowedRedirectUrl(undefined, env)).toBe(false);
  });

  test("isAllowedRedirectUrl fail-closed when ALLOWED_ORIGINS is empty", () => {
    const env = {
      ALLOWED_ORIGINS: "",
      APP_URL: undefined,
    };
    expect(isAllowedRedirectUrl("https://myapp.com", env)).toBe(false);
  });
});
