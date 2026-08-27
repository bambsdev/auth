// tests/d1/auth.service.d1.test.ts
import { describe, test, expect, beforeEach } from "bun:test";
import { AuthService } from "../../src/services/auth.service";
import { CacheService } from "../../src/services/cache.service";
import { hashPassword } from "../../src/utils/password";
import { hashToken } from "../../src/utils/hash";
import { users, refreshTokens } from "../../src/db/d1/schema";
import { createAuthDbAdapter } from "../../src/db/adapter";

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

describe("AuthService D1 Unit Tests (TDD)", () => {
  let mockKv: MockKV;
  let mockCache: MockCache;
  let cacheService: CacheService;
  let authService: AuthService;
  let mockD1Db: any;
  let usersStore: any[];
  let refreshTokensStore: any[];

  beforeEach(() => {
    mockKv = new MockKV();
    mockCache = new MockCache();
    cacheService = new CacheService(mockKv as any, mockCache as any);

    usersStore = [];
    refreshTokensStore = [];

    mockD1Db = {
      query: {
        users: {
          findFirst: async (opts: any) => {
            if (!opts?.where) return usersStore[0] || null;
            return usersStore.find((u) => {
              if (opts.where) {
                // simple search
                return true;
              }
              return true;
            }) || null;
          },
        },
        refreshTokens: {
          findMany: async (opts: any) => {
            return refreshTokensStore.filter((t) => !t.isRevoked);
          },
        },
      },
      insert: (table: any) => ({
        values: (data: any) => ({
          returning: async () => [data],
          then: async (resolve: any) => {
            if (table === users) usersStore.push(data);
            if (table === refreshTokens) refreshTokensStore.push(data);
            if (resolve) resolve([data]);
            return [data];
          },
        }),
      }),
      update: (table: any) => ({
        set: (data: any) => ({
          where: (cond: any) => ({
            returning: async () => [{ id: "test-id" }],
            then: async (resolve: any) => {
              if (resolve) resolve([{ id: "test-id" }]);
              return [{ id: "test-id" }];
            },
          }),
        }),
      }),
      transaction: async (cb: any) => {
        return await cb({
          select: (cols?: any) => ({
            from: (table: any) => ({
              where: (cond: any) => ({
                limit: (lim: number) => refreshTokensStore.slice(0, lim),
                then: async (resolve: any) => {
                  if (resolve) resolve(refreshTokensStore);
                  return refreshTokensStore;
                },
              }),
            }),
          }),
          update: (table: any) => ({
            set: (data: any) => ({
              where: (cond: any) => ({
                then: async (resolve: any) => {
                  if (resolve) resolve([{ id: "token-1" }]);
                  return [{ id: "token-1" }];
                },
              }),
            }),
          }),
          insert: (table: any) => ({
            values: (data: any) => ({
              then: async (resolve: any) => {
                refreshTokensStore.push(data);
                if (resolve) resolve([data]);
                return [data];
              },
            }),
          }),
        });
      },
    };

    authService = new AuthService(
      mockD1Db,
      cacheService,
      "test-access-secret-1234567890123456",
      "test-refresh-secret-1234567890123456",
      "d1",
    );
  });

  test("should be configured with D1 dialect", () => {
    expect(authService.adapter.dialect).toBe("d1");
  });

  test("should successfully generate token pair for D1", async () => {
    const tokens = await authService.generateTokenPair("user-123", "web");
    expect(tokens.accessToken).toBeDefined();
    expect(tokens.refreshToken).toBeDefined();
    expect(tokens.expiresIn).toBeGreaterThan(0);
  });

  test("should validate access token properly", async () => {
    const tokens = await authService.generateTokenPair("user-123", "web");
    const payload = await authService.validateAccessToken(tokens.accessToken);
    expect(payload.sub).toBe("user-123");
    expect(payload.client).toBe("web");
  });

  test("should blacklist access token on logout", async () => {
    const tokens = await authService.generateTokenPair("user-123", "web");
    const payload = await authService.validateAccessToken(tokens.accessToken);

    await authService.logout(payload.jti, payload.exp, tokens.refreshToken);
    const isBlacklisted = await cacheService.isTokenBlacklisted(payload.jti);
    expect(isBlacklisted).toBe(true);
  });
});
