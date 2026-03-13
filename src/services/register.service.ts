// src/services/register.service.ts

import { eq } from "drizzle-orm";
import { users } from "../db/schema";
import { hashPassword } from "../utils/password";
import { fail } from "../utils/error";
import { registerSchema, type RegisterInput } from "../utils/validation";
import type { DB } from "../db/client";

export interface RegisterResult {
  id: string;
  email: string;
  createdAt: Date;
}

// ── Service ───────────────────────────────────────────────────────────────────

export class RegisterService {
  constructor(private readonly db: DB) {}

  async register(input: RegisterInput): Promise<RegisterResult> {
    const { email, password, fullName } = input;

    // Cek email duplikat
    const existing = await this.db.query.users.findFirst({
      where: eq(users.email, email),
      columns: { id: true },
    });

    if (existing) fail("Email sudah terdaftar", "EMAIL_TAKEN", 409);

    // Hash password (Web Crypto API)
    const hashed = await hashPassword(password);

    // Derive username dari email
    const derived = email.split("@")[0];
    const username = await this.resolveUniqueUsername(derived);

    // Insert
    const [created] = await this.db
      .insert(users)
      .values({
        email,
        password: hashed,
        username,
        fullName: fullName ?? derived,
        isActive: true,
      })
      .returning({
        id: users.id,
        email: users.email,
        fullName: users.fullName,
        createdAt: users.createdAt,
      });

    return created as RegisterResult;
  }

  // ── Resolve Unique Username ──────────────────────────────────────────────
  // Jika username sudah dipakai, kurangi 1 karakter dari belakang sampai unik.

  private async resolveUniqueUsername(base: string): Promise<string> {
    let candidate = base;
    while (candidate.length > 0) {
      const existing = await this.db.query.users.findFirst({
        where: eq(users.username, candidate),
        columns: { id: true },
      });
      if (!existing) return candidate;
      candidate = candidate.slice(0, -1);
    }
    // Fallback: gunakan UUID jika semua trimmed versions sudah terpakai
    return crypto.randomUUID().slice(0, 8);
  }
}
