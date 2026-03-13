// src/utils/logger.ts
import type { MiddlewareHandler } from "hono";
import type { Bindings, Variables } from "../types/index";

export const customLogger = (): MiddlewareHandler<{
  Bindings: Bindings;
  Variables: Variables;
}> => {
  return async (c, next) => {
    const start = Date.now();
    await next();
    const ms = Date.now() - start;

    // 1. Ambil data penting untuk Audit
    const ip =
      c.req.header("CF-Connecting-IP") ||
      c.req.header("X-Forwarded-For") ||
      "unknown";
    const method = c.req.method;

    // Gunakan pathname saja agar url params panjang tidak memenuhi log, opsional tapi disarankan
    const url = new URL(c.req.url).pathname;
    const status = c.res.status;

    // (Opsional) Jika route sudah melewati authMiddleware, kita bisa ambil userId
    // Menggunakan get() dari ctx untuk aman menghindari typescript warning jika var tidak terinisialisasi
    const userId = c.get("userId") ? ` User:${c.get("userId")}` : "";

    const timestamp = new Date().toISOString();

    // 2. Beri Log Level & Warna sederhana berdasarkan HTTP Status
    if (status >= 500) {
      console.error(
        `🔴 [${timestamp}] ERROR: ${method} ${url} - ${status} (${ms}ms) IP:${ip}${userId}`,
      );
    } else if (status >= 400) {
      console.warn(
        `🟠 [${timestamp}] WARN: ${method} ${url} - ${status} (${ms}ms) IP:${ip}${userId}`,
      );
    } else {
      console.log(
        `🟢 [${timestamp}] INFO: ${method} ${url} - ${status} (${ms}ms) IP:${ip}${userId}`,
      );
    }
  };
};
