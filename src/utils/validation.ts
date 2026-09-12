// src/utils/validation.ts
//
// Zod v4 schemas untuk validasi input di semua endpoint.
// Centralized validation — satu file, satu sumber kebenaran.

import { z } from "@hono/zod-openapi";

// ── Client Type ───────────────────────────────────────────────────────────────

export const clientTypeSchema = z
  .enum(["web", "mobile", "desktop"])
  .default("web");

// ── Register ──────────────────────────────────────────────────────────────────

export const registerSchema = z.object({
  email: z
    .string()
    .email("Format email tidak valid")
    .openapi({ example: "user@example.com", description: "Email pengguna" })
    .transform((v) => v.toLowerCase().trim()),
  password: z
    .string()
    .min(8, "Password minimal 8 karakter")
    .max(64, "Password maksimal 64 karakter")
    .regex(/[a-zA-Z]/, "Password harus mengandung huruf")
    .regex(/[0-9]/, "Password harus mengandung angka")
    .openapi({ example: "Password123", description: "Kata sandi" }),
  fullName: z.string().min(1, "Nama lengkap tidak boleh kosong").max(100, "Nama lengkap maksimal 100 karakter").optional()
    .openapi({ example: "John Doe", description: "Nama lengkap pengguna" }),
}).openapi("RegisterRequest");

export type RegisterInput = z.infer<typeof registerSchema>;

// ── Login ─────────────────────────────────────────────────────────────────────

export const loginSchema = z.object({
  email: z
    .string()
    .email("Format email tidak valid")
    .openapi({ example: "user@example.com", description: "Email terdaftar" })
    .transform((v) => v.toLowerCase().trim()),
  password: z.string().min(1, "Password wajib diisi")
    .openapi({ example: "Password123!", description: "Kata sandi" }),
  clientType: clientTypeSchema,
}).openapi("LoginRequest");

// ── Refresh Token ─────────────────────────────────────────────────────────────

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, "Refresh token wajib diisi").optional()
    .openapi({ example: "eyJhbG...", description: "JWT Refresh Token" }),
}).optional().default({}).openapi("RefreshRequest");

// ── Logout ────────────────────────────────────────────────────────────────────

export const logoutSchema = z.object({
  refreshToken: z.string().min(1).optional()
    .openapi({ example: "eyJhbG...", description: "Refresh Token untuk di-revoke" }),
}).optional().default({}).openapi("LogoutRequest");

// ── Verify Email by Link ──────────────────────────────────────────────────────

export const verifyEmailSchema = z.object({
  token: z
    .string()
    .length(64, "Token verifikasi tidak valid")
    .regex(/^[a-f0-9]+$/, "Token verifikasi tidak valid")
    .openapi({
      example: "e89b12d3...",
      description: "Token unik 64 karakter hex",
    }),
}).openapi("VerifyEmailRequest");

// ── Verify Email by Code (OTP method) ────────────────────────────────────────

export const verifyEmailCodeSchema = z.object({
  email: z
    .string()
    .email("Format email tidak valid")
    .openapi({ example: "user@example.com", description: "Email yang didaftarkan" })
    .transform((v) => v.toLowerCase().trim()),
  code: z
    .string()
    .length(6, "Kode verifikasi harus 6 digit")
    .regex(/^\d{6}$/, "Kode verifikasi harus berupa 6 digit angka")
    .openapi({ example: "482910", description: "Kode OTP 6 digit dari email" }),
}).openapi("VerifyEmailCodeRequest");

// ── Resend Verification ───────────────────────────────────────────────────────

export const resendVerificationSchema = z.object({
  email: z
    .string()
    .email("Format email tidak valid")
    .openapi({ example: "user@example.com", description: "Email untuk kirim ulang" })
    .transform((v) => v.toLowerCase().trim()),
}).openapi("ResendVerificationRequest");

// ── Forgot Password ───────────────────────────────────────────────────────────

export const forgotPasswordSchema = z.object({
  email: z
    .string()
    .email("Format email tidak valid")
    .openapi({ example: "user@example.com", description: "Email reset" })
    .transform((v) => v.toLowerCase().trim()),
}).openapi("ForgotPasswordRequest");

// ── Reset Password ────────────────────────────────────────────────────────────

