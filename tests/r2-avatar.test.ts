// tests/r2-avatar.test.ts
//
// Unit tests for R2 avatar operations:
// - extractR2KeyFromUrl (supporting various domains, query params, and mount points)
// - R2UploadService.deleteByUrl

import { describe, test, expect } from "bun:test";
import { extractR2KeyFromUrl, R2UploadService } from "../src/services/r2-upload.service";

describe("R2 Avatar Key Extraction & Deletion Unit Tests (TDD)", () => {
  const uuid = "123e4567-e89b-12d3-a456-426614174000";

  test("should extract key from URL containing query parameters or timestamps", () => {
    const url = `https://dev-back.rakkita.id/settings/avatar-file/auth/avatars/${uuid}.jpg?t=1725678901`;
    const key = extractR2KeyFromUrl(url, "https://pub-xxx.r2.dev");
    expect(key).toBe(`auth/avatars/${uuid}.jpg`);
  });

  test("should extract key from custom mount point (/settings/avatar-file/)", () => {
    const url = `https://dev-back.rakkita.id/settings/avatar-file/auth/avatars/${uuid}.png`;
    const key = extractR2KeyFromUrl(url, undefined);
    expect(key).toBe(`auth/avatars/${uuid}.png`);
  });

  test("should extract key from default API proxy (/api/settings/avatar-file/)", () => {
    const url = `https://myapp.com/api/settings/avatar-file/auth/avatars/${uuid}.webp`;
    const key = extractR2KeyFromUrl(url, undefined);
    expect(key).toBe(`auth/avatars/${uuid}.webp`);
  });

  test("should extract key from BUCKET_PUBLIC_URL", () => {
    const url = `https://pub-avatar.r2.dev/auth/avatars/${uuid}.jpg`;
    const key = extractR2KeyFromUrl(url, "https://pub-avatar.r2.dev");
    expect(key).toBe(`auth/avatars/${uuid}.jpg`);
  });

  test("should extract key from any custom domain containing auth/avatars/", () => {
    const url = `https://custom-cdn.example.org/static/auth/avatars/${uuid}.jpg#hash`;
    const key = extractR2KeyFromUrl(url, undefined);
    expect(key).toBe(`auth/avatars/${uuid}.jpg`);
  });

  test("should return null for external/Google avatar URLs", () => {
    const googleUrl = "https://lh3.googleusercontent.com/a/ACg8ocK123456789=s96-c";
    const key = extractR2KeyFromUrl(googleUrl, "https://pub-xxx.r2.dev");
    expect(key).toBeNull();
  });

  test("should return null for null or empty input", () => {
    expect(extractR2KeyFromUrl(null, undefined)).toBeNull();
    expect(extractR2KeyFromUrl("", undefined)).toBeNull();
  });

  test("R2UploadService.deleteByUrl should call bucket.delete and return key", async () => {
    let deletedKey: string | null = null;
    const mockBucket = {
      delete: async (key: string) => {
        deletedKey = key;
      },
    } as any;

    const r2Service = new R2UploadService(mockBucket, "https://pub-xxx.r2.dev");
    const testUrl = `https://dev-back.rakkita.id/settings/avatar-file/auth/avatars/${uuid}.jpg?t=123`;
    const result = await r2Service.deleteByUrl(testUrl);

    expect(result).toBe(`auth/avatars/${uuid}.jpg`);
    expect(deletedKey).toBe(`auth/avatars/${uuid}.jpg`);
  });

  test("R2UploadService.deleteByUrl should ignore external URLs and return null", async () => {
    let deleteCalled = false;
    const mockBucket = {
      delete: async () => {
        deleteCalled = true;
      },
    } as any;

    const r2Service = new R2UploadService(mockBucket, "https://pub-xxx.r2.dev");
    const googleUrl = "https://lh3.googleusercontent.com/a/ACg8ocK123456789=s96-c";
    const result = await r2Service.deleteByUrl(googleUrl);

    expect(result).toBeNull();
    expect(deleteCalled).toBe(false);
  });
});

if (!(global as any).caches) {
  (global as any).caches = {
    default: {
      put: async () => {},
      match: async () => undefined,
      delete: async () => {},
    },
  };
}

