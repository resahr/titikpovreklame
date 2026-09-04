/* ══════════════════════ EKSPOR EXCEL DUA SHEET ══════════════════════
   CSV secara format hanya bisa memuat satu tabel, jadi ekspor dua sheet
   dibuat sebagai berkas .xlsx sungguhan.

   Sheet "Detail POV"  : satu baris per POV — sama isinya dengan tombol CSV
   Sheet "Ringkas"     : satu baris per titik reklame, dengan jarak median  */

/** Sheet 1 — satu baris per POV (identik dengan keluaran tombol CSV). */
function barisDetail() {
  const out = [['id_reklame', 'jenis', 'tipe', 'jalan', 'kelurahan', 'kecamatan', 'prioritas',
                'reklame_lat', 'reklame_lon', 'pov_ke', 'pov_lat', 'pov_lon',
                'jarak_m', 'status', 'perlu_dicek']];
  data.forEach(r => {
    if (r.del) return;                 /* titik terhapus tidak ikut diekspor */
    if (!r.povs.length) {
      out.push([r.id, r.jenis, r.tipe, r.jalan, r.kel, r.kec, r.prio, r.rlat, r.rlon,
                '', '', '', '', 'tanpa POV', '']);
      return;
    }
    r.povs.forEach((p, i) => out.push([
      r.id, r.jenis, r.tipe, r.jalan, r.kel, r.kec, r.prio, r.rlat, r.rlon,
      i + 1, p.lat, p.lon, p.d,
      p.st === 'baru' ? 'baru' : (p.st === 'ubah' ? 'digeser' : 'asli'),
      p.d > FLAG ? 'ya' : ''
    ]));
  });
  return out;
}

/**
 * Sheet 2 — satu baris per titik reklame.
 *
 * jarak_median_m diambil dari r.median, yaitu median jarak semua POV titik itu
 * ke titik reklamenya (dihitung ulang setiap kali POV digeser/ditambah/dihapus).
 * Titik tanpa POV dibiarkan KOSONG, bukan 0 — angka 0 akan terbaca sebagai
 * "POV tepat di titik reklame", padahal artinya belum ada POV sama sekali.
 */
function barisRingkas() {
  const out = [['id_reklame', 'jenis', 'tipe', 'jalan', 'jarak_median_m']];
  data.forEach(r => {
    if (r.del) return;                 /* titik terhapus tidak ikut diekspor */
    out.push([r.id, r.jenis, r.tipe, r.jalan, r.povs.length ? r.median : '']);
  });
  return out;
}

/**
 * Sheet 3 — daftar titik yang ditandai terhapus, lengkap dengan siapa
 * dan kapan. Hanya muncul kalau memang ada yang dihapus.
 *
 * Penghapusan tidak membuang apa pun: POV-nya masih tersimpan di server
 * dan titiknya bisa dipulihkan lewat filter "Terhapus" di aplikasi.
 * Sheet ini ada supaya penghapusan tetap bisa ditelusuri di luar aplikasi.
 */
function barisDihapus() {
  const out = [['id_reklame', 'jenis', 'tipe', 'jalan', 'kecamatan',
                'jumlah_pov_tersimpan', 'jarak_median_m', 'dihapus_oleh', 'waktu']];
  data.forEach(r => {
    if (!r.del) return;
    out.push([r.id, r.jenis, r.tipe, r.jalan, r.kec,
              r.povs.length, r.povs.length ? r.median : '',
              r.by || '', (r.at || '').replace('T', ' ').slice(0, 16)]);
  });
  return out;
}

/* ═══════════ SHEET "DATA LENGKAP" — 172 kolom berkas survei awal ═══════════

   Atribut lengkap (4,3 MB) TIDAK ikut dimuat saat halaman dibuka; hanya
   diambil ketika tombol ekspor ditekan, supaya peta tetap ringan.

   Yang DITIMPA dengan hasil kerja tim hanyalah yang memang sedang digarap:
   enam kolom koordinat POV dan koordinat titik reklamenya.

   JARAK_MEAN dan JARAK_MED_ sengaja DIBIARKAN APA ADANYA. Keduanya ternyata
   tidak berhubungan dengan koordinat POV di berkas itu sendiri — dari 694
   titik ber-POV, hanya 8 yang cocok (selisih tengah 24 m). Menimpanya berarti
   membuang angka yang artinya belum jelas. Hasil hitungan POV ditaruh di
   kolom tambahan berawalan POV_ di paling kanan.                          */

const POV_KOL = ['VP1_KOORDI', 'VP2_KOORDI', 'VP3_KOORDI',
                 'VPK1_KOORD', 'VPK2_KOORD', 'VPK3_KOORD'];
const KOL_LON = ['LONG_DISP', 'longitude'];
const KOL_LAT = ['LAT_DISP', 'latitude'];

let ATRIBUT = null;

