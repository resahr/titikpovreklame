/* ══════════════════════ KOLABORASI ══════════════════════
   Sinkronisasi lewat Google Apps Script + Google Sheets.

   Yang disimpan di server hanyalah SELISIH: satu baris per titik
   yang pernah diedit. Data dasar 2.420 titik tetap statis di
   data/titik.json, jadi Sheet tidak pernah membengkak.

   Bentrok dijaga per titik: dua orang menggarap titik berbeda
   tidak akan pernah saling menimpa. Titik yang sedang dibuka
   orang lain ditandai gembok.                                   */

/* Diisi saat pemasangan — lihat README.md langkah 5. */
const API_URL = '__API_URL__';
const APP_VERSION = 3;    // harus sama dengan APP_VER di apps-script/Code.gs

const POLL_MS  = 10000;   /* selang tarik perubahan dari server   */
const PUSH_MS  = 1200;    /* tunda kirim setelah berhenti mengedit */
const DRAFT_MAX = 400;    /* batas titik yang disimpan sbg draf lokal */
const LSK = { name:'pov_nama', code:'pov_kode', draft:'pov_draf' };

const SYNC = {
  name:'', code:'', rev:0, live:false,
  base:  Object.create(null),   /* id -> rev server terakhir yang kita tahu */
  queue: Object.create(null),   /* id -> true, menunggu dikirim             */
  peers: [], claimed:null,
  srvState: Object.create(null),  /* id -> status terakhir di server        */
  gagalMasuk: '',                /* alasan kegagalan masuk terakhir        */
  usang: false,                   /* true bila server memakai versi lebih baru */
  serverVer: 0,                   /* versi protokol yang dipakai server        */
  badCode: 0,                     /* berapa kali beruntun server menolak kode  */
  perluRender: false,             /* status hapus berubah -> daftar wajib disusun ulang */
  perluFilter: false,             /* ada titik baru -> daftar pilihan filter wajib diulang */
  pushT:null, pollT:null, sending:false, lastOk:0, fails:0
};

/* ───────────── normalisasi POV ─────────────
   Di berkas: [lat, lon, s]  dengan s 0=asli 1=digeser 2=baru
   Di memori: {lat, lon, st} dengan st undefined|'ubah'|'baru'   */
const ST_IN  = [undefined, 'ubah', 'baru'];
const ST_OUT = { ubah:1, baru:2 };

function povIn(p){
  if (Array.isArray(p)) return { lat:+p[0], lon:+p[1], st:ST_IN[p[2]|0] };
  return { lat:+p.lat, lon:+p.lon, st:p.st };
}
function povOut(p){
  const s = ST_OUT[p.st] || 0;
  return s ? [p.lat, p.lon, s] : [p.lat, p.lon];
}

/* ───────────── boot ───────────── */

function bootFrom(rows){
  data = rows.map(r => {
    const o = Object.assign({}, r);
    o.povs = (r.povs || []).map(povIn);
    o.jenis = o.jenis || 'Tidak Diketahui';
    o.prio  = o.prio  || 'TANPA PRIORITAS';
    recalc(o);
    return o;
  });
  ORIG = JSON.parse(JSON.stringify(data));
  Object.keys(origMap).forEach(k => delete origMap[k]);
  ORIG.forEach(r => origMap[r.id] = r);

  $('eUndo').disabled = true;
  buildFilters(); render(); renderEditor(); setHint();
  if (data.length) map.fitBounds(L.latLngBounds(data.map(r => [r.rlat, r.rlon])).pad(.05));
}

/* Berkas hasil "Simpan HTML" membawa datanya sendiri di #dataset.
   Berkas seperti itu dibuka luring — tanpa gerbang masuk, tanpa sync. */
function bootEmbedded(){
  const t = ($('dataset').textContent || '').trim();
  if (!t) return false;
  try {
    bootFrom(JSON.parse(t));
    $('collabbar').hidden = true;
    $('gate').hidden = true;
    toast('Berkas arsip — mode luring, perubahan tidak tersinkron');
    return true;
  } catch (e) { return false; }
}

