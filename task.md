# ?? Task Execution Plan & Tracking (v1.4.11)

Dokumen ini mencatat rencana kerja dan verifikasi untuk perbaikan filter gambar, pembersihan file R2, dan binding kontrol avatar ALLOW_AVATAR_UPLOAD.

---

## ?? Target & Kebutuhan

1. **Filter Gambar Perempuan:**
   - Masalah: Foto/gambar perempuan lolos dari filter moderasi AI.
   - Solusi: Menambahkan label busana, aksesoris, dan identitas perempuan sesuai klasifikasi ImageNet ResNet-50.

2. **Pembersihan Bersih File R2 saat Hapus Avatar:**
   - Masalah: Saat DELETE /settings/avatar dipanggil, file avatar di R2 public masih tertinggal.
   - Solusi:
     - Memperbaiki extractR2KeyFromUrl agar membersihkan query parameter dan mengenali key auth/avatars/ secara tangguh.
     - Meng-await operasi bucket.delete(oldKey) di setting.service.ts agar tidak dihentikan secara prematur oleh runtime Cloudflare Workers.

3. **Fitur Baru ALLOW_AVATAR_UPLOAD:**
   - Kebutuhan: Memberikan opsi env/binding bagi consumer apakah mengizinkan user mengunggah gambar profil atau tidak, dengan default/fallback true.
   - Solusi:
     - Jika consumer set false atau "false", request upload avatar ditolak dengan kode 403 AVATAR_UPLOAD_DISABLED.
     - Jika consumer set true, "true", atau tidak di-set (undefined), user diizinkan mengunggah avatar.

4. **Versi & Dokumentasi:**
   - Bump versi package ke 1.4.11.
   - Update CHANGELOG.md.
   - Update README.md.
   - Update / tambah unit test TDD.

---

## ? Status Eksekusi

- [x] Perluas DEFAULT_BLOCKED_LABELS pada src/utils/image-filter.ts
- [x] Perbaiki extractR2KeyFromUrl pada src/services/r2-upload.service.ts
- [x] Jadikan bucket.delete(oldKey) asynchronous await pada src/services/setting.service.ts
- [x] Tambah ALLOW_AVATAR_UPLOAD pada SharedAuthBindings (src/types/index.ts) dan ImageFilterConfig (src/utils/image-filter.ts)
- [x] Terapkan pengecekan izin upload avatar di avatarRoute (src/routes/factory/setting.factory.ts)
- [x] Buat pengujian TDD di tests/r2-avatar.test.ts dan update tests/image-filter.test.ts
- [x] Verifikasi tipe data (bun run typecheck)
- [x] Verifikasi seluruh unit test (bun test - 112 passed)
- [x] Build paket rilis (bun run build)
- [x] Update package.json ke 1.4.11
- [x] Update CHANGELOG.md
- [x] Update README.md
