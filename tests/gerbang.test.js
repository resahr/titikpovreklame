/**
 * Gerbang login TIDAK BOLEH merebut layar orang yang sedang mengedit.
 *
 * Dua pemicu nyata yang dulu melakukannya:
 *   1. satu jawaban BAD_CODE dari server — diperiksa di SETIAP polling
 *   2. tombol "ganti nama" di bilah atas — sekali sentuh, tanpa konfirmasi
 *
 *   node --experimental-websocket tests/gerbang.test.js
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
const MOCK_PORT = 8921, PORT = 8821, CDP_PORT = 9449;

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
    } };
}

const gateTampil = 'document.getElementById("gate").hidden===false';

(async () => {
  const mock = await startMock(MOCK_PORT);
  const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  fs.writeFileSync(path.join(ROOT, 'index.test.html'),
    src.replace(/https:\/\/script\.google\.com\/macros\/s\/[^'"]*/, `http://localhost:${MOCK_PORT}`));
  const srv = await serveStatic(PORT);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gerbang-'));
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
  await A.wait('typeof data!=="undefined"&&data.length===2420', 'data termuat');
  await A.ev(`document.getElementById('gateName').value='Rikrik';
              document.getElementById('gateCode').value=${JSON.stringify(mock.code)};
              gateSubmit(); true`);
  await A.wait('SYNC.live===true', 'masuk');

  /* Polling dimatikan supaya jumlah penolakan bisa dihitung persis. */
  await A.ev('stopPolling(); true');

  console.log('\nsedang mengedit sebuah titik, lalu server menolak kodenya');
  const T = await A.ev('data.find(r=>r.povs.length>0).id');
  await A.ev(`(()=>{setEditMode(true);selectRec(${JSON.stringify(T)},false);
    const r=byId(${JSON.stringify(T)});snapshot(r);
    r.povs[0].lat=+(r.povs[0].lat+0.001).toFixed(6);r.povs[0].st='ubah';r.ed=true;
    rebuild(r.id);afterEdit(r);return true})()`);
  await A.wait('Object.keys(SYNC.queue).length===0', 'editan pertama tersimpan');
  const latEdit = await A.ev(`byId(${JSON.stringify(T)}).povs[0].lat`);

  mock.sandbox.gantiKodeAkses('KODE-BARU-XYZ');       /* kode di perangkat jadi basi */

  console.log('\npenolakan ke-1 dan ke-2 — dianggap gangguan, layar tidak direbut');
  for (let i = 1; i <= 2; i++) {
    await A.ev(`api('pull',{since:0}).then(()=>true).catch(()=>true)`);
    ok(!(await A.ev(gateTampil)), `penolakan ke-${i}: gerbang TIDAK muncul`);
  }
  ok(await A.ev('SYNC.badCode===2'), 'penolakan beruntun dihitung (2)');
  ok(await A.ev('SYNC.live===true'), 'sesi masih hidup, masih bisa mengedit');

  console.log('\npenolakan ke-3 — menyerah, tapi tetap tidak merebut layar');
  await A.ev(`api('pull',{since:0}).then(()=>true).catch(()=>true)`);
  ok(!(await A.ev(gateTampil)), 'gerbang TETAP tidak muncul sendiri');
  ok(await A.ev('document.getElementById("authwarn") && !document.getElementById("authwarn").hidden'),
     'yang muncul hanya bilah tipis di atas');
  ok(!(await A.ev('SYNC.live')), 'sinkron dihentikan (luring)');

  console.log('\nhasil kerja tidak hilang saat luring');
  await A.ev(`(()=>{const r=byId(${JSON.stringify(T)});snapshot(r);
    r.povs[0].lon=+(r.povs[0].lon+0.002).toFixed(6);r.povs[0].st='ubah';r.ed=true;
    rebuild(r.id);afterEdit(r);return true})()`);
  await sleep(2000);
  const lonLuring = await A.ev(`byId(${JSON.stringify(T)}).povs[0].lon`);
  ok(await A.ev(`Object.keys(SYNC.queue).indexOf(${JSON.stringify(T)})>=0`),
     'editan luring tetap masuk antrean kirim');
  ok(await A.ev(`(()=>{const d=JSON.parse(localStorage.getItem('pov_draf')||'{}');
                 return !!d[${JSON.stringify(T)}]})()`), 'editan luring tersimpan sebagai draf lokal');
  ok(Math.abs(await A.ev(`byId(${JSON.stringify(T)}).povs[0].lat`) - latEdit) < 1e-9,
     'editan sebelumnya masih utuh di layar');

  console.log('\ngerbang baru terbuka kalau PEMAKAI yang menekan tombolnya');
  await A.ev('document.getElementById("authGo").click(); true');
  ok(await A.ev(gateTampil), 'ditekan sengaja -> gerbang terbuka');

  console.log('\nmasuk dengan kode baru, editan luring ikut terkirim');
  await A.ev(`document.getElementById('gateName').value='Rikrik';
              document.getElementById('gateCode').value='KODE-BARU-XYZ';
              gateSubmit(); true`);
  await A.wait('SYNC.live===true', 'masuk lagi');
  ok(!(await A.ev(gateTampil)), 'gerbang tertutup');
  ok(await A.ev('document.getElementById("authwarn").hidden'), 'bilah peringatan ikut hilang');
  ok(await A.ev('SYNC.badCode===0'), 'hitungan penolakan disetel ulang');
  await A.wait('Object.keys(SYNC.queue).length===0', 'draf luring terkirim');
  const srvLon = await A.ev(`(async()=>{const r=await api('pull',{since:0});
    const c=(r.changes||[]).find(x=>x.id===${JSON.stringify(T)});
    return c&&c.povs&&c.povs[0]?c.povs[0][1]:null})()`);
  ok(srvLon !== null && Math.abs(srvLon - lonLuring) < 1e-9,
     'editan yang dibuat saat luring sampai ke server');

  console.log('\ntombol "ganti nama" tidak boleh sekali sentuh');
  await A.ev('stopPolling(); true');
  ok(await A.ev(`(()=>{document.getElementById('btnKeluar').click();
      return document.getElementById('gate').hidden})()`), 'sentuhan pertama tidak membuka gerbang');
  ok(await A.ev(`document.getElementById('btnKeluar').textContent==='yakin ganti nama?'`),
     'tombolnya minta konfirmasi dulu');
  await A.ev('document.getElementById("btnKeluar").click(); true');
  ok(await A.ev(gateTampil), 'sentuhan kedua baru membuka gerbang');
  await A.ev(`document.getElementById('gateName').value='Rikrik';
              document.getElementById('gateCode').value='KODE-BARU-XYZ'; gateSubmit(); true`);
  await A.wait('SYNC.live===true', 'masuk lagi');

  console.log('\nkonfirmasi mereda sendiri kalau tidak jadi');
  await A.ev('document.getElementById("btnKeluar").click(); true');
  await sleep(4500);
  ok(await A.ev(`document.getElementById('btnKeluar').textContent==='ganti nama'`),
     'kembali normal setelah 4 detik didiamkan');
  ok(!(await A.ev(gateTampil)), 'gerbang tetap tertutup');

  console.log('\nganti nama ditolak selama masih ada yang belum terkirim');
  await A.ev('stopPolling(); true');
  await A.ev(`(()=>{const r=byId(${JSON.stringify(T)});snapshot(r);
    r.povs[0].lat=+(r.povs[0].lat+0.003).toFixed(6);r.ed=true;
    SYNC.queue[r.id]=true;return true})()`);
  await A.ev('document.getElementById("btnKeluar").click(); true');
  await A.ev('document.getElementById("btnKeluar").click(); true');
  ok(!(await A.ev(gateTampil)), 'dua kali sentuh pun ditolak, pekerjaan didahulukan');

  console.log(`\n${pass} lulus, ${fail} gagal\n`);
  A.ws.close(); bersih();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nGAGAL: ' + e.message + '\n'); process.exit(1); });
