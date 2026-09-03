// tests/auth.service.test.ts
//
// Unit tests for AuthService.
// Mock Drizzle ORM DB client, CacheService (KV & Cache API).

import { describe, test, expect, beforeEach } from "bun:test";
import { AuthService } from "../src/services/auth.service";
import { CacheService } from "../src/services/cache.service";
import { hashPassword } from "../src/utils/password";
import { hashToken } from "../src/utils/hash";
import { users, refreshTokens } from "../src/db/schema";

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

// ── Drizzle Condition Values Extractor ────────────────────────────────────────

function extractConditionValues(obj: any): any[] {
  if (!obj) return [];
  const results: any[] = [];
  
  if (obj && Array.isArray(obj.queryChunks)) {
    for (const chunk of obj.queryChunks) {
      if (chunk && typeof chunk === "object") {
        if ("table" in chunk && "name" in chunk) {
          continue;
        }
        if (Array.isArray(chunk.queryChunks)) {
          results.push(...extractConditionValues(chunk));
          continue;
        }
        if ("value" in chunk) {
          if (Array.isArray(chunk.value)) {
            continue;
          }
          results.push(chunk.value);
        }
      }
    }
  }

  if (obj && Array.isArray(obj.conditions)) {
    for (const cond of obj.conditions) {
      results.push(...extractConditionValues(cond));
    }
  }
  
  return results;
}

// ── Mock DB ──────────────────────────────────────────────────────────────────

