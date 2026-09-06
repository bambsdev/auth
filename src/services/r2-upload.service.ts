// src/services/r2-upload.service.ts
//
// Reusable R2 upload service — handles upload, URL construction,
// old file cleanup. Dapat dipakai untuk avatar user, store logo, dll.

/**
 * Coba ekstrak R2 object key dari URL yang sudah tersimpan.
 *
 * Cara kerjanya:
 * 1. Jika URL dimulai dengan BUCKET_PUBLIC_URL → key = sisa URL
 * 2. Jika URL mengandung proxy prefix → key = sisa setelah prefix
 * 3. Selainnya (Google, eksternal, null) → return null
 */
export function extractR2KeyFromUrl(
  url: string | null,
  bucketPublicUrl: string | undefined,
  proxyPrefix?: string,
): string | null {
  if (!url || typeof url !== "string") return null;

  try {
    // 1. Bersihkan query params (?v=1) atau hash (#xyz) jika ada
    const cleanUrl = url.split(/[?#]/)[0].trim();

    // 2. Cek apakah mengandung prefix standar avatar auth/avatars/
    // Karena R2UploadService selalu meng-upload dengan prefix "auth/avatars/"
    const authAvatarIdx = cleanUrl.indexOf("auth/avatars/");
    if (authAvatarIdx !== -1) {
      const candidateKey = cleanUrl.slice(authAvatarIdx);
      if (candidateKey.length > "auth/avatars/".length) {
        return candidateKey;
      }
    }

    // 3. Cek apakah URL mengandung proxy endpoint "/avatar-file/" terlepas dari mount prefix
    const avatarFileIdx = cleanUrl.indexOf("/avatar-file/");
    if (avatarFileIdx !== -1) {
      const candidateKey = cleanUrl.slice(avatarFileIdx + "/avatar-file/".length);
      if (candidateKey.length > 0) {
        return candidateKey;
      }
    }

    // 4. Jika ada custom proxyPrefix spesifik
    const defaultPrefix = proxyPrefix ?? "/api/settings/avatar-file/";
    if (cleanUrl.includes(defaultPrefix)) {
      const parts = cleanUrl.split(defaultPrefix);
      if (parts.length > 1 && parts[1]) {
        return parts[1];
      }
    }

    // 5. Cek apakah cocok dengan bucketPublicUrl (jika string R2 public ada)
    if (bucketPublicUrl) {
      const base = bucketPublicUrl.replace(/\/+$/, "");
      if (cleanUrl.startsWith(base)) {
        let key = cleanUrl.slice(base.length);
        if (key.startsWith("/")) key = key.slice(1);
        if (key.length > 0) return key;
      }
    }

    // 6. Regex Fallback untuk pola UUID: (folder/)+(UUID.ext)
    const fallbackRegex =
      /((?:[a-zA-Z0-9_-]+\/)+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-zA-Z0-9]+)/i;
    const match = cleanUrl.match(fallbackRegex);
    if (match && match[1]) {
      return match[1];
    }
  } catch (err) {
    console.error("[extractR2KeyFromUrl] Error parsing URL:", err);
  }

  return null; // Asumsi URL Google/eksternal yang tidak dikenali
}

export function getExtensionFromContentType(contentType: string): string {
  if (!contentType || typeof contentType !== "string") return "jpg";
  const cleanType = contentType.split(";")[0].trim().toLowerCase();
  switch (cleanType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/svg+xml":
      return "svg";
    default: {
      const parts = cleanType.split("/");
      if (parts.length > 1 && parts[1]) {
        const sub = parts[1].replace(/[^a-z0-9]/g, "");
        if (sub.length > 0) return sub;
      }
      return "jpg";
    }
  }
}

// ── Service ───────────────────────────────────────────────────────────────────

export class R2UploadService {
  constructor(
    private readonly bucket: R2Bucket,
    private readonly bucketPublicUrl?: string,
  ) {}

  /**
   * Upload file ke R2 dan return key + URL.
   *
   * @param buffer     - File content sebagai ArrayBuffer
   * @param contentType - MIME type (e.g. "image/png")
   * @param prefix     - R2 key prefix (e.g. "auth/avatars", "store/logos")
   * @param proxyBasePath - Fallback proxy path jika tidak ada BUCKET_PUBLIC_URL
   */
  async upload(
    buffer: ArrayBuffer,
    contentType: string,
    prefix: string,
    proxyBasePath: string = "/api/settings/avatar-file",
  ): Promise<{ key: string; url: string }> {
    const ext = getExtensionFromContentType(contentType);
    const key = `${prefix}/${crypto.randomUUID()}.${ext}`;

    await this.bucket.put(key, buffer, {
      httpMetadata: { contentType },
    });

    const url = this.bucketPublicUrl
      ? `${this.bucketPublicUrl.replace(/\/$/, "")}/${key}`
      : `${proxyBasePath}/${key}`;

    return { key, url };
  }

  /**
   * Hapus file R2 berdasarkan URL lama (jika URL dari R2 kita).
   * Aman dipanggil dengan URL Google/eksternal — akan di-skip.
   *
   * @param oldUrl         - URL avatar lama dari DB
   * @param proxyPrefix    - Proxy prefix untuk ekstraksi key
   */
  async deleteByUrl(
    oldUrl: string | null,
    proxyPrefix?: string,
  ): Promise<string | null> {
    const key = extractR2KeyFromUrl(oldUrl, this.bucketPublicUrl, proxyPrefix);
    if (!key) return null;

    try {
      await this.bucket.delete(key);
      console.log(`[r2-upload] Deleted old file: ${key}`);
      return key;
    } catch (err) {
      console.error(`[r2-upload] Failed to delete: ${key}`, err);
      return null;
    }
  }
}
