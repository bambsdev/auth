// src/utils/password.ts
//
// Web Crypto API — built-in di Cloudflare Workers, zero dependency.
// Algoritma : PBKDF2 + SHA-256 + 16-byte random salt
// Format DB  : "saltHex:hashHex"

import { toHex, fromHex } from "./hash";

const ITERATIONS = 100_000;
const KEY_LENGTH = 256; // bits

export async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );

  const derivedBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    KEY_LENGTH,
  );

  return `${toHex(salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength))}:${toHex(derivedBits)}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [saltHex, storedHash] = stored.split(":");
  if (!saltHex || !storedHash) return false;

  const encoder = new TextEncoder();
  const salt = fromHex(saltHex) as Uint8Array<ArrayBuffer>;

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );

  const derivedBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    KEY_LENGTH,
  );

  // Timing-safe comparison — cegah timing attack
  return timingSafeEqual(toHex(derivedBits), storedHash);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function timingSafeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < maxLen; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}
