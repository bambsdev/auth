// src/services/cache.service.ts
//
// Layer penengah antara setiap request dan KV.
//
// Flow READ  : Cache API (L1, gratis, per-edge) → KV (L2, global)
// Flow WRITE : KV (source of truth) + populate Cache API
//
// Negative cache:
//   Token valid (tidak ada di KV) → disimpan sebagai "0" di Cache API
//   → Request ke-2 dst dalam TTL window → Cache HIT "0" → skip KV
//   → Hemat KV reads hingga 99%
//
// Tradeoff yang diterima:
//   Window 60 detik setelah logout, token masih bisa lolos di edge lain.
//   Acceptable karena refresh token langsung mati di PostgreSQL saat logout.

import { KVNamespace } from "@cloudflare/workers-types";
import {
  NEGATIVE_CACHE_TTL_SECONDS,
  RATE_LIMIT_WINDOW,
} from "../config/token.config";

// URL palsu sebagai namespace Cache API key
const CACHE_BASE = "https://auth-cache.internal";

export class CacheService {
  constructor(
    private readonly kv: KVNamespace,
    private readonly cache: Cache,
  ) {}

  // ── Blacklist ─────────────────────────────────────────────────────────────

  /** Dipanggil saat logout. Write ke KV + populate Cache API langsung. */
  async blacklistToken(jti: string, ttlSeconds: number): Promise<void> {
    const key = `blacklist:${jti}`;

    await this.kv.put(key, "1", {
      expirationTtl: ttlSeconds + 30, // +30s buffer propagasi KV antar region
    });

    // Override apapun yang ada di cache (termasuk negative cache "0")
    await this.cache.put(this.key(key), this.response("1", ttlSeconds));
  }

  /**
   * Cek apakah token di-blacklist.
   *
   * Return true  → token blacklisted, tolak request
   * Return false → token valid (boleh lanjut)
   *
   * "0" di cache = negative cache (sudah dicek ke KV, tidak ada)
   *       → skip KV, langsung return false
   */
  async isTokenBlacklisted(jti: string): Promise<boolean> {
    const key = `blacklist:${jti}`;

    // L1: Cache API
    const cached = await this.cache.match(this.key(key));
    if (cached) {
      const val = await cached.text();
      return val === "1"; // "1" = blacklisted, "0" = negative cache (valid)
    }

    // L2: KV (hanya saat cache miss)
    const kvVal = await this.kv.get(key);

    if (kvVal === "1") {
      // Blacklisted → cache sebagai "1"
      await this.cache.put(
        this.key(key),
        this.response("1", NEGATIVE_CACHE_TTL_SECONDS),
      );
      return true;
    }

    // Tidak ada di KV → token valid
    // Simpan negative cache "0" → request berikutnya skip KV
    await this.cache.put(
      this.key(key),
      this.response("0", NEGATIVE_CACHE_TTL_SECONDS),
    );
    return false;
  }

  // ── Rate Limit ────────────────────────────────────────────────────────────

  async getRateLimit(ip: string): Promise<number> {
    const key = `ratelimit:${ip}`;

    const cached = await this.cache.match(this.key(key));
    if (cached) return parseInt(await cached.text(), 10);

    const kvVal = await this.kv.get(key);
    const count = kvVal ? parseInt(kvVal, 10) : 0;

    // Cache hasil (30 detik) untuk kurangi KV reads saat banyak attempt
    await this.cache.put(this.key(key), this.response(String(count), 30));
    return count;
  }

  async incrementRateLimit(ip: string): Promise<number> {
    const key = `ratelimit:${ip}`;
    const current = await this.getRateLimit(ip);
    const newCount = current + 1;

    await this.kv.put(key, String(newCount), {
      expirationTtl: RATE_LIMIT_WINDOW,
    });

    // Update cache dengan nilai terbaru
    await this.cache.put(this.key(key), this.response(String(newCount), 30));
    return newCount;
  }

  async clearRateLimit(ip: string): Promise<void> {
    const key = `ratelimit:${ip}`;
    await this.kv.delete(key);
    await this.cache.delete(this.key(key));
  }

  // ── OAuth State (CSRF protection) ─────────────────────────────────────────
  // State token disimpan di KV dengan TTL 10 menit.
  // One-time use: setelah dipakai di callback, langsung dihapus.

  async setOAuthState(state: string, payload: string): Promise<void> {
    const key = `oauth-state:${state}`;
    await this.kv.put(key, payload, {
      expirationTtl: 60 * 10, // 10 menit
    });
  }

  async getOAuthState(state: string): Promise<string | null> {
    const key = `oauth-state:${state}`;
    return this.kv.get(key);
  }

  async deleteOAuthState(state: string): Promise<void> {
    const key = `oauth-state:${state}`;
    await this.kv.delete(key);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private key(k: string): Request {
    return new Request(`${CACHE_BASE}/${k}`);
  }

  private response(value: string, maxAge: number): Response {
    return new Response(value, {
      headers: {
        "Cache-Control": `public, max-age=${maxAge}`,
        "Content-Type": "text/plain",
      },
    });
  }
}
