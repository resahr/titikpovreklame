/* ══════════════════════ TAMBAH TITIK REKLAME ══════════════════════

   Data dasar 2.420 titik bersifat statis; server hanya menyimpan SELISIH
   per id. Titik yang ditambahkan pemakai tidak ada di data dasar, jadi
   atributnya (jenis, tipe, jalan, kelurahan, kecamatan, prioritas) ikut
   dikirim ke server sebagai `meta` dan disimpan di kolom ke-9 sheet
   `edits`. Dari situ rekan lain bisa menyusunnya kembali.

   ID diketik sendiri oleh pemakai. Karena data dasar sama persis di semua
   perangkat, pemeriksaan "id sudah dipakai" di sini sudah cukup untuk
   menangkal tabrakan dengan titik survei. Yang tidak bisa dilihat dari
   sini — dua orang mengetik id yang sama di saat bersamaan — ditangkal
   server lewat penolakan `id_dipakai`.                                  */

let tambahMode = false;

const TAMBAH_WAJIB = [
  ['tJenis', 'Jenis'], ['tTipe', 'Tipe'], ['tJalan', 'Jalan'],
  ['tKel', 'Kelurahan'], ['tKec', 'Kecamatan'], ['tPrio', 'Prioritas']
];

/* Nilai yang sudah dipakai di data, untuk daftar pilihan. */
function nilaiUnik(f){
  const s = new Set();
  data.forEach(r => { const v = String(r[f] == null ? '' : r[f]).trim(); if (v) s.add(v); });
  return [...s].sort((a, b) => a.localeCompare(b, 'id'));
}

/**
 * Membuat satu titik baru di memori dan mendaftarkannya ke semua indeks.
 * Dipakai tiga jalur: borang di layar ini, perubahan yang datang dari
 * rekan, dan pemulihan draf lokal setelah tab ditutup.
 */
function buatTitik(id, meta, rlat, rlon, povs){
  const r = {
    id, baru: true, ed: true,
    tipe:  meta.tipe  || '', jenis: meta.jenis || '',
    jalan: meta.jalan || '', kel:   meta.kel   || '',
    kec:   meta.kec   || '', prio:  meta.prio  || 'TANPA PRIORITAS',
    rlat: +rlat, rlon: +rlon,
    povs: (povs || []).map(povIn)
  };
  recalc(r);
  data.push(r);
  /* "Kembalikan titik ini" mengembalikan ke keadaan saat DIBUAT — titik
     tambahan tidak punya data survei untuk dijadikan acuan. */
  const salinan = JSON.parse(JSON.stringify(r));
  ORIG.push(salinan);
  origMap[id] = salinan;
  return r;
}

/* ───────────── mode menaruh titik ───────────── */

function startTambah(){
  if (typeof stopAdd === 'function') stopAdd();
  tambahMode = true;
  map.getContainer().classList.add('adding');
  $('btnTambahTitik').classList.add('on');
  toast('Klik lokasi titik reklame di peta — Esc untuk batal');
}
function stopTambah(){
  tambahMode = false;
  map.getContainer().classList.remove('adding');
  const b = $('btnTambahTitik');
  if (b) b.classList.remove('on');
}

/* ───────────── borang ───────────── */

function isiPilihan(){
  const opsi = (el, arr, kosong) => {
    el.innerHTML = (kosong ? '<option value="">— pilih —</option>' : '') +
      arr.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  };
  opsi($('tJenis'), nilaiUnik('jenis'), true);
  opsi($('tKec'),   nilaiUnik('kec'),   true);
  opsi($('tPrio'),  nilaiUnik('prio'),  true);
  /* Tipe, jalan dan kelurahan pakai datalist: boleh pilih dari yang ada,
     boleh juga mengetik yang belum pernah ada. */
  const dl = (el, arr) => el.innerHTML = arr.map(v => `<option value="${esc(v)}">`).join('');
  dl($('tTipeList'),  nilaiUnik('tipe'));
  dl($('tJalanList'), nilaiUnik('jalan'));
  dl($('tKelList'),   nilaiUnik('kel'));
}

