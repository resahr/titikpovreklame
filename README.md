# WebGIS Titik POV — Reklame Batam (kolaboratif)

Editor titik POV untuk 2.420 titik reklame, bisa dikerjakan beberapa orang
sekaligus, tersimpan otomatis, dan bisa ditinggal lalu dilanjutkan kapan saja.

Halaman webnya statis (GitHub Pages). Editan tim disimpan di Google Sheets
lewat Google Apps Script.

---

## Struktur berkas

```
webgis-pov/
├── index.html              ← halaman jadi, ini yang di-upload ke GitHub
├── data/titik.json         ← 2.420 titik, data dasar (statis, 54 KB ter-gzip)
├── apps-script/Code.gs     ← backend, ditempel ke Google Apps Script
├── deploy.sh               ← memasang backend + menerbitkan ke GitHub Pages
├── build.py                ← merakit index.html dari mockup + lapisan kolaborasi
├── config.json             ← menyimpan API_URL (dibuat otomatis)
├── src/                    ← sumber lapisan kolaborasi
│   ├── collab.js               mesin sinkronisasi
│   ├── ekspor.js               ekspor Excel dua sheet
│   ├── collab.css              gaya bilah status & gerbang masuk
│   ├── collab.html             bilah status
│   └── gate.html               layar masuk (nama + kode akses)
└── tests/                  ← lihat bagian "Menjalankan uji"
```

Yang di-upload ke GitHub hanya **`index.html`** dan **`data/`**.
Sisanya perkakas kerja, boleh ikut atau tidak.

---

## Pemasangan

### Cara cepat — `./deploy.sh`

Skrip ini mengerjakan seluruh pemasangan: membuat Spreadsheet + project Apps
Script, mengunggah backend, menerbitkan Web App, menanam URL-nya ke halaman,
membuat repo GitHub, dan menyalakan GitHub Pages.

Tiga hal ini **harus Anda lakukan sendiri** — semuanya otentikasi akun Anda,
tidak bisa diwakilkan:

```bash
# 1. Aktifkan Apps Script API (buka, geser tombol ke ON)
open https://script.google.com/home/usersettings

# 2. Login Google
clasp login

# 3. Login GitHub
gh auth login          # GitHub.com -> HTTPS -> Login with a web browser
```

Lalu:

```bash
cd webgis-pov
./deploy.sh                      # atau: ./deploy.sh nama-repo-pilihan-anda
```

Skrip aman dijalankan berulang — langkah yang sudah selesai dilewati. Di
akhir ia mencetak tautan WebGIS, URL backend, dan dua langkah penutup:
membuka URL backend sekali untuk memberi izin, lalu membaca kode akses dari
sheet `info` di Spreadsheet Anda.

Kalau lebih suka mengerjakan manual lewat antarmuka Google, ikuti langkah
1–5 di bawah — hasilnya sama.

---

### 1. Buat Spreadsheet dan pasang backend

1. Buat Google Spreadsheet baru — namai misalnya *Reklame POV — Data Editan*.
2. **Ekstensi › Apps Script**.
3. Hapus isi `Code.gs` bawaan, tempel **seluruh isi** `apps-script/Code.gs`.
4. Simpan (ikon disket).
5. Pilih fungsi **`setup`** di kotak dropdown, klik **Run**.
   Google akan minta izin sekali — pilih akun Anda, lalu *Advanced ›
   Go to … (unsafe)* › *Allow*. Ini wajar untuk skrip milik sendiri.
6. Kembali ke Spreadsheet, buka sheet **`info`**. Di sana tertulis:

   ```
   KODE AKSES TIM    K7QM-3XPD
   ```

   Inilah yang dibagikan ke tim. Kode ini sengaja disimpan di dalam
   Spreadsheet, bukan di berkas kode, supaya tidak pernah ikut ter-commit
   ke GitHub. Mau kode sendiri? Jalankan `gantiKodeAkses("kode-pilihan-anda")`.

   Kalau langkah 5 terlewat pun tidak apa-apa — backend memasang dirinya
   sendiri saat permintaan pertama datang.

