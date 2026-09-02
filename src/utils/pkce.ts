// src/utils/pkce.ts
//
// RFC 7636 Proof Key for Code Exchange (PKCE) utilities

/**
 * Base64URL encoder without padding (RFC 7636 Section 3)
 */
export function base64UrlEncode(buffer: Uint8Array | ArrayBuffer): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Generates an RFC 7636 compliant code_verifier.
 * High-entropy cryptographic random string, length between 43 and 128 characters.
 * @param lengthInBytes Number of random bytes (default 64, produces ~86 characters base64url)
 */
export function generateCodeVerifier(lengthInBytes = 64): string {
  const bytes = new Uint8Array(lengthInBytes);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/**
 * Computes an RFC 7636 S256 code_challenge from a code_verifier:
 * code_challenge = BASE64URL(SHA256(ASCII(code_verifier)))
 */
export async function generateCodeChallenge(codeVerifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(hash);
}
