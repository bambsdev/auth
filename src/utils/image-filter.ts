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
          // DEBUG: Log top results
          console.log(`[image-filter] Classification Results:`, 
            detections.slice(0, 3).map(d => `${d.label} (${(d.score * 100).toFixed(1)}%)`).join(", ")
          );

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
        // Cek Quota Exceeded (429)
        if (detErr?.message?.includes("429") || detErr?.status === 429) {
          console.warn("[image-filter] Quota exceeded (429), allowing image.");
          return { allowed: true };
        }
        console.warn("[image-filter] Classification failed:", detErr?.message ?? detErr);
      }

      return { allowed: true };
    } catch (err: any) {
      console.error("[image-filter] Error:", err?.message ?? err);
      // Fail-open
      return { allowed: true };
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

      const imageArray = new Uint8Array(buffer);

      // 2. Classify Image (Buffer)
      try {
        const detections = (await this.ai.run("@cf/microsoft/resnet-50" as any, {
          image: Array.from(imageArray),
        }) as unknown) as { label: string; score: number }[];

        if (detections && Array.isArray(detections)) {
          // DEBUG: Log top results (Buffer)
          console.log(`[image-filter] Classification Results (Buffer):`, 
            detections.slice(0, 3).map(d => `${d.label} (${(d.score * 100).toFixed(1)}%)`).join(", ")
          );

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
          console.warn("[image-filter] Quota exceeded (429 - Buffer), allowing image.");
          return { allowed: true };
        }
        console.warn("[image-filter] Classification failed (buffer):", detErr?.message ?? detErr);
      }

      return { allowed: true };
    } catch (err: any) {
      console.error("[image-filter] Buffer filter error:", err?.message ?? err);
      return { allowed: true };
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
      console.log(`[image-filter] Image blocked: ${result.reason}`);
      return null;
    }

    return imageUrl;
  }
}
