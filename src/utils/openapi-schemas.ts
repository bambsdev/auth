import { z } from "@hono/zod-openapi";

// ── Shared Standard Schemas ──────────────────────────────────────────────────

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().openapi({ example: "VALIDATION_ERROR" }),
    message: z.string().openapi({ example: "Input tidak valid" }),
  })
}).openapi("ErrorResponse");

export const TokenResponseSchema = z.object({
  data: z.object({
    message: z.string().openapi({ example: "Login berhasil" }),
    accessToken: z.string().openapi({ example: "eyJhbGciOiJIUzI1NiIsInR..." }),
    refreshToken: z.string().optional().openapi({ example: "eyJhbGciOiJIUzI1NiIsInR..." }),
    expiresIn: z.number().openapi({ example: 86400 }),
    tokenType: z.string().openapi({ example: "Bearer" }),
  })
}).openapi("TokenResponse");

export const BasicMessageSchema = z.object({
  data: z.object({
    message: z.string().openapi({ example: "Operasi berhasil" }),
  })
}).openapi("MessageResponse");

export const HandoffTokenResponseSchema = z.object({
  data: z.object({
    token: z.string().openapi({ example: "e89b12d3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1", description: "One-time handoff token" }),
    expiresIn: z.number().openapi({ example: 180, description: "Durasi aktif dalam detik" }),
    expiresAt: z.string().openapi({ example: "2026-09-12T09:30:00.000Z", description: "Waktu kedaluwarsa (ISO string)" }),
    redirectUrl: z.string().optional().openapi({ example: "/book/al-hikam" }),
  }),
}).openapi("HandoffTokenResponse");

export const ExchangeHandoffResponseSchema = z.object({
  data: z.object({
    message: z.string().openapi({ example: "Handoff berhasil" }),
    accessToken: z.string().openapi({ example: "eyJhbGciOiJIUzI1NiIsInR..." }),
    expiresIn: z.number().openapi({ example: 86400 }),
    tokenType: z.string().openapi({ example: "Bearer" }),
    redirectUrl: z.string().optional().openapi({ example: "/book/al-hikam" }),
    user: z.object({
      id: z.string().openapi({ example: "123e4567-e89b-12d3-a456-426614174000" }),
      email: z.string().openapi({ example: "user@example.com" }),
      fullName: z.string().nullable().optional().openapi({ example: "John Doe" }),
      username: z.string().nullable().optional().openapi({ example: "johndoe" }),
      avatarUrl: z.string().nullable().optional().openapi({ example: "https://example.com/avatar.jpg" }),
    }),
  }),
}).openapi("ExchangeHandoffResponse");

// ── Auth Security Scheme ───────────────────────────────────────────────────────

export const BearerAuth = {
  Bearer: []
};
