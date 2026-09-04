/**
 * Ekspor PDF — satu halaman per titik, mengikuti filter di layar.
 *
 * Uji ini memakai jaringan sungguhan (pustaka jsPDF dari cdnjs, ubin satelit
 * Google, foto di Google Drive), jadi jalannya lebih lambat dari uji lain.
 *
 *   node --experimental-websocket tests/pdf.test.js
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
const MOCK_PORT = 8961, PORT = 8861, CDP_PORT = 9453;
const TITIK = 'ANL-BAJ-BKA-KOR-022';        /* 6 POV, beberapa foto survei */

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
    wait: async (x, l, t = 180000) => {
      const s = Date.now();
      while (Date.now() - s < t) { try { if (await ev(x)) return true; } catch (e) {} await sleep(400); }
      throw new Error('waktu habis: ' + (l || x));
    } };
}

/* Menyaring lewat kotak pencarian sungguhan, bukan menyetel `filtered` langsung. */
const cari = (t, q) => t.ev(`(()=>{const s=document.getElementById('fSearch');
  s.value=${JSON.stringify(q)}; s.dispatchEvent(new Event('input'));
  applyFilters(); return filtered.length})()`);

(async () => {
  const mock = await startMock(MOCK_PORT);
  const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  fs.writeFileSync(path.join(ROOT, 'index.test.html'),
    src.replace(/https:\/\/script\.google\.com\/macros\/s\/[^'"]*/, `http://localhost:${MOCK_PORT}`));
  const srv = await serveStatic(PORT);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-'));
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
  await A.ev(`document.getElementById('gateName').value='Rikrik';
              document.getElementById('gateCode').value=${JSON.stringify(mock.code)};
              gateSubmit(); true`);
  await A.wait('SYNC.siap===true', 'sinkron pertama selesai');

  console.log('\ntombolnya ada dan menunggu data siap');
  ok(await A.ev('!!document.getElementById("btnPDF")'), 'tombol Simpan PDF ada');

  console.log('\nbahan mentah: mini-peta dan foto benar-benar bisa diambil');
  const peta = await A.ev(`(async()=>{const r=byId(${JSON.stringify(TITIK)});
    const d=await petaMini(r,552,372); return d?d.slice(0,22)+'|'+d.length:'null'})()`);
  ok(/^data:image\/jpeg/.test(peta), 'mini-peta jadi JPEG (' + peta.split('|')[1] + ' byte)');
  ok(Number(peta.split('|')[1]) > 20000, 'ukurannya wajar — ubin satelit benar-benar tergambar');

  const foto = await A.ev(`(async()=>{await muatAtribut();
    const a=ATRIBUT.peta[${JSON.stringify(TITIK)}];
    const i=ATRIBUT.cols.indexOf('VISIBILITA');
    const img=await muatGambar(String(a[i]).trim()+'=s400',25000);
    return img?img.naturalWidth+'x'+img.naturalHeight:'gagal'})()`);
  /* Google sesekali membatasi laju permintaan; ini keterangan, bukan syarat
     lulus, supaya uji tidak gagal karena hal di luar kendali kode. */
  console.log('  · foto survei lintas-domain: ' +
    (/^\d+x\d+$/.test(foto) ? foto : 'GAGAL (kemungkinan dibatasi laju oleh Google)'));

  console.log('\nsatu kegagalan sesaat dicoba ulang, bukan langsung menyerah');
  const ulang = await A.ev(`(async()=>{
    const asli = window.Image; let n = 0;
    window.Image = function(){ n++; return new asli(); };
    /* URL yang pasti gagal, supaya jumlah percobaannya terhitung pasti. */
    const img = await muatGambar('https://lh3.googleusercontent.com/d/TIDAK-ADA-SAMA-SEKALI=s400', 4000);
    window.Image = asli;
    return (img ? 'berhasil' : 'menyerah') + ' setelah ' + n + ' percobaan';
  })()`);
  ok(ulang === 'menyerah setelah 2 percobaan',
     'dicoba dua kali sebelum menyerah: ' + ulang);

  console.log('\nPDF mengikuti filter di layar');
  ok(await cari(A, TITIK) === 1, 'filter dipersempit ke satu titik');

  /* save() dicegat supaya berkasnya tidak benar-benar diunduh saat pengujian. */
  await A.ev(`(async()=>{const J=await muatJsPDF();
    window.__hasil=null;
    const sadap=function(nama){ window.__hasil={
      nama, halaman:this.getNumberOfPages(),
      byte:this.output('arraybuffer').byteLength }; return this; };
    /* jsPDF menyalin metode dari jsPDF.API ke tiap objek saat dibuat,
       jadi menyadap prototype saja tidak akan pernah terpakai. */
    if (J.API) J.API.save = sadap;
    J.prototype.save = sadap;
    return true})()`);

  await A.ev('exportPDF(); true');
  try { await A.wait('window.__hasil!==null', 'PDF selesai dibuat', 120000); }
  catch (e) { throw new Error(e.message + ' | galat di halaman: ' +
    (await A.ev('window.__pdfGalat || "(tidak ada)"')) +
    ' | toast: ' + (await A.ev('document.getElementById("toast").textContent'))); }
  const h1 = await A.ev('JSON.stringify(window.__hasil)').then(JSON.parse);
  ok(h1.halaman === 1, `satu titik -> ${h1.halaman} halaman`);
  ok(/^POV_reklame_.*\.pdf$/.test(h1.nama), 'nama berkas: ' + h1.nama);
  ok(h1.byte > 25000, `berisi gambar mini-peta (${Math.round(h1.byte / 1024)} KB)`);
  ok(await A.ev('document.getElementById("pdfbox")===null'), 'panel kemajuan ditutup lagi');

  console.log('\nfilter lebih luas -> lebih banyak halaman');
  const n = await cari(A, 'ANL-BAJ-DKU-KOR-03');
  ok(n === 2, `filter mencakup ${n} titik`);
  await A.ev('window.__hasil=null; exportPDF(); true');
  await A.wait('window.__hasil!==null', 'PDF kedua selesai', 300000);
  const h2 = await A.ev('JSON.stringify(window.__hasil)').then(JSON.parse);
  ok(h2.halaman === n, `${n} titik -> ${h2.halaman} halaman (satu halaman satu titik)`);
  ok(h2.byte > h1.byte, 'berkasnya lebih besar dari yang satu halaman');

  console.log('\ntitik terhapus tidak ikut tercetak');
  await cari(A, TITIK);
  await A.ev(`(()=>{setEditMode(true);selectRec(${JSON.stringify(TITIK)},false);
    toggleHapus();toggleHapus();return true})()`);
  await A.wait(`byId(${JSON.stringify(TITIK)}).del===true`, 'ditandai terhapus');
  await A.ev('window.__hasil=null; exportPDF(); true');
  await sleep(2500);
  ok(await A.ev('window.__hasil===null'), 'tidak ada PDF dibuat — daftarnya kosong');
  ok(/tidak ada titik|longgarkan/i.test(await A.ev('document.getElementById("toast").textContent') || ''),
     'diberi tahu alasannya');
  await A.ev(`(()=>{povMode='deleted';applyFilters();selectRec(${JSON.stringify(TITIK)},false);
    toggleHapus();povMode='all';applyFilters();return true})()`);
  await A.wait(`byId(${JSON.stringify(TITIK)}).del!==true`, 'dipulihkan lagi');

  console.log('\nekspor ditahan sebelum data tim siap');
  await A.ev('SYNC.siap=false; window.__hasil=null; exportPDF(); true');
  await sleep(1200);
  ok(await A.ev('window.__hasil===null'), 'PDF tidak dibuat saat data belum lengkap');
  await A.ev('SYNC.siap=true; true');

  console.log('\ntidak menyentuh data maupun server');
  ok(await A.ev('data.length===2420'), 'jumlah titik tetap');
  ok(await A.ev('Object.keys(SYNC.queue).length===0'), 'tidak ada yang dikirim ke server');

  console.log(`\n${pass} lulus, ${fail} gagal\n`);
  A.ws.close(); bersih();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nGAGAL: ' + e.message + '\n'); process.exit(1); });