describe("ALLOW_AVATAR_UPLOAD Endpoint Enforcement (TDD)", () => {
  const { createSettingRoutes } = require("../src/routes/factory/setting.factory");
  const { Hono } = require("hono");
  const { sign } = require("hono/jwt");

  const JWT_SECRET = "super-secret-jwt-key-at-least-32-chars-long";

  const buildApp = (envOverrides: any = {}, varOverrides: any = {}) => {
    const app = new Hono();
    app.use("*", async (c: any, next: any) => {
      c.env = {
        JWT_SECRET,
        JWT_REFRESH_SECRET: JWT_SECRET,
        KV: {
          get: async () => null,
          put: async () => {},
          delete: async () => {},
        },
        ...envOverrides,
      };
      c.set("db", {
        query: {
          users: {
            findFirst: async () => ({ id: "test-user-id", avatarUrl: null }),
          },
        },
      });
      if (varOverrides.imageFilterConfig) {
        c.set("imageFilterConfig", varOverrides.imageFilterConfig);
      }
      await next();
    });
    const settingRoutes = createSettingRoutes("pg");
    app.route("/settings", settingRoutes);
    return app;
  };

  const createAuthHeader = async (userId: string = "test-user-id") => {
    const token = await sign(
      {
        sub: userId,
        jti: "test-jti-" + Math.random(),
        type: "access",
        client: "web",
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      JWT_SECRET,
      "HS256",
    );
    return `Bearer ${token}`;
  };

  test("should reject avatar upload with 403 when ALLOW_AVATAR_UPLOAD is false (boolean)", async () => {
    const app = buildApp({ ALLOW_AVATAR_UPLOAD: false });
    const authHeader = await createAuthHeader();
    const formData = new FormData();
    formData.append("avatar", new Blob(["fake-img"], { type: "image/png" }), "avatar.png");

    const res = await app.request("https://localhost/settings/avatar", {
      method: "PUT",
      headers: { Authorization: authHeader },
      body: formData,
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("AVATAR_UPLOAD_DISABLED");
  });

  test("should reject avatar upload with 403 when ALLOW_AVATAR_UPLOAD is 'false' (string)", async () => {
    const app = buildApp({ ALLOW_AVATAR_UPLOAD: "false" });
    const authHeader = await createAuthHeader();
    const formData = new FormData();
    formData.append("avatar", new Blob(["fake-img"], { type: "image/png" }), "avatar.png");

    const res = await app.request("https://localhost/settings/avatar", {
      method: "PUT",
      headers: { Authorization: authHeader },
      body: formData,
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("AVATAR_UPLOAD_DISABLED");
  });

  test("should reject avatar upload when imageFilterConfig.allowAvatarUpload is false", async () => {
    const app = buildApp({}, { imageFilterConfig: { allowAvatarUpload: false } });
    const authHeader = await createAuthHeader();
    const formData = new FormData();
    formData.append("avatar", new Blob(["fake-img"], { type: "image/png" }), "avatar.png");

    const res = await app.request("https://localhost/settings/avatar", {
      method: "PUT",
      headers: { Authorization: authHeader },
      body: formData,
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("AVATAR_UPLOAD_DISABLED");
  });

  test("should allow avatar upload by default (fallback: true) when ALLOW_AVATAR_UPLOAD is undefined", async () => {
    const app = buildApp({}); // no ALLOW_AVATAR_UPLOAD provided
    const authHeader = await createAuthHeader();
    const formData = new FormData();
    formData.append("avatar", new Blob(["fake-img"], { type: "image/png" }), "avatar.png");

    const res = await app.request("https://localhost/settings/avatar", {
      method: "PUT",
      headers: { Authorization: authHeader },
      body: formData,
    });

    // Karena R2_PUBLIC belum dipasang di mock env, statusnya 500 (R2_NOT_CONFIGURED), BUKAN 403 (AVATAR_UPLOAD_DISABLED)
    expect(res.status).not.toBe(403);
    const body = await res.json();
    expect(body?.error?.code).not.toBe("AVATAR_UPLOAD_DISABLED");
  });
});

