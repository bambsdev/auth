// tests/password-reset.service.test.ts
import { describe, test, expect, beforeEach } from "bun:test";
import { PasswordResetService } from "../src/services/password-reset.service";
import { hashToken } from "../src/utils/hash";

function extractConditionMap(obj: any): Record<string, any> {
  const map: Record<string, any> = {};
  if (!obj) return map;

  if (Array.isArray(obj.queryChunks)) {
    for (let i = 0; i < obj.queryChunks.length; i++) {
      const chunk = obj.queryChunks[i];
      if (chunk && typeof chunk === "object" && "table" in chunk && "name" in chunk) {
        const colName = chunk.name;
        for (let j = i + 1; j < obj.queryChunks.length; j++) {
          const valChunk = obj.queryChunks[j];
          if (valChunk && typeof valChunk === "object") {
            if ("table" in valChunk && "name" in valChunk) break;
            if ("value" in valChunk) {
              if (Array.isArray(valChunk.value)) continue;
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

describe("PasswordResetService Unit Tests", () => {
  let dbStore: {
    users: any[];
    passwordResets: any[];
    refreshTokens: any[];
  };

  beforeEach(() => {
    dbStore = {
      users: [],
      passwordResets: [],
      refreshTokens: [],
    };
  });

  const createMockDb = () => {
    return {
      query: {
        users: {
          findFirst: async (options: any) => {
            const map = extractConditionMap(options?.where);
            return (
              dbStore.users.find((u) => {
                if (map.email && u.email !== map.email) return false;
                if (map.id && u.id !== map.id) return false;
                return true;
              }) || null
            );
          },
        },
      },
      delete: (table: any) => {
        return {
          where: (condition: any) => {
            const map = extractConditionMap(condition);
            const userIdVal = map.user_id ?? map.userId;
            if (userIdVal !== undefined) {
              dbStore.passwordResets = dbStore.passwordResets.filter(
                (r) => r.userId !== userIdVal || r.usedAt !== null,
              );
            }
            return Promise.resolve();
          },
        };
      },
      insert: (table: any) => {
        return {
          values: (values: any) => {
            const row = {
              id: values.id || crypto.randomUUID(),
              usedAt: null,
              createdAt: new Date(),
              ...values,
            };
            dbStore.passwordResets.push(row);
            return Promise.resolve();
          },
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
                      const hashVal = map.token_hash ?? map.tokenHash;
                      if (hashVal !== undefined) {
                        return dbStore.passwordResets.filter(
                          (r) => r.tokenHash === hashVal,
                        );
                      }
                      const idVal = map.id;
                      if (idVal !== undefined) {
                        return dbStore.users.filter((u) => u.id === idVal);
                      }
                      return [];
                    };
                    const forObj = {
                      for: (lockMode: string) => {
                        const results = getResults();
                        return Object.assign(Promise.resolve(results), {
                          limit: (limit: number) =>
                            Promise.resolve(results.slice(0, limit)),
                        });
                      },
                    };
                    return Object.assign(forObj, {
                      limit: (limit: number) =>
                        Promise.resolve(getResults().slice(0, limit)),
                    });
                  },
                };
              },
            };
          },
          update: (table: any) => {
            return {
              set: (values: any) => {
                return {
                  where: (condition: any) => {
                    const map = extractConditionMap(condition);
                    const idVal = map.id;
                    const userIdVal = map.user_id ?? map.userId;
                    if (idVal) {
                      dbStore.passwordResets.forEach((r) => {
                        if (r.id === idVal) Object.assign(r, values);
                      });
                      dbStore.users.forEach((u) => {
                        if (u.id === idVal) Object.assign(u, values);
                      });
                    }
                    if (userIdVal) {
                      dbStore.refreshTokens.forEach((rt) => {
                        if (rt.userId === userIdVal) Object.assign(rt, values);
                      });
                    }
                    return Promise.resolve();
                  },
                };
              },
            };
          },
        };
        return callback(mockTx);
      },
    };
  };

  test("createResetToken should invalidate previous unused reset tokens for the same user", async () => {
    const db = createMockDb();
    const service = new PasswordResetService(db as any);

    const token1 = await service.createResetToken("user-1");
    expect(token1).toBeDefined();
    expect(dbStore.passwordResets.length).toBe(1);

    const token2 = await service.createResetToken("user-1");
    expect(token2).toBeDefined();
    // Previous unused token was invalidated (deleted), so only the newest token exists
    expect(dbStore.passwordResets.length).toBe(1);
    expect(dbStore.passwordResets[0].tokenHash).toBe(await hashToken(token2));
  });

  test("resetPassword should succeed and mark token as used", async () => {
    dbStore.users.push({
      id: "user-1",
      email: "user@example.com",
      isActive: true,
    });

    const db = createMockDb();
    const service = new PasswordResetService(db as any);

    const token = await service.createResetToken("user-1");
    const result = await service.resetPassword(token, "NewPassword123!");

    expect(result.userId).toBe("user-1");
    expect(result.email).toBe("user@example.com");
    expect(dbStore.passwordResets[0].usedAt).toBeInstanceOf(Date);
  });
});
