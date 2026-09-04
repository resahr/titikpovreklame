/**
 * Pengosongan massal POV, lengkap dengan cadangan dan jalan pulang.
 *
 *   node alat/kosongkan-pov.js --lihat                    lihat sasaran, tidak mengirim apa pun
 *   node alat/kosongkan-pov.js --kerjakan                 kosongkan (cadangan dibuat otomatis)
 *   node alat/kosongkan-pov.js --pulihkan <berkas>        kembalikan persis seperti sebelum dikosongkan
 *
 * Pilihan sasaran:
 *   --jenis Koridor,Pedestrian   jenis yang dikerjakan (bawaan: Koridor)
 *   --hanya-perlu-dicek          batasi ke titik yang punya POV > 250 m saja
 *
 * Kenapa aman dijalankan saat tim sedang bekerja: setiap titik dikirim dengan
 * baseRev miliknya. Kalau ada rekan menyentuh titik yang sama lebih dulu,
 * server MENOLAK (alasan "basi") dan tidak menimpa apa pun — bukan menang paksa.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const API  = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).api_url;
const KODE = process.env.POV_KODE || 'A9LY-29QX';
const NAMA = 'Biosphere Plus (hapus massal)';   /* maksimal 40 karakter; muncul di sheet log */
const FLAG = 250;                               /* sama dengan FLAG di index.html */

function ambilNilai(bendera, bawaan) {
  const i = process.argv.indexOf(bendera);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : bawaan;
}
const JENIS = ambilNilai('--jenis', 'Koridor').split(',').map(s => s.trim()).filter(Boolean);
const HANYA_PERLU_DICEK = process.argv.includes('--hanya-perlu-dicek');

const dist = (a, b, c, d) => {
  const R = 6371008.8, t = Math.PI / 180, p1 = a * t, p2 = c * t, dp = (c - a) * t, dl = (d - b) * t;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};

/* Apps Script kadang menjawab kosong sesaat — dicoba ulang, bukan dianggap gagal.
   POST ke /exec selalu berakhir 405 (Google mengalihkan ke alamat khusus GET),
   jadi dari terminal harus lewat GET ?payload=… */
async function call(op, extra = {}) {
  const payload = JSON.stringify(Object.assign({ op, code: KODE, name: NAMA }, extra));
  let akhir;
  for (let i = 1; i <= 5; i++) {
    try {
      const r = await fetch(API + '?payload=' + encodeURIComponent(payload));
      const t = await r.text();
      if (!t.trim()) throw new Error('jawaban kosong (HTTP ' + r.status + ')');
      const j = JSON.parse(t);
      if (j.busy) throw new Error('server sibuk');
      if (!j.ok) throw new Error(j.error || 'ditolak server');
      return j;
    } catch (e) { akhir = e; if (i < 5) await new Promise(s => setTimeout(s, 1500 * i)); }
  }
  throw akhir;
}

/** Data dasar + editan server = keadaan yang benar-benar dilihat pemakai. */
function keadaan(base, changes) {
  const m = {};
  base.forEach(r => m[r.id] = { ...r, povs: r.povs.map(p => ({ lat: p[0], lon: p[1], st: null })),
                                del: false, rev: 0 });
  changes.forEach(c => {
    const r = m[c.id]; if (!r) return;
    r.rev = c.rev;
    if (c.state === 'orig') {                       /* sudah dikembalikan ke data survei */
      const o = base.find(b => b.id === c.id);
      r.povs = o.povs.map(p => ({ lat: p[0], lon: p[1], st: null }));
      r.rlat = o.rlat; r.rlon = o.rlon; r.del = false; return;
    }
    r.del  = c.state === 'hapus';
    r.povs = (c.povs || []).map(p => ({ lat: p[0], lon: p[1],
                                        st: p[2] === 2 ? 'baru' : (p[2] === 1 ? 'ubah' : null) }));
    if (c.rlat != null) r.rlat = c.rlat;
    if (c.rlon != null) r.rlon = c.rlon;
  });
  const all = Object.values(m);
  all.forEach(r => {
    r.povs.forEach(p => p.d = +dist(r.rlat, r.rlon, p.lat, p.lon).toFixed(1));
    r.fl = r.povs.filter(p => p.d > FLAG).length;
  });
  return all;
}

