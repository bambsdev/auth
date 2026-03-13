// src/utils/validation.ts
//
// Zod v4 schemas untuk validasi input di semua endpoint.
// Centralized validation — satu file, satu sumber kebenaran.

import { z } from "zod";

// ── Client Type ───────────────────────────────────────────────────────────────

export const clientTypeSchema = z
  .enum(["web", "mobile", "desktop"])
  .default("web");

// ── Register ──────────────────────────────────────────────────────────────────

export const registerSchema = z.object({
  email: z
    .string()
    .email("Format email tidak valid")
    .transform((v) => v.toLowerCase().trim()),
  password: z
    .string()
    .min(8, "Password minimal 8 karakter")
    .regex(/[A-Z]/, "Password harus ada huruf kapital")
    .regex(/[0-9]/, "Password harus ada angka"),
  fullName: z.string().min(1, "Nama lengkap tidak boleh kosong").optional(),
});

export type RegisterInput = z.infer<typeof registerSchema>;

// ── Login ─────────────────────────────────────────────────────────────────────

export const loginSchema = z.object({
  email: z
    .string()
    .email("Format email tidak valid")
    .transform((v) => v.toLowerCase().trim()),
  password: z.string().min(1, "Password wajib diisi"),
  clientType: clientTypeSchema,
});

// ── Refresh Token ─────────────────────────────────────────────────────────────

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, "Refresh token wajib diisi"),
});

// ── Logout ────────────────────────────────────────────────────────────────────

export const logoutSchema = z.object({
  refreshToken: z.string().optional(),
});

// ── Resend Verification ───────────────────────────────────────────────────────

export const resendVerificationSchema = z.object({
  email: z
    .string()
    .email("Format email tidak valid")
    .transform((v) => v.toLowerCase().trim()),
});

// ── Google Token (Mobile Flow) ────────────────────────────────────────────────

export const googleTokenSchema = z.object({
  idToken: z.string().min(1, "Google ID token wajib diisi"),
  clientType: clientTypeSchema,
});

// ── Body Model (Block-based content mirip Medium) ─────────────────────────────

const markupTypeEnum = z.enum([
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "link",
]);

export const markupSchema = z.object({
  start: z.number().int().min(0),
  end: z.number().int().min(0),
  type: markupTypeEnum,
  href: z.string().url().optional(), // hanya untuk type "link"
});

const paragraphTypeEnum = z.enum([
  "P",
  "H1",
  "H2",
  "BQ1",
  "BQ2",
  "PRE",
  "IMG",
  "VID",
  "link",
  "HR",
  "OLI",
  "ULI",
]);

export const paragraphSchema = z.object({
  id: z.string().min(1, "Paragraph ID wajib diisi"),
  type: paragraphTypeEnum,
  text: z.string().optional(), // optional untuk IMG, VID, HR
  markups: z.array(markupSchema).optional().default([]),
  metadata: z
    .object({
      src: z.string().optional(), // URL gambar/video
      alt: z.string().optional(), // alt text gambar
      caption: z.string().optional(),
      language: z.string().optional(), // untuk PRE (code block)
      href: z.string().optional(), // untuk type "link" embed
    })
    .optional(),
});

export const bodyModelSchema = z.object({
  paragraphs: z.array(paragraphSchema).min(1, "Konten tidak boleh kosong"),
});

// ── Posts ──────────────────────────────────────────────────────────────────────

export const createPostSchema = z.object({
  title: z
    .string()
    .min(1, "Judul tidak boleh kosong")
    .max(300, "Judul maksimal 300 karakter"),
  bodyModel: bodyModelSchema,
  coverImage: z.string().url("URL cover image tidak valid").optional(),
  clientType: clientTypeSchema,
});

export const updatePostSchema = z.object({
  title: z
    .string()
    .min(1, "Judul tidak boleh kosong")
    .max(300, "Judul maksimal 300 karakter")
    .optional(),
  bodyModel: bodyModelSchema.optional(),
  coverImage: z
    .string()
    .url("URL cover image tidak valid")
    .nullable()
    .optional(),
  isUnlisted: z.boolean().optional(),
});

export const publishPostSchema = z.object({
  tags: z
    .array(z.string().uuid("Tag ID harus UUID valid"))
    .max(5, "Maksimal 5 tag")
    .optional()
    .default([]),
});

// ── Comments ──────────────────────────────────────────────────────────────────

export const createCommentSchema = z.object({
  content: z.object({
    text: z
      .string()
      .min(1, "Komentar tidak boleh kosong")
      .max(2000, "Komentar maksimal 2000 karakter"),
    markups: z.array(markupSchema).optional().default([]),
  }),
  parentId: z.string().uuid("Parent ID harus UUID valid").optional(),
});

export const updateCommentSchema = z.object({
  content: z.object({
    text: z
      .string()
      .min(1, "Komentar tidak boleh kosong")
      .max(2000, "Komentar maksimal 2000 karakter"),
    markups: z.array(markupSchema).optional().default([]),
  }),
});

// ── Cursor Pagination ─────────────────────────────────────────────────────────

export const cursorPaginationSchema = z.object({
  cursor: z.string().optional(), // ISO timestamp + UUID encoded
  limit: z
    .string()
    .optional()
    .transform((v) => {
      const n = v ? parseInt(v, 10) : 10;
      return Math.min(Math.max(n, 1), 50); // clamp 1-50
    }),
});

// ── Reports ───────────────────────────────────────────────────────────────────

export const reportSchema = z.object({
  category: z.enum([
    "spam",
    "inappropriate",
    "hate_speech",
    "plagiarism",
    "other",
  ]),
  reason: z.string().max(1000, "Alasan maksimal 1000 karakter").optional(),
});

// ── Admin ─────────────────────────────────────────────────────────────────────

export const promoteAdminSchema = z.object({
  role: z.enum(["moderator", "stakeholder"]).default("moderator"),
  internalNotes: z.string().max(500).optional(),
});

export const reviewReportSchema = z.object({
  status: z.enum(["reviewed", "action_taken", "dismissed"]),
  adminNotes: z.string().max(1000).optional(),
});

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
    .optional(),
  fullName: z
    .string()
    .min(1, "Nama lengkap tidak boleh kosong")
    .max(255, "Nama lengkap maksimal 255 karakter")
    .optional(),
});

// ── Settings: Change Password ─────────────────────────────────────────────────

export const changePasswordSchema = z.object({
  currentPassword: z.string().optional(),
  newPassword: z
    .string()
    .min(8, "Password baru minimal 8 karakter")
    .regex(/[A-Z]/, "Password baru harus ada huruf kapital")
    .regex(/[0-9]/, "Password baru harus ada angka"),
  clientType: clientTypeSchema,
});

// ── Settings: Update Avatar ───────────────────────────────────────────────────

export const updateAvatarSchema = z.object({
  avatarUrl: z.string().url("URL avatar tidak valid").nullable(),
});

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
