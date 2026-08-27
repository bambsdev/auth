// src/services/token.service.ts
import { Client } from "pg";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import { lt, or, isNotNull } from "drizzle-orm";
import * as pgSchema from "../db/pg/schema";
import * as d1Schema from "../db/d1/schema";
import type { D1DB } from "../types/index";

// ── PostgreSQL Cleanup Functions ──────────────────────────────────────────────

/**
 * Hapus refresh token yang sudah expired (PostgreSQL)
 */
export async function cleanupExpiredTokens(
  connectionString: string,
): Promise<{ deletedCount: number }> {
  const client = new Client({ connectionString });

  try {
    await client.connect();
    const db = drizzlePg(client, { schema: pgSchema, logger: false });

    const result = await db
      .delete(pgSchema.refreshTokens)
      .where(lt(pgSchema.refreshTokens.expiresAt, new Date()));

    const count = result.rowCount ?? 0;
    console.log(`[cron] Expired refresh tokens cleaned up (PG). Rows affected: ${count}`);
    return { deletedCount: count };
  } catch (error) {
    console.error("[cron] Error cleaning up expired tokens (PG):", error);
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Hapus password reset token yang sudah expired atau sudah dipakai (PostgreSQL)
 */
export async function cleanupExpiredPasswordResets(
  connectionString: string,
): Promise<{ deletedCount: number }> {
  const client = new Client({ connectionString });

  try {
    await client.connect();
    const db = drizzlePg(client, { schema: pgSchema, logger: false });

    const result = await db
      .delete(pgSchema.passwordResets)
      .where(
        or(
          lt(pgSchema.passwordResets.expiresAt, new Date()),
          isNotNull(pgSchema.passwordResets.usedAt),
        ),
      );

    const count = result.rowCount ?? 0;
    console.log(`[cron] Expired/used password resets cleaned up (PG). Rows affected: ${count}`);
    return { deletedCount: count };
  } catch (error) {
    console.error("[cron] Error cleaning up password resets (PG):", error);
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Hapus email verification token yang sudah expired atau sudah dipakai (PostgreSQL)
 */
export async function cleanupExpiredEmailVerifications(
  connectionString: string,
): Promise<{ deletedCount: number }> {
  const client = new Client({ connectionString });

  try {
    await client.connect();
    const db = drizzlePg(client, { schema: pgSchema, logger: false });

    const result = await db
      .delete(pgSchema.emailVerifications)
      .where(
        or(
          lt(pgSchema.emailVerifications.expiresAt, new Date()),
          isNotNull(pgSchema.emailVerifications.usedAt),
        ),
      );

    const count = result.rowCount ?? 0;
    console.log(`[cron] Expired/used email verifications cleaned up (PG). Rows affected: ${count}`);
    return { deletedCount: count };
  } catch (error) {
    console.error("[cron] Error cleaning up email verifications (PG):", error);
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

// ── Cloudflare D1 Cleanup Functions ───────────────────────────────────────────

function getD1Db(d1OrDb: D1Database | D1DB): D1DB {
  if ("batch" in d1OrDb && "exec" in d1OrDb && "prepare" in d1OrDb) {
    return drizzleD1(d1OrDb as D1Database, { schema: d1Schema, logger: false });
  }
  return d1OrDb as D1DB;
}

/**
 * Hapus refresh token yang sudah expired (Cloudflare D1)
 */
export async function cleanupExpiredTokensD1(
  d1OrDb: D1Database | D1DB,
): Promise<{ deletedCount: number }> {
  try {
    const db = getD1Db(d1OrDb);
    const result = await db
      .delete(d1Schema.refreshTokens)
      .where(lt(d1Schema.refreshTokens.expiresAt, new Date()))
      .returning({ id: d1Schema.refreshTokens.id });

    const count = result.length;
    console.log(`[cron] Expired refresh tokens cleaned up (D1). Rows affected: ${count}`);
    return { deletedCount: count };
  } catch (error) {
    console.error("[cron] Error cleaning up expired tokens (D1):", error);
    throw error;
  }
}

/**
 * Hapus password reset token yang sudah expired atau sudah dipakai (Cloudflare D1)
 */
export async function cleanupExpiredPasswordResetsD1(
  d1OrDb: D1Database | D1DB,
): Promise<{ deletedCount: number }> {
  try {
    const db = getD1Db(d1OrDb);
    const result = await db
      .delete(d1Schema.passwordResets)
      .where(
        or(
          lt(d1Schema.passwordResets.expiresAt, new Date()),
          isNotNull(d1Schema.passwordResets.usedAt),
        ),
      )
      .returning({ id: d1Schema.passwordResets.id });

    const count = result.length;
    console.log(`[cron] Expired/used password resets cleaned up (D1). Rows affected: ${count}`);
    return { deletedCount: count };
  } catch (error) {
    console.error("[cron] Error cleaning up password resets (D1):", error);
    throw error;
  }
}

/**
 * Hapus email verification token yang sudah expired atau sudah dipakai (Cloudflare D1)
 */
export async function cleanupExpiredEmailVerificationsD1(
  d1OrDb: D1Database | D1DB,
): Promise<{ deletedCount: number }> {
  try {
    const db = getD1Db(d1OrDb);
    const result = await db
      .delete(d1Schema.emailVerifications)
      .where(
        or(
          lt(d1Schema.emailVerifications.expiresAt, new Date()),
          isNotNull(d1Schema.emailVerifications.usedAt),
        ),
      )
      .returning({ id: d1Schema.emailVerifications.id });

    const count = result.length;
    console.log(`[cron] Expired/used email verifications cleaned up (D1). Rows affected: ${count}`);
    return { deletedCount: count };
  } catch (error) {
    console.error("[cron] Error cleaning up email verifications (D1):", error);
    throw error;
  }
}
