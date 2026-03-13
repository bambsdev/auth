// src/middleware/auth.middleware.ts

import { createMiddleware } from "hono/factory";
import { CacheService } from "../services/cache.service";
import { AuthService } from "../services/auth.service";
import type { Bindings, Variables } from "../types/index";

export const authMiddleware = createMiddleware<{
  Bindings: Bindings;
  Variables: Variables;
}>(async (c, next) => {
  const header = c.req.header("Authorization");

  if (!header?.startsWith("Bearer ")) {
    return c.json(
      {
        error: { code: "UNAUTHORIZED", message: "Token tidak ditemukan" },
      },
      401,
    );
  }

  const token = header.slice(7);

  // DB sudah di-inject oleh dbMiddleware → ambil dari context
  const db = c.var.db;
  const cacheService = new CacheService(c.env.KV, caches.default);
  const authService = new AuthService(
    db,
    cacheService,
    c.env.JWT_SECRET,
    c.env.JWT_REFRESH_SECRET,
  );

  try {
    const payload = await authService.validateAccessToken(token);
    c.set("userId", payload.sub);
    c.set("jti", payload.jti);
    c.set("clientType", payload.client);
  } catch (err: any) {
    return c.json(
      {
        error: { code: err.code ?? "UNAUTHORIZED", message: err.message },
      },
      401,
    );
  }

  await next();
});
