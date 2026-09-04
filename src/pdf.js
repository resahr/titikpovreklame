/* ══════════════════════ EKSPOR PDF — SATU HALAMAN PER TITIK ══════════════════════

   Mengikuti filter yang sedang aktif di layar: apa yang tampil di daftar,
   itu yang tercetak.

   Isi halaman: ID titik, mini-peta, 3 foto, kecamatan, kelurahan, nama
   jalan, sub wilayah, jenis, tipe, media, ukuran, tarif.

   Gambar diambil dari sumber yang sama dengan aplikasi (ubin satelit Google
   dan foto di Google Drive). Keduanya mengizinkan CORS, jadi bisa digambar
   ke canvas tanpa membuatnya "tercemar" — tanpa itu canvas tidak bisa dibaca
   kembali dan gambar mustahil masuk ke PDF.

   Foto diminta versi kecil lewat akhiran "=s400" (300x400, ~54 KB); ukuran
   aslinya 1200x1600 (~800 KB) akan membuat berkasnya ratusan MB.            */

const JSPDF_URL  = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
const PDF_UBIN   = 'https://mt1.google.com/vt/lyrs=s&x=$X&y=$Y&z=$Z';
const PDF_BANYAK = 300;     /* di atas ini, pemakai diberi tahu dulu */
const PDF_FOTO_MAKS = 3;

/* Foto dan koordinat berselang-seling di berkas survei: enam foto pertama
   memang milik POV 1..6 berurutan. Diambil tiga yang pertama tersedia. */
const PDF_FOTO = [
  { kol: 'VISIBILITA', label: 'POV 1' }, { kol: 'VISIBILIT1', label: 'POV 2' },
  { kol: 'VISIBILIT2', label: 'POV 3' }, { kol: 'VISIBILIT3', label: 'POV 4' },
  { kol: 'VISIBILIT4', label: 'POV 5' }, { kol: 'VISIBILIT5', label: 'POV 6' },
  { kol: 'KONDISI_LA', label: 'Kondisi lahan' },
  { kol: 'FOTO_TAMBA', label: 'Foto tambahan' },
];

let JSPDF_SIAP = null;
function muatJsPDF() {
  if (JSPDF_SIAP) return JSPDF_SIAP;
  JSPDF_SIAP = new Promise((res, rej) => {
    if (window.jspdf && window.jspdf.jsPDF) return res(window.jspdf.jsPDF);
    const s = document.createElement('script');
    s.src = JSPDF_URL;
    s.onload = () => (window.jspdf && window.jspdf.jsPDF)
      ? res(window.jspdf.jsPDF) : rej(new Error('jsPDF tidak termuat'));
    s.onerror = () => rej(new Error('gagal mengunduh pustaka PDF'));
    document.head.appendChild(s);
  }).catch(e => { JSPDF_SIAP = null; throw e; });
  return JSPDF_SIAP;
}

/* ───────────── pemuat gambar ───────────── */

function sekaliMuat(url, batasMs) {
  return new Promise(res => {
    const img = new Image();
    let selesai = false;
    const habis = setTimeout(() => { if (!selesai) { selesai = true; img.src = ''; res(null); } }, batasMs);
    img.crossOrigin = 'anonymous';        /* wajib: tanpa ini canvas tercemar */
    img.onload  = () => { if (!selesai) { selesai = true; clearTimeout(habis); res(img); } };
    img.onerror = () => { if (!selesai) { selesai = true; clearTimeout(habis); res(null); } };
    img.src = url;
  });
}

/**
 * Memuat satu gambar; mengembalikan null (bukan melempar) bila gagal, supaya
 * satu foto rusak tidak menggagalkan seluruh PDF.
 *
 * Dicoba dua kali: saat mencetak banyak halaman, Google sesekali membatasi
 * laju permintaan dan satu gambar gagal begitu saja. Tanpa percobaan ulang
 * foto itu hilang dari laporan tanpa jejak — dan itu sudah terjadi saat
 * pengujian.
 */
async function muatGambar(url, batasMs) {
  const batas = batasMs || 8000;
  const a = await sekaliMuat(url, batas);
  if (a) return a;
  await new Promise(r => setTimeout(r, 700));
  return sekaliMuat(url, batas);
}

const kanvasJPEG = (c, mutu) => c.toDataURL('image/jpeg', mutu || 0.72);

/* ───────────── mini-peta ───────────── */

const lon2x = (lon, z) => (lon + 180) / 360 * Math.pow(2, z);
const lat2y = (lat, z) => {
  const r = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z);
};

