/**
 * Uji ujung-ke-ujung edit paralel.
 *
 * Dua tab Chrome sungguhan (origin berbeda, jadi localStorage terpisah)
 * memuat aplikasi yang sudah dibangun, masuk dengan nama berbeda,
 * mengedit, lalu diperiksa apakah perubahan saling menyeberang.
 * Backend-nya apps-script/Code.gs yang sesungguhnya.
 *
 *   node --experimental-websocket tests/e2e.test.js
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
const MOCK_PORT = 8899, PORT_A = 8777, PORT_B = 8778, CDP_PORT = 9333;

let pass = 0, fail = 0;
const ok = (c, l) => c ? (pass++, console.log('  ✓ ' + l)) : (fail++, console.log('  ✗ ' + l));
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── server berkas statis ── */
const MIME = { '.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css' };
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

/* ── klien CDP seadanya ── */
async function cdpTarget(url) {
  const r = await fetch(`http://localhost:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  const t = await r.json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0; const waiting = new Map();
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  };
  const send = (method, params) => new Promise(res => {
    const n = ++id; waiting.set(n, res);
    ws.send(JSON.stringify({ id: n, method, params: params || {} }));
  });

  return {
    send, ws,
    async eval(expression) {
      const m = await send('Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true });
      if (m.result && m.result.exceptionDetails)
        throw new Error(m.result.exceptionDetails.exception?.description || 'galat di halaman');
      return m.result?.result?.value;
    },
    async waitFor(expr, label, timeoutMs = 25000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        try { if (await this.eval(expr)) return true; } catch (e) {}
        await sleep(250);
      }
      throw new Error('waktu habis menunggu: ' + (label || expr));
    },
    close() { ws.close(); }
  };
}

/* ── jalan ── */
(async () => {
  console.log('\nmenyiapkan');
  const mock = await startMock(MOCK_PORT);
  console.log('  server tiruan siap, kode akses ' + mock.code);

  // bangun salinan uji yang menunjuk ke server tiruan
  const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  if (src.indexOf('__API_URL__') < 0)
    console.log('  ! index.html sudah punya API_URL sungguhan — diganti untuk uji ini');
  fs.writeFileSync(path.join(ROOT, 'index.test.html'),
    src.replace(/__API_URL__|https:\/\/script\.google\.com\/[^'"]*/, `http://localhost:${MOCK_PORT}`));

  const sa = await serveStatic(PORT_A), sb = await serveStatic(PORT_B);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'povtest-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    'about:blank'
  ], { stdio: 'ignore' });

  const cleanup = () => {
    try { chrome.kill(); } catch (e) {}
    try { sa.close(); sb.close(); mock.server.close(); } catch (e) {}
    try { fs.unlinkSync(path.join(ROOT, 'index.test.html')); } catch (e) {}
  };
  process.on('exit', cleanup);

  // tunggu CDP siap
  for (let i = 0; i < 60; i++) {
    try { await fetch(`http://localhost:${CDP_PORT}/json/version`); break; }
    catch (e) { await sleep(250); }
  }

  const A = await cdpTarget(`http://localhost:${PORT_A}/index.test.html`);
  const B = await cdpTarget(`http://localhost:${PORT_B}/index.test.html`);
  await A.send('Runtime.enable'); await B.send('Runtime.enable');

  console.log('\nmemuat data dasar');
  await A.waitFor('typeof data!=="undefined" && data.length===2420', 'data tab A');
  await B.waitFor('typeof data!=="undefined" && data.length===2420', 'data tab B');
  ok(true, 'kedua tab memuat 2.420 titik');
  ok(await A.eval('!document.getElementById("gate").hidden'), 'gerbang masuk tampil sebelum login');

  console.log('\nmasuk dengan nama berbeda');
  const login = async (tab, nama) => {
    await tab.eval(`document.getElementById('gateName').value=${JSON.stringify(nama)};
                    document.getElementById('gateCode').value=${JSON.stringify(mock.code)};
                    gateSubmit(); true`);
    await tab.waitFor('SYNC.live===true', 'login ' + nama);
  };
  await login(A, 'Budi');
  await login(B, 'Sari');
  ok(await A.eval('document.getElementById("gate").hidden'), 'gerbang tertutup setelah masuk');
  ok(await A.eval('SYNC.name==="Budi"') && await B.eval('SYNC.name==="Sari"'), 'nama tercatat masing-masing');

  console.log('\nkode akses salah ditolak');
  const C = await cdpTarget(`http://localhost:${PORT_A}/index.test.html`);
  await C.send('Runtime.enable');
  await C.waitFor('typeof data!=="undefined" && data.length===2420', 'data tab C');
  await C.eval(`document.getElementById('gateName').value='Penyusup';
                document.getElementById('gateCode').value='SALAH-SEKALI';
                gateSubmit(); true`);
  await C.waitFor('document.getElementById("gateMsg").textContent.indexOf("Gagal masuk")===0', 'pesan tolak');
  ok(!(await C.eval('SYNC.live')), 'kode salah tidak bisa masuk');
  ok(!(await C.eval('document.getElementById("gate").hidden')), 'gerbang tetap tertutup rapat');
  C.close();

  console.log('\nBudi mengedit satu titik');
  const TID = await A.eval('data.find(r=>r.povs.length>0).id');
  const semula = await A.eval(`byId(${JSON.stringify(TID)}).povs[0].lat`);
  await A.eval(`(()=>{
    setEditMode(true); selectRec(${JSON.stringify(TID)}, false);
    const r = byId(${JSON.stringify(TID)});
    snapshot(r); r.povs[0].lat = +(r.povs[0].lat + 0.002).toFixed(6);
    r.povs[0].st = 'ubah'; r.ed = true;
    rebuild(r.id); afterEdit(r); return true; })()`);
  const baru = await A.eval(`byId(${JSON.stringify(TID)}).povs[0].lat`);
  ok(Math.abs(baru - semula - 0.002) < 1e-6, `POV digeser di tab Budi (${TID})`);

  await A.waitFor('Object.keys(SYNC.queue).length===0', 'antrean terkirim');
  ok(true, 'perubahan terkirim ke server');
  ok(await A.eval('document.getElementById("syncdot").className==="ok"'), 'indikator jadi hijau');

  console.log('\nSari menerima perubahan Budi');
  await B.eval('pollNow(); true');
  await B.waitFor(`Math.abs(byId(${JSON.stringify(TID)}).povs[0].lat - ${baru}) < 1e-9`,
                  'perubahan sampai ke Sari');
  ok(true, 'koordinat POV identik di kedua tab');
  ok(await B.eval(`byId(${JSON.stringify(TID)}).povs[0].st === 'ubah'`), 'penanda "digeser" ikut menyeberang');
  ok(await B.eval(`byId(${JSON.stringify(TID)}).by === 'Budi'`), 'Sari melihat siapa yang mengubah');

  console.log('\nkehadiran & gembok');
  await B.eval('pollNow(); true');
  await B.waitFor('SYNC.peers.some(p=>p.editor==="Budi")', 'Budi terlihat online');
  ok(await B.eval(`lockOf(${JSON.stringify(TID)}) === 'Budi'`), 'Sari melihat titik itu dipegang Budi');
  ok(await B.eval('document.getElementById("peers").textContent.indexOf("Budi")>=0'), 'nama Budi tampil di bilah');

  console.log('\ntitik BERBEDA — dua orang menyimpan tanpa bentrok');
  const T2 = await A.eval(`data.find(r=>r.povs.length>0 && r.id!==${JSON.stringify(TID)}).id`);
  await B.eval(`(()=>{
    setEditMode(true); selectRec(${JSON.stringify(T2)}, false);
    const r = byId(${JSON.stringify(T2)});
    snapshot(r); r.povs[0].lon = +(r.povs[0].lon + 0.003).toFixed(6);
    r.povs[0].st='ubah'; r.ed=true; rebuild(r.id); afterEdit(r); return true; })()`);
  await B.waitFor('Object.keys(SYNC.queue).length===0', 'editan Sari terkirim');
  await A.eval('pollNow(); true');
  await A.waitFor(`byId(${JSON.stringify(T2)}).by === 'Sari'`, 'editan Sari sampai ke Budi');
  ok(true, 'kedua editan hidup berdampingan');
  ok(await A.eval(`byId(${JSON.stringify(TID)}).by === undefined || byId(${JSON.stringify(TID)}).ed === true`),
     'editan Budi tidak tertimpa');

  console.log('\ntitik SAMA — yang basi diberi tahu, bukan ditimpa diam-diam');
  // Sari mengedit T2 lagi (rev naik). Budi memaksa kirim dengan baseRev lama.
  await B.eval(`(()=>{
    const r = byId(${JSON.stringify(T2)});
    snapshot(r); r.povs[0].lat = +(r.povs[0].lat + 0.004).toFixed(6); r.ed=true;
    afterEdit(r); return true; })()`);
  await B.waitFor('Object.keys(SYNC.queue).length===0', 'editan kedua Sari terkirim');
  const sariLat = await B.eval(`byId(${JSON.stringify(T2)}).povs[0].lat`);

  const conflict = await A.eval(`(async()=>{
    const r = byId(${JSON.stringify(T2)});
    r.povs[0].lat = 9.999999; r.ed = true;
    SYNC.base[${JSON.stringify(T2)}] = 1;           /* sengaja dibuat basi */
    SYNC.queue[${JSON.stringify(T2)}] = true;
    await pushNow();
    return byId(${JSON.stringify(T2)}).povs[0].lat;
  })()`);
  ok(Math.abs(conflict - sariLat) < 1e-9, 'Budi otomatis memakai versi Sari yang lebih baru');
  ok(conflict !== 9.999999, 'tulisan basi Budi tidak masuk ke server');
  const serverLat = await A.eval(`(async()=>{
    const res = await api('pull',{since:0});
    const c = res.changes.find(x=>x.id===${JSON.stringify(T2)});
    return c.povs[0][0];
  })()`);
  ok(Math.abs(serverLat - sariLat) < 1e-9, 'server tetap memegang versi Sari');

  console.log('\nsimpan & lanjutkan: muat ulang halaman');
  const D = await cdpTarget(`http://localhost:${PORT_A}/index.test.html`);
  await D.send('Runtime.enable');
  await D.waitFor('typeof data!=="undefined" && data.length===2420', 'data tab D');
  await D.eval(`document.getElementById('gateName').value='Budi';
                document.getElementById('gateCode').value=${JSON.stringify(mock.code)};
                gateSubmit(); true`);
  await D.waitFor('SYNC.live===true', 'login ulang');
  await D.waitFor(`byId(${JSON.stringify(TID)}).ed === true`, 'editan lama termuat');
  ok(Math.abs(await D.eval(`byId(${JSON.stringify(TID)}).povs[0].lat`) - baru) < 1e-9,
     'pekerjaan sebelumnya kembali utuh setelah tutup-buka');
  ok(Math.abs(await D.eval(`byId(${JSON.stringify(T2)}).povs[0].lat`) - sariLat) < 1e-9,
     'editan rekan juga ikut termuat');
  D.close();

  console.log('\nkembalikan satu titik ke data survei');
  await A.eval(`selectRec(${JSON.stringify(TID)}, false); resetRec(); true`);
  await A.waitFor('Object.keys(SYNC.queue).length===0', 'reset terkirim');
  await B.eval('pollNow(); true');
  await B.waitFor(`Math.abs(byId(${JSON.stringify(TID)}).povs[0].lat - ${semula}) < 1e-9`,
                  'reset sampai ke Sari');
  ok(true, 'pengembalian ke data survei menyeberang ke rekan');

  A.close(); B.close();
  console.log(`\n${pass} lulus, ${fail} gagal\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\nGAGAL: ' + e.message + '\n');
  process.exit(1);
});
