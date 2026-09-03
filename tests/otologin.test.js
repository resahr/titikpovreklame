/**
 * Uji masuk otomatis: setelah sekali masuk, halaman login tidak boleh
 * muncul lagi di perangkat itu — termasuk sesudah muat ulang.
 *
 *   node --experimental-websocket tests/otologin.test.js
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
const MOCK_PORT = 8911, PORT = 8811, CDP_PORT = 9448;

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
  const t = await (await fetch(
    `http://localhost:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
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
    },
    /* Muat ulang lalu tunggu aplikasi siap lagi — meniru refresh pemakai. */
    muatUlang: async function () {
      await ev('location.reload()').catch(() => {});
      await sleep(1200);
      await this.wait('typeof data!=="undefined"&&data.length===2420', 'data setelah muat ulang');
    } };
}

(async () => {
  const mock = await startMock(MOCK_PORT);
  const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  fs.writeFileSync(path.join(ROOT, 'index.test.html'),
    src.replace(/https:\/\/script\.google\.com\/macros\/s\/[^'"]*/, `http://localhost:${MOCK_PORT}`));
  const srv = await serveStatic(PORT);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oto-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  const bersih = () => {
    try { chrome.kill(); } catch (e) {}
    try { srv.close(); mock.server.close(); } catch (e) {}
    try { fs.unlinkSync(path.join(ROOT, 'index.test.html')); } catch (e) {}
  };
  process.on('exit', bersih);
  for (let i = 0; i < 60; i++) { try { await fetch(`http://localhost:${CDP_PORT}/json/version`); break; } catch (e) { await sleep(250); } }

  const URL_UJI = `http://localhost:${PORT}/index.test.html`;
  const A = await tab(URL_UJI);

  console.log('\nkunjungan pertama — gerbang memang harus muncul');
  await A.wait('typeof data!=="undefined"&&data.length===2420', 'data termuat');
  await sleep(800);
  ok(await A.ev('!document.getElementById("gate").hidden'), 'halaman login tampil');
  ok(!(await A.ev('SYNC.live')), 'belum masuk');

  await A.ev(`document.getElementById('gateName').value='Rikrik';
              document.getElementById('gateCode').value=${JSON.stringify(mock.code)};
              gateSubmit(); true`);
  await A.wait('SYNC.live===true', 'masuk');
  ok(true, 'masuk dengan mengetik sekali');

  console.log('\nmuat ulang — halaman login TIDAK boleh muncul lagi');
  await A.muatUlang();
  await A.wait('SYNC.live===true', 'masuk sendiri setelah muat ulang');
  ok(await A.ev('document.getElementById("gate").hidden'), 'gerbang tetap tersembunyi');
  ok(await A.ev(`SYNC.name==='Rikrik'`), 'nama diingat');
  ok(await A.ev('document.getElementById("meName").textContent==="Rikrik"'), 'nama tampil di bilah');

  console.log('\nmuat ulang berkali-kali pun tetap mulus');
  for (let i = 1; i <= 3; i++) {
    await A.muatUlang();
    await A.wait('SYNC.live===true', 'masuk otomatis ke-' + i);
    if (!(await A.ev('document.getElementById("gate").hidden'))) { ok(false, 'muat ulang ke-' + i); break; }
  }
  ok(await A.ev('document.getElementById("gate").hidden'), 'tiga kali muat ulang, gerbang tidak pernah muncul');

  console.log('\ndata tim tetap termuat lewat jalur masuk otomatis');
  const T = await A.ev('data.find(r=>r.povs.length>0).id');
  await A.ev(`(()=>{setEditMode(true);selectRec(${JSON.stringify(T)},false);
    const r=byId(${JSON.stringify(T)});snapshot(r);
    r.povs[0].lat=+(r.povs[0].lat+0.001).toFixed(6);r.povs[0].st='ubah';r.ed=true;
    rebuild(r.id);afterEdit(r);return true})()`);
  await A.wait('Object.keys(SYNC.queue).length===0', 'editan tersimpan');
  const lat = await A.ev(`byId(${JSON.stringify(T)}).povs[0].lat`);
  await A.muatUlang();
  await A.wait('SYNC.live===true', 'masuk otomatis');
  ok(Math.abs(await A.ev(`byId(${JSON.stringify(T)}).povs[0].lat`) - lat) < 1e-9,
     'editan sebelum muat ulang kembali utuh');
  ok(await A.ev(`byId(${JSON.stringify(T)}).ed===true`), 'ditandai sudah diedit');

  console.log('\nkode tersimpan yang ditolak server -> gerbang muncul dengan penjelasan');
  await A.ev(`localStorage.setItem('pov_kode','KODE-NGAWUR'); true`);
  await A.muatUlang();
  await A.wait('!document.getElementById("gate").hidden', 'gerbang muncul');
  ok(!(await A.ev('SYNC.live')), 'tidak masuk dengan kode salah');
  const pesan = await A.ev('document.getElementById("gateMsg").textContent');
  ok(/tidak berlaku|Gagal|salah/i.test(pesan), 'pesannya menjelaskan: ' + JSON.stringify(pesan.slice(0, 60)));
  ok(await A.ev(`document.getElementById('gateName').value==='Rikrik'`), 'nama tetap terisi, tinggal betulkan kodenya');

  console.log('\nmasuk lagi dengan kode benar, lalu lanjut mulus');
  await A.ev(`document.getElementById('gateCode').value=${JSON.stringify(mock.code)}; gateSubmit(); true`);
  await A.wait('SYNC.live===true', 'masuk ulang');
  await A.muatUlang();
  await A.wait('SYNC.live===true', 'otomatis lagi');
  ok(await A.ev('document.getElementById("gate").hidden'), 'kembali mulus tanpa gerbang');

  console.log('\ntombol "ganti nama" tetap berfungsi');
  await A.ev('document.getElementById("btnKeluar").click(); true');
  await sleep(600);
  ok(!(await A.ev('document.getElementById("gate").hidden')), 'gerbang bisa dibuka sengaja');
  ok(!(await A.ev('SYNC.live')), 'sesi dihentikan sampai masuk lagi');

  console.log(`\n${pass} lulus, ${fail} gagal\n`);
  A.ws.close(); bersih();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nGAGAL: ' + e.message + '\n'); process.exit(1); });
