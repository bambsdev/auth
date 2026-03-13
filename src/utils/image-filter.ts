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
  "face",
  "woman",
  "women",
  "girl",
  "female",
  "lady",
  "queen",
  "bride",
  "groom",
  "wig",
  "lipstick",
  "bikini",
  "brassiere",
  "miniskirt",
  "maillot",
  "velvet",
  "bonnet",
  "mask",
  "head",
  "person",
  "people",
  "hijab",
  "veil",

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
      const imageArray = [...new Uint8Array(imageBuffer)];

      // 2. Classify via resnet-50
      const results = (await this.ai.run("@cf/microsoft/resnet-50", {
        image: imageArray,
      })) as { label: string; score: number }[];

      if (!results || !Array.isArray(results)) {
        // Jika AI gagal, izinkan (fail-open) — bisa diubah ke fail-close
        console.warn("[image-filter] AI returned unexpected result:", results);
        return { allowed: true };
      }

      // 3. Cek apakah ada label terlarang di atas threshold
      for (const prediction of results) {
        if (prediction.score < CONFIDENCE_THRESHOLD) continue;

        const labelLower = prediction.label.toLowerCase();
        for (const keyword of BLOCKED_KEYWORDS) {
          if (labelLower.includes(keyword)) {
            return {
              allowed: false,
              reason: `Terdeteksi konten terlarang: "${prediction.label}" (${(prediction.score * 100).toFixed(1)}%)`,
            };
          }
        }
      }

      return { allowed: true };
    } catch (err: any) {
      console.error("[image-filter] Error:", err?.message ?? err);
      // Fail-open: jika terjadi error jaringan/AI, izinkan (bisa diubah ke fail-close)
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
