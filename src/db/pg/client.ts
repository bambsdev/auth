// src/db/pg/client.ts
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { createMiddleware } from "hono/factory";
import * as schema from "./schema";
import type { PgBindings, PgVariables, PgDB } from "../../types/index";

export type { PgDB as DB };

export async function createDb(connectionString: string) {
  const client = new Client({ connectionString });
  await client.connect();
  return drizzle(client, { schema, logger: false });
}

export const dbMiddleware = createMiddleware<{
  Bindings: PgBindings;
  Variables: PgVariables;
}>(async (c, next) => {
  const connectionString =
    c.env.LOCAL_DATABASE_URL || c.env.HYPERDRIVE?.connectionString;

  if (!connectionString) {
    throw new Error("Database connection string is missing");
  }

  const client = new Client({ connectionString });
  await client.connect();
  const db = drizzle(client, { schema, logger: false });
  c.set("db", db);

  try {
    await next();
  } finally {
    c.executionCtx.waitUntil(
      client.end().catch((err) =>
        console.error("[pg-db] Failed to close DB connection:", err),
      ),
    );
  }
});