export const resetPasswordSchema = z.object({
  token: z
    .string()
    .length(64, "Token reset tidak valid")
    .regex(/^[a-f0-9]+$/, "Token reset tidak valid")
    .openapi({ example: "e89b12d3...", description: "Token unik 64 karakter hex" }),
  newPassword: z
    .string()
    .min(8, "Password baru minimal 8 karakter")
    .max(64, "Password baru maksimal 64 karakter")
    .regex(/[a-zA-Z]/, "Password baru harus mengandung huruf")
    .regex(/[0-9]/, "Password baru harus mengandung angka")
    .optional()
    .openapi({ example: "Password123", description: "Password baru" }),
  password: z
    .string()
    .min(8, "Password baru minimal 8 karakter")
    .max(64, "Password baru maksimal 64 karakter")
    .regex(/[a-zA-Z]/, "Password baru harus mengandung huruf")
    .regex(/[0-9]/, "Password baru harus mengandung angka")
    .optional()
    .openapi({ example: "Password123", description: "Password baru (alias)" }),
}).openapi("ResetPasswordRequest");

// ── Google Token (Mobile Flow) ────────────────────────────────────────────────

export const googleTokenSchema = z.object({
  idToken: z.string().min(1, "Google ID token wajib diisi")
    .openapi({ example: "eyJhbG...", description: "Google ID Token" }),
  clientType: clientTypeSchema.default("mobile"),
}).openapi("GoogleTokenRequest");

// ── Settings: Update Profile ──────────────────────────────────────────────────

export const updateProfileSchema = z.object({
  username: z
    .string()
    .min(3, "Username minimal 3 karakter")
    .max(50, "Username maksimal 50 karakter")
    .regex(
      /^[a-zA-Z0-9_]+$/,
      "Username hanya boleh huruf, angka, dan underscore",
    )
    .optional()
    .openapi({ example: "johndoe", description: "Username baru" }),
  fullName: z
    .string()
    .min(1, "Nama lengkap tidak boleh kosong")
    .max(100, "Nama lengkap maksimal 100 karakter")
    .optional()
    .openapi({ example: "John Doe", description: "Nama lengkap baru" }),
}).openapi("UpdateProfileRequest");

// ── Settings: Change Password ─────────────────────────────────────────────────

export const changePasswordSchema = z.object({
  currentPassword: z.string().optional()
    .openapi({ example: "OldPassword123!", description: "Password saat ini" }),
  newPassword: z
    .string()
    .min(8, "Password baru minimal 8 karakter")
    .max(64, "Password baru maksimal 64 karakter")
    .regex(/[a-zA-Z]/, "Password baru harus mengandung huruf")
    .regex(/[0-9]/, "Password baru harus mengandung angka")
    .openapi({ example: "Password123", description: "Password baru" }),
  clientType: clientTypeSchema,
}).openapi("ChangePasswordRequest");

// ── Settings: Update Avatar ───────────────────────────────────────────────────

export const updateAvatarSchema = z.object({
  avatarUrl: z.string().url("URL avatar tidak valid").nullable()
    .openapi({ example: "https://example.com/avatar.jpg", description: "URL avatar" }),
}).openapi("UpdateAvatarRequest");

// ── Handoff Token (Cross-Client SSO) ──────────────────────────────────────────

export const createHandoffTokenSchema = z.object({
  redirectUrl: z
    .string()
    .max(2000, "URL redirect terlalu panjang")
    .optional()
    .openapi({
      example: "/book/al-hikam",
      description: "Path atau URL tujuan di aplikasi web setelah proses handoff berhasil",
    }),
  expiresInSeconds: z
    .number()
    .int("Masa berlaku harus berupa bilangan bulat")
    .min(30, "Masa berlaku minimal 30 detik")
    .max(600, "Masa berlaku maksimal 600 detik (10 menit)")
    .default(180)
    .optional()
    .openapi({
      example: 180,
      description: "Durasi masa berlaku tiket dalam detik (default: 180 detik / 3 menit)",
    }),
}).optional().default({}).openapi("CreateHandoffTokenRequest");

export const exchangeHandoffTokenSchema = z.object({
  token: z
    .string()
    .min(1, "Token handoff wajib diisi")
    .max(256, "Format token handoff tidak valid")
    .openapi({
      example: "e89b12d3c4d5e6f7...",
      description: "One-time handoff token 64 karakter hex yang didapatkan dari aplikasi pemanggil",
    }),
}).openapi("ExchangeHandoffTokenRequest");

// ── Helper: Parse body dengan Zod, throw error standar jika gagal ─────────────

export function parseBody<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    throw Object.assign(new Error(firstIssue.message), {
      code: "VALIDATION_ERROR",
      status: 400,
    });
  }
  return result.data;
}
