// tests/index.test.ts
//
// Unit tests for @bambsdev/auth
// Validates that all exports exist and Zod schemas work correctly.

import { describe, test, expect } from "bun:test";
import {
  authRoutes,
  settingRoutes,
  dbMiddleware,
  authMiddleware,
  ImageFilterService,
  users,
  refreshTokens,
  emailVerifications,
  oauthAccounts,
  schema,
  parseBody,
  registerSchema,
  loginSchema,
  refreshSchema,
  logoutSchema,
  updateProfileSchema,
  changePasswordSchema,
  updateAvatarSchema,
  resetPasswordSchema,
} from "../src/index";

// ── Test: All Exports Exist ───────────────────────────────────────────────────

describe("Package Exports", () => {
  test("authRoutes is exported and is a Hono instance", () => {
    expect(authRoutes).toBeDefined();
    expect(typeof authRoutes.fetch).toBe("function");
  });

  test("settingRoutes is exported and is a Hono instance", () => {
    expect(settingRoutes).toBeDefined();
    expect(typeof settingRoutes.fetch).toBe("function");
  });

  test("dbMiddleware is exported", () => {
    expect(dbMiddleware).toBeDefined();
    expect(typeof dbMiddleware).toBe("function");
  });


  test("authMiddleware is exported", () => {
    expect(authMiddleware).toBeDefined();
    expect(typeof authMiddleware).toBe("function");
  });

  test("ImageFilterService is exported", () => {
    expect(ImageFilterService).toBeDefined();
    expect(typeof ImageFilterService).toBe("function"); // class constructor
  });

  test("DB schema tables are exported", () => {
    expect(users).toBeDefined();
    expect(refreshTokens).toBeDefined();
    expect(emailVerifications).toBeDefined();
    expect(oauthAccounts).toBeDefined();
  });

  test("schema namespace is exported", () => {
    expect(schema).toBeDefined();
    expect(schema.users).toBeDefined();
    expect(schema.refreshTokens).toBeDefined();
  });

  test("parseBody is exported", () => {
    expect(parseBody).toBeDefined();
    expect(typeof parseBody).toBe("function");
  });
});

// ── Test: Zod Validation Schemas ──────────────────────────────────────────────

describe("Validation Schemas", () => {
  test("registerSchema validates correct input", () => {
    const result = registerSchema.safeParse({
      email: "Test@Example.COM",
      password: "Password123",
      fullName: "Test User",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe("test@example.com"); // transformed to lowercase
    }
  });

  test("registerSchema rejects weak password", () => {
    const result = registerSchema.safeParse({
      email: "test@example.com",
      password: "weak",
    });
    expect(result.success).toBe(false);
  });


  test("registerSchema rejects password without number", () => {
    const result = registerSchema.safeParse({
      email: "test@example.com",
      password: "PasswordABC",
    });
    expect(result.success).toBe(false);
  });

  test("loginSchema validates correct input", () => {
    const result = loginSchema.safeParse({
      email: "User@Test.com",
      password: "anypassword",
      clientType: "mobile",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe("user@test.com");
      expect(result.data.clientType).toBe("mobile");
    }
  });

  test("loginSchema defaults clientType to web", () => {
    const result = loginSchema.safeParse({
      email: "user@test.com",
      password: "mypassword",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.clientType).toBe("web");
    }
  });

  test("refreshSchema validates correct input", () => {
    const result = refreshSchema.safeParse({
      refreshToken: "some-token-value",
    });
    expect(result.success).toBe(true);
  });

  test("refreshSchema rejects empty token", () => {
    const result = refreshSchema.safeParse({
      refreshToken: "",
    });
    expect(result.success).toBe(false);
  });

  test("updateProfileSchema validates correct input", () => {
    const result = updateProfileSchema.safeParse({
      username: "valid_user",
      fullName: "Valid Name",
    });
    expect(result.success).toBe(true);
  });

  test("updateProfileSchema rejects invalid username characters", () => {
    const result = updateProfileSchema.safeParse({
      username: "invalid user!",
    });
    expect(result.success).toBe(false);
  });

  test("changePasswordSchema validates correct input", () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: "OldPass123",
      newPassword: "NewPass456",
      clientType: "web",
    });
    expect(result.success).toBe(true);
  });

  test("updateAvatarSchema validates URL", () => {
    const result = updateAvatarSchema.safeParse({
      avatarUrl: "https://example.com/avatar.png",
    });
    expect(result.success).toBe(true);
  });

  test("updateAvatarSchema allows null", () => {
    const result = updateAvatarSchema.safeParse({
      avatarUrl: null,
    });
    expect(result.success).toBe(true);
  });

  test("updateAvatarSchema rejects invalid URL", () => {
    const result = updateAvatarSchema.safeParse({
      avatarUrl: "not-a-url",
    });
    expect(result.success).toBe(false);
  });

  test("resetPasswordSchema validates 64-char hex token", () => {
    const validToken = "a".repeat(64);
    const result = resetPasswordSchema.safeParse({
      token: validToken,
      newPassword: "NewPassword123",
    });
    expect(result.success).toBe(true);
  });

  test("resetPasswordSchema rejects invalid token length and non-hex characters", () => {
    const shortResult = resetPasswordSchema.safeParse({
      token: "short-token",
      newPassword: "NewPassword123",
    });
    expect(shortResult.success).toBe(false);

    const nonHexResult = resetPasswordSchema.safeParse({
      token: "z".repeat(64),
      newPassword: "NewPassword123",
    });
    expect(nonHexResult.success).toBe(false);
  });
});

// ── Test: parseBody Helper ────────────────────────────────────────────────────

describe("parseBody Helper", () => {
  test("parseBody returns parsed data for valid input", () => {
    const data = parseBody(loginSchema, {
      email: "user@test.com",
      password: "pass",
    });
    expect(data.email).toBe("user@test.com");
    expect(data.clientType).toBe("web"); // default
  });

  test("parseBody throws for invalid input", () => {
    expect(() => parseBody(loginSchema, { email: "not-email" })).toThrow();
  });

  test("parseBody error has code VALIDATION_ERROR", () => {
    try {
      parseBody(loginSchema, {});
      expect(true).toBe(false); // should not reach here
    } catch (err: any) {
      expect(err.code).toBe("VALIDATION_ERROR");
      expect(err.status).toBe(400);
    }
  });
});

// ── Test: AuditService Null Guard ─────────────────────────────────────────────

describe("AuditService", () => {
  test("AuditService does not throw when analytics binding is undefined", () => {
    const { AuditService } = require("../src/services/audit.service");
    const audit = new AuditService(undefined);
    expect(() => {
      audit.log({ event: "login_success", ip: "127.0.0.1" });
    }).not.toThrow();
  });
});

// ── Test: Password Utility & Timing Safety ────────────────────────────────────

describe("Password Verification", () => {
  test("verifyPassword succeeds for valid password and fails for invalid", async () => {
    const { hashPassword, verifyPassword } = require("../src/utils/password");
    const hash = await hashPassword("MySecretPass123");
    expect(await verifyPassword("MySecretPass123", hash)).toBe(true);
    expect(await verifyPassword("WrongPassword123", hash)).toBe(false);
    expect(await verifyPassword("MySecretPass123", "invalid-format")).toBe(false);
    expect(await verifyPassword("MySecretPass123", "salt:short")).toBe(false);
  }, 15000);
});
