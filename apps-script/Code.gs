/**
 * Backend kolaborasi — WebGIS Titik POV Reklame Batam
 *
 * Model data: hanya SELISIH (delta) yang disimpan di sini.
 * Data dasar 2.420 titik tetap statis di GitHub Pages (data/titik.json).
 * Sheet ini hanya berisi baris untuk titik yang pernah diedit seseorang.
 *
 * Cara pasang: lihat README.md. Ringkasnya —
 *   1. Buat Google Spreadsheet baru
 *   2. Ekstensi > Apps Script, tempel seluruh berkas ini
 *   3. Jalankan fungsi setup() satu kali
 *   4. Deploy > New deployment > Web app
 *        Execute as       : Me
 *        Who has access   : Anyone
 *   5. Salin URL /exec ke API_URL di index.html
 */

// ─────────────────────────── konfigurasi ───────────────────────────

var SH_EDITS    = 'edits';
var SH_PRESENCE = 'presence';
var SH_LOG      = 'log';
var SH_INFO     = 'info';

var CLAIM_TTL_MS = 150000;  // kunci titik kedaluwarsa 2,5 menit tanpa heartbeat
var LOCK_WAIT_MS = 25000;
var MAX_LOG_ROWS = 20000;   // log dipangkas otomatis di atas ini

var APP_VER = 3;            // dinaikkan tiap kali protokol berubah
var P = PropertiesService.getScriptProperties();

// ─────────────────────────── pemasangan ───────────────────────────

var JUDUL_SS = 'Reklame POV — Data Editan';

/**
 * Spreadsheet tempat seluruh editan tim disimpan.
 *
 * SS_TETAP mengunci sasarannya. Ini ADA SEJARAHNYA: versi sebelumnya,
 * bila openById gagal sesaat, menghapus id tersimpan lalu MEMBUAT
 * spreadsheet baru yang kosong. Satu gangguan Drive sesaat sudah cukup
 * membuat seluruh pekerjaan tim seolah lenyap (sebenarnya hanya jadi
 * yatim di berkas lama). Jangan pernah kembali ke pola itu.
 *
 * Aturan sekarang:
 *   - kalau SS_TETAP diisi, hanya berkas itu yang dipakai;
 *   - gagal membuka = LEMPAR GALAT, bukan diam-diam bikin baru;
 *   - membuat berkas baru hanya boleh saat benar-benar belum ada apa pun.
 *
 * Id spreadsheet bukan kata sandi: tanpa izin Drive, mengetahuinya
 * tidak memberi akses apa pun.
 */
var SS_TETAP = '1ljI2wEsf9xlCCoU5z3EFuktpyZ3jo8eYgSG2QvHmGyo';

function getSS_() {
  if (SS_TETAP) {
    var tetap = SpreadsheetApp.openById(SS_TETAP);   // gagal = galat jelas, bukan berkas baru
    if (P.getProperty('SS_ID') !== SS_TETAP) {
      P.setProperty('SS_ID', SS_TETAP);
      P.setProperty('SS_URL', tetap.getUrl());
    }
    return tetap;
  }

  var id = P.getProperty('SS_ID');
  if (id) return SpreadsheetApp.openById(id);       // sengaja tidak ditangkap

  var ss = null;
  try { ss = SpreadsheetApp.getActive(); } catch (e) {}   // kasus menempel pada Sheet
  if (!ss) ss = SpreadsheetApp.create(JUDUL_SS);          // hanya saat benar-benar pertama kali

  P.setProperty('SS_ID', ss.getId());
  P.setProperty('SS_URL', ss.getUrl());
  return ss;
}


/**
 * Jalankan SEKALI dari editor Apps Script.
 * Membuat ketiga sheet, menyiapkan header, dan membuat kode akses acak.
 */
