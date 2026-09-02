// tests/auth.routes.test.ts
//
// Integration tests for Hono authRoutes.
// Sets up a test Hono app, injects mock dependencies, and verifies endpoint request/response payloads.

import { describe, test, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { authRoutes } from "../src/routes/index";
import { hashPassword } from "../src/utils/password";
import { hashToken } from "../src/utils/hash";

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

// Inject global caches for Edge compatibility locally in Bun
global.caches = {
  default: new MockCache()
} as any;

const mockAi = {
  run: async () => []
};

// ── Drizzle Table Name Resolver ──────────────────────────────────────────────

function getTableName(table: any): string {
  if (!table) return "";
  if (typeof table.tableName === "string") return table.tableName;
  
  const symbols = Object.getOwnPropertySymbols(table);
  for (const sym of symbols) {
    if (sym.toString() === "Symbol(drizzle:Name)" || sym.toString() === "Symbol(drizzle:OriginalName)") {
      return (table as any)[sym];
    }
  }
  return "";
}

// ── Drizzle Condition Map Extractor ──────────────────────────────────────────

function extractConditionMap(obj: any): Record<string, any> {
  const map: Record<string, any> = {};
  if (!obj) return map;

  if (Array.isArray(obj.queryChunks)) {
    for (let i = 0; i < obj.queryChunks.length; i++) {
      const chunk = obj.queryChunks[i];
      if (chunk && typeof chunk === "object" && "table" in chunk && "name" in chunk) {
        const colName = chunk.name;
        // Search forward for the value chunk
        for (let j = i + 1; j < obj.queryChunks.length; j++) {
          const valChunk = obj.queryChunks[j];
          if (valChunk && typeof valChunk === "object") {
            if ("table" in valChunk && "name" in valChunk) {
              break;
            }
            if ("value" in valChunk) {
              if (Array.isArray(valChunk.value)) {
                continue;
              }
              map[colName] = valChunk.value;
              break;
            }
          }
        }
      }
      if (chunk && typeof chunk === "object" && Array.isArray(chunk.queryChunks)) {
        Object.assign(map, extractConditionMap(chunk));
      }
    }
  }

  if (Array.isArray(obj.conditions)) {
    for (const cond of obj.conditions) {
      Object.assign(map, extractConditionMap(cond));
    }
  }

  return map;
}

// ── Mock DB Store ────────────────────────────────────────────────────────────

describe("Hono Auth Routes Integration Tests (TDD)", () => {
  let mockKv: MockKV;
  let dbStore: {
    users: any[];
    refreshTokens: any[];
    emailVerifications: any[];
  };

  beforeEach(() => {
    mockKv = new MockKV();
    // Reset the global cache for each test
    (global.caches.default as any).store.clear();
    dbStore = {
      users: [],
      refreshTokens: [],
      emailVerifications: [],
    };
  });

  const createMockDb = () => {
    const mockDb = {
      query: {
        users: {
          findFirst: async (options: any) => {
            const map = extractConditionMap(options?.where);
            return dbStore.users.find(u => {
              const emailVal = map.email;
              if (emailVal !== undefined && u.email !== emailVal) return false;
              const idVal = map.id;
              if (idVal !== undefined && u.id !== idVal) return false;
              return true;
            }) || null;
          }
        },
        oauthAccounts: {
          findFirst: async (options: any) => {
            return null;
          }
        },
        refreshTokens: {
          findMany: async (options: any) => {
            const map = extractConditionMap(options?.where);
            let list = dbStore.refreshTokens;
            const userIdVal = map.userId ?? map.user_id;
            if (userIdVal !== undefined) {
              list = list.filter(r => r.userId === userIdVal);
            }
            return list.filter(r => !r.isRevoked && r.expiresAt > new Date());
          }
        }
      },
      delete: (table: any) => {
        return {
          where: (condition: any) => {
            const map = extractConditionMap(condition);
            const tableName = getTableName(table);
            if (tableName === "email_verifications") {
              const userIdVal = map.user_id ?? map.userId;
              if (userIdVal !== undefined) {
                dbStore.emailVerifications = dbStore.emailVerifications.filter(v => v.userId !== userIdVal);
              }
            }
            return Promise.resolve();
          }
        };
      },
      insert: (table: any) => {
        return {
          values: (values: any) => {
            const tableName = getTableName(table);
            const row = {
              id: values.id || crypto.randomUUID(),
              isRevoked: false,
              usedAt: null,
              createdAt: new Date(),
              ...values,
            };
            const runInsert = () => {
              if (tableName === "users") {
                const duplicate = dbStore.users.some(u => u.email === values.email);
                if (duplicate) {
                  return [];
                }
                dbStore.users.push(row);
                return [row];
              } else if (tableName === "refresh_tokens") {
                dbStore.refreshTokens.push(row);
                return [row];
              } else if (tableName === "email_verifications") {
                dbStore.emailVerifications.push(row);
                return [row];
              }
              return [row];
            };

            const chainObj = {
              onConflictDoNothing: () => {
                return {
                  returning: (fields: any) => {
                    const inserted = runInsert();
                    return Promise.resolve(inserted);
                  }
                };
              },
              returning: (fields: any) => {
                const inserted = runInsert();
                return Promise.resolve(inserted);
              }
            };
            return Object.assign(Promise.resolve(), chainObj);
          }
        };
      },
      update: (table: any) => {
        return {
          set: (values: any) => {
            return {
              where: (condition: any) => {
                const map = extractConditionMap(condition);
                const tableName = getTableName(table);
                if (tableName === "users") {
                  dbStore.users.forEach(u => {
                    const idVal = map.id;
                    if (idVal !== undefined && u.id === idVal) {
                      Object.assign(u, values);
                    }
                  });
                } else if (tableName === "refresh_tokens") {
                  dbStore.refreshTokens.forEach(r => {
                    const hashVal = map.token_hash ?? map.tokenHash;
                    const userIdVal = map.user_id ?? map.userId;
                    const idVal = map.id;
                    if (
                      (hashVal !== undefined && r.tokenHash === hashVal) ||
                      (userIdVal !== undefined && r.userId === userIdVal) ||
                      (idVal !== undefined && r.id === idVal)
                    ) {
                      Object.assign(r, values);
                    }
                  });
                } else if (tableName === "email_verifications") {
                  dbStore.emailVerifications.forEach(v => {
                    const idVal = map.id;
                    const tokenHashVal = map.token_hash ?? map.tokenHash;
                    if (
                      (idVal !== undefined && v.id === idVal) ||
                      (tokenHashVal !== undefined && v.tokenHash === tokenHashVal)
                    ) {
                      Object.assign(v, values);
                    }
                  });
                }
                return {
                  returning: (fields: any) => {
                    if (tableName === "users") {
                      const idVal = map.id;
                      const updatedUsers = dbStore.users.filter(u => idVal !== undefined && u.id === idVal);
                      return updatedUsers.length > 0 ? updatedUsers : [{ id: idVal }];
                    }
                    return [{ id: map.id }];
                  }
                };
              }
            };
          }
        };
      },
      select: (fields?: any) => {
        return {
          from: (table: any) => {
            const fromObj = {
              innerJoin: (joinTable: any, joinCondition: any) => {
                return {
                  where: (condition: any) => {
                    const whereObj = {
                      limit: (limitNum: number) => {
                        return Promise.resolve([]);
                      }
                    };
                    return Object.assign(Promise.resolve([]), whereObj);
                  }
                };
              },
              where: (condition: any) => {
                const map = extractConditionMap(condition);
                const tableName = getTableName(table);
                let list: any[] = [];
                if (tableName === "users") {
                  list = dbStore.users.filter(u => {
                    const idVal = map.id;
                    if (idVal !== undefined && u.id !== idVal) return false;
                    const emailVal = map.email;
                    if (emailVal !== undefined && u.email !== emailVal) return false;
                    return true;
                  });
                }
                const whereObj = {
                  limit: (limitNum: number) => Promise.resolve(list.slice(0, limitNum))
                };
                return Object.assign(Promise.resolve(list), whereObj);
              }
            };
            return fromObj;
          }
        };
      },
      transaction: async (callback: (tx: any) => Promise<any>) => {
        const mockTx = {
          select: () => {
            return {
              from: (table: any) => {
                return {
                  where: (condition: any) => {
                    const map = extractConditionMap(condition);
                    const getResults = () => {
                      const tableName = getTableName(table);
                      if (tableName === "users") {
                        return dbStore.users.filter(u => {
                          const idVal = map.id;
                          if (idVal !== undefined && u.id !== idVal) return false;
                          const emailVal = map.email;
                          if (emailVal !== undefined && u.email !== emailVal) return false;
                          return true;
                        });
                      } else if (tableName === "refresh_tokens") {
                        return dbStore.refreshTokens.filter(r => {
                          const hashVal = map.token_hash ?? map.tokenHash;
                          if (hashVal !== undefined && r.tokenHash !== hashVal) {
                            return false;
                          }
                          const familyVal = map.family_id ?? map.familyId;
                          if (familyVal !== undefined && r.familyId !== familyVal) {
                            return false;
                          }
                          return true;
                        });
                      } else if (tableName === "email_verifications") {
                        return dbStore.emailVerifications.filter(v => {
                          const tokenHashVal = map.token_hash ?? map.tokenHash;
                          if (tokenHashVal !== undefined && v.tokenHash !== tokenHashVal) {
                            return false;
                          }
                          const userIdVal = map.user_id ?? map.userId;
                          if (userIdVal !== undefined && v.userId !== userIdVal) {
                            return false;
                          }
                          return true;
                        });
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
                    const map = extractConditionMap(condition);
                    const tableName = getTableName(table);
                    if (tableName === "users") {
                      dbStore.users.forEach(u => {
                        const idVal = map.id;
                        if (idVal !== undefined && u.id === idVal) {
                          Object.assign(u, values);
                        }
                      });
                    } else if (tableName === "refresh_tokens") {
                      dbStore.refreshTokens.forEach(r => {
                        const hashVal = map.token_hash ?? map.tokenHash;
                        const familyVal = map.family_id ?? map.familyId;
                        const idVal = map.id;
                        if (
                          (hashVal !== undefined && r.tokenHash === hashVal) ||
                          (familyVal !== undefined && r.familyId === familyVal) ||
                          (idVal !== undefined && r.id === idVal)
                        ) {
                          Object.assign(r, values);
                        }
                      });
                    } else if (tableName === "email_verifications") {
                      dbStore.emailVerifications.forEach(v => {
                        const idVal = map.id;
                        const tokenHashVal = map.token_hash ?? map.tokenHash;
                        if (
                          (idVal !== undefined && v.id === idVal) ||
                          (tokenHashVal !== undefined && v.tokenHash === tokenHashVal)
                        ) {
                          Object.assign(v, values);
                        }
                      });
                    }
                    return {
                      returning: (fields: any) => {
                        if (tableName === "users") {
                          const idVal = map.id;
                          const updatedUsers = dbStore.users.filter(u => idVal !== undefined && u.id === idVal);
                          return updatedUsers.map(u => ({ id: u.id, email: u.email }));
                        }
                        return [{ id: map.id }];
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
                const tableName = getTableName(table);
                const row = {
                  id: values.id || crypto.randomUUID(),
                  isRevoked: false,
                  usedAt: null,
                  createdAt: new Date(),
                  ...values,
                };
                if (tableName === "users") {
                  dbStore.users.push(row);
                } else if (tableName === "refresh_tokens") {
                  dbStore.refreshTokens.push(row);
                } else if (tableName === "email_verifications") {
                  dbStore.emailVerifications.push(row);
                }
                const res = [row];
                return Object.assign(Promise.resolve(res), {
                  returning: () => Promise.resolve(res),
                  onConflictDoNothing: () => Promise.resolve(res)
                });
              }
            };
          }
        };
        return callback(mockTx);
      }
    };
    return mockDb as any;
  };

  const createTestApp = () => {
    const app = new Hono();
    const db = createMockDb();
    
    app.use("*", async (c, next) => {
      c.set("db", db);
      c.set("emailConfig", {
        verificationMethod: "link"
      });
      c.env = {
        JWT_SECRET: "jwt-secret-key-1234567890",
        JWT_REFRESH_SECRET: "jwt-refresh-secret-key-1234567890",
        KV: mockKv,
        ANALYTICS: { writeDataPoint: () => {} },
        RESEND_API_KEY: "mock_resend_key",
        APP_URL: "https://auth.example.com",
        EMAIL_FROM: "no-reply@example.com",
        GOOGLE_CLIENT_ID: "test-client-id",
        AI: mockAi,
      };
      await next();
    });

    app.route("/auth", authRoutes);
    return app;
  };

  // ── Route Tests ────────────────────────────────────────────────────────────

  test("POST /auth/register should successfully register a user", async () => {
    // Intercept/mock global fetch call specifically for Resend API in this test
    const originalFetch = global.fetch;
    global.fetch = async (input: any, init: any) => {
      if (typeof input === "string" && input.includes("api.resend.com")) {
        return new Response(JSON.stringify({ id: "resend-id" }), { status: 200 });
      }
      return originalFetch(input, init);
    };

    try {
      const app = createTestApp();
      const res = await app.request("/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "register@example.com",
          password: "Password123",
          fullName: "Registered User"
        })
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.data.message).toBe("Registrasi berhasil. Silakan cek email untuk verifikasi.");
      expect(dbStore.users.length).toBe(1);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test("POST /auth/login should return tokens for verified user", async () => {
    const hashed = await hashPassword("Password123");
    dbStore.users.push({
      id: "user-1",
      email: "login@example.com",
      password: hashed,
      isActive: true,
      isEmailVerified: true,
      username: "loginuser",
      fullName: "Login User"
    });

    const app = createTestApp();
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "login@example.com",
        password: "Password123"
      })
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.accessToken).toBeDefined();
    expect(json.data.refreshToken).toBeUndefined();
    const setCookie = res.headers.get("Set-Cookie");
    expect(setCookie).toContain("refresh_token=");
    expect(setCookie).toContain("HttpOnly");
  });

  test("POST /auth/login should return 401 for incorrect credentials", async () => {
    const hashed = await hashPassword("Password123");
    dbStore.users.push({
      id: "user-1",
      email: "login@example.com",
      password: hashed,
      isActive: true,
      isEmailVerified: true,
    });

    const app = createTestApp();
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "login@example.com",
        password: "WrongPassword"
      })
    });

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error.code).toBe("INVALID_CREDENTIALS");
    expect(json.error.remainingAttempts).toBeDefined();
  });

  test("POST /auth/google/token should return tokens and set httpOnly cookie for web client", async () => {
    const originalFetch = global.fetch;
    global.fetch = async (input: any, init: any) => {
      if (typeof input === "string" && input.includes("tokeninfo")) {
        return new Response(
          JSON.stringify({
            sub: "google-sub-123",
            email: "onetap@example.com",
            email_verified: "true",
            name: "OneTap User",
            aud: "test-client-id",
          }),
          { status: 200 }
        );
      }
      return originalFetch(input, init);
    };

    try {
      const app = createTestApp();
      const res = await app.request("/auth/google/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idToken: "valid-google-id-token",
          clientType: "web",
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.accessToken).toBeDefined();
      expect(json.data.refreshToken).toBeDefined();
      
      const cookieHeader = res.headers.get("Set-Cookie");
      expect(cookieHeader).toContain("refresh_token=");
    } finally {
      global.fetch = originalFetch;
    }
  });

  test("POST /auth/verify-email-code should enforce rate limiting after max attempts", async () => {
    const app = createTestApp();
    const email = "otp-rate-test@example.com";

    // Attempt 5 times with invalid code
    for (let i = 0; i < 5; i++) {
      const res = await app.request("/auth/verify-email-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code: "123456" }),
      });
      expect(res.status).toBe(401);
    }

    // 6th attempt should be rate limited (429)
    const res6 = await app.request("/auth/verify-email-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, code: "123456" }),
    });

    expect(res6.status).toBe(429);
    const json = await res6.json();
    expect(json.error.code).toBe("RATE_LIMITED");
    expect(json.error.retryAfterSeconds).toBeDefined();
    expect(json.error.message).toContain("Coba lagi");
  });

  test("POST /auth/forgot-password should enforce rate limiting and 5-minute message", async () => {
    const app = createTestApp();
    const email = "forgot-rate-test@example.com";

    // 3 requests to trigger rate limit
    for (let i = 0; i < 3; i++) {
      await app.request("/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
    }

    // 4th request should return 429
    const res = await app.request("/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });

    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.error.code).toBe("RATE_LIMITED");
    expect(json.error.retryAfterSeconds).toBeDefined();
    expect(json.error.message).toContain("Coba lagi");
  });

  test("GET /auth/google/callback with valid redirectUrl should not leak refreshToken in query params", async () => {
    const originalFetch = global.fetch;
    global.fetch = async (input: any, init: any) => {
      if (typeof input === "string" && input.includes("oauth2.googleapis.com/token")) {
        return new Response(
          JSON.stringify({
            access_token: "google_access_token",
            expires_in: 3600,
            token_type: "Bearer",
            scope: "openid email profile",
          }),
          { status: 200 }
        );
      }
      if (typeof input === "string" && input.includes("googleapis.com/oauth2/v3/userinfo")) {
        return new Response(
          JSON.stringify({
            sub: "google-sub-oauth",
            email: "oauthuser@example.com",
            email_verified: true,
            name: "OAuth User",
          }),
          { status: 200 }
        );
      }
      return originalFetch(input, init);
    };

    try {
      const app = createTestApp();
      // Set state in KV
      const state = "test-oauth-state-123";
      await mockKv.put(
        `oauth-state:${state}`,
        JSON.stringify({
          clientType: "web",
          redirectUrl: "https://auth.example.com/dashboard",
          ts: Date.now(),
        })
      );

      const res = await app.request(`/auth/google/callback?code=valid-code&state=${state}`);
      expect(res.status).toBe(302);
      
      const location = res.headers.get("Location");
      expect(location).toBeDefined();
      const redirectUrl = new URL(location!);
      
      // Verify accessToken is in URL fragment (#), NOT in query params (RFC 6750)
      const fragment = new URLSearchParams(redirectUrl.hash.slice(1));
      expect(fragment.get("accessToken")).toBeDefined();
      expect(redirectUrl.searchParams.get("accessToken")).toBeNull();
      expect(redirectUrl.searchParams.get("refreshToken")).toBeNull();

      // Verify HttpOnly cookie is set for web client
      const setCookie = res.headers.get("Set-Cookie");
      expect(setCookie).toContain("refresh_token=");
    } finally {
      global.fetch = originalFetch;
    }
  });

  test("POST /auth/resend-verification should not increment rate limit for nonexistent user", async () => {
    const app = createTestApp();
    const email = "nonexistent-user@example.com";

    // Calling resend multiple times for a non-existent email should return 200 without blocking by rate limit
    for (let i = 0; i < 5; i++) {
      const res = await app.request("/auth/resend-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      expect(res.status).toBe(200);
    }
  });

  test("POST /auth/refresh should enforce rate limiting on repeated failed attempts", async () => {
    const app = createTestApp();

    for (let i = 0; i < 5; i++) {
      const res = await app.request("/auth/refresh", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "192.168.1.100",
        },
        body: JSON.stringify({ refreshToken: "invalid-token" }),
      });
      expect(res.status).toBe(401);
    }

    const rateLimitedRes = await app.request("/auth/refresh", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CF-Connecting-IP": "192.168.1.100",
      },
      body: JSON.stringify({ refreshToken: "invalid-token" }),
    });
    expect(rateLimitedRes.status).toBe(429);
  });

  test("GET /auth/google/callback with malicious redirectUrl in error path should reject open redirect", async () => {
    const app = createTestApp();
    const state = "evil-oauth-state";
    await mockKv.put(
      `oauth-state:${state}`,
      JSON.stringify({
        clientType: "web",
        redirectUrl: "https://evil-phishing-site.com/steal-data",
        ts: Date.now(),
      })
    );

    // Call callback with error
    const res = await app.request(`/auth/google/callback?error=access_denied&state=${state}`);
    expect(res.status).toBe(302);
    const location = res.headers.get("Location");
    expect(location).toBeDefined();
    // Must NOT redirect to evil-phishing-site.com! Should fallback to allowed origin or app url
    expect(location).not.toContain("evil-phishing-site.com");
  });
});