### 2. Terbitkan sebagai Web App

1. **Deploy › New deployment**.
2. Ikon roda gigi › **Web app**.
3. Isi:
   - **Execute as** : `Me`
   - **Who has access** : `Anyone`
4. **Deploy**, lalu salin **Web app URL**. Bentuknya:
   `https://script.google.com/macros/s/AKfycb…/exec`

> **"Anyone" itu aman di sini?** Ya. URL-nya boleh diketahui siapa saja,
> tapi setiap permintaan tetap wajib menyertakan kode akses yang benar —
> diperiksa di sisi server, bukan di browser. Tidak ada token rahasia
> apa pun di dalam `index.html`.

### 3. Tanam URL ke halaman

```bash
cd webgis-pov
python3 build.py --api-url "https://script.google.com/macros/s/AKfycb…/exec"
```

URL-nya tersimpan di `config.json`, jadi `python3 build.py` berikutnya
tidak perlu mengulang.

### 4. Unggah ke GitHub

Buat repo baru (misal `titikpovreklame`), lalu:

```bash
cd webgis-pov
git init && git add index.html data/
git commit -m "WebGIS titik POV kolaboratif"
git branch -M main
git remote add origin https://github.com/<akun-anda>/titikpovreklame.git
git push -u origin main
```

Di GitHub: **Settings › Pages › Source: main / (root) › Save**.
Beberapa menit kemudian situsnya hidup di
`https://<akun-anda>.github.io/titikpovreklame/`.

### 5. Bagikan ke tim

Kirim dua hal: **tautannya** dan **kode aksesnya**. Selesai.

Setiap orang mengetik nama dan kode **sekali saja** di perangkatnya. Sesudah
itu aplikasi masuk sendiri — halaman login tidak muncul lagi, termasuk setelah
refresh, muat ulang otomatis, atau tutup-buka browser. Gerbang hanya kembali
tampil bila kode diganti, atau saat orang itu memakai perangkat/browser baru.

Mau berganti nama di perangkat yang sama? Klik **ganti nama** di bilah atas.

---

## Cara kerja kolaborasinya

**Yang disimpan di server cuma selisihnya.** Data dasar 2.420 titik tidak
pernah ikut dikirim. Sheet hanya berisi satu baris untuk tiap titik yang
pernah disentuh orang. Kalau tim menggarap 300 titik, isinya 300 baris —
bukan 2.420.

**Bentrok dijaga per titik.** Dua orang menggarap titik berbeda tidak akan
pernah saling menimpa, sekali pun bekerja di detik yang sama. Kalau dua
orang kebetulan menggarap titik yang *sama*, yang menyimpan belakangan
diberi tahu dan otomatis diberi versi terbaru — pekerjaan tidak hilang
diam-diam.

**Gembok lunak.** Titik yang sedang dibuka orang lain diberi tanda 🔒
beserta namanya, di kartu daftar maupun di panel editor. Bukan larangan —
hanya supaya tidak dua orang menggarap hal yang sama tanpa sadar.

**Menyimpan itu otomatis.** Berhenti mengedit ±1 detik, perubahan terkirim.
Bilah atas menunjukkan statusnya. Perubahan rekan masuk paling lambat 10 detik.

**Kalau internet putus**, perubahan disimpan di browser dan dikirim ulang
begitu sambungan pulih. Menutup tab saat masih ada yang belum terkirim akan
memunculkan peringatan.

**Melanjutkan pekerjaan** tidak butuh langkah khusus — buka lagi tautannya,
masukkan nama dan kode, semua editan tim langsung termuat.

### Tombol yang berubah dari mockup

| Tombol | Fungsi sekarang |
|---|---|
| **Muat ulang dari server** | Buang perubahan lokal yang belum terkirim, tarik ulang keadaan terbaru. (Dulu: "Kembalikan semua") |
| **Kembalikan titik ini** | Kembalikan satu titik ke data survei asli — ikut tersinkron ke rekan |
| **Simpan JSON / CSV / HTML** | Tetap seperti semula. Berkas HTML hasil unduhan berjalan mandiri, luring, tanpa sinkronisasi |
| **Simpan Excel** | Baru. Berkas `.xlsx` berisi **dua sheet** — lihat di bawah |