function bukaBorang(lat, lon){
  stopTambah();
  isiPilihan();
  $('tLat').value = (+lat).toFixed(6);
  $('tLon').value = (+lon).toFixed(6);
  $('tMsg').textContent = '';
  $('tMsg').className = 'tmsg';
  $('tbox').hidden = false;
  cekId();
  setTimeout(() => $('tId').focus(), 60);
}
function tutupBorang(){ $('tbox').hidden = true; }

/** Pesan langsung di bawah kolom ID, tanpa menunggu tombol Simpan. */
function cekId(){
  const v = $('tId').value.trim();
  const note = $('tIdNote');
  if (!v) { note.textContent = 'ID wajib diisi.'; note.className = 'tnote warn'; return false; }
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._\/-]{2,39}$/.test(v)) {
    note.textContent = 'Gunakan 3–40 huruf/angka, boleh - _ . / dan spasi.';
    note.className = 'tnote warn'; return false;
  }
  const kembar = data.find(r => r.id.toLowerCase() === v.toLowerCase());
  if (kembar) {
    note.textContent = `Sudah dipakai${kembar.jalan ? ' — ' + kembar.jalan : ''}. Pilih ID lain.`;
    note.className = 'tnote warn'; return false;
  }
  note.textContent = 'ID belum dipakai.';
  note.className = 'tnote ok';
  return true;
}

function simpanTitikBaru(){
  const pesan = (t) => { $('tMsg').textContent = t; $('tMsg').className = 'tmsg warn'; };

  if (SYNC.serverVer && SYNC.serverVer < 3) {
    pesan('Server masih versi lama dan belum bisa menyimpan atribut titik baru. ' +
          'Tunggu beberapa menit lalu coba lagi.');
    return;
  }
  if (!cekId()) { pesan('Perbaiki dulu ID-nya.'); $('tId').focus(); return; }
  const id = $('tId').value.trim();

  const nilai = {};
  for (const [el, label] of TAMBAH_WAJIB) {
    const v = $(el).value.trim();
    if (!v) { pesan(`${label} belum diisi.`); $(el).focus(); return; }
    nilai[el] = v;
  }

  const lat = parseFloat($('tLat').value), lon = parseFloat($('tLon').value);
  if (!isFinite(lat) || !isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    pesan('Koordinat tidak valid.'); return;
  }

  const meta = {
    jenis: nilai.tJenis, tipe: nilai.tTipe, jalan: nilai.tJalan,
    kel:   nilai.tKel,   kec:  nilai.tKec,  prio:  nilai.tPrio, baru: true
  };
  const r = buatTitik(id, meta, r6(lat), r6(lon), []);

  tutupBorang();
  buildFilters(); applyFilters();
  if (!editMode) setEditMode(true);
  selectRec(id, true);
  markSync(r);                      /* antre + draf lokal, lalu dikirim */
  drawOverview(); updateStats(); updateFoot();
  toast(`${id} ditambahkan — klik "+ Tambah POV" untuk mulai menaruh POV-nya`);
}

/* ───────────── pemasangan ke halaman ───────────── */