/** Zoom terbesar (maks 19) yang masih memuat seluruh titik di dalam kanvas. */
function pilihZoom(pts, lebar, tinggi) {
  for (let z = 19; z >= 12; z--) {
    const xs = pts.map(p => lon2x(p[1], z) * 256), ys = pts.map(p => lat2y(p[0], z) * 256);
    if (Math.max(...xs) - Math.min(...xs) <= lebar - 40 &&
        Math.max(...ys) - Math.min(...ys) <= tinggi - 40) return z;
  }
  return 12;
}

async function petaMini(r, lebar, tinggi) {
  /* POV berjarak tak wajar (koordinat tertukar) dikecualikan dari pembingkaian,
     kalau tidak petanya melompat ke skala kota dan titiknya tak terlihat. */
  const dekat = r.povs.filter(p => p.d <= FLAG);
  const pts = [[r.rlat, r.rlon], ...dekat.map(p => [p.lat, p.lon])];
  const z = pilihZoom(pts, lebar, tinggi);
  const cx = pts.reduce((a, p) => a + lon2x(p[1], z), 0) / pts.length;
  const cy = pts.reduce((a, p) => a + lat2y(p[0], z), 0) / pts.length;

  const c = document.createElement('canvas');
  c.width = lebar; c.height = tinggi;
  const g = c.getContext('2d');
  g.fillStyle = '#1a2620'; g.fillRect(0, 0, lebar, tinggi);

  const px = lon => (lon2x(lon, z) - cx) * 256 + lebar / 2;
  const py = lat => (lat2y(lat, z) - cy) * 256 + tinggi / 2;

  const tugas = [];
  for (let tx = Math.floor(cx - lebar / 512); tx <= Math.floor(cx + lebar / 512); tx++)
    for (let ty = Math.floor(cy - tinggi / 512); ty <= Math.floor(cy + tinggi / 512); ty++)
      tugas.push({ tx, ty });

  const gambar = await Promise.all(tugas.map(t => muatGambar(
    PDF_UBIN.replace('$X', t.tx).replace('$Y', t.ty).replace('$Z', z))));
  gambar.forEach((img, i) => {
    if (!img) return;
    const t = tugas[i];
    g.drawImage(img, (t.tx - cx) * 256 + lebar / 2, (t.ty - cy) * 256 + tinggi / 2, 256, 256);
  });

  const rx = px(r.rlon), ry = py(r.rlat);
  g.lineWidth = 1.5; g.strokeStyle = 'rgba(255,255,255,.8)';
  dekat.forEach(p => { g.beginPath(); g.moveTo(rx, ry); g.lineTo(px(p.lon), py(p.lat)); g.stroke(); });
  dekat.forEach((p, i) => {
    const x = px(p.lon), y = py(p.lat);
    g.beginPath(); g.arc(x, y, 7, 0, 7); g.fillStyle = povColor(p); g.fill();
    g.lineWidth = 1.5; g.strokeStyle = '#0f1210'; g.stroke();
    g.fillStyle = '#0f1210'; g.font = 'bold 10px sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(i + 1), x, y + .5);
  });
  g.beginPath(); g.arc(rx, ry, 9, 0, 7);
  g.fillStyle = '#e8462f'; g.fill();
  g.lineWidth = 3; g.strokeStyle = '#fff'; g.stroke();

  g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(0, tinggi - 17, 108, 17);
  g.fillStyle = '#fff'; g.font = '11px sans-serif'; g.textAlign = 'left';
  g.fillText('© Google · zoom ' + z, 5, tinggi - 5);
  return kanvasJPEG(c, .7);
}

/* ───────────── tampilan kemajuan ───────────── */

let pdfBatal = false;
function pdfPanel(tampil, teks, persen) {
  let d = document.getElementById('pdfbox');
  if (!d) {
    if (!tampil) return;
    d = document.createElement('div');
    d.id = 'pdfbox';
    d.setAttribute('style',
      'position:fixed;inset:0;z-index:9600;display:flex;align-items:center;' +
      'justify-content:center;background:rgba(8,10,9,.72)');
    d.innerHTML =
      '<div style="background:#151915;border:1px solid #2c3830;border-radius:10px;' +
      'padding:20px;width:min(380px,92vw);box-shadow:0 12px 40px rgba(0,0,0,.5)">' +
      '<div style="font-size:14px;color:#dfe8df;margin-bottom:10px">Menyiapkan PDF</div>' +
      '<div id="pdfmsg" style="font-size:12px;color:#93a397;min-height:32px"></div>' +
      '<div style="height:6px;background:#0e120f;border-radius:3px;overflow:hidden;margin:10px 0">' +
      '<div id="pdfbar" style="height:100%;width:0;background:#3c8450;transition:width .2s"></div></div>' +
      '<div style="text-align:right"><button id="pdfBatal" style="padding:6px 14px;' +
      'border-radius:6px;border:1px solid #2c3830;background:#1d241e;color:#dfe8df;' +
      'font:inherit;font-size:13px;cursor:pointer">Batal</button></div></div>';
    document.body.appendChild(d);
    document.getElementById('pdfBatal').onclick = () => {
      pdfBatal = true;
      document.getElementById('pdfmsg').textContent = 'Menghentikan…';
    };
  }
  if (teks !== undefined) document.getElementById('pdfmsg').textContent = teks;
  if (persen !== undefined) document.getElementById('pdfbar').style.width = persen + '%';
  if (!tampil) d.remove();
}

