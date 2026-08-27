// src/services/register.service.ts
import { eq } from "drizzle-orm";
import { hashPassword } from "../utils/password";
import { resolveUniqueUsername } from "../utils/username";
import { fail } from "../utils/error";
import { type RegisterInput } from "../utils/validation";
import type { AnyAuthDB } from "../types/index";
import { AuthDbAdapter, createAuthDbAdapter, type AuthDbDialect } from "../db/adapter";

export interface RegisterResult {
  id: string;
  email: string;
  fullName?: string | null;
  createdAt: Date;
}

// ── Service ───────────────────────────────────────────────────────────────────

export class RegisterService {
  private readonly adapter: AuthDbAdapter;

  constructor(dbOrAdapter: AnyAuthDB | AuthDbAdapter, dialect: AuthDbDialect = "pg") {
    if ("dialect" in dbOrAdapter && "tables" in dbOrAdapter) {
      this.adapter = dbOrAdapter;
    } else {
      this.adapter = createAuthDbAdapter(dbOrAdapter, dialect);
    }
  }

  async register(input: RegisterInput): Promise<RegisterResult> {
    const { email, password, fullName } = input;
    const db = this.adapter.db as any;
    const usersTable = this.adapter.tables.users;

    // Cek email duplikat
    const existing = await db.query.users.findFirst({
      where: eq(usersTable.email, email.toLowerCase().trim()),
      columns: { id: true },
    });

    if (existing) fail("Email sudah terdaftar", "EMAIL_TAKEN", 409);

    // Hash password (Web Crypto API)
    const hashed = await hashPassword(password);

    // Derive username dari email
    const derived = email.split("@")[0];
    const username = await resolveUniqueUsername(this.adapter, derived);

    // Insert
    const [created] = await db
      .insert(usersTable)
      .values({
        email: email.toLowerCase().trim(),
        password: hashed,
        username,
        fullName: fullName ?? derived,
        isActive: true,
      })
      .returning({
        id: usersTable.id,
        email: usersTable.email,
        fullName: usersTable.fullName,
        createdAt: usersTable.createdAt,
      });

    return created as RegisterResult;
  }
}
