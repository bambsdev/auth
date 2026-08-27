// src/db/d1/schema.ts
import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
  index,
} from "drizzle-orm/sqlite-core";

// ── Users & Auth ──────────────────────────────────────────────────────────────

export const users = sqliteTable(
  "users",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    email: text("email").unique().notNull(),
    username: text("username").unique(), // nullable — auto-filled dari email split @
    password: text("password"), // nullable — null untuk OAuth-only users
    fullName: text("full_name"),
    avatarUrl: text("avatar_url"), // dari profil OAuth atau diatur user
    isEmailVerified: integer("is_email_verified", { mode: "boolean" }).default(
      false,
    ),
    isActive: integer("is_active", { mode: "boolean" }).default(true),
    createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(
      () => new Date(),
    ),
    updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(
      () => new Date(),
    ),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
  },
  (table) => ({
    usersActiveIdx: index("users_active_idx")
      .on(table.id)
      .where(sql`deleted_at IS NULL`),
  }),
);

export const refreshTokens = sqliteTable("refresh_tokens", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(), // SHA-256 dari actual token
  clientType: text("client_type").notNull(), // 'web' | 'mobile' | 'desktop'
  deviceInfo: text("device_info", { mode: "json" }), // { ua, ip, deviceName }
  familyId: text("family_id").notNull(),
  isRevoked: integer("is_revoked", { mode: "boolean" }).default(false),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(
    () => new Date(),
  ),
  lastUsedAt: integer("last_used_at", { mode: "timestamp" }).$defaultFn(
    () => new Date(),
  ),
}, (table) => ({
  familyIdx: index("refresh_tokens_family_idx").on(table.familyId),
}));

export const emailVerifications = sqliteTable("email_verifications", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(), // SHA-256 dari plain token
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  usedAt: integer("used_at", { mode: "timestamp" }), // null = belum dipakai
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(
    () => new Date(),
  ),
});

export const passwordResets = sqliteTable("password_resets", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(), // SHA-256 dari plain token
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  usedAt: integer("used_at", { mode: "timestamp" }), // null = belum dipakai
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(
    () => new Date(),
  ),
});

export const oauthAccounts = sqliteTable(
  "oauth_accounts",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(), // "google"
    providerUserId: text("provider_user_id").notNull(), // Google sub
    email: text("email"),
    displayName: text("display_name"),
    avatarUrl: text("avatar_url"),
    createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(
      () => new Date(),
    ),
    updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(
      () => new Date(),
    ),
  },
  (table) => ({
    // Satu akun provider hanya bisa di-link ke satu user
    uniqueProviderUser: uniqueIndex("oauth_provider_user_idx").on(
      table.provider,
      table.providerUserId,
    ),
  }),
);