/* ───────────── susunan halaman ───────────── */

const rupiah = v => {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (/^Rp/i.test(s)) return s;                    /* sudah berformat di berkas */
  const n = Number(s);
  return isFinite(n) && n ? 'Rp ' + Math.round(n).toLocaleString('id-ID') : s;
};

function halamanTitik(doc, r, asli, kolIdx, petaImg, fotoImg) {
  const L = 12, KANAN = 198, W = KANAN - L;
  const nilai = k => {
    const i = kolIdx[k];
    const v = (i === undefined || !asli) ? '' : asli[i];
    return v === null || v === undefined ? '' : String(v).trim();
  };

  /* kepala: ID titik */
  doc.setFillColor(233, 238, 233); doc.rect(L, 12, W, 15, 'F');
  doc.setTextColor(18, 24, 20); doc.setFont('helvetica', 'bold'); doc.setFontSize(16);
  doc.text(String(r.id), L + 4, 22.5);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(85, 96, 88);
  doc.text(`${r.jenis || '-'} · ${r.tipe || '-'}`, KANAN - 4, 22.5, { align: 'right' });

  /* keterangan, dua kolom */
  const baris = [
    ['Kecamatan', r.kec || '-', 'Kelurahan', r.kel || '-'],
    ['Nama jalan', r.jalan || '-', 'Sub wilayah', nilai('Sub_wilayah_SK_321') || '-'],
    ['Jenis', r.jenis || '-', 'Tipe', r.tipe || '-'],
    ['Media', nilai('media_type') || '-', 'Ukuran', nilai('Ukuran_bidang_standar') || '-'],
    ['Tarif sewa / th', rupiah(nilai('Tarif_Sewa')) || '-',
     'Usulan / th', rupiah(nilai('usulan15')) || '-'],
  ];
  let y = 35;
  const kolom2 = L + W / 2;
  baris.forEach(([l1, v1, l2, v2]) => {
    doc.setFontSize(8); doc.setFont('helvetica', 'normal'); doc.setTextColor(125, 134, 127);
    doc.text(l1, L, y); doc.text(l2, kolom2, y);
    doc.setFontSize(9.5); doc.setFont('helvetica', 'bold'); doc.setTextColor(22, 30, 24);
    doc.text(String(v1).slice(0, 44), L, y + 4.6);
    doc.text(String(v2).slice(0, 44), kolom2, y + 4.6);
    y += 11;
  });

  /* ringkasan jarak POV — satu baris, karena mini-peta saja tidak
     menyampaikan jaraknya */
  doc.setDrawColor(222); doc.line(L, y - 2, KANAN, y - 2);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(85, 96, 88);
  doc.text(r.povs.length
    ? `${r.povs.length} POV · median ${r.median} m · rata2 ${r.mean} m · ` +
      `rentang ${r.min}–${r.max} m` + (r.fl ? ` · ${r.fl} perlu dicek` : '')
    : 'Belum ada POV disurvei', L, y + 3.5);
  doc.text(`${r.rlat.toFixed(6)}, ${r.rlon.toFixed(6)}`, KANAN, y + 3.5, { align: 'right' });

  /* mini-peta */
  const petaY = y + 8, petaH = 88;
  if (petaImg) doc.addImage(petaImg, 'JPEG', L, petaY, W, petaH);
  else {
    doc.setDrawColor(205); doc.rect(L, petaY, W, petaH);
    doc.setFontSize(9); doc.setTextColor(150, 155, 150);
    doc.text('Mini-peta tidak tersedia', L + W / 2, petaY + petaH / 2, { align: 'center' });
  }

  /* foto */
  const fY = petaY + petaH + 9;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(60, 132, 80);
  doc.text(fotoImg.length ? `Foto survei (${fotoImg.length})` : 'Foto survei', L, fY - 3);
  if (fotoImg.length) {
    const sela = 5, fw = (W - sela * (PDF_FOTO_MAKS - 1)) / PDF_FOTO_MAKS, fh = fw * 4 / 3;
    fotoImg.forEach((f, i) => {
      const bx = L + i * (fw + sela);
      doc.addImage(f.data, 'JPEG', bx, fY, fw, fh);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(110, 120, 112);
      doc.text(f.label + (f.jarak != null ? ` · ${f.jarak} m` : ''), bx, fY + fh + 3.5);
    });
  } else {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(150, 155, 150);
    doc.text('Tidak ada foto survei untuk titik ini', L, fY + 4);
  }

  doc.setFontSize(7); doc.setTextColor(150, 155, 150);
  doc.text(`${r.id}  ·  dicetak ${new Date().toLocaleDateString('id-ID')}`, L, 290);
}

