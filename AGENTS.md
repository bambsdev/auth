# 🤖 AGENTS.md: Gateway & Rules for AI Agents

Selamat datang, **AI Agent**! File ini berfungsi sebagai panduan utama, pintu gerbang instruksi (*gateway*), dan aturan standar (*ruleset*) yang wajib kamu terapkan saat berkontribusi atau melakukan modifikasi pada repositori **`@bambsdev/auth`**.

---

## 📦 Tentang Project `@bambsdev/auth`

`@bambsdev/auth` adalah sebuah **dependency / library autentikasi** khusus yang dirancang untuk digunakan oleh aplikasi *consumer* yang dideploy di lingkungan **Cloudflare Workers** (Serverless/Edge Runtime). 

### Arsitektur Utama & Tech Stack:
- **Framework**: [Hono](https://hono.dev) (menggunakan `OpenAPIHono` untuk dokumentasi Swagger/OpenAPI otomatis).
- **ORM**: [Drizzle ORM](https://orm.drizzle.team/) (PostgreSQL).
- **Runtime**: [Cloudflare Workers](https://workers.cloudflare.com/) (Edge Runtime).
- **State & Storage**: Cloudflare KV, Cloudflare R2, dan Cloudflare Hyperdrive.
- **AI Integration**: Cloudflare Workers AI (`@cf/microsoft/resnet-50` untuk filter gambar).
- **Arsitektur**: Clean Service Layer Architecture (Pemisahan tegas antara routes, database schemas, services, middlewares, dan utilities).

---

## 📜 Aturan Pengembangan AI Agent (Agentic Engineering Rules)

Sebagai AI Agent, kamu harus mematuhi **14 Aturan Utama** berikut demi menjaga kualitas, keamanan, kompatibilitas, dan keberlanjutan kode pada proyek ini:

### 1. Task Execution & Verification (Kerjaan Sampai Tujuan)
> **Rule:**
> *"Sebelum menulis kode, buatlah Execution Plan langkah demi langkah. Jangan melompat ke langkah berikutnya sebelum langkah saat ini terverifikasi. Jika memungkinkan, tulis unit test (TDD) terlebih dahulu untuk menetapkan standar keberhasilan."*
>
> **Tujuan:** Memastikan agen tidak berhalusinasi di tengah jalan dan tetap fokus pada *acceptance criteria* awal.

### 2. Strict Type Safety & Explicit Handling (Aman dari Bug)
> **Rule:**
> *"Gunakan strict typing secara absolut. Dilarang keras menggunakan tipe data `any` atau `interface{}` tanpa justifikasi teknis yang disetujui. Setiap fungsi harus mengembalikan error secara eksplisit (seperti pola di Golang) dan tidak boleh membiarkan exception lewat tanpa handling yang jelas."*
>
> **Tujuan:** Menghindari *runtime error* yang sering terjadi karena ketidakcocokan tipe data atau nilai *null/undefined* yang tidak tertangkap.

### 3. Secure Configuration & Least Privilege (Aman dari Security Alert)
> **Rule:**
> *"Dilarang keras menyertakan hardcoded secrets, API keys, atau kredensial di dalam kode. Selalu gunakan environment variables. Terapkan validasi server-side yang ketat pada setiap input sebelum diproses."*
>
> **Tujuan:** Memastikan codebase lolos dari *automated security scanning* (seperti SonarQube atau GitHub Advanced Security).

### 4. Input Sanitization & Data Layer Isolation (Aman dari Injection)
> **Rule:**
> *"Wajib menggunakan ORM (seperti Drizzle ORM) atau parameterized queries saat berinteraksi dengan database. Tolak penggunaan eksekusi Raw SQL kecuali mutlak diperlukan dan pastikan input telah melalui proses sanitasi. Hindari shell/command execution langsung dari input pengguna."*
>
> **Tujuan:** Menutup rapat celah *SQL Injection*, *NoSQL Injection*, dan *Command Injection*.

### 5. Modular Architecture & SoC (No Spaghetti Code)
> **Rule:**
> *"Terapkan Separation of Concerns (SoC). Pisahkan business logic dari route handlers, middleware, atau proxy files. Jaga agar setiap fungsi melakukan satu hal saja (Single Responsibility Principle) dan batasi panjang fungsi. Ekstrak logika yang berulang menjadi utilitas independen."*
>
> **Tujuan:** Memastikan codebase tetap *maintainable* dan mudah dibaca oleh tim (terutama saat melakukan transisi dari prototype ke versi stabil).

### 6. Gemini-Optimized Context Usage (Optimasi Konteks Gemini)
> **Rule:**
> *"Manfaatkan context window Gemini yang masif. Sebelum mengusulkan perubahan kode, analisis seluruh struktur repositori, pola arsitektur, dan dependencies yang ada di dalam workspace. Pastikan kodemu meniru code style yang sudah ada daripada memperkenalkan style baru."*
>
> **Tujuan:** Mencegah AI memberikan solusi yang benar secara teori, tapi tidak bisa berjalan (*incompatible*) di codebase eksisting.

### 7. Edge & Serverless Compatibility (Target Infrastruktur)
> **Rule:**
> *"Pastikan kode yang ditulis kompatibel dengan Edge runtime (misalnya Cloudflare Workers) jika arsitektur membutuhkannya. Hindari modul atau dependencies yang mengandalkan built-in Node.js secara berat jika target deploy-nya adalah lingkungan serverless ringan (seperti Hono atau Next.js Edge)."*
>
> **Tujuan:** Menghindari *error* infrastruktur saat deployment karena ketidakcocokan runtime.

### 8. Authentication Flow & State Integrity (Keamanan Otorisasi)
> **Rule:**
> *"Pahami perbedaan antara mengambil data sesi pengguna dari token/session yang aman versus membaca ID dari parameter/URL. Jangan pernah mempercayai parameter client-side untuk menentukan hak akses modifikasi data."*
>
> **Tujuan:** Mencegah celah otorisasi seperti IDOR (*Insecure Direct Object Reference*) atau eskalasi privilege saat mengatur *route handlers*.

### 9. Autonomous Self-Correction Loop (Kemampuan Debugging)
> **Rule:**
> *"Jika terjadi error saat build, kompilasi, atau testing, jangan langsung menebak (hallucinate) solusinya. Baca stack trace atau log pesan kesalahan secara teliti, analisis dokumentasi resmi library yang bersangkutan, lalu rencanakan ulang perbaikan yang logis."*
>
> **Tujuan:** Membuat agen lebih tahan banting dan efisien saat menemui *blocker*, mencegah looping perbaikan error yang tidak ada habisnya.

### 10. Structured Logging & Observability (Visibilitas)
> **Rule:**
> *"Implementasikan structured logging untuk setiap transaksi penting, otentikasi, atau kegagalan sistem. Gunakan format log yang mudah dipilah, sehingga jejak (trace) tindakan aplikasi dapat dianalisis."*
>
> **Tujuan:** Memudahkan kamu dan tim teknis melacak akar masalah (*root cause*) jika pekerjaan yang dilakukan agen tidak sesuai ekspektasi saat runtime.

### 11. Backward Compatibility & SemVer Integrity (Kompatibilitas Library)
> **Rule:**
> *"Dilarang keras mengubah signature fungsi, tipe data export, atau endpoint yang sudah ada secara acak karena dapat merusak (breaking changes) aplikasi consumer. Jika harus melakukan perubahan destruktif pada public API, ajukan rencana deprecation atau versi mayor baru terlebih dahulu."*
>
> **Tujuan:** Menjaga stabilitas aplikasi consumer agar tidak crash ketika melakukan update versi library.

### 12. OpenAPI & Swagger Documentation Sync (Sinkronisasi Dokumentasi)
> **Rule:**
> *"Karena project ini menggunakan `@hono/zod-openapi`, setiap kali menambahkan atau mengubah route/endpoint baru, wajib hukumnya memperbarui atau mendefinisikan Zod OpenAPI schema secara presisi. Jangan biarkan ada endpoint baru yang tidak terdaftar di dokumentasi OpenAPI."*
>
> **Tujuan:** Menjamin kontrak API antara library dan consumer (serta dokumentasi Swagger) selalu sinkron secara otomatis.

### 13. Dependency Minimization & Edge Constraints (Efisiensi Bundle Size)
> **Rule:**
> *"Jangan pernah menambahkan dependency pihak ketiga baru (`dependencies` di package.json) tanpa justifikasi kuat. Jika sangat diperlukan, diskusikan terlebih dahulu. Utamakan penggunaan Peer Dependencies agar ukuran bundle library tetap kecil demi performa optimal di Cloudflare Workers (Edge runtime)."*
>
> **Tujuan:** Cloudflare Workers memiliki batas ukuran file bundle yang sangat ketat (misal 1MB/10MB). Menjaga library tetap ringan adalah prioritas utama.

### 14. Mocking & Cloudflare Bindings in Testing (Testability)
> **Rule:**
> *"Saat menulis unit test yang membutuhkan akses ke Cloudflare Resources (seperti KV, R2, Hyperdrive, AI), wajib menggunakan mock bindings yang sesuai (misalnya mock KV/R2 object) agar test dapat berjalan secara lokal menggunakan Bun Test tanpa membutuhkan koneksi ke Cloudflare asli."*
>
> **Tujuan:** Menghindari kegagalan test saat dijalankan di CI/CD pipeline yang tidak memiliki akses ke Cloudflare credentials asli.

---

## 🛠️ Panduan Perintah Pengembangan (Developer Commands)

Untuk melakukan verifikasi kode dan pengujian secara mandiri, gunakan perintah-perintah berikut yang berjalan di runtime **Bun**:

- **Mengecek Tipe Data (Typecheck):**
  ```bash
  bun run typecheck
  ```
- **Melakukan Build Package:**
  ```bash
  bun run build
  ```
- **Menjalankan Unit Test:**
  ```bash
  bun run test
  ```

---

> [!IMPORTANT]
> **AI Agent:** Sebelum memulai setiap tugas, buatlah dokumen perencanaan di `task.md` (jika diposisikan dalam pengerjaan fitur/bug) dan biasakan untuk membaca file [README.md](file:///d:/project-hono/auth/README.md) untuk memahami integrasi secara penuh.