### Menghapus titik reklame

Tombol **Hapus titik** ada di panel editor, di samping "Kembalikan titik ini".
Klik sekali untuk meminta konfirmasi, klik lagi untuk menghapus.

**Menghapus tidak membuang hasil kerja.** Titiknya ditandai terhapus, tapi
seluruh POV dan koordinat editannya tetap tersimpan di server. Memulihkannya
mengembalikan semuanya persis seperti sebelum dihapus.

Titik terhapus hilang dari peta, daftar, statistik, dan ekspor. Untuk
meninjaunya, pilih **Terhapus** di baris filter — di sana ada tombol
**Pulihkan titik**.

Penghapusan bersifat **lengket di sisi server**: sekali sebuah titik ditandai
hapus, penyimpanan biasa tidak bisa menghidupkannya lagi — hanya pemulihan
yang disengaja. Ini yang melindungi penghapusan dari tab yang masih memakai
aplikasi versi lama. Setiap penghapusan dan pemulihan tercatat di sheet `log`.

### Ekspor Excel dua sheet

CSV secara format hanya bisa memuat satu tabel, jadi permintaan "sheet 2"
diwujudkan sebagai berkas Excel sungguhan. Tombol **Simpan CSV** yang lama
tidak diubah.

**Sheet `Detail POV`** — satu baris per POV, isinya sama persis dengan tombol CSV:

| id_reklame | jenis | tipe | jalan | kelurahan | kecamatan | prioritas | reklame_lat | reklame_lon | pov_ke | pov_lat | pov_lon | jarak_m | status | perlu_dicek |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

**Sheet `Ringkas`** — satu baris per titik reklame (2.420 baris):

| id_reklame | jenis | tipe | jalan | jarak_median_m |
|---|---|---|---|---|

`jarak_median_m` adalah median jarak seluruh POV titik itu ke titik reklamenya,
dihitung ulang otomatis setiap kali POV digeser, ditambah, atau dihapus.

Titik tanpa POV dibiarkan **kosong**, bukan diisi 0 — angka 0 akan terbaca
sebagai "POV tepat di titik reklame", padahal artinya belum ada POV sama sekali.

**Sheet `Dihapus`** — hanya muncul kalau ada titik yang dihapus. Berisi
id, jenis, tipe, jalan, kecamatan, jumlah POV yang masih tersimpan, jarak
median, siapa yang menghapus, dan kapan. Gunanya supaya penghapusan tetap
bisa ditelusuri di luar aplikasi.

Ekspor mencakup **seluruh 2.420 titik** (dikurangi yang terhapus), bukan
hanya yang sedang tersaring.

---

## Perawatan

Semua dijalankan dari editor Apps Script (pilih fungsi, klik Run):

| Fungsi | Gunanya |
|---|---|
| `lihatKodeAkses()` | Lihat kode yang berlaku (juga ada di sheet `info`) |
| `gantiKodeAkses("KODE-BARU")` | Ganti kode; semua orang harus masuk ulang |
| `eksporSemua()` | Cetak seluruh editan sebagai JSON ke Execution log (arsip) |
| `hapusSemuaEditan()` | Kosongkan seluruh editan tim. **Tidak bisa dibatalkan** |

Sheet `log` mencatat siapa mengubah titik apa dan kapan — berguna kalau ada
yang perlu ditelusuri. Sheet `presence` isinya sementara, boleh diabaikan.

### Menerbitkan pembaruan saat aplikasi sedang dipakai

`deploy.sh` **memperbarui deployment yang sudah ada**, bukan membuat yang baru,
sehingga URL `/exec` tidak berubah dan tab yang sedang terbuka di komputer tim
tidak terputus.

