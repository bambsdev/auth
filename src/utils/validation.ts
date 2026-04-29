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
    .transform((v) => v.toLowerCase().trim())
    .openapi({ example: "user@example.com", description: "Email pengguna" }),
  password: z
    .string()
    .min(6, "Password minimal 6 karakter")
    .regex(/[a-zA-Z]/, "Password harus mengandung huruf")
    .regex(/[0-9]/, "Password harus mengandung angka")
    .openapi({ example: "pass12", description: "Kata sandi" }),
  fullName: z.string().min(1, "Nama lengkap tidak boleh kosong").optional()
    .openapi({ example: "John Doe", description: "Nama lengkap pengguna" }),
}).openapi("RegisterRequest");

export type RegisterInput = z.infer<typeof registerSchema>;

// ── Login ─────────────────────────────────────────────────────────────────────

export const loginSchema = z.object({
  email: z
    .string()
    .email("Format email tidak valid")
    .transform((v) => v.toLowerCase().trim())
    .openapi({ example: "user@example.com", description: "Email terdaftar" }),
  password: z.string().min(1, "Password wajib diisi")
    .openapi({ example: "Password123!", description: "Kata sandi" }),
  clientType: clientTypeSchema,
}).openapi("LoginRequest");

// ── Refresh Token ─────────────────────────────────────────────────────────────

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, "Refresh token wajib diisi")
    .openapi({ example: "eyJhbG...", description: "JWT Refresh Token" }),
}).openapi("RefreshRequest");

// ── Logout ────────────────────────────────────────────────────────────────────

export const logoutSchema = z.object({
  refreshToken: z.string().optional()
    .openapi({ example: "eyJhbG...", description: "Refresh Token untuk di-revoke" }),
}).openapi("LogoutRequest");

// ── Verify Email by Code (OTP method) ────────────────────────────────────────

export const verifyEmailCodeSchema = z.object({
  email: z
    .string()
    .email("Format email tidak valid")
    .transform((v) => v.toLowerCase().trim())
    .openapi({ example: "user@example.com", description: "Email yang didaftarkan" }),
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
    .transform((v) => v.toLowerCase().trim())
    .openapi({ example: "user@example.com", description: "Email untuk kirim ulang" }),
}).openapi("ResendVerificationRequest");

// ── Forgot Password ───────────────────────────────────────────────────────────

export const forgotPasswordSchema = z.object({
  email: z
    .string()
    .email("Format email tidak valid")
    .transform((v) => v.toLowerCase().trim())
    .openapi({ example: "user@example.com", description: "Email reset" }),
}).openapi("ForgotPasswordRequest");

// ── Reset Password ────────────────────────────────────────────────────────────

export const resetPasswordSchema = z.object({
  token: z.string().min(1, "Token reset wajib diisi")
    .openapi({ example: "e89b-12d3...", description: "Token unik" }),
  newPassword: z
    .string()
    .min(6, "Password baru minimal 6 karakter")
    .regex(/[a-zA-Z]/, "Password baru harus mengandung huruf")
    .regex(/[0-9]/, "Password baru harus mengandung angka")
    .openapi({ example: "pass12", description: "Password baru" }),
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
    .max(255, "Nama lengkap maksimal 255 karakter")
    .optional()
    .openapi({ example: "John Doe", description: "Nama lengkap baru" }),
}).openapi("UpdateProfileRequest");

// ── Settings: Change Password ─────────────────────────────────────────────────

export const changePasswordSchema = z.object({
  currentPassword: z.string().optional()
    .openapi({ example: "OldPassword123!", description: "Password saat ini" }),
  newPassword: z
    .string()
    .min(6, "Password baru minimal 6 karakter")
    .regex(/[a-zA-Z]/, "Password baru harus mengandung huruf")
    .regex(/[0-9]/, "Password baru harus mengandung angka")
    .openapi({ example: "pass12", description: "Password baru" }),
  clientType: clientTypeSchema,
}).openapi("ChangePasswordRequest");

// ── Settings: Update Avatar ───────────────────────────────────────────────────

export const updateAvatarSchema = z.object({
  avatarUrl: z.string().url("URL avatar tidak valid").nullable()
    .openapi({ example: "https://example.com/avatar.jpg", description: "URL avatar" }),
}).openapi("UpdateAvatarRequest");

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
