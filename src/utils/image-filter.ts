// src/utils/image-filter.ts
//
// Image AI filter — menggunakan @cf/microsoft/resnet-50 untuk mendeteksi
// gambar yang berbau sex, vulgar, pakaian minim (bikini, underwear, dll.)
// secara fleksibel dan case-insensitive.
//

export interface ImageFilterConfig {
  enabled?: boolean;
  blockedLabels?: string[];
  confidenceThreshold?: number;
  maxSizeBytes?: number; // Custom max avatar file size in bytes (default: 1MB)
  failOpenOnAiError?: boolean; // Opsional: jika true, loloskan gambar jika AI Cloudflare Workers error / offline
}

export interface IImageFilterService {
  isImageAllowed(
    imageUrl: string,
  ): Promise<{ allowed: boolean; reason?: string }>;
  isImageBufferAllowed(
    buffer: ArrayBuffer,
    contentType: string,
  ): Promise<{ allowed: boolean; reason?: string }>;
  filterImageUrl(imageUrl: string | null | undefined): Promise<string | null>;
}

// ── Service ───────────────────────────────────────────────────────────────────

// Confidence threshold default
const CONFIDENCE_THRESHOLD = 0.15;

const DEFAULT_BLOCKED_LABELS = [
  "bikini",
  "brassiere",
  "miniskirt",
  "maillot",
  "diaper",
  "sex",
  "sexy",
  "vulgar"
];

export function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;

    const hostname = parsed.hostname.toLowerCase();
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "0.0.0.0" ||
      hostname === "169.254.169.254"
    ) {
      return false;
    }

    // Blokir private IPv4 ranges (10.x.x.x, 172.16-31.x.x, 192.168.x.x, 100.64-127.x.x CGNAT, 169.254.x.x link-local)
    if (
      /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|169\.254\.)/.test(
        hostname,
      )
    ) {
      return false;
    }

    // Blokir suffix domain internal/lokal
    if (
      hostname.endsWith(".internal") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".lan") ||
      hostname.endsWith(".home")
    ) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

export class ImageFilterService implements IImageFilterService {
  constructor(
    private readonly ai: Ai,
    private readonly config?: ImageFilterConfig,
  ) {}

  /**
    * Periksa apakah gambar di URL mengandung konten terlarang.
    * Return { allowed, reason? }
    */
  async isImageAllowed(
    imageUrl: string,
  ): Promise<{ allowed: boolean; reason?: string }> {
    try {
      if (this.config?.enabled === false) {
        return { allowed: true };
      }

      if (!isSafeUrl(imageUrl)) {
        return { allowed: false, reason: "URL gambar tidak valid atau tidak diizinkan" };
      }

      if (!this.ai) {
        console.warn("[image-filter] Cloudflare Workers AI binding ('AI') is missing or undefined.");
        if (this.config?.failOpenOnAiError) {
          return { allowed: true };
        }
        return { allowed: false, reason: "Deteksi keamanan gambar gagal. Binding AI tidak tersedia." };
      }

      // 1. Fetch image
      const response = await fetch(imageUrl);
      if (!response.ok) {
        return { allowed: false, reason: "Gagal mengambil gambar dari URL" };
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.startsWith("image/")) {
        return { allowed: false, reason: "URL bukan gambar yang valid" };
      }

      const imageBuffer = await response.arrayBuffer();
      const imageArray = new Uint8Array(imageBuffer);

      // 2. Classify Image menggunakan @cf/microsoft/resnet-50
      try {
        const detections = (await this.ai.run("@cf/microsoft/resnet-50" as any, {
          image: Array.from(imageArray),
        }) as unknown) as { label: string; score: number }[];

        if (detections && Array.isArray(detections)) {
          const threshold = this.config?.confidenceThreshold ?? CONFIDENCE_THRESHOLD;
          const blocked = this.config?.blockedLabels ?? DEFAULT_BLOCKED_LABELS;

          for (const det of detections) {
            const labelLower = det.label.toLowerCase();
            const matchesBlocked = blocked.some(blockedLabel => 
              labelLower.includes(blockedLabel.toLowerCase())
            );

            if (matchesBlocked && det.score > threshold) {
              return {
                allowed: false,
                reason: `Terdeteksi konten tidak pantas (${det.label}) dengan skor ${(det.score * 100).toFixed(1)}%`,
              };
            }
          }
        }
      } catch (detErr: any) {
        if (detErr?.message?.includes("429") || detErr?.status === 429) {
          console.warn("[image-filter] Quota exceeded (429), failing close.");
          return { allowed: false, reason: "Batas penggunaan fitur deteksi gambar harian tercapai. Silakan coba unggah kembali esok hari." };
        }
        console.warn("[image-filter] Classification failed:", detErr?.message ?? detErr);
        if (this.config?.failOpenOnAiError) {
          console.warn("[image-filter] failOpenOnAiError is enabled, allowing image despite AI classification failure.");
          return { allowed: true };
        }
        return { allowed: false, reason: "Deteksi keamanan gambar gagal. Silakan coba lagi nanti." };
      }
      return { allowed: true };
    } catch (err: any) {
      console.error("[image-filter] Error:", err?.message ?? err);
      return { allowed: false, reason: "Sistem gagal memproses gambar." };
    }
  }

