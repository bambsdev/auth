// src/db/adapter.ts
import type { PgDB, D1DB, AnyAuthDB } from "../types/index";
import * as pgSchema from "./pg/schema";
import * as d1Schema from "./d1/schema";

export type AuthDbDialect = "pg" | "d1";

export type AnyTableSchema = {
  users: any;
  refreshTokens: any;
  emailVerifications: any;
  passwordResets: any;
  oauthAccounts: any;
};

export interface AuthDbAdapter<TDB extends AnyAuthDB = AnyAuthDB> {
  readonly dialect: AuthDbDialect;
  readonly db: TDB;
  readonly tables: AnyTableSchema;
  selectWithLock<T = any>(
    tx: any,
    table: any,
    condition: any,
    columns?: Record<string, any>,
    limit?: number,
  ): Promise<T[]>;
}

export class PgAuthDbAdapter implements AuthDbAdapter<PgDB> {
  readonly dialect = "pg" as const;
  readonly tables = pgSchema;

  constructor(readonly db: PgDB) {}

  async selectWithLock<T = any>(
    tx: any,
    table: any,
    condition: any,
    columns?: Record<string, any>,
    limit?: number,
  ): Promise<T[]> {
    let query = columns ? tx.select(columns).from(table) : tx.select().from(table);
    query = query.where(condition);
    if (limit) {
      query = query.limit(limit);
    }
    if (typeof query.for === "function") {
      return (await query.for("update")) as T[];
    }
    return (await query) as T[];
  }
}

export class D1AuthDbAdapter implements AuthDbAdapter<D1DB> {
  readonly dialect = "d1" as const;
  readonly tables = d1Schema;

  constructor(readonly db: D1DB) {}

  async selectWithLock<T = any>(
    tx: any,
    table: any,
    condition: any,
    columns?: Record<string, any>,
    limit?: number,
  ): Promise<T[]> {
    let query = columns ? tx.select(columns).from(table) : tx.select().from(table);
    query = query.where(condition);
    if (limit) {
      query = query.limit(limit);
    }
    return (await query) as T[];
  }
}

export function createAuthDbAdapter(db: AnyAuthDB, dialect: AuthDbDialect = "pg"): AuthDbAdapter {
  if (dialect === "d1") {
    return new D1AuthDbAdapter(db as D1DB);
  }
  return new PgAuthDbAdapter(db as PgDB);
}