/* ───────────── penggerak utama ───────────── */

async function exportPDF() {
  if (!siapEkspor()) return;

  const daftar = filtered.filter(r => !r.del);
  if (!daftar.length) { toast('Tidak ada titik yang tampil — longgarkan filternya dulu'); return; }
  if (daftar.length > PDF_BANYAK &&
      !confirm(`${nf(daftar.length)} titik akan dicetak, satu halaman per titik.\n\n` +
               `Dengan foto dan mini-peta ini memakan waktu lama dan menghasilkan ` +
               `berkas yang besar.\n\nPersempit filter dulu, atau lanjutkan?`)) return;

  pdfBatal = false;
  window.__pdfGalat = '';
  pdfPanel(true, 'Memuat pustaka PDF…', 0);
  const tombol = $('btnPDF'); tombol.disabled = true;

  try {
    const [jsPDF] = await Promise.all([muatJsPDF(), muatAtribut()]);
    const kolIdx = {};
    ATRIBUT.cols.forEach((c, i) => kolIdx[c] = i);

    const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
    let dibuat = 0, tanpaFoto = 0, petaGagal = 0, fotoGagal = 0;

    for (let i = 0; i < daftar.length; i++) {
      if (pdfBatal) break;
      const r = daftar[i];
      pdfPanel(true, `${r.id}  (${i + 1} dari ${nf(daftar.length)})`,
               Math.round(i / daftar.length * 100));

      /* Jeda kecil antar titik: rentetan permintaan tanpa henti membuat
         Google membatasi laju, dan gambar mulai berguguran. */
      if (i) await new Promise(s => setTimeout(s, 120));

      const asli = ATRIBUT.peta[r.id] || null;
      const petaImg = await petaMini(r, 744, 352).catch(() => null);
      if (!petaImg) petaGagal++;

      /* Foto dimuat BERSAMAAN. Berurutan, tiap foto bisa menunggu sampai
         batas waktunya dan satu titik saja memakan menitan. */
      let fotoImg = [];
      if (asli && !pdfBatal) {
        const calon = [];
        for (let k = 0; k < PDF_FOTO.length && calon.length < PDF_FOTO_MAKS; k++) {
          const url = String(asli[kolIdx[PDF_FOTO[k].kol]] || '').trim();
          if (/^https?:/.test(url)) calon.push({ url, urut: k, label: PDF_FOTO[k].label });
        }
        fotoImg = (await Promise.all(calon.map(async c => {
          const img = await muatGambar(c.url + '=s400');
          if (!img) { fotoGagal++; return null; }
          const cv = document.createElement('canvas');
          const skala = Math.min(1, 460 / Math.max(img.width, img.height));
          cv.width = Math.round(img.width * skala); cv.height = Math.round(img.height * skala);
          cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
          return { data: kanvasJPEG(cv, .7), label: c.label,
                   jarak: c.urut < 6 && r.povs[c.urut] ? r.povs[c.urut].d : null };
        }))).filter(Boolean);
      }
      if (!fotoImg.length) tanpaFoto++;

      if (dibuat) doc.addPage();
      halamanTitik(doc, r, asli, kolIdx, petaImg, fotoImg);
      dibuat++;
    }

    if (!dibuat) { pdfPanel(false); toast('Dibatalkan — tidak ada halaman dibuat'); return; }

    pdfPanel(true, 'Menyimpan berkas…', 100);
    doc.save(`POV_reklame_${stamp()}.pdf`);
    pdfPanel(false);
    toast(`PDF tersimpan — ${nf(dibuat)} halaman` +
          (pdfBatal ? ' (dihentikan lebih awal)' : '') +
          (tanpaFoto ? ` · ${nf(tanpaFoto)} titik tanpa foto` : '') +
          (petaGagal ? ` · ${nf(petaGagal)} tanpa peta` : ''));
    /* Gambar yang gagal diambil dilaporkan terang-terangan, bukan didiamkan. */
    if (fotoGagal) toast(`${nf(fotoGagal)} foto gagal diunduh dan tidak masuk PDF — ` +
                         `biasanya karena sambungan tersendat. Ulangi bila perlu.`);
  } catch (e) {
    pdfPanel(false);
    window.__pdfGalat = String((e && e.stack) || e);
    toast('Gagal membuat PDF: ' + e.message);
  } finally {
    tombol.disabled = false;
  }
}

$('btnPDF').onclick = exportPDF;