  /**
    * Filter langsung dari ArrayBuffer
    */
  async isImageBufferAllowed(
    buffer: ArrayBuffer,
    contentType: string,
  ): Promise<{ allowed: boolean; reason?: string }> {
    try {
      if (this.config?.enabled === false) {
        return { allowed: true };
      }

      if (!contentType.startsWith("image/")) {
        return { allowed: false, reason: "File bukan gambar yang valid" };
      }

      if (!this.ai) {
        console.warn("[image-filter] Cloudflare Workers AI binding ('AI') is missing or undefined.");
        if (this.config?.failOpenOnAiError) {
          return { allowed: true };
        }
        return { allowed: false, reason: "Deteksi keamanan gambar gagal. Binding AI tidak tersedia." };
      }

      const imageArray = new Uint8Array(buffer);

      // 2. Classify Image (Buffer)
      try {
        const detections = (await this.ai.run("@cf/microsoft/resnet-50" as any, {
          image: Array.from(imageArray),
        }) as unknown) as { label: string; score: number }[];

        if (detections && Array.isArray(detections)) {
          const threshold = this.config?.confidenceThreshold ?? CONFIDENCE_THRESHOLD;
          const blocked = this.config?.blockedLabels ?? DEFAULT_BLOCKED_LABELS;

          for (const det of detections) {
            const labelLower = det.label.toLowerCase();
            const matchesBlocked = blocked.some(blockedLabel => 
              labelLower.includes(blockedLabel.toLowerCase())
            );

            if (matchesBlocked && det.score > threshold) {
              return {
                allowed: false,
                reason: `Terdeteksi konten tidak pantas (${det.label}) dengan skor ${(det.score * 100).toFixed(1)}%`,
              };
            }
          }
        }
      } catch (detErr: any) {
        if (detErr?.message?.includes("429") || detErr?.status === 429) {
          console.warn("[image-filter] Quota exceeded (429 - Buffer), failing close.");
          return { allowed: false, reason: "Batas penggunaan fitur deteksi gambar harian tercapai. Silakan coba unggah kembali esok hari." };
        }
        console.warn("[image-filter] Classification failed (buffer):", detErr?.message ?? detErr);
        if (this.config?.failOpenOnAiError) {
          console.warn("[image-filter] failOpenOnAiError is enabled, allowing image despite AI classification failure.");
          return { allowed: true };
        }
        return { allowed: false, reason: "Deteksi keamanan gambar gagal. Silakan coba lagi nanti." };
      }
      return { allowed: true };
    } catch (err: any) {
      console.error("[image-filter] Buffer filter error:", err?.message ?? err);
      return { allowed: false, reason: "Sistem gagal memproses gambar." };
    }
  }

  /**
   * Filter image URL — return URL asli jika lolos, null jika ditolak.
   */
  async filterImageUrl(
    imageUrl: string | null | undefined,
  ): Promise<string | null> {
    if (!imageUrl) return null;

    const result = await this.isImageAllowed(imageUrl);
    if (!result.allowed) {
      console.warn(`[image-filter] Image blocked: ${result.reason}`);
      return null;
    }

    return imageUrl;
  }
}