Urutannya penting bila protokolnya berubah: **backend dulu, halaman kemudian.**
`deploy.sh` sudah melakukannya dalam urutan itu.

Kalau `APP_VER` di `Code.gs` dinaikkan, klien versi lama akan menerima nomor
versi yang lebih tinggi, menampilkan pemberitahuan, lalu memuat ulang dirinya
sendiri **setelah** semua perubahannya tersimpan dan pemakainya tidak sedang
mengedit. Tidak ada pekerjaan yang hilang.

### Kalau mockup direvisi lagi

`build.py` menempelkan ulang lapisan kolaborasi ke mockup mana pun:

```bash
python3 build.py --mockup ../WebGIS_Jarak_Reklame_POV_Editor2.html
```

Kalau potongan kode yang dikaitkan sudah berubah bentuk, build sengaja
**berhenti dengan pesan jelas** — lebih baik gagal terang-terangan daripada
diam-diam menghasilkan halaman rusak.

---

## Menjalankan uji

```bash
node tests/backend.test.js                        # 57 uji — logika backend
node tests/contract.test.js                       # 12 uji — kecocokan klien↔server
node --experimental-websocket tests/e2e.test.js   # 22 uji — dua browser sungguhan
node --experimental-websocket tests/hapus.test.js # 21 uji — hapus/pulihkan & tab versi lama
node --experimental-websocket tests/otologin.test.js # 15 uji — masuk otomatis
```

Uji ujung-ke-ujung menjalankan `Code.gs` yang sesungguhnya di Node,
membuka dua tab Chrome dengan origin berbeda, lalu benar-benar mengedit
dari kedua sisi: perubahan menyeberang, bentrok tertangani, dan pekerjaan
tetap utuh setelah tab ditutup lalu dibuka lagi.

Ada juga `tests/mock-server.js` untuk mencoba sendiri tanpa Google:

```bash
node tests/mock-server.js 8899        # cetak kode akses di terminal
sed 's|__API_URL__|http://localhost:8899|' index.html > index.test.html
python3 -m http.server 8777           # buka http://localhost:8777/index.test.html
```

---

## Hal yang perlu diketahui

**Kuota Apps Script.** Tiap browser menarik perubahan sekali per 10 detik.
Permintaan "tidak ada perubahan" sengaja dibuat sangat murah — tidak membuka
spreadsheet sama sekali, hanya membaca satu properti. Untuk tim sampai
sekitar 10 orang bekerja seharian, ini nyaman di dalam kuota akun Google
biasa. Kalau tim jauh lebih besar, naikkan `POLL_MS` di `src/collab.js`
lalu build ulang.

**Kehadiran bisa telat.** Daftar "siapa online" diperbarui tiap 10 detik dan
klaim kedaluwarsa setelah 2,5 menit tanpa kabar. Jadi gembok bisa tertinggal
sebentar setelah seseorang menutup tab. Ini tidak memengaruhi keamanan data —
pencegahan bentrok yang sesungguhnya ada di nomor revisi per titik, bukan di
gembok.

**Peta dasar.** Mockup memakai ubin Google Satellite lewat endpoint yang bukan
API resmi. Berfungsi, tapi bukan pemakaian yang direstui Google. Untuk
penggunaan resmi/publik, ganti ke Esri World Imagery (gratis untuk pemakaian
wajar) atau Google Maps Platform berbayar. Barisnya ada di `index.html`,
cari `L.tileLayer`.

**Kode akses itu satu untuk bersama.** Cukup untuk tim internal dan mencatat
siapa mengubah apa, tapi bukan login sungguhan: siapa pun yang tahu kodenya
bisa memakai nama siapa pun. Kalau nanti perlu akuntabilitas yang mengikat,
backend-nya perlu diganti ke yang punya autentikasi per orang.

**375 POV bertanda "perlu dicek"** pada data awal — jaraknya lebih dari 250 m
dari titik reklamenya, kemungkinan besar koordinat tertukar antar titik saat
survei. Saring dengan tombol **Perlu dicek** di sidebar.
