// tests/verification.service.test.ts
//
// Unit tests for VerificationService.
// Mock Drizzle ORM DB client.

import { describe, test, expect, beforeEach } from "bun:test";
import { VerificationService } from "../src/services/verification.service";
import { users, emailVerifications } from "../src/db/schema";
import { hashToken } from "../src/utils/hash";

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

// ── Mock DB ──────────────────────────────────────────────────────────────────

describe("VerificationService Unit Tests (TDD)", () => {
  let dbStore: {
    users: any[];
    emailVerifications: any[];
  };

  beforeEach(() => {
    dbStore = {
      users: [],
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
        }
      },
      delete: (table: any) => {
        return {
          where: (condition: any) => {
            const map = extractConditionMap(condition);
            if (table === emailVerifications) {
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
            if (table === emailVerifications) {
              dbStore.emailVerifications.push({
                id: crypto.randomUUID(),
                usedAt: null,
                createdAt: new Date(),
                ...values,
              });
            }
            return Promise.resolve();
          }
        };
      },
      update: (table: any) => {
        return {
          set: (values: any) => {
            return {
              where: (condition: any) => {
                const map = extractConditionMap(condition);
                if (table === users) {
                  dbStore.users.forEach(u => {
                    const idVal = map.id;
                    if (idVal !== undefined && u.id === idVal) {
                      Object.assign(u, values);
                    }
                  });
                } else if (table === emailVerifications) {
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
                    if (table === users) {
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
      transaction: async (callback: (tx: any) => Promise<any>) => {
        const mockTx = {
          select: () => {
            return {
              from: (table: any) => {
                return {
                  where: (condition: any) => {
                    const map = extractConditionMap(condition);
                    const getResults = () => {
                      if (table === users) {
                        return dbStore.users.filter(u => {
                          const idVal = map.id;
                          if (idVal !== undefined && u.id !== idVal) return false;
                          return true;
                        });
                      } else if (table === emailVerifications) {
                        return dbStore.emailVerifications.filter(v => {
                          const tokenHashVal = map.token_hash ?? map.tokenHash;
                          if (tokenHashVal !== undefined && v.tokenHash !== tokenHashVal) {
                            return false;
                          }
                          const userIdVal = map.user_id ?? map.userId;
                          if (userIdVal !== undefined && v.userId !== userIdVal) {
                            return false;
                          }
                          const idVal = map.id;
                          if (idVal !== undefined && v.id !== idVal) {
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
                    if (table === users) {
                      dbStore.users.forEach(u => {
                        const idVal = map.id;
                        if (idVal !== undefined && u.id === idVal) {
                          Object.assign(u, values);
                        }
                      });
                    } else if (table === emailVerifications) {
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
                        if (table === users) {
                          const idVal = map.id;
                          const updatedUsers = dbStore.users.filter(u => idVal !== undefined && u.id === idVal);
                          return updatedUsers.map(u => ({ id: u.id, email: u.email }));
                        }
                        return [{ id: map.id || map.token_hash || map.tokenHash }];
                      }
                    };
                  }
                };
              }
            };
          }
        };
        return callback(mockTx);
      }
    };
    return mockDb as any;
  };

  // ── Test Link Flow ─────────────────────────────────────────────────────────

  test("should create a link verification token", async () => {
    const db = createMockDb();
    const service = new VerificationService(db);

    const token = await service.createVerificationToken("user-1");
    expect(token).toBeDefined();
    expect(token.length).toBe(64); // 32-byte hex is 64 characters

    expect(dbStore.emailVerifications.length).toBe(1);
    expect(dbStore.emailVerifications[0].userId).toBe("user-1");
    expect(dbStore.emailVerifications[0].tokenHash).toBe(await hashToken(token));
  });

  test("should verify email using a valid token", async () => {
    dbStore.users.push({
      id: "user-1",
      email: "test@example.com",
      isEmailVerified: false,
    });

    const db = createMockDb();
    const service = new VerificationService(db);

    const token = await service.createVerificationToken("user-1");
    const result = await service.verifyEmail(token);

    expect(result.userId).toBe("user-1");
    expect(result.email).toBe("test@example.com");

    // Check user is verified in DB
    expect(dbStore.users[0].isEmailVerified).toBe(true);

    // Check verification record is marked as used
    expect(dbStore.emailVerifications[0].usedAt).toBeInstanceOf(Date);
  });

  test("should reject verification if token is already used", async () => {
    dbStore.users.push({
      id: "user-1",
      email: "test@example.com",
      isEmailVerified: false,
    });

    const db = createMockDb();
    const service = new VerificationService(db);

    const token = await service.createVerificationToken("user-1");
    
    // First verification (success)
    await service.verifyEmail(token);

    // Second verification (fail)
    expect(
      service.verifyEmail(token)
    ).rejects.toThrow("Token verifikasi sudah digunakan");
  });

  test("should reject verification if token has expired", async () => {
    dbStore.users.push({
      id: "user-1",
      email: "test@example.com",
      isEmailVerified: false,
    });

    const db = createMockDb();
    const service = new VerificationService(db);

    const token = await service.createVerificationToken("user-1");
    
    // Make token expired (e.g. 20 minutes ago)
    dbStore.emailVerifications[0].expiresAt = new Date(Date.now() - 20 * 60 * 1000);

    expect(
      service.verifyEmail(token)
    ).rejects.toThrow("Token verifikasi sudah expired");
  });

  test("should resend verification link successfully", async () => {
    dbStore.users.push({
      id: "user-1",
      email: "test@example.com",
      isEmailVerified: false,
      isActive: true,
    });

    const db = createMockDb();
    const service = new VerificationService(db);

    const result = await service.resendVerification("test@example.com");
    expect(result.token).toBeDefined();
    expect(result.userId).toBe("user-1");
    expect(dbStore.emailVerifications.length).toBe(1);
  });

  // ── Test OTP / Code Flow ───────────────────────────────────────────────────

  test("should create verification code (OTP)", async () => {
    const db = createMockDb();
    const service = new VerificationService(db);

    const code = await service.createVerificationCode("user-1");
    expect(code).toBeDefined();
    expect(code.length).toBe(6); // 6-digit OTP code

    expect(dbStore.emailVerifications.length).toBe(1);
    expect(dbStore.emailVerifications[0].userId).toBe("user-1");
    expect(dbStore.emailVerifications[0].tokenHash).toBe(await hashToken(code));
  });

  test("should verify email using a valid OTP code", async () => {
    dbStore.users.push({
      id: "user-1",
      email: "test@example.com",
      isEmailVerified: false,
      isActive: true,
    });

    const db = createMockDb();
    const service = new VerificationService(db);

    const code = await service.createVerificationCode("user-1");
    const result = await service.verifyEmailCode("test@example.com", code);

    expect(result.userId).toBe("user-1");
    expect(result.email).toBe("test@example.com");

    expect(dbStore.users[0].isEmailVerified).toBe(true);
    expect(dbStore.emailVerifications[0].usedAt).toBeInstanceOf(Date);
  });

  test("should reject verification if OTP code is incorrect", async () => {
    dbStore.users.push({
      id: "user-1",
      email: "test@example.com",
      isEmailVerified: false,
      isActive: true,
    });

    const db = createMockDb();
    const service = new VerificationService(db);

    await service.createVerificationCode("user-1");

    expect(
      service.verifyEmailCode("test@example.com", "999999")
    ).rejects.toThrow("Email atau kode tidak valid");
  });

  test("should resend verification code successfully", async () => {
    dbStore.users.push({
      id: "user-1",
      email: "test@example.com",
      isEmailVerified: false,
      isActive: true,
    });

    const db = createMockDb();
    const service = new VerificationService(db);

    const result = await service.resendVerificationCode("test@example.com");
    expect(result.code).toBeDefined();
    expect(result.code.length).toBe(6);
    expect(result.userId).toBe("user-1");
  });
});
