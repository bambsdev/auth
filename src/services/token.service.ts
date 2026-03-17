// src/services/token.service.ts
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { lt } from "drizzle-orm";
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