function setup() {
  var ss = getSS_();

  ensureSheet_(ss, SH_EDITS,    ['id','rev','state','povs','rlat','rlon','editor','updated','meta']);
  ensureSheet_(ss, SH_PRESENCE, ['editor','titik','ts']);
  ensureSheet_(ss, SH_LOG,      ['waktu','editor','id','aksi','detail']);

  if (!P.getProperty('REV')) P.setProperty('REV', '0');

  var code = P.getProperty('ACCESS_CODE');
  if (!code) {
    code = randomCode_();
    P.setProperty('ACCESS_CODE', code);
  }
  tulisInfo_(ss, code);

  Logger.log('Setup selesai.\n\nKODE AKSES TIM: %s\n\nBagikan kode ini ke anggota tim. ' +
             'Untuk menggantinya, jalankan gantiKodeAkses("kode-baru").', code);
  return code;
}

/**
 * Kode akses ditulis ke dalam Spreadsheet, bukan ke berkas kode.
 * Dengan begitu ia tidak pernah ikut ter-commit ke GitHub, dan
 * pemilik Sheet bisa membacanya kapan saja tanpa membuka Apps Script.
 */
function tulisInfo_(ss, code) {
  var sh = ss.getSheetByName(SH_INFO) || ss.insertSheet(SH_INFO, 0);
  sh.getRange('A1:B4').setValues([
    ['KODE AKSES TIM', code],
    ['Dibagikan ke', 'anggota tim, bersama tautan WebGIS-nya'],
    ['Mengganti kode', 'Ekstensi > Apps Script, jalankan gantiKodeAkses("KODE-BARU")'],
    ['Catatan', 'Jangan taruh kode ini di berkas yang di-upload ke GitHub.']
  ]);
  sh.getRange('A1:A4').setFontWeight('bold');
  sh.getRange('B1').setFontWeight('bold').setFontSize(14);
  sh.setColumnWidth(1, 130); sh.setColumnWidth(2, 460);
  return sh;
}

/**
 * Memasang diri saat permintaan pertama datang, supaya pemilik tidak
 * perlu menjalankan setup() secara manual dari editor Apps Script.
 */
function ensureReady_() {
  /* READY menandai pemasangan sudah pernah jalan. Tapi kalau sheet kerjanya
     hilang (berkas diganti, tab dihapus manual), pemasangan harus diulang —
     kalau tidak, setiap permintaan gagal dengan "getLastRow of null". */
  if (P.getProperty('READY') === '1') {
    try {
      if (getSS_().getSheetByName(SH_EDITS)) return;
    } catch (e) { throw e; }
    P.deleteProperty('READY');
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) return;
  try {
    if (P.getProperty('READY') === '1') return;
    setup();
    P.setProperty('READY', '1');
  } finally {
    lock.releaseLock();
  }
}

/** Lihat kode akses yang berlaku sekarang. */
function lihatKodeAkses() {
  var c = P.getProperty('ACCESS_CODE');
  Logger.log('Kode akses saat ini: %s', c);
  return c;
}

/** Ganti kode akses. Semua orang harus memasukkan kode baru pada muat ulang berikutnya. */
function gantiKodeAkses(kodeBaru) {
  if (!kodeBaru || String(kodeBaru).length < 4) throw new Error('Kode minimal 4 karakter.');
  P.setProperty('ACCESS_CODE', String(kodeBaru));
  tulisInfo_(getSS_(), String(kodeBaru));
  Logger.log('Kode akses diganti menjadi: %s', kodeBaru);
}

function randomCode_() {
  var a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', s = '';
  for (var i = 0; i < 8; i++) s += a.charAt(Math.floor(Math.random() * a.length));
  return s.slice(0, 4) + '-' + s.slice(4);
}

