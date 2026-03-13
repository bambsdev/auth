// src/utils/error.ts
//
// Shared error helper — melempar Error dengan property `code` dan `status`.
// Dipakai di seluruh service layer untuk standarisasi error response.

export interface AppError extends Error {
  code: string;
  status: number;
}

/**
 * Throw error dengan code dan status HTTP.
 * Digunakan sebagai early return pattern di service layer.
 */
export function fail(message: string, code: string, status = 401): never {
  throw Object.assign(new Error(message), { code, status });
}
