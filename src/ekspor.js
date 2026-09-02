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
    out.push([r.id, r.jenis, r.tipe, r.jalan, r.povs.length ? r.median : '']);
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

function exportXLSX() {
  if (typeof XLSX === 'undefined') {
    toast('Pustaka Excel belum termuat — periksa sambungan internet, lalu coba lagi');
    return;
  }
  if (!data.length) { toast('Belum ada data untuk diekspor'); return; }

  const d = barisDetail(), s = barisRingkas();
  const wb = XLSX.utils.book_new();

  const wsD = XLSX.utils.aoa_to_sheet(d);
  wsD['!cols'] = lebarKolom(d);
  wsD['!freeze'] = { xSplit: 0, ySplit: 1 };
  XLSX.utils.book_append_sheet(wb, wsD, 'Detail POV');

  const wsS = XLSX.utils.aoa_to_sheet(s);
  wsS['!cols'] = lebarKolom(s, 34);
  wsS['!freeze'] = { xSplit: 0, ySplit: 1 };
  XLSX.utils.book_append_sheet(wb, wsS, 'Ringkas');

  XLSX.writeFile(wb, `POV_reklame_${stamp()}.xlsx`);

  const berPOV = data.filter(r => r.povs.length).length;
  toast(`Excel tersimpan — ${nf(d.length - 1)} baris POV, ` +
        `${nf(s.length - 1)} titik (${nf(berPOV)} ber-POV)`);
}

$('btnXLSX').onclick = exportXLSX;
