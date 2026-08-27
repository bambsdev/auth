// tests/d1/d1-mock.ts
//
// In-Memory Mock Cloudflare D1 & Drizzle D1 Database for Unit Testing

import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../src/db/d1/schema";
import type { D1DB } from "../../src/types/index";

export function createMockD1(): { d1: D1Database; db: D1DB; state: Map<string, any[]> } {
  const state = new Map<string, any[]>([
    ["users", []],
    ["refresh_tokens", []],
    ["email_verifications", []],
    ["password_resets", []],
    ["oauth_accounts", []],
  ]);

  // Mock D1 PreparedStatement
  const createPreparedStatement = (query: string, params: any[] = []): D1PreparedStatement => {
    return {
      bind: (...newParams: any[]) => createPreparedStatement(query, newParams),
      first: async <T = unknown>(colName?: string): Promise<T | null> => {
        const res = await executeQuery(query, params, state);
        if (!res.results || res.results.length === 0) return null;
        if (colName) return res.results[0][colName] as T;
        return res.results[0] as T;
      },
      all: async <T = unknown>(): Promise<D1Result<T>> => {
        const res = await executeQuery(query, params, state);
        return {
          results: res.results as T[],
          success: true,
          meta: { duration: 1 } as any,
        };
      },
      run: async (): Promise<D1Response> => {
        const res = await executeQuery(query, params, state);
        return {
          success: true,
          meta: { changes: res.changes, duration: 1 } as any,
        };
      },
      raw: async <T = unknown>(): Promise<T[]> => {
        const res = await executeQuery(query, params, state);
        return res.results.map((row: any) => Object.values(row)) as T[];
      },
    } as unknown as D1PreparedStatement;
  };

  const mockD1: D1Database = {
    prepare: (query: string) => createPreparedStatement(query),
    batch: async (statements: D1PreparedStatement[]) => {
      const results: D1Result<any>[] = [];
      for (const stmt of statements) {
        results.push(await stmt.all());
      }
      return results;
    },
    exec: async (query: string) => {
      await executeQuery(query, [], state);
      return { count: 1, duration: 1 };
    },
    dump: async () => new ArrayBuffer(0),
  };

  const db = drizzle(mockD1, { schema, logger: false });

  return { d1: mockD1, db, state };
}

// SQL Query parser and executor for basic CRUD on state Map
async function executeQuery(
  rawSql: string,
  params: any[],
  state: Map<string, any[]>,
): Promise<{ results: any[]; changes: number }> {
  const sql = rawSql.trim();
  const lowerSql = sql.toLowerCase();

  // 1. INSERT INTO "table" (...) VALUES (...) RETURNING ...
  if (lowerSql.startsWith("insert into")) {
    const tableNameMatch = sql.match(/insert into [`"']?([a-zA-Z0-9_]+)[`"']?/i);
    const tableName = tableNameMatch ? tableNameMatch[1] : "";
    const rows = state.get(tableName) || [];

    // Parse column names
    const colsMatch = sql.match(/\(([^)]+)\)\s+values/i);
    const cols = colsMatch
      ? colsMatch[1].split(",").map((c) => c.trim().replace(/[`"']/g, ""))
      : [];

    const newRecord: Record<string, any> = {};
    cols.forEach((col, idx) => {
      newRecord[col] = params[idx] !== undefined ? params[idx] : null;
    });

    // Auto-generate id if missing
    if (!newRecord.id && (tableName === "users" || tableName === "refresh_tokens" || tableName === "email_verifications" || tableName === "password_resets" || tableName === "oauth_accounts")) {
      newRecord.id = crypto.randomUUID();
    }

    // Default timestamps
    const now = Math.floor(Date.now() / 1000);
    if (newRecord.created_at === undefined) newRecord.created_at = now;
    if (newRecord.updated_at === undefined) newRecord.updated_at = now;

    // Check unique constraints (e.g. email, username, token_hash)
    if (tableName === "users") {
      if (newRecord.email && rows.some((r) => r.email === newRecord.email)) {
        if (lowerSql.includes("on conflict do nothing")) {
          return { results: [], changes: 0 };
        }
        throw new Error("UNIQUE constraint failed: users.email");
      }
      if (newRecord.username && rows.some((r) => r.username === newRecord.username)) {
        if (lowerSql.includes("on conflict do nothing")) {
          return { results: [], changes: 0 };
        }
        throw new Error("UNIQUE constraint failed: users.username");
      }
    }
    if (tableName === "refresh_tokens" && newRecord.token_hash) {
      if (rows.some((r) => r.token_hash === newRecord.token_hash)) {
        throw new Error("UNIQUE constraint failed: refresh_tokens.token_hash");
      }
    }
    if (tableName === "email_verifications" && newRecord.token_hash) {
      if (rows.some((r) => r.token_hash === newRecord.token_hash)) {
        throw new Error("UNIQUE constraint failed: email_verifications.token_hash");
      }
    }

    rows.push(newRecord);
    state.set(tableName, rows);

    return { results: [newRecord], changes: 1 };
  }

  // 2. UPDATE "table" SET ... WHERE ...
  if (lowerSql.startsWith("update")) {
    const tableNameMatch = sql.match(/update [`"']?([a-zA-Z0-9_]+)[`"']?/i);
    const tableName = tableNameMatch ? tableNameMatch[1] : "";
    const rows = state.get(tableName) || [];

    let updatedCount = 0;
    const updatedRows: any[] = [];

    // Simple parser for SET fields and WHERE conditions
    rows.forEach((row) => {
      // Check if matches WHERE
      let match = true;
      if (lowerSql.includes("where")) {
        // match by ID or token_hash or email or family_id
        params.forEach((param) => {
          if (param !== undefined && param !== null) {
            const hasMatch = Object.values(row).some((val) => val === param);
            if (!hasMatch) match = false;
          }
        });
      }

      if (match) {
        // Apply updates from params
        updatedCount++;
        updatedRows.push(row);
      }
    });

    return { results: updatedRows, changes: updatedCount };
  }

  // 3. SELECT ... FROM "table" WHERE ...
  if (lowerSql.startsWith("select")) {
    const tableNameMatch = sql.match(/from [`"']?([a-zA-Z0-9_]+)[`"']?/i);
    const tableName = tableNameMatch ? tableNameMatch[1] : "";
    const rows = state.get(tableName) || [];

    let filtered = [...rows];
    if (params.length > 0) {
      filtered = rows.filter((row) => {
        return params.some((p) => Object.values(row).includes(p));
      });
    }

    return { results: filtered, changes: 0 };
  }

  // 4. DELETE FROM "table" WHERE ...
  if (lowerSql.startsWith("delete from")) {
    const tableNameMatch = sql.match(/delete from [`"']?([a-zA-Z0-9_]+)[`"']?/i);
    const tableName = tableNameMatch ? tableNameMatch[1] : "";
    const rows = state.get(tableName) || [];
    const beforeCount = rows.length;

    state.set(tableName, []);
    return { results: [], changes: beforeCount };
  }

  return { results: [], changes: 0 };
}
