/**
 * Pilihan peta dasar: satelit / satelit+label / peta jalan.
 *
 *   node --experimental-websocket tests/peta.test.js
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
const MOCK_PORT = 8951, PORT = 8851, CDP_PORT = 9452;

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
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  };
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
    muatUlang: async function () {
      await ev('location.reload()').catch(() => {});
      await sleep(1300);
      await this.wait('typeof data!=="undefined"&&data.length>=2420', 'data setelah muat ulang');
    } };
}

const urlAktif = 'petaDasar._url';
const tombolAktif = `(()=>{const b=document.querySelector('#petaPilih button.on');return b?b.dataset.kode:null})()`;

(async () => {
  const mock = await startMock(MOCK_PORT);
  const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  fs.writeFileSync(path.join(ROOT, 'index.test.html'),
    src.replace(/https:\/\/script\.google\.com\/macros\/s\/[^'"]*/, `http://localhost:${MOCK_PORT}`));
  const srv = await serveStatic(PORT);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'peta-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  const bersih = () => {
    try { chrome.kill(); } catch (e) {}
    try { srv.close(); mock.server.close(); } catch (e) {}
    try { fs.unlinkSync(path.join(ROOT, 'index.test.html')); } catch (e) {}
  };
  process.on('exit', bersih);
  for (let i = 0; i < 60; i++) {
    try { await fetch(`http://localhost:${CDP_PORT}/json/version`); break; } catch (e) { await sleep(250); }
  }

  const A = await tab(`http://localhost:${PORT}/index.test.html`);
  await A.wait('typeof data!=="undefined"&&data.length===2420', 'data dasar');

  console.log('\nkontrol muncul di peta');
  ok(await A.ev('!!document.getElementById("petaPilih")'), 'kotak pilihan peta ada');
  ok(await A.ev('document.querySelectorAll("#petaPilih button").length===3'), 'tiga pilihan');
  const label = await A.ev(`JSON.stringify([...document.querySelectorAll('#petaPilih button')].map(b=>b.textContent))`);
  ok(/Satelit/.test(label) && /Peta jalan/.test(label), 'labelnya: ' + label);
  ok(await A.ev(`document.querySelector('#petaPilih').closest('.leaflet-top.leaflet-right')!==null`),
     'diletakkan di kanan atas, tidak menabrak tombol zoom');

  console.log('\nbawaan tetap satelit seperti sebelumnya');
  ok(/lyrs=s&/.test(await A.ev(urlAktif)), 'ubin yang dipakai lyrs=s');
  ok(await A.ev(tombolAktif) === 's', 'tombol Satelit ditandai aktif');

  console.log('\nberganti ke peta jalan');
  await A.ev(`document.querySelector('#petaPilih button[data-kode="m"]').click(); true`);
  await sleep(400);
  ok(/lyrs=m&/.test(await A.ev(urlAktif)), 'ubin berganti ke lyrs=m (Google Maps)');
  ok(await A.ev(tombolAktif) === 'm', 'tombol Peta jalan jadi aktif');
  ok(await A.ev('document.querySelectorAll("#petaPilih button.on").length===1'), 'hanya satu yang aktif');

  console.log('\nberganti ke satelit + label');
  await A.ev(`document.querySelector('#petaPilih button[data-kode="y"]').click(); true`);
  await sleep(400);
  ok(/lyrs=y&/.test(await A.ev(urlAktif)), 'ubin berganti ke lyrs=y');

  console.log('\npilihan diingat setelah muat ulang');
  await A.muatUlang();
  ok(/lyrs=y&/.test(await A.ev(urlAktif)), 'kembali ke satelit+label sendiri');
  ok(await A.ev(tombolAktif) === 'y', 'tombolnya ikut ditandai');

  console.log('\nmenekan tombol peta tidak ikut mengklik peta di belakangnya');
  await A.ev(`document.getElementById('gateName').value='Rikrik';
              document.getElementById('gateCode').value=${JSON.stringify(mock.code)};
              gateSubmit(); true`);
  await A.wait('SYNC.live===true', 'masuk');
  await A.ev('setEditMode(true); startTambah(); true');
  ok(await A.ev('tambahMode===true'), 'mode tambah titik menyala');
  const pusat = await A.ev('JSON.stringify(map.getCenter())');
  await A.ev(`document.querySelector('#petaPilih button[data-kode="s"]').click(); true`);
  await sleep(500);
  ok(await A.ev('document.getElementById("tbox").hidden'),
     'borang tambah titik TIDAK ikut terbuka');
  ok(await A.ev('JSON.stringify(map.getCenter())') === pusat, 'peta tidak bergeser');
  ok(/lyrs=s&/.test(await A.ev(urlAktif)), 'peta dasar tetap berganti seperti seharusnya');

  console.log('\nmurni tampilan — tidak menyentuh data maupun server');
  ok(await A.ev('data.length===2420'), 'jumlah titik tidak berubah');
  ok(await A.ev('Object.keys(SYNC.queue).length===0'), 'tidak ada yang dikirim ke server');

  console.log(`\n${pass} lulus, ${fail} gagal\n`);
  A.ws.close(); bersih();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nGAGAL: ' + e.message + '\n'); process.exit(1); });