async function boot(){
  injectLockWarn();
  if (bootEmbedded()) return;

  setSync('busy', 'Memuat data dasar…');
  try {
    const r = await fetch('data/titik.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    bootFrom(await r.json());
  } catch (e) {
    setSync('off', 'Gagal memuat data/titik.json — ' + e.message);
    toast('Data dasar gagal dimuat: ' + e.message);
    return;
  }
  /* Sudah pernah masuk di perangkat ini? Masuk sendiri, diam-diam.
     Gerbang hanya muncul kalau memang belum pernah masuk, atau kalau
     kredensial yang tersimpan ditolak server. */
  const namaTsp = (localStorage.getItem(LSK.name) || '').trim();
  const kodeTsp = (localStorage.getItem(LSK.code) || '').trim();
  if (namaTsp && kodeTsp && API_URL && API_URL.indexOf('__API') !== 0) {
    setSync('busy', `Masuk sebagai <b>${esc(namaTsp)}</b>…`);
    if (await masuk(namaTsp, kodeTsp, true)) return;
    setSync('', 'Perlu masuk ulang');
    openGate(SYNC.gagalMasuk
      ? 'Sambungan ke server gagal: ' + SYNC.gagalMasuk
      : 'Kode akses yang tersimpan sudah tidak berlaku. Masukkan yang baru.');
    return;
  }

  setSync('', 'Menunggu Anda masuk…');
  openGate();
}

/* ───────────── gerbang masuk ───────────── */

function openGate(msg){
  const g = $('gate');
  $('gateName').value = localStorage.getItem(LSK.name) || '';
  $('gateCode').value = localStorage.getItem(LSK.code) || '';
  $('gateMsg').textContent = msg || '';
  $('gateMsg').className = msg ? '' : 'info';
  g.hidden = false;
  setTimeout(() => ($('gateName').value ? $('gateCode') : $('gateName')).focus(), 60);
}

/**
 * Satu-satunya jalur masuk, dipakai gerbang maupun masuk otomatis.
 * `diam` = true berarti dipanggil tanpa gerbang tampil; kegagalan
 * jaringan dicoba ulang sebentar sebelum menyerah, supaya sambungan
 * yang tersendat tidak melempar orang ke halaman login.
 */
async function masuk(name, code, diam){
  /* Percobaan masuk yang GAGAL tidak boleh merusak sesi yang sudah jalan:
     dulu SYNC.name/SYNC.code langsung ditimpa sebelum diverifikasi, jadi
     salah ketik kode di gerbang membuat sesi yang tadinya sehat ikut
     ditolak server di polling berikutnya. */
  const namaLama = SYNC.name, kodeLama = SYNC.code;
  SYNC.name = name; SYNC.code = code;
  const percobaan = diam ? 3 : 1;
  const pulihkan = () => { SYNC.name = namaLama; SYNC.code = kodeLama; };

  for (let i = 1; i <= percobaan; i++) {
    try {
      const res = await api('hello');
      if (!res.ok) {
        /* Kode ditolak: percuma diulang, langsung ke gerbang. */
        if (res.code === 'BAD_CODE') { pulihkan(); return false; }
        throw new Error(res.error || 'ditolak');
      }
      localStorage.setItem(LSK.name, name);
      localStorage.setItem(LSK.code, code);
      $('gate').hidden = true;
      authStrip(false);
      SYNC.badCode = 0;
      $('meName').textContent = name;
      SYNC.live = true;
      await firstSync();
      startPolling();
      return true;
    } catch (e) {
      SYNC.gagalMasuk = e.message;
      if (i < percobaan) {
        setSync('busy', `Sambungan tersendat — mencoba lagi (${i}/${percobaan - 1})…`);
        await new Promise(r => setTimeout(r, 2000 * i));
      }
    }
  }
  pulihkan();
  return false;
}

async function gateSubmit(){
  const name = $('gateName').value.trim();
  const code = $('gateCode').value.trim();
  if (!name) { $('gateMsg').textContent = 'Nama harus diisi.'; return; }
  if (!code) { $('gateMsg').textContent = 'Kode akses harus diisi.'; return; }
  if (!API_URL || API_URL.indexOf('__API') === 0) {
    $('gateMsg').textContent = 'API_URL belum diisi di index.html — lihat README langkah 5.';
    return;
  }

  $('gateGo').disabled = true;
  $('gateMsg').className = 'info';
  $('gateMsg').textContent = 'Menghubungi server…';
  SYNC.gagalMasuk = '';

  const berhasil = await masuk(name, code, false);
  $('gateGo').disabled = false;
  if (!berhasil) {
    $('gateMsg').className = '';
    $('gateMsg').textContent = 'Gagal masuk: ' + (SYNC.gagalMasuk || 'kode akses salah');
  }
}

/* ───────────── kode akses ditolak di tengah sesi ─────────────
   Dulu satu jawaban BAD_CODE langsung membuka gerbang login menutupi
   layar — padahal itu diperiksa di SETIAP polling, jadi satu gangguan
   sesaat cukup untuk melempar orang keluar saat sedang mengedit.

   Sekarang: pekerjaan diamankan ke draf lokal, dua penolakan pertama
   dianggap gangguan dan polling dibiarkan menyusul. Kalau memang benar
   ditolak, yang muncul hanya bilah tipis di atas — pemakai sendiri yang
   memutuskan kapan memasukkan kode baru.                              */
const BAD_MAX = 3;

function authStrip(tampil, pesan){
  let s = document.getElementById('authwarn');
  if (!s) {
    if (!tampil) return;
    s = document.createElement('div');
    s.id = 'authwarn';
    s.setAttribute('style',
      'position:fixed;left:0;right:0;top:0;z-index:9000;display:flex;gap:10px;' +
      'flex-wrap:wrap;align-items:center;justify-content:center;padding:8px 12px;' +
      'font-size:13px;background:#7a2e1a;color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.35)');
    s.innerHTML = '<span id="authmsg"></span>' +
                  '<button id="authGo" class="btn xs">Masukkan kode akses</button>';
    document.body.appendChild(s);
    document.getElementById('authGo').onclick = () => {
      authStrip(false);
      openGate('Masukkan kode akses yang berlaku. Pekerjaan Anda tidak hilang.');
    };
  }
  if (pesan) document.getElementById('authmsg').textContent = pesan;
  s.hidden = !tampil;
}

function tolakKode(){
  SYNC.badCode++;
  saveDrafts();                     /* apa pun yang terjadi, jangan sampai hilang */
  if (SYNC.badCode < BAD_MAX) {
    setSync('off', 'Server menolak kode akses — mencoba lagi…');
    return;                          /* anggap gangguan sesaat; polling menyusul */
  }
  stopPolling();
  SYNC.live = false;
  setSync('off', `Luring — ${queueIds().length} perubahan tersimpan di perangkat ini`);
  authStrip(true, 'Kode akses ditolak server. Pekerjaan Anda aman tersimpan di perangkat ini.');
}

/* ───────────── panggilan API ─────────────
   Content-Type text/plain disengaja: menghindari preflight CORS,
   yang tidak dilayani Apps Script.                              */
async function api(op, extra){
  const body = JSON.stringify(Object.assign(
    { op, code: SYNC.code, name: SYNC.name }, extra || {}));
  const r = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body, redirect: 'follow'
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  cekVersi(j);
  /* Kode ditolak DI TENGAH SESI tidak boleh merebut layar orang yang
     sedang mengedit — lihat tolakKode(). Saat masuk (SYNC.live masih
     false) penanganannya ada di masuk()/gateSubmit(). */
  if (j && j.code === 'BAD_CODE') { if (SYNC.live) tolakKode(); }
  else if (j && j.ok) { SYNC.badCode = 0; authStrip(false); }
  return j;
}

/* ───────────── sinkron pertama ───────────── */

async function firstSync(){
  setSync('busy', 'Mengambil pekerjaan tim…');
  const res = await api('pull', { since: 0, claim: null });
  if (!res.ok) { setSync('off', res.error || 'gagal'); return; }

  SYNC.rev = res.rev;
  res.changes.forEach(applyRemote);
  SYNC.peers = res.presence || [];

  const drafts = restoreDrafts();
  render(); renderPeers();

  const n = res.changes.length;
  setSyncIdle();
  if (drafts) toast(`${n} editan tim dimuat · ${drafts} perubahan lokal Anda dikirim ulang`);
  else if (n)  toast(`${n} titik hasil editan tim dimuat`);
  else         toast('Terhubung — belum ada editan tersimpan');

  if (drafts) pushNow();
}

/* ───────────── terapkan perubahan dari server ───────────── */

function applyRemote(ch){
  let i = data.findIndex(x => x.id === ch.id);
  if (i < 0) {
    /* Titik yang ditambahkan rekan: tidak ada di data dasar, jadi harus
       disusun dari `meta` yang ikut dikirim server. Tanpa meta tidak ada
       yang bisa dibuat — abaikan saja daripada menebak. */
    if (!ch.meta || !ch.meta.baru) return;
    buatTitik(ch.id, ch.meta, ch.rlat, ch.rlon, ch.povs);
    i = data.length - 1;
    SYNC.perluRender = true;
    SYNC.perluFilter = true;
  }
  SYNC.base[ch.id] = ch.rev;

  /* Jangan rebut titik yang sedang saya edit dan belum terkirim —
     tandai saja, biar saya yang memutuskan. */
  if (ch.id === selectedId && editMode && SYNC.queue[ch.id]) {
    toast(`${ch.editor} juga mengubah ${ch.id} — perubahan Anda menang bila dikirim lebih dulu`);
    return;
  }

  SYNC.srvState[ch.id] = ch.state;

  if (ch.state === 'orig') {
    data[i] = JSON.parse(JSON.stringify(origMap[ch.id]));
  } else {
    const r = data[i];
    r.povs = (ch.povs || []).map(povIn);
    if (ch.rlat != null) r.rlat = ch.rlat;
    if (ch.rlon != null) r.rlon = ch.rlon;
    r.by = ch.editor; r.at = ch.updated;
    /* 'hapus' menyimpan POV apa adanya — titik ditandai terhapus,
       hasil kerjanya tidak dibuang, sehingga pemulihan mengembalikannya utuh. */
    const delSebelum = !!r.del;
    r.del = (ch.state === 'hapus');
    r.ed  = !r.del;
    /* Muncul/hilangnya titik mengubah isi daftar tersaring, bukan sekadar
       isi satu kartu — jadi daftar & peta harus disusun ulang. */
    if (delSebelum !== !!r.del) SYNC.perluRender = true;
  }
  recalc(data[i]); syncFiltered(data[i]);
  if (layers[ch.id]) rebuild(ch.id);
  updateCard(data[i]);
  if (ch.id === selectedId) renderEditor();
}

/* ───────────── antre & kirim ───────────── */

/* Dulu baris pertamanya `if (!r || !SYNC.live) return;` — artinya setiap
   editan yang dibuat saat luring TIDAK diantrekan dan TIDAK didraf sama
   sekali: terlihat di layar, lalu lenyap tanpa jejak begitu tab ditutup.
   Antre + draf sekarang SELALU jalan; yang ditunda hanya pengirimannya. */
function markSync(r){
  if (!r) return;
  SYNC.queue[r.id] = true;
  saveDrafts();
  if (!SYNC.live) {
    setSync('off', `Luring — ${queueIds().length} perubahan tersimpan di perangkat ini`);
    return;
  }
  setSync('busy', 'Perubahan menunggu dikirim…');
  clearTimeout(SYNC.pushT);
  SYNC.pushT = setTimeout(pushNow, PUSH_MS);
}

function queueIds(){ return Object.keys(SYNC.queue); }

async function pushNow(){
  if (!SYNC.live || SYNC.sending) return;
  const ids = queueIds();
  if (!ids.length) return;

  SYNC.sending = true;
  setSync('busy', 'Menyimpan…');

  const items = ids.map(id => {
    const r = byId(id);
    if (!r) return null;
    const state = r.del ? 'hapus' : (r.ed ? 'edit' : 'orig');
    const it = {
      id,
      baseRev: SYNC.base[id] || 0,
      state,
      povs:    state === 'orig' ? [] : r.povs.map(povOut),
      rlat:    r.rlat, rlon: r.rlon
    };
    /* Server menolak menghidupkan titik terhapus lewat penyimpanan biasa.
       Hanya pemulihan yang disengaja yang boleh, dan itu ditandai di sini. */
    if (state !== 'hapus' && SYNC.srvState[id] === 'hapus') it.undelete = true;

    /* Titik tambahan: atributnya tidak ada di data dasar, jadi harus ikut
       dikirim. Penanda `baru` hanya pada pengiriman PERTAMA — sesudah
       server mengenalnya, penanda itu justru akan ditolak sebagai id kembar. */
    if (r.baru) {
      it.meta = { tipe: r.tipe, jenis: r.jenis, jalan: r.jalan,
                  kel: r.kel, kec: r.kec, prio: r.prio, baru: true };
      if (!SYNC.base[id]) it.baru = true;
    }
    return it;
  }).filter(Boolean);

  try {
    const res = await api('push', { items });
    if (!res.ok) {
      if (res.busy) { SYNC.sending = false; setTimeout(pushNow, 2500); return; }
      throw new Error(res.error || 'gagal');
    }

    res.accepted.forEach(a => {
      SYNC.base[a.id] = a.rev;
      const r = byId(a.id);
      if (r) {
        SYNC.srvState[a.id] = r.del ? 'hapus' : (r.ed ? 'edit' : 'orig');
        /* Server mencatat kita sebagai pengubah — catat juga di sini,
           supaya ekspor & kartu daftar menampilkan nama yang sama
           tanpa harus menunggu perubahan itu ditarik kembali. */
        r.by = SYNC.name;
        r.at = new Date().toISOString();
      }
      delete SYNC.queue[a.id];
    });

    if (res.conflicts && res.conflicts.length) {
      res.conflicts.forEach(c => {
        delete SYNC.queue[c.id];
        applyRemote(Object.assign({ id: c.id }, c.server));
      });
      const names = res.conflicts.map(c => c.server.editor).filter((v, i, a) => a.indexOf(v) === i);
      toast(`${res.conflicts.length} titik bentrok — versi ${names.join(', ')} yang dipakai. ` +
            `Buka lagi titiknya bila perlu diperbaiki.`);
    }

    SYNC.rev = res.rev;
    SYNC.fails = 0; SYNC.lastOk = Date.now();
    saveDrafts();
    dirty = queueIds().length > 0;
    updateFoot(); updateChg();
    setSyncIdle();
  } catch (e) {
    SYNC.fails++;
    setSync('off', `Luring — ${queueIds().length} perubahan tersimpan di perangkat ini`);
  } finally {
    SYNC.sending = false;
    if (queueIds().length && SYNC.fails) setTimeout(pushNow, Math.min(30000, 3000 * SYNC.fails));
  }
}

/* ───────────── polling ───────────── */

function startPolling(){
  stopPolling();
  SYNC.pollT = setInterval(pollNow, POLL_MS);
  pollNow();
}
function stopPolling(){ if (SYNC.pollT) clearInterval(SYNC.pollT); SYNC.pollT = null; }

async function pollNow(){
  if (!SYNC.live || SYNC.sending) return;
  const claim = (editMode && selectedId) ? selectedId : null;
  try {
    const res = await api('pull', { since: SYNC.rev, claim });
    if (!res.ok) return;
    SYNC.claimed = claim;
    SYNC.fails = 0; SYNC.lastOk = Date.now();

    if (res.changes && res.changes.length) {
      const others = res.changes.filter(c => c.editor !== SYNC.name);
      res.changes.forEach(applyRemote);
      SYNC.rev = res.rev;
      if (SYNC.perluFilter) { SYNC.perluFilter = false; buildFilters(); }
      if (SYNC.perluRender) { SYNC.perluRender = false; render(); }
      else { drawOverview(); updateStats(); updateFoot(); }
      if (others.length) {
        const who = others.map(c => c.editor).filter((v, i, a) => a.indexOf(v) === i);
        toast(`${others.length} titik diperbarui oleh ${who.join(', ')}`);
      }
    } else {
      SYNC.rev = res.rev;
    }

    SYNC.peers = res.presence || [];
    renderPeers(); refreshLockWarn();
    if (!queueIds().length) setSyncIdle();
  } catch (e) {
    SYNC.fails++;
    if (SYNC.fails >= 2) setSync('off', 'Sambungan terputus — mencoba lagi…');
  }
}

/* ───────────── draf lokal (jaring pengaman) ───────────── */

function saveDrafts(){
  try {
    const ids = queueIds().slice(0, DRAFT_MAX), out = {};
    ids.forEach(id => {
      const r = byId(id);
      if (!r) return;
      out[id] = { ed: r.ed, rlat: r.rlat, rlon: r.rlon,
                  povs: r.povs.map(povOut), base: SYNC.base[id] || 0 };
      if (r.del) out[id].del = true;
      /* Titik tambahan belum ada di data dasar: tanpa atributnya, draf ini
         tidak bisa dipulihkan sama sekali setelah tab ditutup. */
      if (r.baru) out[id].meta = { tipe: r.tipe, jenis: r.jenis, jalan: r.jalan,
                                   kel: r.kel, kec: r.kec, prio: r.prio, baru: true };
    });
    if (Object.keys(out).length) localStorage.setItem(LSK.draft, JSON.stringify(out));
    else localStorage.removeItem(LSK.draft);
  } catch (e) { /* kuota penuh — abaikan, server tetap sumber kebenaran */ }
}

function restoreDrafts(){
  let raw;
  try { raw = localStorage.getItem(LSK.draft); } catch (e) { return 0; }
  if (!raw) return 0;
  let d; try { d = JSON.parse(raw); } catch (e) { return 0; }

  let n = 0, adaBaru = false;
  Object.keys(d).forEach(id => {
    let i = data.findIndex(x => x.id === id);
    if (i < 0) {
      if (!d[id].meta) return;                 /* bukan titik tambahan — lewati */
      buatTitik(id, d[id].meta, d[id].rlat, d[id].rlon, []);
      i = data.length - 1;
      adaBaru = true;
    }
    const r = data[i];
    r.povs = (d[id].povs || []).map(povIn);
    r.rlat = d[id].rlat; r.rlon = d[id].rlon; r.ed = d[id].ed;
    r.del  = d[id].del === true;
    recalc(r); syncFiltered(r);
    SYNC.queue[id] = true;
    n++;
  });
  if (adaBaru) buildFilters();
  return n;
}

/* ───────────── tampilan status & kehadiran ───────────── */

function setSync(state, msg){
  const d = $('syncdot');
  d.className = state;
  $('syncmsg').innerHTML = msg;
}

function setSyncIdle(){
  if (SYNC.usang) return;          /* jangan timpa peringatan versi baru */
  const n = queueIds().length;
  if (n) { setSync('busy', `${n} perubahan menunggu dikirim…`); return; }
  const t = SYNC.lastOk ? new Date(SYNC.lastOk) : new Date();
  const hh = String(t.getHours()).padStart(2, '0'), mm = String(t.getMinutes()).padStart(2, '0');
  setSync('ok', `Tersimpan di server &middot; <b>${hh}:${mm}</b>`);
}

function renderPeers(){
  const box = $('peers');
  const others = SYNC.peers.filter(p => p.editor !== SYNC.name);
  if (!others.length) { box.innerHTML = '<span class="peer">hanya Anda</span>'; return; }
  box.innerHTML = others.map(p =>
    `<span class="peer${p.titik ? ' busy' : ''}">${esc(p.editor)}` +
    (p.titik ? `<span class="on"> &rarr; ${esc(p.titik)}</span>` : '') + `</span>`
  ).join('');
}

/* siapa memegang titik ini (selain saya) */
function lockOf(id){
  const p = SYNC.peers.find(x => x.titik === id && x.editor !== SYNC.name);
  return p ? p.editor : null;
}

function injectLockWarn(){
  const ed = $('editor');
  ['delwarn', 'lockwarn'].forEach(id => {
    const w = document.createElement('div');
    w.id = id; w.hidden = true;
    ed.insertBefore(w, ed.firstChild);
  });
}

function refreshLockWarn(){
  const w = $('lockwarn');
  if (!w) return;
  const who = selectedId ? lockOf(selectedId) : null;
  if (!who || !editMode) { w.hidden = true; return; }
  w.hidden = false;
  w.innerHTML = `<span class="grow">Titik ini sedang dibuka <b>${esc(who)}</b>. ` +
                `Anda tetap bisa mengedit, tapi yang mengirim lebih dulu yang menang.</span>`;
}

/* ───────────── muat ulang dari server ───────────── */

function reloadFromServer(){
  if (!resetArm) {
    resetArm = true;
    $('btnResetAll').textContent = 'Buang perubahan lokal?';
    setTimeout(() => { resetArm = false; $('btnResetAll').textContent = 'Muat ulang dari server'; }, 4000);
    return;
  }
  resetArm = false;
  $('btnResetAll').textContent = 'Muat ulang dari server';

  Object.keys(SYNC.queue).forEach(k => delete SYNC.queue[k]);
  try { localStorage.removeItem(LSK.draft); } catch (e) {}

  data = JSON.parse(JSON.stringify(ORIG));
  shown.forEach(id => { if (layers[id]) map.removeLayer(layers[id]); });
  Object.keys(layers).forEach(k => delete layers[k]);
  Object.keys(refs).forEach(k => delete refs[k]);
  shown = []; undoStack = []; dirty = false; SYNC.rev = 0;
  SYNC.base = Object.create(null);

  render(); renderEditor(); updateChg();
  toast('Memuat ulang dari server…');
  firstSync();
}

/* ───────────── kaitan ke fungsi editor bawaan ─────────────
   Dibungkus, bukan diubah — supaya kode mockup tetap utuh
   dan mudah dipasang ulang kalau mockup direvisi lagi.        */

const _afterEdit = afterEdit;
afterEdit = function (r) { _afterEdit(r); markSync(r); };

const _undo = undo;
undo = function () {
  const top = undoStack.length ? undoStack[undoStack.length - 1].id : null;
  _undo();
  if (top) markSync(byId(top));
};

const _resetRec = resetRec;
resetRec = function () {
  const id = selectedId;
  _resetRec();
  if (id) { const r = byId(id); if (r) { r.ed = false; markSync(r); } }
};

const _renderEditor = renderEditor;
renderEditor = function () { _renderEditor(); syncDelUI(); };

const _selectRec = selectRec;
selectRec = function (id, zoom, fromDrag) {
  _hapusArm = false;
  _selectRec(id, zoom, fromDrag);
  refreshLockWarn();
  if (SYNC.live && editMode && id !== SYNC.claimed) pollNow();
};

const _setEditMode = setEditMode;
setEditMode = function (on) {
  _setEditMode(on);
  refreshLockWarn();
  if (SYNC.live) pollNow();
};

const _cardHTML = cardHTML;
cardHTML = function (r) {
  const html  = _cardHTML(r);
  const who   = lockOf(r.id);
  const extra =
    (who ? `<span class="tag t-lock">&#128274; ${esc(who)}</span>` : '') +
    (SYNC.queue[r.id] ? '<span class="tag t-sync">mengirim…</span>' :
      (r.by && r.by !== SYNC.name ? `<span class="tag t-sync">${esc(r.by)}</span>` : ''));
  if (!extra) return html;
  /* sisipkan tepat sebelum penutup <div class="tags"> yang terakhir */
  const i = html.lastIndexOf('</div>');
  return i < 0 ? html + extra : html.slice(0, i) + extra + html.slice(i);
};

/* ───────────── versi aplikasi ─────────────
   Kalau server sudah memakai protokol lebih baru, tab ini usang.
   Ia tetap boleh menyelesaikan yang belum terkirim, lalu memuat ulang
   sendiri begitu aman — tidak ada pekerjaan yang hilang.            */

function cekVersi(res){
  if (!res || !res.ver) return;
  SYNC.serverVer = res.ver;
  /* Hanya server yang LEBIH BARU yang boleh memicu muat ulang. Kalau
     dibandingkan dengan `!==`, halaman yang terbit lebih dulu daripada
     backend-nya akan memuat ulang berulang-ulang selama jeda penerbitan —
     GitHub Pages masih menyajikan versi lama sampai ±10 menit. */
  if (res.ver <= APP_VERSION || SYNC.usang) return;
  SYNC.usang = true;
  setSync('off', 'Versi baru tersedia — halaman akan dimuat ulang sendiri');
  const coba = () => {
    if (queueIds().length || editMode || addMode) { setTimeout(coba, 5000); return; }
    location.reload();
  };
  setTimeout(coba, 4000);
}

/* ───────────── hapus & pulihkan titik ─────────────
   Menghapus TIDAK membuang hasil kerja: POV tetap tersimpan di server,
   titiknya hanya ditandai terhapus. Memulihkan mengembalikannya utuh. */

let _hapusArm = false;

function syncDelUI(){
  const b = $('eDel'), w = $('delwarn');
  if (!b || !w) return;
  const r = selectedId ? byId(selectedId) : null;
  if (!r || !editMode) { w.hidden = true; return; }

  if (r.del) {
    b.textContent = 'Pulihkan titik';
    b.className = 'btn xs pri';
    w.hidden = false;
    w.innerHTML = `<span class="grow">Titik ini <b>ditandai terhapus</b>` +
      (r.by ? ` oleh ${esc(r.by)}` : '') +
      `. ${r.povs.length} POV-nya tetap tersimpan dan akan kembali utuh bila dipulihkan.</span>`;
  } else {
    b.textContent = _hapusArm ? 'Yakin hapus?' : 'Hapus titik';
    b.className = 'btn xs danger';
    w.hidden = true;
  }
}

function toggleHapus(){
  const r = selectedId ? byId(selectedId) : null;
  if (!r) return;

  if (r.del) {                       /* pulihkan */
    _hapusArm = false;
    snapshot(r);
    r.del = false;
    r.ed  = r.povs.some(p => p.st) || undefined;
    recalc(r); syncFiltered(r);
    markSync(r);
    rebuild(r.id); drawOverview(); render(); renderEditor();
    toast(`${r.id} dipulihkan — ${r.povs.length} POV kembali`);
    return;
  }

  if (!_hapusArm) {                  /* klik pertama: minta konfirmasi */
    _hapusArm = true; syncDelUI();
    setTimeout(() => { if (_hapusArm) { _hapusArm = false; syncDelUI(); } }, 4000);
    return;
  }

  _hapusArm = false;
  snapshot(r);
  r.del = true;
  syncFiltered(r);
  markSync(r);

  const id = r.id, n = r.povs.length;
  if (layers[id]) { map.removeLayer(layers[id]); delete layers[id]; delete refs[id]; }
  shown = shown.filter(x => x !== id);
  selectedId = null;
  render(); renderEditor();
  toast(`${id} dihapus — ${n} POV tetap tersimpan, bisa dipulihkan lewat filter "Terhapus"`);
}

function jumlahTerhapus(){ return data.reduce((a, r) => a + (r.del ? 1 : 0), 0); }

/* ───────────── event tambahan ───────────── */

$('eDel').onclick = toggleHapus;
$('gateGo').onclick = gateSubmit;
['gateName', 'gateCode'].forEach(id =>
  $(id).addEventListener('keydown', e => { if (e.key === 'Enter') gateSubmit(); }));

/* Tombol ini duduk di bilah atas, kecil, dan bersebelahan dengan daftar
   rekan — sekali tersenggol (apalagi di layar sentuh) gerbang login dulu
   langsung menutupi layar di tengah mengedit. Sekarang harus disengaja,
   dan ditolak selama masih ada perubahan yang belum terkirim.          */
let _keluarArm = false;
function resetKeluar(){ _keluarArm = false; $('btnKeluar').textContent = 'ganti nama'; }

$('btnKeluar').onclick = () => {
  const n = queueIds().length;
  if (n) {
    toast(`${n} perubahan belum terkirim — tunggu tersimpan dulu sebelum ganti nama`);
    return;
  }
  if (!_keluarArm) {
    _keluarArm = true;
    $('btnKeluar').textContent = 'yakin ganti nama?';
    setTimeout(() => { if (_keluarArm) resetKeluar(); }, 4000);
    return;
  }
  resetKeluar();
  stopPolling(); SYNC.live = false;
  openGate('Masuk lagi dengan nama yang lain.');
};

/* Kirim sisa antrean sebelum tab ditutup. */
window.addEventListener('beforeunload', e => {
  if (queueIds().length) { saveDrafts(); e.preventDefault(); e.returnValue = ''; }
});

/* Begitu tab kembali aktif, tarik perubahan segera. */
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && SYNC.live) pollNow();
});

boot();