function pasangTambahUI(){
  const gaya = document.createElement('style');
  gaya.textContent = `
#tbox{position:fixed;inset:0;z-index:9500;display:flex;align-items:center;
  justify-content:center;background:rgba(8,10,9,.72);padding:16px}
#tbox[hidden]{display:none}
#tbox .tcard{background:#151915;border:1px solid #2c3830;border-radius:10px;
  padding:18px;width:min(460px,100%);max-height:90vh;overflow:auto;
  box-shadow:0 12px 40px rgba(0,0,0,.5)}
#tbox h3{margin:0 0 12px;font-size:15px;color:#dfe8df}
#tbox label{display:block;font-size:12px;color:#93a397;margin:9px 0 0}
#tbox input,#tbox select{width:100%;margin-top:3px;padding:7px 8px;
  background:#0e120f;border:1px solid #2c3830;border-radius:6px;
  color:#e6efe6;font-size:13px;font-family:inherit}
#tbox .g2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
#tbox .tnote{font-size:11px;margin-top:4px;min-height:14px}
#tbox .tnote.ok{color:#8fd18f}
#tbox .tnote.warn{color:#e0a15f}
#tbox .tmsg{font-size:12px;min-height:16px;color:#93a397}
#tbox .tmsg.warn{color:#e08a6b}
#tbox .tact{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
#tbox .tact button{padding:7px 14px;border-radius:6px;border:1px solid #2c3830;
  background:#1d241e;color:#dfe8df;font-size:13px;cursor:pointer;font-family:inherit}
#tbox .tact button.pri{background:#2f6b3f;border-color:#3c8450;color:#eaf6ea}
#btnTambahTitik.on{outline:2px solid #9b6cf0}
.tag.t-baru{background:#3a2b5c;color:#c7b0ff}`;
  document.head.appendChild(gaya);

  const bar = $('editbar');
  const b = document.createElement('button');
  b.className = 'btn xs pri'; b.id = 'btnTambahTitik';
  b.textContent = '+ Titik reklame';
  b.title = 'Tambahkan titik reklame baru — klik tombol ini lalu klik lokasinya di peta';
  b.style.marginRight = '10px';
  bar.insertBefore(b, bar.firstChild);
  b.onclick = () => tambahMode ? stopTambah() : startTambah();

  const d = document.createElement('div');
  d.id = 'tbox'; d.hidden = true;
  d.innerHTML = `<div class="tcard" role="dialog" aria-modal="true" aria-label="Tambah titik reklame">
    <h3>Tambah titik reklame</h3>
    <div class="tmsg" id="tMsg"></div>
    <label>ID titik<input id="tId" maxlength="40" autocomplete="off" placeholder="mis. ANL-BTK-HTU-KOR-103"></label>
    <div class="tnote" id="tIdNote"></div>
    <div class="g2">
      <label>Jenis<select id="tJenis"></select></label>
      <label>Tipe<input id="tTipe" list="tTipeList" autocomplete="off"><datalist id="tTipeList"></datalist></label>
    </div>
    <label>Jalan<input id="tJalan" list="tJalanList" autocomplete="off"><datalist id="tJalanList"></datalist></label>
    <div class="g2">
      <label>Kelurahan<input id="tKel" list="tKelList" autocomplete="off"><datalist id="tKelList"></datalist></label>
      <label>Kecamatan<select id="tKec"></select></label>
    </div>
    <label>Prioritas<select id="tPrio"></select></label>
    <div class="g2">
      <label>Lintang<input id="tLat" type="number" step="0.000001"></label>
      <label>Bujur<input id="tLon" type="number" step="0.000001"></label>
    </div>
    <div class="tact">
      <button id="tBatal" type="button">Batal</button>
      <button id="tSimpan" type="button" class="pri">Simpan titik</button>
    </div>
  </div>`;
  document.body.appendChild(d);

  $('tBatal').onclick = tutupBorang;
  $('tSimpan').onclick = simpanTitikBaru;
  $('tId').addEventListener('input', cekId);
  $('tId').addEventListener('keydown', e => { if (e.key === 'Enter') simpanTitikBaru(); });
  d.addEventListener('click', e => { if (e.target === d) tutupBorang(); });

  map.on('click', e => { if (tambahMode) bukaBorang(e.latlng.lat, e.latlng.lng); });

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!$('tbox').hidden) tutupBorang();
    else if (tambahMode) stopTambah();
  });

  /* Menaruh POV dan menaruh titik baru tidak boleh aktif bersamaan. */
  const startAddAsli = startAdd;
  startAdd = function(){ stopTambah(); return startAddAsli.apply(this, arguments); };

  /* Titik tambahan diberi tanda supaya gampang dibedakan dari hasil survei. */
  const cardAsli = cardHTML;
  cardHTML = function(r){
    const h = cardAsli.call(this, r);
    return r.baru ? h.replace('<div class="tags">', '<div class="tags"><span class="tag t-baru">baru</span>') : h;
  };
}

pasangTambahUI();