async function kirim(items, label) {
  let ok = 0; const tolak = [];
  for (let i = 0; i < items.length; i += 12) {
    const res = await call('push', { items: items.slice(i, i + 12) });
    ok += res.accepted.length;
    (res.conflicts || []).forEach(c => tolak.push(c));
    console.log(`  batch ${Math.floor(i / 12) + 1}: ${res.accepted.length} diterima, ${(res.conflicts || []).length} ditolak`);
  }
  console.log(`\n${label}: ${ok} titik berhasil, ${tolak.length} ditolak`);
  tolak.forEach(c => console.log(`   ditolak ${c.id} — ${c.alasan}` +
    (c.alasan === 'basi' ? ' (ada rekan mengubahnya lebih dulu; jalankan ulang bila perlu)' : '')));
  return { ok, tolak };
}

(async () => {
  const arg = process.argv.slice(2);
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/titik.json'), 'utf8'));

  /* ── memulihkan dari cadangan ─────────────────────────────────────────── */
  if (arg[0] === '--pulihkan') {
    const f = arg[1];
    if (!f) { console.error('sebutkan berkas cadangannya, misal: --pulihkan cadangan/cadangan-koridor-....json'); process.exit(1); }
    const cad = JSON.parse(fs.readFileSync(path.isAbsolute(f) ? f : path.join(ROOT, f), 'utf8'));
    const live = await call('pull', { since: 0 });
    const srv = {}; live.changes.forEach(c => srv[c.id] = c);
    console.log(`memulihkan ${cad.titik.length} titik (${cad.titik.reduce((a, t) => a + t.povs.length, 0)} POV) dari cadangan ${cad.dibuat}`);
    await kirim(cad.titik.map(t => ({
      id: t.id, baseRev: srv[t.id] ? srv[t.id].rev : 0, state: 'edit',
      povs: t.povs, rlat: t.rlat, rlon: t.rlon })), 'pemulihan');
    return;
  }

  /* ── melihat / mengerjakan ────────────────────────────────────────────── */
  const kerjakan = arg.includes('--kerjakan');
  const live = await call('pull', { since: 0 });
  const all = keadaan(base, live.changes);
  const sasaran = all.filter(r => JENIS.includes(r.jenis) && !r.del && r.povs.length &&
                                  (!HANYA_PERLU_DICEK || r.fl > 0));

  console.log(`jenis sasaran: ${JENIS.join(', ')}` +
              (HANYA_PERLU_DICEK ? ' · hanya yang punya POV > ' + FLAG + ' m' : ' · SELURUH POV'));
  console.log(`rev server ${live.rev} · ${live.changes.length} baris editan`);
  console.log(`sasaran: ${sasaran.length} titik, ${sasaran.reduce((a, r) => a + r.povs.length, 0)} POV akan dikosongkan`);
  if (!sasaran.length) { console.log('tidak ada yang perlu dikerjakan.'); return; }

  /* Cadangan dibuat SEBELUM apa pun dikirim — cukup untuk memulihkan persis. */
  const nama = `cadangan-${JENIS.join('-').toLowerCase()}-${new Date().toISOString().slice(0, 19).replace(/[:T-]/g, '')}.json`;
  const tujuan = path.join(ROOT, 'cadangan', nama);
  fs.mkdirSync(path.dirname(tujuan), { recursive: true });
  fs.writeFileSync(tujuan, JSON.stringify({
    dibuat: new Date().toISOString(), revServer: live.rev,
    alasan: `sebelum pengosongan massal POV — jenis ${JENIS.join('+')}` +
            (HANYA_PERLU_DICEK ? ' (hanya yang perlu dicek)' : ' (seluruh POV)'),
    titik: sasaran.map(r => ({
      id: r.id, rev: r.rev, rlat: r.rlat, rlon: r.rlon,
      povs: r.povs.map(p => [p.lat, p.lon, p.st === 'baru' ? 2 : (p.st === 'ubah' ? 1 : 0)]),
      jarak: r.povs.map(p => p.d) }))
  }, null, 1));
  console.log('cadangan -> cadangan/' + nama);

  if (!kerjakan) { console.log('\n(--lihat saja; tambahkan --kerjakan untuk benar-benar mengosongkan)'); return; }
  await kirim(sasaran.map(r => ({
    id: r.id, baseRev: r.rev, state: 'edit', povs: [], rlat: r.rlat, rlon: r.rlon })), 'pengosongan');
})().catch(e => { console.error('GAGAL: ' + e.message); process.exit(1); });
