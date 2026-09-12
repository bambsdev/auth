// tests/handoff.test.ts
//
// Unit & Integration tests for Cross-Client SSO / Mobile-to-Web Handoff feature.
// Tests CacheService, AuthService, and Hono OpenAPI route handlers.

import { describe, test, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { authRoutes } from "../src/routes/index";
import { CacheService } from "../src/services/cache.service";
import { AuthService } from "../src/services/auth.service";
import { sign } from "hono/jwt";

// ── Mock KV and Cache API ────────────────────────────────────────────────────

class MockKV {
  public store = new Map<string, string>();
  async get(key: string) {
    return this.store.get(key) || null;
  }
  async put(key: string, value: string, options?: any) {
    this.store.set(key, value);
  }
  async delete(key: string) {
    this.store.delete(key);
  }
}

class MockCache {
  public store = new Map<string, Response>();
  async put(request: any, response: any) {
    this.store.set(request.url || request, response.clone());
  }
  async match(request: any) {
    const res = this.store.get(request.url || request);
    return res ? res.clone() : undefined;
  }
  async delete(request: any) {
    return this.store.delete(request.url || request);
  }
}

// ── Mock DB ──────────────────────────────────────────────────────────────────

function createMockDb(initialUser?: any) {
  const usersStore = new Map<string, any>();
  const refreshTokensStore = new Map<string, any>();

  if (initialUser) {
    usersStore.set(initialUser.id, { ...initialUser });
  }

  return {
    query: {
      users: {
        findFirst: async ({ where }: any) => {
          for (const u of usersStore.values()) {
            if (where?.userId && u.id === where.userId) return u;
            if (u.id) return u;
          }
          return null;
        },
      },
      refreshTokens: {
        findMany: async () => Array.from(refreshTokensStore.values()),
      },
    },
    insert: (table: any) => ({
      values: async (data: any) => {
        const row = { id: crypto.randomUUID(), ...data, createdAt: new Date() };
        refreshTokensStore.set(row.id, row);
        return [row];
      },
    }),
    update: (table: any) => ({
      set: (data: any) => ({
        where: async () => [],
      }),
    }),
    usersStore,
    refreshTokensStore,
  };
}

describe("Cross-Client SSO / Handoff Token", () => {
  const JWT_SECRET = "test-access-secret-32-chars-long!";
  const JWT_REFRESH = "test-refresh-secret-32-chars-lon!";
  const USER_ID = "11111111-2222-3333-4444-555555555555";

  let mockKv: MockKV;
  let mockCache: MockCache;
  let cacheService: CacheService;

  beforeEach(() => {
    mockKv = new MockKV();
    mockCache = new MockCache();
    cacheService = new CacheService(mockKv as any, mockCache as any);
  });

  describe("CacheService Handoff Methods", () => {
    test("createHandoffToken should generate 64-char hex token and store in KV", async () => {
      const token = await cacheService.createHandoffToken(USER_ID, {
        redirectUrl: "/book/al-hikam",
      }, 180);

      expect(token).toBeDefined();
      expect(typeof token).toBe("string");
      expect(token.length).toBe(64);

      const raw = await mockKv.get(`handoff:${token}`);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed.userId).toBe(USER_ID);
      expect(parsed.redirectUrl).toBe("/book/al-hikam");
    });

    test("consumeHandoffToken should return data and delete token immediately (one-time use)", async () => {
      const token = await cacheService.createHandoffToken(USER_ID, {
        redirectUrl: "/checkout",
      }, 120);

      // First consume: should succeed
      const firstConsume = await cacheService.consumeHandoffToken(token);
      expect(firstConsume).not.toBeNull();
      expect(firstConsume?.userId).toBe(USER_ID);
      expect(firstConsume?.redirectUrl).toBe("/checkout");

      // Second consume: must return null (already deleted)
      const secondConsume = await cacheService.consumeHandoffToken(token);
      expect(secondConsume).toBeNull();
    });

    test("consumeHandoffToken with non-existent token should return null", async () => {
      const result = await cacheService.consumeHandoffToken("non-existent-token-12345");
      expect(result).toBeNull();
    });
  });

  describe("AuthService Handoff Methods", () => {
    test("exchangeHandoff should exchange valid token for web session tokens and user data", async () => {
      const mockUser = {
        id: USER_ID,
        email: "santri@rakkita.id",
        fullName: "Santri Rakkita",
        username: "santri_rakkita",
        avatarUrl: null,
        isActive: true,
        isEmailVerified: true,
        deletedAt: null,
      };
      const mockDb = createMockDb(mockUser);
      const authService = new AuthService(
        mockDb as any,
        cacheService,
        JWT_SECRET,
        JWT_REFRESH,
        "pg",
      );

      const token = await authService.createHandoffToken(USER_ID, "/book/slug-1");
      const exchangeResult = await authService.exchangeHandoff(token);

      expect(exchangeResult.tokens.accessToken).toBeDefined();
      expect(exchangeResult.tokens.refreshToken).toBeDefined();
      expect(exchangeResult.tokens.expiresIn).toBeGreaterThan(0);
      expect(exchangeResult.user.id).toBe(USER_ID);
      expect(exchangeResult.user.email).toBe("santri@rakkita.id");
      expect(exchangeResult.redirectUrl).toBe("/book/slug-1");
    });

    test("exchangeHandoff should throw error if token is invalid or reused", async () => {
      const mockUser = {
        id: USER_ID,
        email: "santri@rakkita.id",
        isActive: true,
        deletedAt: null,
      };
      const mockDb = createMockDb(mockUser);
      const authService = new AuthService(
        mockDb as any,
        cacheService,
        JWT_SECRET,
        JWT_REFRESH,
        "pg",
      );

      const token = await authService.createHandoffToken(USER_ID);
      await authService.exchangeHandoff(token);

      // Re-use attempt must throw
      expect(authService.exchangeHandoff(token)).rejects.toThrow();
    });
  });

  describe("Hono Auth Routes Integration (/handoff/token & /handoff/exchange)", () => {
    let app: Hono;
    let mockDb: any;
    let validAccessToken: string;

    const mockUser = {
      id: USER_ID,
      email: "user@rakkita.id",
      fullName: "User Test",
      username: "usertest",
      avatarUrl: "https://example.com/avatar.png",
      isActive: true,
      isEmailVerified: true,
      deletedAt: null,
    };

    beforeEach(async () => {
      mockKv = new MockKV();
      mockCache = new MockCache();
      global.caches = { default: mockCache } as any;

      mockDb = createMockDb(mockUser);

      // Buat valid Bearer token
      validAccessToken = await sign(
        {
          sub: USER_ID,
          jti: crypto.randomUUID(),
          type: "access",
          client: "mobile",
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600,
        },
        JWT_SECRET,
      );

      app = new Hono();
      app.use("*", async (c, next) => {
        (c as any).env = {
          KV: mockKv,
          JWT_SECRET,
          JWT_REFRESH_SECRET: JWT_REFRESH,
          COOKIE_DOMAIN: "",
          CLIENT_URL: "https://rakkita.id",
          ALLOWED_ORIGINS: "https://rakkita.id",
        };
        c.set("db" as any, mockDb);
        await next();
      });

      app.route("/auth", authRoutes);
    });

    test("POST /auth/handoff/token should return 401 if not authenticated", async () => {
      const res = await app.request("/auth/handoff/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirectUrl: "/library" }),
      });

      expect(res.status).toBe(401);
      const json = await res.json() as any;
      expect(json.error).toBeDefined();
    });

    test("POST /auth/handoff/token should successfully generate handoff token when authenticated", async () => {
      const res = await app.request("/auth/handoff/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${validAccessToken}`,
        },
        body: JSON.stringify({ redirectUrl: "/book/al-hikam", expiresInSeconds: 120 }),
      });

      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.data.token).toBeDefined();
      expect(json.data.token.length).toBe(64);
      expect(json.data.expiresIn).toBe(120);
      expect(json.data.redirectUrl).toBe("/book/al-hikam");
      expect(json.data.expiresAt).toBeDefined();
    });

    test("POST /auth/handoff/exchange should redeem token, set cookie, and return web session", async () => {
      // 1. Create handoff token via authenticated request
      const tokenRes = await app.request("/auth/handoff/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${validAccessToken}`,
        },
        body: JSON.stringify({ redirectUrl: "/payment/RT-123" }),
      });
      const tokenJson = await tokenRes.json() as any;
      const handoffToken = tokenJson.data.token;

      // 2. Exchange token from web client (unauthenticated)
      const exchangeRes = await app.request("/auth/handoff/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: handoffToken }),
      });

      expect(exchangeRes.status).toBe(200);
      const exchangeJson = await exchangeRes.json() as any;
      expect(exchangeJson.data.message).toBe("Handoff berhasil");
      expect(exchangeJson.data.accessToken).toBeDefined();
      expect(exchangeJson.data.tokenType).toBe("Bearer");
      expect(exchangeJson.data.redirectUrl).toBe("/payment/RT-123");
      expect(exchangeJson.data.user.id).toBe(USER_ID);
      expect(exchangeJson.data.user.email).toBe("user@rakkita.id");

      // Verify Set-Cookie header for refresh token
      const setCookieHeader = exchangeRes.headers.get("Set-Cookie");
      expect(setCookieHeader).toBeDefined();
      expect(setCookieHeader).toContain("refresh_token=");
      expect(setCookieHeader).toContain("HttpOnly");

      // 3. Trying to exchange the same token again must fail (401)
      const secondExchange = await app.request("/auth/handoff/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: handoffToken }),
      });
      expect(secondExchange.status).toBe(401);
      const secondJson = await secondExchange.json() as any;
      expect(secondJson.error.code).toBe("INVALID_HANDOFF_TOKEN");
    });

    test("POST /auth/handoff-token alias route should also work seamlessly", async () => {
      const res = await app.request("/auth/handoff-token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${validAccessToken}`,
        },
        body: JSON.stringify({ redirectUrl: "/settings" }),
      });

      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.data.token).toBeDefined();
      expect(json.data.redirectUrl).toBe("/settings");
    });
  });
});
