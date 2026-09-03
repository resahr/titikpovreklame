/**
 * Uji fitur hapus titik, termasuk keamanannya saat aplikasi sedang dipakai
 * dan sebagian orang masih membuka versi lama.
 *
 *   node --experimental-websocket tests/hapus.test.js
 */
'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { spawn } = require('child_process');
const { start: startMock } = require('./mock-server');

const ROOT   = path.join(__dirname, '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MOCK_PORT = 8901, PORT_A = 8801, PORT_B = 8802, CDP_PORT = 9447;

let pass = 0, fail = 0;
const ok = (c, l) => c ? (pass++, console.log('  ✓ ' + l)) : (fail++, console.log('  ✗ ' + l));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const MIME = { '.html': 'text/html', '.json': 'application/json' };
function serveStatic(port) {
  const s = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const f = path.join(ROOT, rel);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      res.writeHead(404); return res.end('nope');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => s.listen(port, () => r(s)));
}

async function tab(url) {
  const r = await fetch(`http://localhost:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  const t = await r.json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const waiting = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
  const ev = expr => new Promise(res => {
    const n = ++id; waiting.set(n, res);
    ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate',
      params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  }).then(m => {
    if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description || 'galat');
    return m.result?.result?.value;
  });
  return { ev, ws,
    wait: async (x, l, t = 30000) => {
      const s = Date.now();
      while (Date.now() - s < t) { try { if (await ev(x)) return true; } catch (e) {} await sleep(300); }
      throw new Error('waktu habis: ' + (l || x));
    } };
}

(async () => {
  const mock = await startMock(MOCK_PORT);
  const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  fs.writeFileSync(path.join(ROOT, 'index.test.html'),
    src.replace(/https:\/\/script\.google\.com\/macros\/s\/[^'"]*/, `http://localhost:${MOCK_PORT}`));
  const sa = await serveStatic(PORT_A), sb = await serveStatic(PORT_B);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hapus-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  const bersih = () => {
    try { chrome.kill(); } catch (e) {}
    try { sa.close(); sb.close(); mock.server.close(); } catch (e) {}
    try { fs.unlinkSync(path.join(ROOT, 'index.test.html')); } catch (e) {}
  };
  process.on('exit', bersih);
  for (let i = 0; i < 60; i++) { try { await fetch(`http://localhost:${CDP_PORT}/json/version`); break; } catch (e) { await sleep(250); } }

  const A = await tab(`http://localhost:${PORT_A}/index.test.html`);
  const B = await tab(`http://localhost:${PORT_B}/index.test.html`);
  const masuk = async (t, nama) => {
    await t.wait('typeof data!=="undefined"&&data.length===2420', 'data ' + nama);
    await t.ev(`document.getElementById('gateName').value=${JSON.stringify(nama)};
                document.getElementById('gateCode').value=${JSON.stringify(mock.code)};
                gateSubmit(); true`);
    await t.wait('SYNC.live===true', 'login ' + nama);
  };
  await masuk(A, 'Rikrik'); await masuk(B, 'wahyu');

  console.log('\npersiapan — Rikrik menggarap sebuah titik lebih dulu');
  const T = await A.ev('data.find(r=>r.povs.length>=3).id');
  await A.ev(`(()=>{setEditMode(true);selectRec(${JSON.stringify(T)},false);
    const r=byId(${JSON.stringify(T)});snapshot(r);
    r.povs[0].lat=+(r.povs[0].lat+0.001).toFixed(6);r.povs[0].st='ubah';r.ed=true;
    rebuild(r.id);afterEdit(r);return true})()`);
  await A.wait('Object.keys(SYNC.queue).length===0', 'editan tersimpan');
  const nPov = await A.ev(`byId(${JSON.stringify(T)}).povs.length`);
  const latEdit = await A.ev(`byId(${JSON.stringify(T)}).povs[0].lat`);
  ok(nPov >= 3, `${T} punya ${nPov} POV dan sudah diedit`);

  console.log('\nmenghapus titik');
  await A.ev(`(()=>{selectRec(${JSON.stringify(T)},false);toggleHapus();toggleHapus();return true})()`);
  await A.wait('Object.keys(SYNC.queue).length===0', 'penghapusan terkirim');
  ok(await A.ev(`byId(${JSON.stringify(T)}).del===true`), 'ditandai terhapus di sisi Rikrik');
  ok(await A.ev(`!filtered.some(r=>r.id===${JSON.stringify(T)})`), 'hilang dari daftar & peta');
  ok(await A.ev(`byId(${JSON.stringify(T)}).povs.length===${nPov}`), 'POV-nya TIDAK ikut terbuang');

  console.log('\nrekan lain ikut melihat');
  await B.ev('pollNow();true');
  await B.wait(`byId(${JSON.stringify(T)}).del===true`, 'sampai ke wahyu');
  ok(await B.ev(`!filtered.some(r=>r.id===${JSON.stringify(T)})`), 'hilang juga dari layar wahyu');
  ok(await B.ev(`byId(${JSON.stringify(T)}).povs.length===${nPov}`), 'POV utuh di sisi wahyu');

  console.log('\nfilter "Terhapus" untuk meninjau');
  await B.ev(`povMode='deleted';applyFilters();true`);
  ok(await B.ev(`filtered.some(r=>r.id===${JSON.stringify(T)})`), 'muncul di filter Terhapus');
  ok(await B.ev('filtered.every(r=>r.del)'), 'filter itu hanya berisi yang terhapus');
  await B.ev(`povMode='all';applyFilters();true`);

  console.log('\nINTI — tab versi LAMA tidak bisa menghidupkan titik terhapus');
  // Persis yang dikirim aplikasi versi sebelumnya: simpan biasa, tanpa tahu status hapus.
  const lama = await B.ev(`(async()=>{
    const r = byId(${JSON.stringify(T)});
    return await api('push', { items: [{ id:${JSON.stringify(T)},
      baseRev: SYNC.base[${JSON.stringify(T)}] || 0, state:'edit',
      povs: r.povs.map(povOut), rlat:r.rlat, rlon:r.rlon }] });
  })()`);
  ok(lama.accepted.length === 0, 'penyimpanan gaya lama ditolak server');
  ok(lama.conflicts.length === 1 && lama.conflicts[0].alasan === 'terhapus', 'alasan: terhapus');
  await A.ev('pollNow();true'); await sleep(1500);
  ok(await A.ev(`byId(${JSON.stringify(T)}).del===true`), 'titik TETAP terhapus');

  console.log('\nekspor mengecualikan yang terhapus, tapi tetap mencatatnya');
  const eks = await A.ev(`(()=>({
    detail: barisDetail().some(b=>b[0]===${JSON.stringify(T)}),
    ringkas: barisRingkas().some(b=>b[0]===${JSON.stringify(T)}),
    dihapus: barisDihapus().find(b=>b[0]===${JSON.stringify(T)}) || null
  }))()`);
  ok(!eks.detail, 'tidak ada di sheet Detail POV');
  ok(!eks.ringkas, 'tidak ada di sheet Ringkas');
  ok(!!eks.dihapus, 'tercatat di sheet Dihapus');
  ok(eks.dihapus && eks.dihapus[5] === nPov, `sheet Dihapus mencatat ${nPov} POV tersimpan`);
  ok(eks.dihapus && eks.dihapus[7] === 'Rikrik', 'mencatat siapa yang menghapus');

  console.log('\npemulihan mengembalikan hasil kerja utuh');
  await A.ev(`(()=>{povMode='deleted';applyFilters();selectRec(${JSON.stringify(T)},false);
    toggleHapus();return true})()`);
  await A.wait('Object.keys(SYNC.queue).length===0', 'pemulihan terkirim');
  ok(await A.ev(`byId(${JSON.stringify(T)}).del!==true`), 'aktif kembali');
  ok(await A.ev(`byId(${JSON.stringify(T)}).povs.length===${nPov}`), `${nPov} POV kembali`);
  ok(Math.abs(await A.ev(`byId(${JSON.stringify(T)}).povs[0].lat`) - latEdit) < 1e-9,
     'koordinat hasil editan sebelum dihapus kembali persis');

  await B.ev('pollNow();true');
  await B.wait(`byId(${JSON.stringify(T)}).del!==true`, 'pemulihan sampai ke wahyu');
  ok(true, 'rekan melihat titiknya hidup lagi');

  console.log('\neditan orang lain tidak tersentuh sama sekali');
  const T2 = await B.ev(`data.find(r=>r.povs.length>0&&r.id!==${JSON.stringify(T)}).id`);
  await B.ev(`(()=>{setEditMode(true);selectRec(${JSON.stringify(T2)},false);
    const r=byId(${JSON.stringify(T2)});snapshot(r);
    r.povs[0].lon=+(r.povs[0].lon+0.002).toFixed(6);r.povs[0].st='ubah';r.ed=true;
    rebuild(r.id);afterEdit(r);return true})()`);
  await B.wait('Object.keys(SYNC.queue).length===0', 'editan wahyu tersimpan');
  await A.ev('pollNow();true');
  await A.wait(`byId(${JSON.stringify(T2)}).by==='wahyu'`, 'editan wahyu sampai');
  ok(true, 'menghapus satu titik tidak mengganggu titik lain yang sedang digarap');

  console.log(`\n${pass} lulus, ${fail} gagal\n`);
  A.ws.close(); B.ws.close(); bersih();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nGAGAL: ' + e.message + '\n'); process.exit(1); });
