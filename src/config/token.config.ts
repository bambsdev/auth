// src/config/token.config.ts

export const TOKEN_POLICY = {
  web: {
    accessToken: { expiresInSeconds: 60 * 15 }, // 15 menit
    refreshToken: { expiresInSeconds: 60 * 60 * 24 * 7 }, // 7 hari
  },
  mobile: {
    accessToken: { expiresInSeconds: 60 * 60 }, // 1 jam
    refreshToken: { expiresInSeconds: 60 * 60 * 24 * 180 }, // 180 hari
  },
  desktop: {
    accessToken: { expiresInSeconds: 60 * 30 }, // 30 menit
    refreshToken: { expiresInSeconds: 60 * 60 * 24 * 30 }, // 30 hari
  },
} as const;

export type ClientType = keyof typeof TOKEN_POLICY;

// Cache API: negative cache TTL untuk token valid
// Semakin kecil = lebih aman, lebih banyak KV reads
// Semakin besar = lebih hemat KV, window vulnerability lebih lebar
export const NEGATIVE_CACHE_TTL_SECONDS = 60;

// Rate limit login
export const RATE_LIMIT_MAX = 5;
export const RATE_LIMIT_WINDOW = 60 * 5; // 5 menit
