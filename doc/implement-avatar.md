Rekomendasi: Satu Bucket, UUID Key, Prefix auth/avatars/
Menggunakan dua bucket terpisah menambah beban konfigurasi bagi consumer tanpa manfaat keamanan yang berarti. Solusi yang lebih elegan adalah satu bucket milik consumer, dengan nama file berbasis UUID dan prefix yang jelas.
Kenapa UUID Menyelesaikan Masalah URL?
Ketika kamu menyimpan file sebagai:
auth/avatars/550e8400-e29b-41d4-a716-446655440000.jpg
Tidak ada yang bisa menebak URL ini meski bucket-nya public, karena UUID tidak memiliki pola yang bisa diprediksi. Ini prinsip yang sama dengan yang dipakai AWS S3, Cloudflare R2, dan hampir semua cloud storage modern untuk file "public tapi unguessable".

Perubahan pada Kode
src/types/index.ts — Binding yang fleksibel
typescriptexport type Bindings = {
// ...existing bindings...

// Consumer hanya perlu menyediakan SALAH SATU dari dua ini:
// - Bucket binding untuk R2 upload (nama binding bisa dikonfigurasi)
BUCKET?: R2Bucket; // nama generik — consumer bisa rename di wrangler.toml
BUCKET_PUBLIC_URL?: string; // base URL public bucket, mis: https://pub-xyz.r2.dev

// Jika consumer tidak punya public URL, avatar di-serve via proxy endpoint
};
Tapi ada masalah dengan pendekatan "nama binding bisa dikonfigurasi" — TypeScript harus tahu nama binding-nya saat compile time. Solusi yang lebih baik adalah mendokumentasikan bahwa consumer harus menggunakan nama binding tertentu. Ini lazim di library Cloudflare Workers. Kita tetap pakai BUCKET dan BUCKET_PUBLIC_URL sebagai konvensi.
src/utils/image-filter.ts — Tambah isImageBufferAllowed
typescriptexport class ImageFilterService {
constructor(private readonly ai: Ai) {}

// Method yang sudah ada untuk URL...
async isImageAllowed(imageUrl: string) { /_ ... existing code ... _/ }
async filterImageUrl(imageUrl: string | null | undefined) { /_ ... existing code ... _/ }

/\*\*

- Method BARU: filter langsung dari ArrayBuffer.
- Dipakai saat file di-upload via multipart/form-data,
- sehingga kita tidak perlu fetch ulang dari URL.
  \*/
  async isImageBufferAllowed(
  buffer: ArrayBuffer,
  contentType: string,
  ): Promise<{ allowed: boolean; reason?: string }> {
  try {
  // Validasi content type sebelum kirim ke AI
  if (!contentType.startsWith("image/")) {
  return { allowed: false, reason: "File bukan gambar yang valid" };
  }

        const imageArray = [...new Uint8Array(buffer)];

        const results = (await this.ai.run("@cf/microsoft/resnet-50", {
          image: imageArray,
        })) as { label: string; score: number }[];

        if (!results || !Array.isArray(results)) {
          console.warn("[image-filter] AI returned unexpected result:", results);
          return { allowed: true }; // fail-open
        }

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
        console.error("[image-filter] Buffer filter error:", err?.message ?? err);
        return { allowed: true }; // fail-open
      }

  }
  }
  src/routes/setting.routes.ts — Refactor endpoint avatar
  typescriptsettingRoutes.put("/avatar", async (c) => {
  const { settingService, imageFilter, audit } = makeServices(c);
  const ip = getIp(c);
  const userId = c.var.userId;

// Cek apakah request adalah multipart/form-data (file upload)
// atau JSON biasa (URL-based, backward compatible)
const contentType = c.req.header("content-type") ?? "";

if (contentType.includes("multipart/form-data")) {
// ── Mode baru: upload file langsung ke R2 ──────────────────────────

    // Pastikan binding tersedia — consumer harus konfigurasi BUCKET di wrangler.toml
    if (!c.env.BUCKET) {
      return c.json(
        { error: { code: "R2_NOT_CONFIGURED", message: "R2 bucket tidak dikonfigurasi" } },
        500,
      );
    }

    let formData: FormData;
    try {
      formData = await c.req.formData();
    } catch {
      return c.json(
        { error: { code: "INVALID_FORM_DATA", message: "Form data tidak valid" } },
        400,
      );
    }

    const file = formData.get("avatar");
    if (!file || !(file instanceof File)) {
      return c.json(
        { error: { code: "MISSING_FILE", message: "File avatar wajib diisi" } },
        400,
      );
    }

    // Validasi ukuran file (mis: max 5MB)
    const MAX_SIZE = 5 * 1024 * 1024;
    if (file.size > MAX_SIZE) {
      return c.json(
        { error: { code: "FILE_TOO_LARGE", message: "Ukuran file maksimal 5MB" } },
        400,
      );
    }

    // Validasi content type
    const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (!allowedTypes.includes(file.type)) {
      return c.json(
        { error: { code: "INVALID_FILE_TYPE", message: "Format file harus JPEG, PNG, WebP, atau GIF" } },
        400,
      );
    }

    const arrayBuffer = await file.arrayBuffer();

    // Jalankan AI filter pada buffer SEBELUM upload ke R2
    const filterResult = await imageFilter.isImageBufferAllowed(arrayBuffer, file.type);
    if (!filterResult.allowed) {
      audit.log({
        event: "avatar_blocked",
        userId,
        ip,
        metadata: { reason: filterResult.reason, source: "upload" },
      });

      return c.json(
        {
          error: {
            code: "AVATAR_BLOCKED",
            message: filterResult.reason ?? "Avatar mengandung konten yang tidak diizinkan",
          },
        },
        400,
      );
    }

    // Lolos filter → upload ke R2
    // UUID sebagai nama file = URL tidak bisa dienumerasi
    const ext = file.type.split("/")[1].replace("jpeg", "jpg");
    const key = `auth/avatars/${crypto.randomUUID()}.${ext}`;

    await c.env.BUCKET.put(key, arrayBuffer, {
      httpMetadata: { contentType: file.type },
    });

    // Konstruksi URL — butuh BUCKET_PUBLIC_URL dari binding
    // Kalau tidak ada, kita simpan key saja dan serve via proxy endpoint
    const avatarUrl = c.env.BUCKET_PUBLIC_URL
      ? `${c.env.BUCKET_PUBLIC_URL}/${key}`
      : `/api/settings/avatar-file/${key}`; // fallback ke proxy

    // Simpan URL ke DB
    const result = await settingService.updateAvatarUrl(userId, avatarUrl);

    audit.log({
      event: "avatar_updated",
      userId,
      ip,
      metadata: { avatarUrl, source: "upload" },
    });

    return c.json({
      message: "Avatar berhasil diperbarui",
      data: { id: result.id, avatarUrl: result.avatarUrl, updatedAt: result.updatedAt },
    });

} else {
// ── Mode lama: update via URL (backward compatible) ────────────────
// Kode existing tetap berjalan untuk consumer yang kirim JSON { avatarUrl: "..." }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { error: { code: "INVALID_JSON", message: "Request body bukan JSON valid" } },
        400,
      );
    }

    const { avatarUrl } = parseBody(updateAvatarSchema, body);

    try {
      const result = await settingService.updateAvatar(userId, avatarUrl);
      // ... kode existing untuk URL-based avatar
    } catch (err: any) {
      return errorResponse(c, err);
    }

}
});

