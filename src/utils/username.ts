// src/utils/username.ts
import { eq } from "drizzle-orm";
import type { AuthDbAdapter } from "../db/adapter";
import type { AnyAuthDB } from "../types/index";
import { users as defaultPgUsers } from "../db/pg/schema";

/**
 * Resolves a unique, sanitized username satisfying /^[a-zA-Z0-9_]+$/ with min length 3.
 */
export async function resolveUniqueUsername(
  dbOrAdapter: AnyAuthDB | AuthDbAdapter,
  baseInput: string,
  customUsersTable?: any,
): Promise<string> {
  const isAdapter = "tables" in dbOrAdapter && "db" in dbOrAdapter;
  const db = (isAdapter ? (dbOrAdapter as AuthDbAdapter).db : dbOrAdapter) as any;
  const usersTable = customUsersTable ?? (isAdapter ? (dbOrAdapter as AuthDbAdapter).tables.users : defaultPgUsers);

  // 1. Sanitasi input: hanya simpan a-z, A-Z, 0-9, dan _
  let sanitized = baseInput.replace(/[^a-zA-Z0-9_]/g, "");

  // 2. Jika setelah sanitasi panjangnya < 3, pad dengan karakter acak
  if (sanitized.length < 3) {
    const randomDigits = String(Math.floor(100 + Math.random() * 900));
    sanitized = (sanitized + "user" + randomDigits).slice(0, 50);
  }

  // Cap max length 50 (sesuai schema max)
  sanitized = sanitized.slice(0, 50);

  let candidate = sanitized;

  // 3. Cek ketersediaan kandidat utama di DB
  const existing = await db.query.users.findFirst({
    where: eq(usersTable.username, candidate),
    columns: { id: true },
  });

  if (!existing) {
    return candidate;
  }

  // 4. Jika bentrok, tambahkan suffix acak
  for (let i = 0; i < 5; i++) {
    const randomSuffix = String(Math.floor(1000 + Math.random() * 9000));
    const altCandidate = `${sanitized.slice(0, 45)}_${randomSuffix}`;

    const existingSuffix = await db.query.users.findFirst({
      where: eq(usersTable.username, altCandidate),
      columns: { id: true },
    });

    if (!existingSuffix) {
      return altCandidate;
    }
  }

  // Fallback: UUID sanitized
  return `usr_${crypto.randomUUID().replace(/[^a-zA-Z0-9]/g, "").slice(0, 10)}`;
}
