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
    refreshToken: z.string().openapi({ example: "eyJhbGciOiJIUzI1NiIsInR..." }),
    expiresIn: z.number().openapi({ example: 86400 }),
    tokenType: z.string().openapi({ example: "Bearer" }),
  })
}).openapi("TokenResponse");

export const BasicMessageSchema = z.object({
  data: z.object({
    message: z.string().openapi({ example: "Operasi berhasil" }),
  })
}).openapi("MessageResponse");

// ── Auth Security Scheme ───────────────────────────────────────────────────────

export const BearerAuth = {
  Bearer: []
};
