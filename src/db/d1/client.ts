// src/db/d1/client.ts
import { drizzle } from "drizzle-orm/d1";
import { createMiddleware } from "hono/factory";
import * as schema from "./schema";
import type { D1Bindings, D1Variables, D1DB } from "../../types/index";

export type { D1DB as DB };

export function createD1Db(d1: D1Database) {
  return drizzle(d1, { schema, logger: false });
}

export const d1Middleware = createMiddleware<{
  Bindings: D1Bindings;
  Variables: D1Variables;
}>(async (c, next) => {
  if (!c.env.DB) {
    throw new Error("D1 database binding 'DB' is missing in environment");
  }

  const db = drizzle(c.env.DB, { schema, logger: false });
  c.set("db", db);

  await next();
});
