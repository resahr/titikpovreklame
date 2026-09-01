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

const POLL_MS  = 10000;   /* selang tarik perubahan dari server   */
const PUSH_MS  = 1200;    /* tunda kirim setelah berhenti mengedit */
const DRAFT_MAX = 400;    /* batas titik yang disimpan sbg draf lokal */
const LSK = { name:'pov_nama', code:'pov_kode', draft:'pov_draf' };

const SYNC = {
  name:'', code:'', rev:0, live:false,
  base:  Object.create(null),   /* id -> rev server terakhir yang kita tahu */
  queue: Object.create(null),   /* id -> true, menunggu dikirim             */
  peers: [], claimed:null,
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

  SYNC.name = name; SYNC.code = code;
  try {
    const res = await api('hello');
    if (!res.ok) throw new Error(res.error || 'ditolak');
    localStorage.setItem(LSK.name, name);
    localStorage.setItem(LSK.code, code);
    $('gate').hidden = true;
    $('meName').textContent = name;
    SYNC.live = true;
    await firstSync();
    startPolling();
  } catch (e) {
    $('gateMsg').className = '';
    $('gateMsg').textContent = 'Gagal masuk: ' + e.message;
  } finally {
    $('gateGo').disabled = false;
  }
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
  if (j && j.code === 'BAD_CODE') {
    SYNC.live = false;
    stopPolling();
    openGate('Kode akses ditolak server. Periksa lagi kodenya.');
  }
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
  const i = data.findIndex(x => x.id === ch.id);
  if (i < 0) return;
  SYNC.base[ch.id] = ch.rev;

  /* Jangan rebut titik yang sedang saya edit dan belum terkirim —
     tandai saja, biar saya yang memutuskan. */
  if (ch.id === selectedId && editMode && SYNC.queue[ch.id]) {
    toast(`${ch.editor} juga mengubah ${ch.id} — perubahan Anda menang bila dikirim lebih dulu`);
    return;
  }

  if (ch.state === 'orig') {
    data[i] = JSON.parse(JSON.stringify(origMap[ch.id]));
  } else {
    const r = data[i];
    r.povs = (ch.povs || []).map(povIn);
    if (ch.rlat != null) r.rlat = ch.rlat;
    if (ch.rlon != null) r.rlon = ch.rlon;
    r.ed = true; r.by = ch.editor; r.at = ch.updated;
  }
  recalc(data[i]); syncFiltered(data[i]);
  if (layers[ch.id]) rebuild(ch.id);
  updateCard(data[i]);
  if (ch.id === selectedId) renderEditor();
}

/* ───────────── antre & kirim ───────────── */

function markSync(r){
  if (!r || !SYNC.live) return;
  SYNC.queue[r.id] = true;
  saveDrafts();
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
    const isOrig = r.ed !== true;
    return {
      id,
      baseRev: SYNC.base[id] || 0,
      state:   isOrig ? 'orig' : 'edit',
      povs:    isOrig ? [] : r.povs.map(povOut),
      rlat:    r.rlat, rlon: r.rlon
    };
  }).filter(Boolean);

  try {
    const res = await api('push', { items });
    if (!res.ok) {
      if (res.busy) { SYNC.sending = false; setTimeout(pushNow, 2500); return; }
      throw new Error(res.error || 'gagal');
    }

    res.accepted.forEach(a => {
      SYNC.base[a.id] = a.rev;
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
      drawOverview(); updateStats(); updateFoot();
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
      if (r) out[id] = { ed: r.ed, rlat: r.rlat, rlon: r.rlon,
                         povs: r.povs.map(povOut), base: SYNC.base[id] || 0 };
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

  let n = 0;
  Object.keys(d).forEach(id => {
    const i = data.findIndex(x => x.id === id);
    if (i < 0) return;
    const r = data[i];
    r.povs = (d[id].povs || []).map(povIn);
    r.rlat = d[id].rlat; r.rlon = d[id].rlon; r.ed = d[id].ed;
    recalc(r); syncFiltered(r);
    SYNC.queue[id] = true;
    n++;
  });
  return n;
}

/* ───────────── tampilan status & kehadiran ───────────── */

function setSync(state, msg){
  const d = $('syncdot');
  d.className = state;
  $('syncmsg').innerHTML = msg;
}

function setSyncIdle(){
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
  const w = document.createElement('div');
  w.id = 'lockwarn'; w.hidden = true;
  $('editor').insertBefore(w, $('editor').firstChild);
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

const _selectRec = selectRec;
selectRec = function (id, zoom, fromDrag) {
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

/* ───────────── event tambahan ───────────── */

$('gateGo').onclick = gateSubmit;
['gateName', 'gateCode'].forEach(id =>
  $(id).addEventListener('keydown', e => { if (e.key === 'Enter') gateSubmit(); }));

$('btnKeluar').onclick = () => {
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
