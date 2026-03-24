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
  if (!url) return null;

  try {
    const defaultPrefix = proxyPrefix ?? "/api/settings/avatar-file/";
    
    // 1. Cek apalah url mengandung proxy endpoint (relatif atau absolut sama saja)
    if (url.includes(defaultPrefix)) {
      const parts = url.split(defaultPrefix);
      if (parts.length > 1 && parts[1]) {
        return parts[1]; // Sisa string adalah key (misal: auth/avatars/123.png)
      }
    }

    // 2. Cek apakah cocok dengan bucketPublicUrl (jika string R2 public ada)
    if (bucketPublicUrl) {
      // Hapus semua trailing slash
      const base = bucketPublicUrl.replace(/\/+$/, "");
      
      if (url.startsWith(base)) {
        // Misal: url = https://pub-xxx.r2.dev/auth/avatars/123.png
        // base = https://pub-xxx.r2.dev
        let key = url.slice(base.length);
        // key = /auth/avatars/123.png
        if (key.startsWith("/")) key = key.slice(1);
        
        if (key.length > 0) return key;
      }
    }

    // 3. Regex Fallback super agresif untuk memastikan key ketemu meskipun config domain beda
    // Mencari format: folder/subfolder/UUID.ext
    const fallbackRegex = /([a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-zA-Z0-9]+)$/i;
    const match = url.match(fallbackRegex);
    if (match && match[1]) {
      return match[1];
    }

  } catch (err) {
    console.error("[extractR2KeyFromUrl] Error parsing URL:", err);
  }

  return null; // Asumsi URL Google/eksternal yang tidak dikenali
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
    const ext = contentType.split("/")[1].replace("jpeg", "jpg");
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
