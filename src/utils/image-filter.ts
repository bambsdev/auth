// src/utils/image-filter.ts
//
// Image AI filter — menggunakan @cf/microsoft/resnet-50 untuk mendeteksi
// apakah gambar mengandung wajah (manusia/hewan) atau identifikasi wanita.
// Jika terdeteksi, gambar ditolak (null).
//
// Reusable: bisa dipakai untuk avatar, cover image, atau URL gambar lainnya.

// ── Blocked Keywords ──────────────────────────────────────────────────────────
// Label ImageNet dari resnet-50 yang mengindikasikan wajah atau identitas wanita.

const BLOCKED_KEYWORDS = [
  // Wajah manusia / identitas wanita
  "wig",
  "lipstick",
  "bikini",
  "brassiere",
  "miniskirt",
  "maillot",
  "swimming trunks",
  "bathrobe",
  "pajamas",
  "sarong",
  "breastplate",
  "scuba diver",
  "groom",
  "gown",
  "kimono",
  "abaya",
  "burqa",
  "hijab",
  "veil",
  "bonnet",
  "stole",
  "cardigan",
  "poncho",
  "cloak",
  "shawl",
  "velvet",
  "mask",
  "sunglasses",
  "necklace",
  "bracelet",
  "earring",
  "person",

  // Hewan bermuka jelas (mamalia, primata, dll.)
  "dog",
  "cat",
  "monkey",
  "ape",
  "gorilla",
  "chimpanzee",
  "orangutan",
  "baboon",
  "macaque",
  "lion",
  "tiger",
  "leopard",
  "bear",
  "wolf",
  "fox",
  "panda",
  "horse",
  "cow",
  "bull",
  "deer",
  "rabbit",
  "hamster",
  "guinea pig",
  "owl",
  "eagle",
  "hawk",
  "parrot",
  "penguin",
  "seal",
  "whale",
  "dolphin",
  "elephant",
  "rhinoceros",
  "hippopotamus",
  "giraffe",
  "zebra",
  "camel",
  "llama",
  "sheep",
  "goat",
  "pig",
  "koala",
  "raccoon",
  "squirrel",
  "chihuahua",
  "poodle",
  "retriever",
  "shepherd",
  "terrier",
  "bulldog",
  "collie",
  "beagle",
  "husky",
  "corgi",
  "pug",
  "tabby",
  "persian",
  "siamese",
  "lynx",
  "cougar",
  "cheetah",
  "jaguar",
  "hyena",
  "weasel",
  "otter",
  "mink",
  "skunk",
  "badger",
  "armadillo",
  "sloth",
  "hedgehog",
  "porcupine",
  "hammerhead",
];

// Confidence threshold — jika label cocok dengan confidence >= ini, tolak
const CONFIDENCE_THRESHOLD = 0.15;

// ── Service ───────────────────────────────────────────────────────────────────

export class ImageFilterService {
  constructor(private readonly ai: Ai) {}

  /**
   * Periksa apakah gambar di URL mengandung konten terlarang.
   * Return { allowed, reason? }
   */
  async isImageAllowed(
    imageUrl: string,
  ): Promise<{ allowed: boolean; reason?: string }> {
    try {
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

      // 2. Object Detection (Sangat Akurat untuk "Person" & "Animals")
      try {
        const detections = (await this.ai.run("@cf/facebook/detr-resnet-50" as any, {
          image: Array.from(imageArray),
        })) as { label: string; score: number }[];

        if (detections && Array.isArray(detections)) {
          // DEBUG: Log top results
          console.log(`[image-filter] Object Detection Results:`, 
            detections.slice(0, 3).map(d => `${d.label} (${(d.score * 100).toFixed(1)}%)`).join(", ")
          );

          for (const det of detections) {
            // Blokir manusia (person)
            if (det.label === "person" && det.score > CONFIDENCE_THRESHOLD) {
              return {
                allowed: false,
                reason: `Terdeteksi manusia (Person Detection) dengan skor ${(det.score * 100).toFixed(1)}%`,
              };
            }
            
            // Blokir hewan (optional but kept based on previous requirement)
            const animals = ["dog", "cat", "bird", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe"];
            if (animals.includes(det.label) && det.score > CONFIDENCE_THRESHOLD) {
              return {
                allowed: false,
                reason: `Terdeteksi hewan (${det.label}) dengan skor ${(det.score * 100).toFixed(1)}%`,
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
        console.warn("[image-filter] Object detection failed:", detErr?.message ?? detErr);
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
      if (!contentType.startsWith("image/")) {
        return { allowed: false, reason: "File bukan gambar yang valid" };
      }

      const imageArray = new Uint8Array(buffer);

      // 2. Object Detection (Buffer)
      try {
        const detections = (await this.ai.run("@cf/facebook/detr-resnet-50" as any, {
          image: Array.from(imageArray),
        })) as { label: string; score: number }[];

        if (detections && Array.isArray(detections)) {
          // DEBUG: Log top results (Buffer)
          console.log(`[image-filter] Object Detection Results (Buffer):`, 
            detections.slice(0, 3).map(d => `${d.label} (${(d.score * 100).toFixed(1)}%)`).join(", ")
          );

          for (const det of detections) {
            if (det.label === "person" && det.score > CONFIDENCE_THRESHOLD) {
              return {
                allowed: false,
                reason: `Terdeteksi manusia (Person Detection) dengan skor ${(det.score * 100).toFixed(1)}%`,
              };
            }

            const animals = ["dog", "cat", "bird", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe"];
            if (animals.includes(det.label) && det.score > CONFIDENCE_THRESHOLD) {
              return {
                allowed: false,
                reason: `Terdeteksi hewan (${det.label}) dengan skor ${(det.score * 100).toFixed(1)}%`,
              };
            }
          }
        }
      } catch (detErr: any) {
        if (detErr?.message?.includes("429") || detErr?.status === 429) {
          console.warn("[image-filter] Quota exceeded (429 - Buffer), allowing image.");
          return { allowed: true };
        }
        console.warn("[image-filter] Object detection failed (buffer):", detErr?.message ?? detErr);
      }

      return { allowed: true };
    } catch (err: any) {
      console.error("[image-filter] Buffer filter error:", err?.message ?? err);
      return { allowed: true };
    }
  }

  /**
   * Filter image URL — return URL asli jika lolos, null jika ditolak.
   * Bisa dipakai untuk avatar, cover image, atau gambar lainnya.
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