// ── Proxy endpoint (opsional) ─────────────────────────────────────────────
// Dipakai kalau consumer tidak set BUCKET_PUBLIC_URL.
// Serve file dari R2 dengan access control.
settingRoutes.get("/avatar-file/\*", async (c) => {
if (!c.env.BUCKET) {
return c.json({ error: { code: "NOT_FOUND", message: "File tidak ditemukan" } }, 404);
}

// Ambil key dari URL path
const key = c.req.path.replace("/api/settings/avatar-file/", "");

const object = await c.env.BUCKET.get(key);
if (!object) {
return c.json({ error: { code: "NOT_FOUND", message: "File tidak ditemukan" } }, 404);
}

return new Response(object.body, {
headers: {
"Content-Type": object.httpMetadata?.contentType ?? "image/jpeg",
"Cache-Control": "public, max-age=31536000", // cache 1 tahun
"ETag": object.etag,
},
});
});
src/services/setting.service.ts — Tambah updateAvatarUrl
Kita perlu method baru yang lebih sederhana — hanya update DB tanpa menjalankan AI filter (karena filter sudah dilakukan di route sebelum upload):
typescript/\*\*

- Update avatar URL di DB langsung, tanpa AI filter.
- Dipakai setelah upload ke R2 — AI filter sudah dijalankan di route layer.
  \*/
  async updateAvatarUrl(userId: string, avatarUrl: string | null) {
  const [updated] = await this.db
  .update(users)
  .set({ avatarUrl, updatedAt: new Date() })
  .where(eq(users.id, userId))
  .returning({
  id: users.id,
  avatarUrl: users.avatarUrl,
  updatedAt: users.updatedAt,
  });

return updated;
}