function ensureSheet_(ss, name, header) {
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  var cur = sh.getRange(1, 1, 1, header.length).getValues()[0];
  if (cur.join('|') !== header.join('|')) {
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

// ─────────────────────────── titik masuk HTTP ───────────────────────────

function doGet(e)  { return route_(e); }
function doPost(e) { return route_(e); }

function route_(e) {
  var req = {};
  try {
    if (e && e.postData && e.postData.contents) req = JSON.parse(e.postData.contents);
    else if (e && e.parameter && e.parameter.payload) req = JSON.parse(e.parameter.payload);
    else if (e && e.parameter) req = e.parameter;
  } catch (err) {
    return json_({ ok: false, error: 'Permintaan tidak terbaca: ' + err.message });
  }

  try {
    ensureReady_();

    if (req.op === 'ping') return json_({ ok: true, rev: currentRev_() });

    // Semua operasi lain wajib menyertakan kode akses yang benar.
    var expected = P.getProperty('ACCESS_CODE');
    if (!expected) return json_({ ok: false, error: 'Backend belum siap. Muat ulang halaman sebentar lagi.' });
    if (String(req.code || '').trim().toUpperCase() !== String(expected).trim().toUpperCase()) {
      return json_({ ok: false, error: 'Kode akses salah.', code: 'BAD_CODE' });
    }

    var name = sanitizeName_(req.name);

    switch (req.op) {
      case 'hello':    return json_(opHello_(name));
      case 'pull':     return json_(opPull_(Number(req.since) || 0, name, req.claim));
      case 'push':     return json_(opPush_(req.items || [], name));
      case 'release':  return json_(opRelease_(name));
      default:         return json_({ ok: false, error: 'Operasi tidak dikenal: ' + req.op });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function sanitizeName_(n) {
  n = String(n == null ? '' : n).replace(/[\x00-\x1f]/g, '').trim().slice(0, 40);
  return n || 'Tanpa nama';
}

// ─────────────────────────── nomor revisi ───────────────────────────
// Disimpan di Script Properties supaya polling "tidak ada perubahan"
// tidak perlu membuka spreadsheet sama sekali (jauh lebih hemat kuota).

function currentRev_() { return Number(P.getProperty('REV') || 0); }
function bumpRev_()    { var r = currentRev_() + 1; P.setProperty('REV', String(r)); return r; }

// ─────────────────────────── operasi ───────────────────────────

function opHello_(name) {
  return {
    ok: true,
    rev: currentRev_(),
    name: name,
    serverTime: Date.now(),
    claimTtl: CLAIM_TTL_MS,
    ver: APP_VER,
    sheet: P.getProperty('SS_URL') || ''
  };
}

/**
 * Ambil semua perubahan dengan rev > since, plus daftar siapa sedang
 * memegang titik apa. `claim` (opsional) sekaligus berfungsi heartbeat:
 * memperbarui klaim editor ini atas satu titik.
 */
function opPull_(since, name, claim) {
  var rev = currentRev_();

  // Jalur cepat: tidak ada perubahan DAN tidak sedang mengklaim apa pun.
  // Tidak membuka spreadsheet — hanya baca properti + cache presence.
  if (rev === since && claim === undefined) {
    var cached = CacheService.getScriptCache().get('PRESENCE');
    if (cached) return { ok: true, rev: rev, changes: [], presence: JSON.parse(cached), cached: true };
  }

  var ss = getSS_();
  var presence = touchPresence_(ss, name, claim);
  var changes = [];

  if (rev !== since) {
    var sh = ss.getSheetByName(SH_EDITS);
    var last = sh.getLastRow();
    if (last > 1) {
      var vals = sh.getRange(2, 1, last - 1, KOL).getValues();
      for (var i = 0; i < vals.length; i++) {
        var v = vals[i];
        if (!v[0]) continue;
        if (Number(v[1]) <= since) continue;
        changes.push({
          id:      String(v[0]),
          rev:     Number(v[1]),
          state:   String(v[2] || 'edit'),
          povs:    v[3] ? JSON.parse(v[3]) : [],
          rlat:    v[4] === '' ? null : Number(v[4]),
          rlon:    v[5] === '' ? null : Number(v[5]),
          editor:  String(v[6] || ''),
          updated: String(v[7] || ''),
          meta:    v[8] ? JSON.parse(v[8]) : null
        });
      }
      changes.sort(function (a, b) { return a.rev - b.rev; });
    }
  }

  return { ok: true, rev: rev, ver: APP_VER, changes: changes, presence: presence };
}

/**
 * Kirim editan. Setiap item diperiksa sendiri-sendiri terhadap baseRev,
 * jadi dua orang yang menggarap titik BERBEDA tidak akan pernah bentrok.
 * Bentrok hanya mungkin pada titik yang sama, dan yang kalah menerima
 * versi server supaya bisa memutuskan.
 */
function opPush_(items, name) {
  if (!items.length) return { ok: true, rev: currentRev_(), accepted: [], conflicts: [] };

  // Satu id hanya boleh muncul sekali per batch — versi terakhir yang menang.
  // Tanpa ini, id ganda akan mencoba menulis ke baris yang belum sempat dibuat.
  var seen = {}, uniq = [];
  for (var d = items.length - 1; d >= 0; d--) {
    var did = String(items[d] && items[d].id || '');
    if (!did || seen[did]) continue;
    seen[did] = 1;
    uniq.unshift(items[d]);
  }
  items = uniq;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    return { ok: false, error: 'Server sedang sibuk, coba lagi sebentar lagi.', busy: true };
  }

  try {
    var ss  = getSS_();
    var sh  = ss.getSheetByName(SH_EDITS);
    var last = sh.getLastRow();

    // Peta id -> {baris, rev} untuk pemeriksaan bentrok.
    var index = {}, vals = [];
    if (last > 1) {
      vals = sh.getRange(2, 1, last - 1, KOL).getValues();
      for (var i = 0; i < vals.length; i++) {
        if (vals[i][0]) index[String(vals[i][0])] = { row: i + 2, rev: Number(vals[i][1]), i: i };
      }
    }

    var accepted = [], conflicts = [], appends = [], logs = [];
    var stampIso = new Date().toISOString();

    for (var k = 0; k < items.length; k++) {
      var it   = items[k];
      var id   = String(it.id || '');
      if (!id) continue;

      var cur      = index[id];
      var baseRev  = Number(it.baseRev || 0);
      var serverRev = cur ? cur.rev : 0;
      var curState  = cur ? String(vals[cur.i][2] || 'edit') : '';

      // Penghapusan bersifat LENGKET: sekali sebuah titik ditandai hapus,
      // ia tidak bisa dihidupkan lagi oleh penyimpanan biasa — hanya oleh
      // pemulihan yang disengaja (undelete: true). Ini yang melindungi
      // penghapusan dari tab lama yang masih memakai aplikasi versi
      // sebelumnya dan tidak mengenal status ini.
      if (curState === 'hapus' && it.state !== 'hapus' && it.undelete !== true) {
        conflicts.push({ id: id, alasan: 'terhapus', server: rowKeServer_(vals[cur.i]) });
        continue;
      }

      /* Titik BARU yang id-nya sudah dipakai orang lain: tolak dengan
         alasan yang jelas, jangan sampai menimpa titik milik orang itu. */
      if (it.baru === true && cur) {
        conflicts.push({ id: id, alasan: 'id_dipakai', server: rowKeServer_(vals[cur.i]) });
        continue;
      }

      if (serverRev > baseRev) {
        conflicts.push({ id: id, alasan: 'basi', server: rowKeServer_(vals[cur.i]) });
        continue;
      }

      var rev = bumpRev_();

      var metaLama = cur && vals[cur.i][8] ? JSON.parse(vals[cur.i][8]) : null;
      var meta     = normMeta_(it.meta) || metaLama;
      if (meta && metaLama && metaLama.baru) meta.baru = true;   /* tidak bisa dicabut */
      var titikBaru = !!(meta && meta.baru);

      var state = (it.state === 'orig' || it.state === 'hapus') ? it.state : 'edit';
      /* 'orig' berarti "kembalikan ke data survei" — titik tambahan tidak
         punya data survei, jadi mengosongkannya hanya akan membuang
         koordinat dan atributnya. */
      if (titikBaru && state === 'orig') state = 'edit';

      // Hanya 'orig' yang mengosongkan isi (kembali ke data survei).
      // 'hapus' TETAP menyimpan POV dan koordinatnya, supaya titik yang
      // dipulihkan kembali lengkap dengan seluruh hasil editan sebelumnya.
      var kosong = (state === 'orig');
      var povs   = kosong ? [] : normPovs_(it.povs);
      var row    = [
        id, rev, state,
        kosong ? '' : JSON.stringify(povs),
        kosong ? '' : num6_(it.rlat),
        kosong ? '' : num6_(it.rlon),
        name, stampIso,
        meta ? JSON.stringify(meta) : ''
      ];

      if (cur) sh.getRange(cur.row, 1, 1, KOL).setValues([row]);
      else     appends.push(row);

      // Perbarui indeks supaya item ganda dalam satu batch tetap konsisten.
      index[id] = { row: cur ? cur.row : -1, rev: rev, i: cur ? cur.i : -1 };
      if (cur) { vals[cur.i] = row; }

      accepted.push({ id: id, rev: rev });
      var aksi = it.baru === true  ? 'tambah titik'
               : state === 'orig'   ? 'kembalikan'
               : state === 'hapus'  ? 'hapus titik'
               : (it.undelete === true ? 'pulihkan titik' : 'simpan');
      logs.push([stampIso, name, id, aksi,
                 state === 'orig' ? 'dikembalikan ke data survei' : povs.length + ' POV']);
    }

    if (appends.length) {
      sh.getRange(sh.getLastRow() + 1, 1, appends.length, KOL).setValues(appends);
    }
    if (logs.length) writeLog_(ss, logs);

    return { ok: true, rev: currentRev_(), accepted: accepted, conflicts: conflicts };

  } finally {
    lock.releaseLock();
  }
}

function opRelease_(name) {
  var ss = getSS_();
  var presence = touchPresence_(ss, name, null);
  return { ok: true, rev: currentRev_(), presence: presence };
}

// ─────────────────────────── kehadiran / kunci lunak ───────────────────────────

/**
 * Perbarui baris kehadiran editor ini dan buang yang kedaluwarsa.
 * claim === undefined  -> hanya baca
 * claim === null       -> lepaskan klaim, tetap tercatat online
 * claim === '<id>'     -> klaim titik itu
 */
function touchPresence_(ss, name, claim) {
  var sh = ss.getSheetByName(SH_PRESENCE);
  var last = sh.getLastRow();
  var now = Date.now();
  var rows = last > 1 ? sh.getRange(2, 1, last - 1, 3).getValues() : [];

  var out = [], mine = -1;
  for (var i = 0; i < rows.length; i++) {
    var ed = String(rows[i][0] || ''), ts = Number(rows[i][2] || 0);
    if (!ed) continue;
    if (now - ts > CLAIM_TTL_MS) continue;          // kedaluwarsa, buang
    if (ed === name) { mine = out.length; }
    out.push([ed, String(rows[i][1] || ''), ts]);
  }

  if (claim !== undefined) {
    var titik = claim === null ? '' : String(claim);
    if (mine >= 0) out[mine] = [name, titik, now];
    else out.push([name, titik, now]);
  }

  // Tulis ulang seluruh blok kehadiran (selalu kecil — hanya editor aktif).
  if (last > 1) sh.getRange(2, 1, last - 1, 3).clearContent();
  if (out.length) sh.getRange(2, 1, out.length, 3).setValues(out);

  var presence = out.map(function (r) {
    return { editor: r[0], titik: r[1], ts: r[2] };
  });
  CacheService.getScriptCache().put('PRESENCE', JSON.stringify(presence), 20);
  return presence;
}

// ─────────────────────────── util ───────────────────────────

/**
 * Bentuk POV di penyimpanan: [lat, lon] atau [lat, lon, s]
 * dengan s = 1 (digeser) atau 2 (baru). s=0 (asli) tidak ditulis.
 * Penanda ini WAJIB dipertahankan — dialah yang memberi warna
 * hijau/oranye/biru pada POV di peta.
 */
/** Bentuk satu baris sheet `edits` menjadi objek yang dikirim ke klien. */
var KOL = 9;                /* lebar baris sheet edits, termasuk kolom meta */

function rowKeServer_(v) {
  return {
    rev:     Number(v[1]),
    state:   String(v[2] || 'edit'),
    povs:    v[3] ? JSON.parse(v[3]) : [],
    rlat:    v[4] === '' ? null : Number(v[4]),
    rlon:    v[5] === '' ? null : Number(v[5]),
    editor:  String(v[6] || ''),
    updated: String(v[7] || ''),
    meta:    v[8] ? JSON.parse(v[8]) : null
  };
}

/* Atribut titik yang DITAMBAHKAN pemakai. Titik hasil survei asli tidak
   punya ini — atributnya sudah ada di data/titik.json. Sekali tersimpan,
   meta tidak pernah dihapus, supaya titik tambahan tidak kehilangan
   identitasnya kalau ada klien lama yang menyimpan tanpa menyertakannya. */
var META_FIELD = ['tipe', 'jenis', 'jalan', 'kel', 'kec', 'prio'];

function normMeta_(m) {
  if (!m || typeof m !== 'object') return null;
  var out = {};
  for (var i = 0; i < META_FIELD.length; i++) {
    var k = META_FIELD[i];
    out[k] = String(m[k] == null ? '' : m[k]).replace(/[\x00-\x1f]/g, '').trim().slice(0, 80);
  }
  out.baru = m.baru === true;
  return out;
}

function normPovs_(povs) {
  var out = [];
  if (!povs || !povs.length) return out;
  for (var i = 0; i < povs.length && i < 60; i++) {
    var p = povs[i];
    if (p == null) continue;
    var isArr = (typeof p.length === 'number');
    var la = coord_(isArr ? p[0] : p.lat);
    var lo = coord_(isArr ? p[1] : p.lon);
    if (la === null || lo === null) continue;
    if (la < -90 || la > 90 || lo < -180 || lo > 180) continue;

    var s = Number(isArr ? p[2] : (p.st === 'baru' ? 2 : (p.st === 'ubah' ? 1 : 0))) || 0;
    if (s === 1 || s === 2) out.push([la, lo, s]);
    else out.push([la, lo]);
  }
  return out;
}

/**
 * Angka koordinat yang benar-benar angka.
 * null/''/undefined/boolean HARUS ditolak — Number(null) itu 0,
 * dan 0 adalah koordinat yang tampak sah (di Teluk Guinea).
 */
function coord_(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  var n = Number(v);
  return isFinite(n) ? +n.toFixed(6) : null;
}

function num6_(v) {
  var n = coord_(v);
  return n === null ? '' : n;
}

function writeLog_(ss, rows) {
  var sh = ss.getSheetByName(SH_LOG);
  if (!sh) return;
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, 5).setValues(rows);
  var last = sh.getLastRow();
  if (last > MAX_LOG_ROWS) sh.deleteRows(2, last - MAX_LOG_ROWS);
}

// ─────────────────────────── pemeliharaan ───────────────────────────

/**
 * Unduh seluruh keadaan saat ini sebagai JSON (untuk arsip/cadangan).
 * Jalankan dari editor, lalu salin isi Logger.
 */
function eksporSemua() {
  var sh = getSS_().getSheetByName(SH_EDITS);
  var last = sh.getLastRow();
  var out = [];
  if (last > 1) {
    sh.getRange(2, 1, last - 1, 8).getValues().forEach(function (v) {
      if (v[0]) out.push({ id: v[0], rev: v[1], state: v[2], povs: v[3] ? JSON.parse(v[3]) : [],
                           rlat: v[4], rlon: v[5], editor: v[6], updated: v[7] });
    });
  }
  Logger.log(JSON.stringify(out));
  return out;
}

/** Kosongkan SELURUH editan tim. Tidak bisa dibatalkan — pakai dengan sangat hati-hati. */
function hapusSemuaEditan() {
  var ss = getSS_();
  var sh = ss.getSheetByName(SH_EDITS);
  if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
  bumpRev_();
  Logger.log('Semua editan dihapus. Rev sekarang: %s', currentRev_());
}
