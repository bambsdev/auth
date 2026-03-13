// src/db/client.ts
//
// Lazy init per-request: buat Client baru tiap request, serahkan pooling ke Hyperdrive.
//
// Kenapa BUKAN Pool global?
//   1. Hyperdrive sudah handle connection pooling di sisi CF edge.
//   2. Pool global bisa stale setelah isolate idle → cold start error 1101.
//   3. Per-request Client = selalu fresh, tidak ada state yang basi.

import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { createMiddleware } from "hono/factory";
import * as schema from "./schema";
import type { Bindings, Variables } from "../types/index";

export function createDb(connectionString: string) {
  const client = new Client({ connectionString });
  return drizzle(client, { schema, logger: false });
}

export type DB = ReturnType<typeof createDb>;

export const dbMiddleware = createMiddleware<{
  Bindings: Bindings;
  Variables: Variables & { db: DB };
}>(async (c, next) => {
  const client = new Client({
    connectionString:
      c.env.LOCAL_DATABASE_URL || c.env.HYPERDRIVE.connectionString,
  });

  await client.connect();
  const db = drizzle(client, { schema, logger: false });
  c.set("db" as any, db);

  try {
    await next();
  } finally {
    client.end().catch(() => {});
  }
});