Ringkasan Arsitektur yang Direkomendasikan
Satu bucket (BUCKET) dengan dua binding opsional di wrangler.toml consumer:

```toml

toml[[r2_buckets]]
binding = "BUCKET"
bucket_name = "my-app-bucket"

```

[vars]
BUCKET_PUBLIC_URL = "https://pub-xyz.r2.dev" # opsional, jika bucket public
Keunggulan pendekatan ini antara lain: consumer tidak perlu membuat bucket kedua khusus untuk auth, UUID filename menghilangkan risiko enumerasi URL, backward compatible (consumer yang tidak punya R2 tetap bisa pakai fitur URL-based), dan kalau bucket tidak public pun ada fallback proxy endpoint yang di-serve melalui Worker.

Pikirannya sederhana: URL R2 milikmu selalu memiliki "sidik jari" yang unik — yaitu domain dari BUCKET_PUBLIC_URL binding, misalnya pub-abc123.r2.dev. URL Google selalu dari domain lh3.googleusercontent.com atau sejenisnya. URL eksternal lainnya tentu dari domain yang lain lagi.
Dengan kata lain, avatarUrl yang ada di database sudah implisit menyimpan informasi "dari mana avatar ini berasal" — kamu hanya perlu bisa "membacanya." Ini menghilangkan kebutuhan kolom avatarR2Key sama sekali.
Logika ekstrasi key-nya pun sangat straightforward:
typescript/\*\*

- Coba ekstrak R2 object key dari avatarUrl yang sudah tersimpan.
-
- Cara kerjanya: jika URL avatar dimulai dengan BUCKET_PUBLIC_URL,
- berarti file ini milik kita di R2. Key-nya adalah sisa URL setelah
- base URL dibuang.
-
- Contoh:
- bucketPublicUrl = "https://pub-abc.r2.dev"
- avatarUrl = "https://pub-abc.r2.dev/auth/avatars/uuid.jpg"
- result = "auth/avatars/uuid.jpg" ← ini yang dikirim ke bucket.delete()
-
- Kalau URL bukan dari R2 kita (Google, eksternal, null), return null.
- Artinya: tidak ada file yang perlu dihapus.
  \*/
  function extractR2KeyFromUrl(
  avatarUrl: string | null,
  bucketPublicUrl: string | undefined,
  ): string | null {
  // Kalau salah satu tidak ada, pasti bukan R2 kita
  if (!avatarUrl || !bucketPublicUrl) return null;

// Normalisasi: pastikan tidak ada trailing slash di base URL
// supaya perbandingan konsisten
const base = bucketPublicUrl.replace(/\/$/, "");

if (!avatarUrl.startsWith(base)) return null;

// Buang base URL + satu karakter "/" di awal key
// "https://pub-abc.r2.dev/auth/avatars/uuid.jpg"
// ^ posisi base.length adalah "/"
// ^ posisi base.length + 1 adalah awal key
const key = avatarUrl.slice(base.length + 1);

// Validasi: key tidak boleh kosong (edge case kalau URL persis sama dengan base)
return key.length > 0 ? key : null;
}
Fungsi ini kemudian dipanggil di updateAvatarFromUpload dan updateAvatarFromUrl di setting service sebelum melakukan update DB:
typescriptasync updateAvatarFromUpload(
userId: string,
newKey: string,
newUrl: string,
bucket: R2Bucket,
bucketPublicUrl: string,
) {
// Ambil URL lama dari DB
const currentUser = await this.db.query.users.findFirst({
where: eq(users.id, userId),
columns: { avatarUrl: true },
});

// Update DB dengan URL baru — tidak ada kolom tambahan
const [updated] = await this.db
.update(users)
.set({ avatarUrl: newUrl, updatedAt: new Date() })
.where(eq(users.id, userId))
.returning({ id: users.id, avatarUrl: users.avatarUrl, updatedAt: users.updatedAt });

// Derivasi key lama dari URL lama — elegant, tidak butuh kolom extra
const oldKey = extractR2KeyFromUrl(currentUser?.avatarUrl ?? null, bucketPublicUrl);

if (oldKey) {
// Avatar lama adalah file R2 milik kita → hapus
bucket.delete(oldKey).catch((err) =>
console.error(`[setting] Gagal hapus R2 lama: ${oldKey}`, err)
);
}
// Kalau oldKey null: avatar lama adalah URL Google/eksternal → tidak perlu dihapus

return updated;
}