async function muatAtribut() {
  if (ATRIBUT) return ATRIBUT;
  const r = await fetch('data/atribut.json', { cache: 'force-cache' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const peta = Object.create(null);
  j.rows.forEach(row => peta[row[j.idIdx]] = row);
  ATRIBUT = { cols: j.cols, peta };
  return ATRIBUT;
}

/** Format koordinat POV persis seperti berkas asli: "1.075346, 103.904020". */
function fmtKoord(p) { return p.lat.toFixed(6) + ', ' + p.lon.toFixed(6); }

function barisLengkap() {
  const A = ATRIBUT;
  const hidup = data.filter(r => !r.del);

  /* Berkas asli hanya menyediakan enam slot POV. Kalau ada titik yang
     sekarang punya lebih, slot tambahan dibuat supaya tidak ada yang hilang. */
  const maks = hidup.reduce((m, r) => Math.max(m, r.povs.length), 0);
  const ekstra = [];
  for (let i = POV_KOL.length; i < maks; i++) ekstra.push('POV' + (i + 1) + '_KOORDI');

  const head = A.cols.concat(ekstra, ['POV_JUMLAH', 'POV_JARAK_MEAN_m',
    'POV_JARAK_MEDIAN_m', 'POV_JARAK_MIN_m', 'POV_JARAK_MAX_m',
    'POV_PERLU_DICEK', 'SUMBER_BARIS', 'DIEDIT_OLEH', 'DIEDIT_WAKTU']);

  const idx = {};
  A.cols.forEach((c, i) => idx[c] = i);
  const out = [head];

  hidup.forEach(r => {
    const asli = A.peta[r.id];
    const row = asli ? asli.slice() : new Array(A.cols.length).fill('');
    if (!asli) {                       /* titik tambahan: isi yang memang kita tahu */
      row[idx.ID_TITIK]   = r.id;
      row[idx.JENIS]      = r.jenis;
      row[idx.TIPE]       = r.tipe;
      row[idx.NAMA_JALAN] = r.jalan;
      row[idx.KELURAHAN_] = r.kel;
      row[idx.KECAMATAN]  = r.kec;
      row[idx.PRIORITAS]  = r.prio;
    }
    KOL_LON.forEach(k => row[idx[k]] = r.rlon);
    KOL_LAT.forEach(k => row[idx[k]] = r.rlat);
    /* Slot POV yang tidak terpakai lagi dikosongkan, jangan menyisakan
       koordinat lama yang sudah dihapus. */
    POV_KOL.forEach((k, i) => row[idx[k]] = r.povs[i] ? fmtKoord(r.povs[i]) : '');

    const n = r.povs.length;
    out.push(row.concat(
      ekstra.map((_, i) => r.povs[6 + i] ? fmtKoord(r.povs[6 + i]) : ''),
      [n, n ? r.mean : '', n ? r.median : '', n ? r.min : '', n ? r.max : '',
       r.fl || '', r.baru ? 'tambahan' : 'survei',
       r.by || '', (r.at || '').replace('T', ' ').slice(0, 16)]));
  });
  return out;
}

function lebarKolom(aoa, maks) {
  return aoa[0].map((_, c) => {
    let w = 0;
    for (let i = 0; i < aoa.length; i++) {
      const v = aoa[i][c];
      const n = v === null || v === undefined ? 0 : String(v).length;
      if (n > w) w = n;
    }
    return { wch: Math.min(maks || 28, Math.max(9, w + 2)) };
  });
}

async function exportXLSX() {
  if (typeof XLSX === 'undefined') {
    toast('Pustaka Excel belum termuat — periksa sambungan internet, lalu coba lagi');
    return;
  }
  if (!data.length) { toast('Belum ada data untuk diekspor'); return; }

  const tombol = $('btnXLSX');
  tombol.disabled = true;
  let lengkap = null, gagalAtribut = '';
  try {
    if (!ATRIBUT) toast('Menyiapkan Excel — memuat atribut lengkap (sekali saja)…');
    await muatAtribut();
    lengkap = barisLengkap();
  } catch (e) {
    /* Sheet lain tetap dibuat — lebih baik ekspor sebagian daripada gagal total. */
    gagalAtribut = e.message;
  } finally {
    tombol.disabled = false;
  }

  const d = barisDetail(), s = barisRingkas();
  const wb = XLSX.utils.book_new();

  if (lengkap) {
    const wsL = XLSX.utils.aoa_to_sheet(lengkap);
    wsL['!cols'] = lebarKolom(lengkap, 40);
    wsL['!freeze'] = { xSplit: 0, ySplit: 1 };
    XLSX.utils.book_append_sheet(wb, wsL, 'Data Lengkap');
  }

  const wsD = XLSX.utils.aoa_to_sheet(d);
  wsD['!cols'] = lebarKolom(d);
  wsD['!freeze'] = { xSplit: 0, ySplit: 1 };
  XLSX.utils.book_append_sheet(wb, wsD, 'Detail POV');

  const wsS = XLSX.utils.aoa_to_sheet(s);
  wsS['!cols'] = lebarKolom(s, 34);
  wsS['!freeze'] = { xSplit: 0, ySplit: 1 };
  XLSX.utils.book_append_sheet(wb, wsS, 'Ringkas');

  const h = barisDihapus();
  if (h.length > 1) {
    const wsH = XLSX.utils.aoa_to_sheet(h);
    wsH['!cols'] = lebarKolom(h, 34);
    wsH['!freeze'] = { xSplit: 0, ySplit: 1 };
    XLSX.utils.book_append_sheet(wb, wsH, 'Dihapus');
  }

  XLSX.writeFile(wb, `POV_reklame_${stamp()}.xlsx`);

  const berPOV = data.filter(r => !r.del && r.povs.length).length;
  toast(`Excel tersimpan — ${nf(d.length - 1)} baris POV, ` +
        `${nf(s.length - 1)} titik (${nf(berPOV)} ber-POV)` +
        (lengkap ? ` · sheet "Data Lengkap" ${nf(lengkap[0].length)} kolom` : '') +
        (h.length > 1 ? ` · ${nf(h.length - 1)} terhapus di sheet terpisah` : ''));
  if (gagalAtribut) {
    toast('Sheet "Data Lengkap" dilewati — atribut gagal dimuat: ' + gagalAtribut);
  }
}

$('btnXLSX').onclick = exportXLSX;
