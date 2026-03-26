// src/services/token.service.ts
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { lt, or, isNotNull } from "drizzle-orm";
import * as schema from "../db/schema";

/**
 * Hapus refresh token yang sudah expired
 */
export async function cleanupExpiredTokens(connectionString: string) {
  const client = new Client({
    connectionString,
  });

  try {
    await client.connect();
    const db = drizzle(client, { schema, logger: false });
    
    const result = await db
      .delete(schema.refreshTokens)
      .where(lt(schema.refreshTokens.expiresAt, new Date()));
      
    console.log(`[cron] Expired refresh tokens cleaned up. Rows affected: ${result.rowCount}`);
  } catch (error) {
    console.error("[cron] Error cleaning up expired tokens:", error);
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Hapus password reset token yang sudah expired atau sudah dipakai
 */
export async function cleanupExpiredPasswordResets(connectionString: string) {
  const client = new Client({
    connectionString,
  });

  try {
    await client.connect();
    const db = drizzle(client, { schema, logger: false });

    const result = await db
      .delete(schema.passwordResets)
      .where(
        or(
          lt(schema.passwordResets.expiresAt, new Date()),
          isNotNull(schema.passwordResets.usedAt),
        ),
      );

    console.log(`[cron] Expired/used password resets cleaned up. Rows affected: ${result.rowCount}`);
  } catch (error) {
    console.error("[cron] Error cleaning up password resets:", error);
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Hapus email verification token yang sudah expired atau sudah dipakai
 */
export async function cleanupExpiredEmailVerifications(connectionString: string) {
  const client = new Client({
    connectionString,
  });

  try {
    await client.connect();
    const db = drizzle(client, { schema, logger: false });

    const result = await db
      .delete(schema.emailVerifications)
      .where(
        or(
          lt(schema.emailVerifications.expiresAt, new Date()),
          isNotNull(schema.emailVerifications.usedAt),
        ),
      );

    console.log(`[cron] Expired/used email verifications cleaned up. Rows affected: ${result.rowCount}`);
  } catch (error) {
    console.error("[cron] Error cleaning up email verifications:", error);
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}