describe("AuthService Unit Tests (TDD)", () => {
  let mockKv: MockKV;
  let mockCache: MockCache;
  let cacheService: CacheService;
  let dbStore: {
    users: any[];
    refreshTokens: any[];
  };

  const JWT_SECRET = "access-secret-key-1234567890";
  const JWT_REFRESH_SECRET = "refresh-secret-key-1234567890";

  beforeEach(() => {
    mockKv = new MockKV();
    mockCache = new MockCache();
    cacheService = new CacheService(mockKv as any, mockCache as any);
    dbStore = {
      users: [],
      refreshTokens: [],
    };
  });

  // Helper to construct mock DB
  const createMockDb = () => {
    const mockDb = {
      query: {
        users: {
          findFirst: async (options: any) => {
            const condVals = extractConditionValues(options?.where);
            if (condVals.length > 0) {
              return dbStore.users.find(u => condVals.includes(u.email) || condVals.includes(u.username)) || null;
            }
            return dbStore.users[0] || null;
          }
        },
        refreshTokens: {
          findMany: async (options: any) => {
            const condVals = extractConditionValues(options?.where);
            let list = dbStore.refreshTokens;
            if (condVals.length > 0) {
              list = list.filter(r => condVals.includes(r.userId));
            }
            return list.filter(r => !r.isRevoked && r.expiresAt > new Date());
          }
        }
      },
      update: (table: any) => {
        return {
          set: (values: any) => {
            return {
              where: (condition: any) => {
                const condVals = extractConditionValues(condition);
                if (table === users) {
                  const user = dbStore.users.find(u => condVals.includes(u.id));
                  if (user) {
                    Object.assign(user, values);
                  }
                } else if (table === refreshTokens) {
                  dbStore.refreshTokens.forEach(r => {
                    const matchesHash = condVals.includes(r.tokenHash);
                    const matchesUserId = condVals.includes(r.userId);
                    const matchesId = condVals.includes(r.id);
                    const matchesFamilyId = condVals.includes(r.familyId);
                    if (matchesHash || matchesUserId || matchesId || matchesFamilyId) {
                      Object.assign(r, values);
                    }
                  });
                }
                return {
                  returning: (fields: any) => {
                    const updatedTokens = dbStore.refreshTokens.filter(r => 
                      condVals.includes(r.id) || condVals.includes(r.tokenHash)
                    );
                    return updatedTokens.length > 0 ? updatedTokens : [{ id: condVals[0] }];
                  }
                };
              }
            };
          }
        };
      },
      insert: (table: any) => {
        return {
          values: (values: any) => {
            dbStore.refreshTokens.push({
              id: crypto.randomUUID(),
              isRevoked: false,
              createdAt: new Date(),
              lastUsedAt: null,
              ...values,
            });
            return Promise.resolve();
          }
        };
      },
      transaction: async (callback: (tx: any) => Promise<any>) => {
        const mockTx = {
          query: mockDb.query,
          select: () => {
            return {
              from: (table: any) => {
                return {
                  where: (condition: any) => {
                    const condVals = extractConditionValues(condition);
                    const getResults = () => {
                      if (table === refreshTokens) {
                        return dbStore.refreshTokens.filter(r => 
                          condVals.includes(r.tokenHash) || condVals.includes(r.familyId)
                        );
                      }
                      return [];
                    };
                    const forObj = {
                      for: (lockMode: string) => {
                        const results = getResults();
                        return Object.assign(Promise.resolve(results), {
                          limit: (limit: number) => Promise.resolve(results.slice(0, limit))
                        });
                      }
                    };
                    return Object.assign(forObj, {
                      limit: (limit: number) => Promise.resolve(getResults().slice(0, limit))
                    });
                  }
                };
              }
            };
          },
          update: (table: any) => {
            return {
              set: (values: any) => {
                return {
                  where: (condition: any) => {
                    const condVals = extractConditionValues(condition);
                    dbStore.refreshTokens.forEach(r => {
                      const matchesHash = condVals.includes(r.tokenHash);
                      const matchesUserId = condVals.includes(r.userId);
                      const matchesId = condVals.includes(r.id);
                      const matchesFamilyId = condVals.includes(r.familyId);
                      if (matchesHash || matchesUserId || matchesId || matchesFamilyId) {
                        Object.assign(r, values);
                      }
                    });
                    return Promise.resolve();
                  }
                };
              }
            };
          },
          insert: (table: any) => {
            return {
              values: (values: any) => {
                dbStore.refreshTokens.push({
                  id: crypto.randomUUID(),
                  isRevoked: false,
                  createdAt: new Date(),
                  lastUsedAt: null,
                  ...values,
                });
                return Promise.resolve();
              }
            };
          }
        };
        return callback(mockTx);
      }
    };
    return mockDb as any;
  };

  // ── Test Login Flow ────────────────────────────────────────────────────────

  test("should successfully login a valid user", async () => {
    const hashed = await hashPassword("Password123");
    dbStore.users.push({
      id: "user-1",
      email: "test@example.com",
      password: hashed,
      isActive: true,
      isEmailVerified: true,
      username: "testuser",
      fullName: "Test User",
    });

    const db = createMockDb();
    const service = new AuthService(db, cacheService, JWT_SECRET, JWT_REFRESH_SECRET);

    const tokens = await service.login("test@example.com", "Password123", "web");
    expect(tokens.accessToken).toBeDefined();
    expect(tokens.refreshToken).toBeDefined();
    expect(tokens.expiresIn).toBe(900); // web client standard accessToken expiresIn is 15 mins (900s)

    // Verify token was stored in mock DB
    expect(dbStore.refreshTokens.length).toBe(1);
    expect(dbStore.refreshTokens[0].userId).toBe("user-1");
  });

  test("should throw error if email is not found", async () => {
    const db = createMockDb();
    const service = new AuthService(db, cacheService, JWT_SECRET, JWT_REFRESH_SECRET);

    expect(
      service.login("nonexistent@example.com", "Password123", "web")
    ).rejects.toThrow("Email atau password salah");
  });

  test("should throw error if user is soft-deleted", async () => {
    const hashed = await hashPassword("Password123");
    dbStore.users.push({
      id: "user-deleted",
      email: "deleted@example.com",
      password: hashed,
      isActive: true,
      isEmailVerified: true,
      deletedAt: new Date(),
    });

    const db = createMockDb();
    const service = new AuthService(db, cacheService, JWT_SECRET, JWT_REFRESH_SECRET);

    expect(
      service.login("deleted@example.com", "Password123", "web")
    ).rejects.toThrow("Email atau password salah");
  });

  test("should throw error if email is not verified", async () => {
    const hashed = await hashPassword("Password123");
    dbStore.users.push({
      id: "user-2",
      email: "unverified@example.com",
      password: hashed,
      isActive: true,
      isEmailVerified: false,
    });

    const db = createMockDb();
    const service = new AuthService(db, cacheService, JWT_SECRET, JWT_REFRESH_SECRET);

    expect(
      service.login("unverified@example.com", "Password123", "web")
    ).rejects.toThrow("Silakan verifikasi email Anda terlebih dahulu");
  });

  test("should throw error for incorrect password", async () => {
    const hashed = await hashPassword("Password123");
    dbStore.users.push({
      id: "user-3",
      email: "test@example.com",
      password: hashed,
      isActive: true,
      isEmailVerified: true,
    });

    const db = createMockDb();
    const service = new AuthService(db, cacheService, JWT_SECRET, JWT_REFRESH_SECRET);

    expect(
      service.login("test@example.com", "WrongPassword", "web")
    ).rejects.toThrow("Email atau password salah");
  });

  // ── Test Token Validation ──────────────────────────────────────────────────

  test("should validate a correct access token", async () => {
    const hashed = await hashPassword("Password123");
    dbStore.users.push({
      id: "user-1",
      email: "test@example.com",
      password: hashed,
      isActive: true,
      isEmailVerified: true,
    });

    const db = createMockDb();
    const service = new AuthService(db, cacheService, JWT_SECRET, JWT_REFRESH_SECRET);

    const tokens = await service.login("test@example.com", "Password123", "web");
    const payload = await service.validateAccessToken(tokens.accessToken);

    expect(payload.sub).toBe("user-1");
    expect(payload.type).toBe("access");
    expect(payload.client).toBe("web");
  });

  test("should reject blacklisted access token", async () => {
    const hashed = await hashPassword("Password123");
    dbStore.users.push({
      id: "user-1",
      email: "test@example.com",
      password: hashed,
      isActive: true,
      isEmailVerified: true,
    });

    const db = createMockDb();
    const service = new AuthService(db, cacheService, JWT_SECRET, JWT_REFRESH_SECRET);

    const tokens = await service.login("test@example.com", "Password123", "web");
    const payload = await service.validateAccessToken(tokens.accessToken);

    // Blacklist the token jti
    await cacheService.blacklistToken(payload.jti, 3600);

    expect(
      service.validateAccessToken(tokens.accessToken)
    ).rejects.toThrow("Token sudah di-revoke");
  });

  // ── Test Refresh Token Rotation ────────────────────────────────────────────

  test("should rotate refresh token successfully", async () => {
    const hashed = await hashPassword("Password123");
    dbStore.users.push({
      id: "user-1",
      email: "test@example.com",
      password: hashed,
      isActive: true,
      isEmailVerified: true,
    });

    const db = createMockDb();
    const service = new AuthService(db, cacheService, JWT_SECRET, JWT_REFRESH_SECRET);

    const tokens = await service.login("test@example.com", "Password123", "web");
    const refreshHash = await hashToken(tokens.refreshToken);

    // Locate refresh token in mock DB store
    const storedToken = dbStore.refreshTokens.find(r => r.tokenHash === refreshHash);
    expect(storedToken).toBeDefined();

    // Perform rotation
    const newTokens = await service.rotateRefreshToken(tokens.refreshToken);
    expect(newTokens.accessToken).toBeDefined();
    expect(newTokens.refreshToken).toBeDefined();
    expect(newTokens.refreshToken).not.toBe(tokens.refreshToken);

    // Verify old refresh token is marked as revoked
    expect(storedToken!.isRevoked).toBe(true);
  });

  test("should detect refresh token reuse attack and revoke family", async () => {
    const hashed = await hashPassword("Password123");
    dbStore.users.push({
      id: "user-1",
      email: "test@example.com",
      password: hashed,
      isActive: true,
      isEmailVerified: true,
    });

    const db = createMockDb();
    // Test reuse detection with gracePeriod = 0 (or expired grace period)
    const service = new AuthService(db, cacheService, JWT_SECRET, JWT_REFRESH_SECRET, "pg", 0);

    const tokens = await service.login("test@example.com", "Password123", "web");
    
    // First rotation (success)
    await service.rotateRefreshToken(tokens.refreshToken);

    // Second rotation using the same token (reuse attack!)
    expect(
      service.rotateRefreshToken(tokens.refreshToken)
    ).rejects.toThrow("Token reuse terdeteksi, semua sesi dicabut");

    // All family tokens should be revoked
    const familyId = dbStore.refreshTokens[0].familyId;
    const activeInFamily = dbStore.refreshTokens.filter(r => r.familyId === familyId && !r.isRevoked);
    expect(activeInFamily.length).toBe(0);
  });

  test("should tolerate rapid re-rotation within grace period (preventing spam reload logout)", async () => {
    const hashed = await hashPassword("Password123");
    dbStore.users.push({
      id: "user-grace",
      email: "grace@example.com",
      password: hashed,
      isActive: true,
      isEmailVerified: true,
    });

    const db = createMockDb();
    // Default 30s grace period
    const service = new AuthService(db, cacheService, JWT_SECRET, JWT_REFRESH_SECRET, "pg", 30);

    const tokens = await service.login("grace@example.com", "Password123", "web");

    // First rotation (e.g. reload 1)
    const rotated1 = await service.rotateRefreshToken(tokens.refreshToken);
    expect(rotated1.accessToken).toBeDefined();

    // Rapid second rotation using old token (e.g. spam reload 2 within 30s)
    // Harus sukses dan mengembalikan token yang valid tanpa me-revoke family!
    const rotated2 = await service.rotateRefreshToken(tokens.refreshToken);
    expect(rotated2.accessToken).toBeDefined();

    // Family masih aktif dan tidak dicabut
    const familyTokens = dbStore.refreshTokens.filter(r => r.userId === "user-grace" && !r.isRevoked);
    expect(familyTokens.length).toBeGreaterThan(0);
  });

  // ── Test Logout and Session Management ─────────────────────────────────────

  test("should revoke token and blacklist access token on logout", async () => {
    const hashed = await hashPassword("Password123");
    dbStore.users.push({
      id: "user-1",
      email: "test@example.com",
      password: hashed,
      isActive: true,
      isEmailVerified: true,
    });

    const db = createMockDb();
    const service = new AuthService(db, cacheService, JWT_SECRET, JWT_REFRESH_SECRET);

    const tokens = await service.login("test@example.com", "Password123", "web");
    const payload = await service.validateAccessToken(tokens.accessToken);
    const refreshHash = await hashToken(tokens.refreshToken);

    await service.logout(payload.jti, payload.exp, tokens.refreshToken);

    // Access token is blacklisted
    const blacklisted = await cacheService.isTokenBlacklisted(payload.jti);
    expect(blacklisted).toBe(true);

    // Refresh token is revoked in DB
    const storedToken = dbStore.refreshTokens.find(r => r.tokenHash === refreshHash);
    expect(storedToken!.isRevoked).toBe(true);
  });

  test("should revoke all sessions on logoutAll", async () => {
    const hashed = await hashPassword("Password123");
    dbStore.users.push({
      id: "user-1",
      email: "test@example.com",
      password: hashed,
      isActive: true,
      isEmailVerified: true,
    });

    const db = createMockDb();
    const service = new AuthService(db, cacheService, JWT_SECRET, JWT_REFRESH_SECRET);

    // Login twice to get two sessions
    await service.login("test@example.com", "Password123", "web");
    await service.login("test@example.com", "Password123", "mobile");

    expect(dbStore.refreshTokens.filter(r => !r.isRevoked).length).toBe(2);

    await service.logoutAll("user-1");

    expect(dbStore.refreshTokens.filter(r => !r.isRevoked).length).toBe(0);
  });

  test("should list active sessions", async () => {
    const hashed = await hashPassword("Password123");
    dbStore.users.push({
      id: "user-1",
      email: "test@example.com",
      password: hashed,
      isActive: true,
      isEmailVerified: true,
    });

    const db = createMockDb();
    const service = new AuthService(db, cacheService, JWT_SECRET, JWT_REFRESH_SECRET);

    await service.login("test@example.com", "Password123", "web");
    await service.login("test@example.com", "Password123", "mobile");

    const sessions = await service.getSessions("user-1");
    expect(sessions.length).toBe(2);
    expect(sessions[0].clientType).toBe("web");
    expect(sessions[1].clientType).toBe("mobile");
  });

  test("should revoke specific session", async () => {
    const hashed = await hashPassword("Password123");
    dbStore.users.push({
      id: "user-1",
      email: "test@example.com",
      password: hashed,
      isActive: true,
      isEmailVerified: true,
    });

    const db = createMockDb();
    const service = new AuthService(db, cacheService, JWT_SECRET, JWT_REFRESH_SECRET);

    await service.login("test@example.com", "Password123", "web");
    const sessionId = dbStore.refreshTokens[0].id;

    const revoked = await service.revokeSession(sessionId, "user-1");
    expect(revoked).toBe(true);
    expect(dbStore.refreshTokens[0].isRevoked).toBe(true);
  });
});
