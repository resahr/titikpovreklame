/**
 * Menambah titik reklame baru — termasuk sampainya ke rekan, bertahannya
 * saat luring, dan penolakan id kembar.
 *
 *   node --experimental-websocket tests/tambah.test.js
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
const MOCK_PORT = 8931, PORT_A = 8831, PORT_B = 8832, CDP_PORT = 9450;

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
      await sleep(1400);
      await this.wait('typeof data!=="undefined"&&data.length>=2420', 'data setelah muat ulang');
    } };
}

/* Mengisi borang tambah titik lalu menekan Simpan. */
const isiBorang = (t, v) => t.ev(`(()=>{
  bukaBorang(${v.lat}, ${v.lon});
  document.getElementById('tId').value=${JSON.stringify(v.id)};
  document.getElementById('tId').dispatchEvent(new Event('input'));
  document.getElementById('tJenis').value=${JSON.stringify(v.jenis)};
  document.getElementById('tTipe').value=${JSON.stringify(v.tipe)};
  document.getElementById('tJalan').value=${JSON.stringify(v.jalan)};
  document.getElementById('tKel').value=${JSON.stringify(v.kel)};
  document.getElementById('tKec').value=${JSON.stringify(v.kec)};
  document.getElementById('tPrio').value=${JSON.stringify(v.prio)};
  return true})()`);

const BARU = {
  id: 'ANL-BTK-HTU-KOR-999', lat: 1.084321, lon: 104.031234,
  jenis: 'Koridor', tipe: 'Sisi Jalan', jalan: 'Jl. Uji Tambah',
  kel: 'TANJUNG UNCANG', kec: 'BATU AJI', prio: 'PRIORITAS 2'
};

(async () => {
  const mock = await startMock(MOCK_PORT);
  const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  fs.writeFileSync(path.join(ROOT, 'index.test.html'),
    src.replace(/https:\/\/script\.google\.com\/macros\/s\/[^'"]*/, `http://localhost:${MOCK_PORT}`));
  const sa = await serveStatic(PORT_A), sb = await serveStatic(PORT_B);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tambah-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  const bersih = () => {
    try { chrome.kill(); } catch (e) {}
    try { sa.close(); sb.close(); mock.server.close(); } catch (e) {}
    try { fs.unlinkSync(path.join(ROOT, 'index.test.html')); } catch (e) {}
  };
  process.on('exit', bersih);
  for (let i = 0; i < 60; i++) {
    try { await fetch(`http://localhost:${CDP_PORT}/json/version`); break; } catch (e) { await sleep(250); }
  }

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

  console.log('\nID kembar ditolak sebelum sempat disimpan');
  const adaId = await A.ev('data[0].id');
  await A.ev(`bukaBorang(1.08,104.03);
    document.getElementById('tId').value=${JSON.stringify(adaId)};
    document.getElementById('tId').dispatchEvent(new Event('input')); true`);
  ok(/dipakai/i.test(await A.ev('document.getElementById("tIdNote").textContent')),
     'id milik titik survei ditolak: ' + adaId);
  ok(await A.ev('cekId()===false'), 'borang tahu id itu tidak sah');
  await A.ev(`document.getElementById('tId').value='ab';
    document.getElementById('tId').dispatchEvent(new Event('input')); true`);
  ok(await A.ev('cekId()===false'), 'id terlalu pendek ditolak');
  await A.ev('tutupBorang(); true');

  console.log('\nRikrik menambahkan titik reklame baru');
  await A.ev('setEditMode(true); true');
  await isiBorang(A, BARU);
  await A.ev('simpanTitikBaru(); true');
  ok(await A.ev('document.getElementById("tbox").hidden'), 'borang tertutup setelah simpan');
  const rA = await A.ev(`JSON.stringify(byId(${JSON.stringify(BARU.id)}) || null)`);
  const oA = rA && JSON.parse(rA);
  ok(!!oA, 'titik ada di data Rikrik');
  ok(oA && oA.baru === true && oA.jalan === BARU.jalan && oA.kec === BARU.kec &&
     oA.prio === BARU.prio && oA.tipe === BARU.tipe && oA.jenis === BARU.jenis,
     'seluruh atribut tersimpan lengkap');
  ok(oA && Math.abs(oA.rlat - BARU.lat) < 1e-9 && Math.abs(oA.rlon - BARU.lon) < 1e-9,
     'koordinat sesuai lokasi yang diklik');
  ok(oA && oA.povs.length === 0, 'mulai tanpa POV');
  ok(await A.ev('data.length===2421'), 'jumlah titik bertambah satu');
  await A.wait('Object.keys(SYNC.queue).length===0', 'terkirim ke server');

  console.log('\nsampai ke rekan lengkap dengan atributnya');
  await B.ev('pollNow(); true');
  await B.wait(`!!byId(${JSON.stringify(BARU.id)})`, 'sampai ke wahyu');
  const oB = JSON.parse(await B.ev(`JSON.stringify(byId(${JSON.stringify(BARU.id)}))`));
  ok(oB.jalan === BARU.jalan && oB.kel === BARU.kel && oB.kec === BARU.kec &&
     oB.tipe === BARU.tipe && oB.jenis === BARU.jenis && oB.prio === BARU.prio,
     'atribut utuh di sisi wahyu');
  ok(oB.baru === true, 'ditandai sebagai titik tambahan');
  ok(await B.ev(`filtered.some(r=>r.id===${JSON.stringify(BARU.id)})`), 'muncul di daftar wahyu');
  ok(await B.ev(`(()=>{const s=new Set();data.forEach(r=>s.add(r.jalan));
                 return s.has(${JSON.stringify(BARU.jalan)})})()`), 'jalan barunya masuk pilihan filter');

  console.log('\nwahyu menaruh POV di titik itu, Rikrik ikut melihat');
  await B.ev(`(()=>{setEditMode(true);selectRec(${JSON.stringify(BARU.id)},false);
    const r=byId(${JSON.stringify(BARU.id)});snapshot(r);
    r.povs.push({lat:${BARU.lat + 0.0003},lon:${BARU.lon + 0.0003},d:0,st:'baru'});
    r.ed=true;recalc(r);rebuild(r.id);afterEdit(r);return true})()`);
  await B.wait('Object.keys(SYNC.queue).length===0', 'POV terkirim');
  await A.ev('pollNow(); true');
  await A.wait(`byId(${JSON.stringify(BARU.id)}).povs.length===1`, 'POV sampai ke Rikrik');
  ok(true, 'POV di titik tambahan tersinkron dua arah');
  ok(await A.ev(`byId(${JSON.stringify(BARU.id)}).baru===true`),
     'tetap dikenali sebagai titik tambahan setelah diedit');

  console.log('\nbertahan setelah muat ulang');
  await A.muatUlang();
  await A.wait('SYNC.live===true', 'masuk otomatis');
  await A.wait(`!!byId(${JSON.stringify(BARU.id)})`, 'titik kembali setelah muat ulang');
  const oR = JSON.parse(await A.ev(`JSON.stringify(byId(${JSON.stringify(BARU.id)}))`));
  ok(oR.jalan === BARU.jalan && oR.kec === BARU.kec && oR.povs.length === 1,
     'atribut dan POV utuh setelah muat ulang');

  console.log('\nikut terekspor');
  const eks = JSON.parse(await A.ev(`JSON.stringify({
    detail: barisDetail().filter(b=>b[0]===${JSON.stringify(BARU.id)}),
    ringkas: barisRingkas().find(b=>b[0]===${JSON.stringify(BARU.id)}) || null })`));
  ok(eks.detail.length === 1, 'satu baris di sheet Detail POV');
  ok(eks.detail[0] && eks.detail[0][3] === BARU.jalan && eks.detail[0][5] === BARU.kec,
     'jalan & kecamatan benar di ekspor');
  ok(!!eks.ringkas && eks.ringkas[1] === BARU.jenis, 'muncul di sheet Ringkas');

  console.log('\ndua orang mengetik ID sama — server menolak yang kedua');
  const KEMBAR = { ...BARU, id: 'ANL-BTK-HTU-KOR-998', jalan: 'Jl. Uji Kembar' };
  await A.ev('setEditMode(true); true');
  await isiBorang(A, KEMBAR);
  await A.ev('simpanTitikBaru(); true');
  await A.wait('Object.keys(SYNC.queue).length===0', 'punya Rikrik terkirim');
  const tolak = await B.ev(`(async()=>{
    const res = await api('push', { items:[{ id:${JSON.stringify(KEMBAR.id)}, baseRev:0,
      state:'edit', povs:[], rlat:1.1, rlon:104.1, baru:true,
      meta:{jenis:'Koridor',tipe:'Halte',jalan:'Jl. Lain',kel:'X',kec:'Y',prio:'PRIORITAS 3',baru:true} }] });
    return JSON.stringify(res)})()`);
  const rt = JSON.parse(tolak);
  ok(rt.accepted.length === 0 && rt.conflicts.length === 1, 'pengiriman kedua ditolak');
  ok(rt.conflicts[0].alasan === 'id_dipakai', 'alasannya jelas: id_dipakai');
  await A.ev('pollNow(); true'); await sleep(1200);
  ok(await A.ev(`byId(${JSON.stringify(KEMBAR.id)}).jalan===${JSON.stringify(KEMBAR.jalan)}`),
     'punya Rikrik tidak tertimpa');

  console.log('\ndibuat saat luring, tidak hilang setelah tab dimuat ulang');
  const LURING = { ...BARU, id: 'ANL-BTK-HTU-KOR-997', jalan: 'Jl. Uji Luring' };
  await A.ev('stopPolling(); SYNC.live=false; true');
  await isiBorang(A, LURING);
  await A.ev('simpanTitikBaru(); true');
  await sleep(1200);
  ok(await A.ev(`(()=>{const d=JSON.parse(localStorage.getItem('pov_draf')||'{}');
     return !!(d[${JSON.stringify(LURING.id)}] && d[${JSON.stringify(LURING.id)}].meta)})()`),
     'draf lokal menyimpan atributnya');
  await A.muatUlang();
  await A.wait('SYNC.live===true', 'tersambung lagi');
  await A.wait(`!!byId(${JSON.stringify(LURING.id)})`, 'titik luring kembali');
  const oL = JSON.parse(await A.ev(`JSON.stringify(byId(${JSON.stringify(LURING.id)}))`));
  ok(oL.jalan === LURING.jalan && oL.kec === LURING.kec, 'atributnya utuh setelah dipulihkan');
  await A.wait('Object.keys(SYNC.queue).length===0', 'menyusul terkirim ke server');
  await B.ev('pollNow(); true');
  await B.wait(`!!byId(${JSON.stringify(LURING.id)})`, 'sampai ke wahyu');
  ok(true, 'titik yang dibuat saat luring akhirnya sampai ke rekan');

  console.log('\nbisa dihapus dan dipulihkan seperti titik lain');
  await A.ev(`(()=>{setEditMode(true);selectRec(${JSON.stringify(BARU.id)},false);
    toggleHapus();toggleHapus();return true})()`);
  await A.wait('Object.keys(SYNC.queue).length===0', 'penghapusan terkirim');
  ok(await A.ev(`byId(${JSON.stringify(BARU.id)}).del===true`), 'titik tambahan bisa dihapus');
  ok(await A.ev(`!filtered.some(r=>r.id===${JSON.stringify(BARU.id)})`), 'hilang dari daftar');
  await A.ev(`(()=>{povMode='deleted';applyFilters();selectRec(${JSON.stringify(BARU.id)},false);
    toggleHapus();povMode='all';applyFilters();return true})()`);
  await A.wait('Object.keys(SYNC.queue).length===0', 'pemulihan terkirim');
  const oP = JSON.parse(await A.ev(`JSON.stringify(byId(${JSON.stringify(BARU.id)}))`));
  ok(oP.del !== true && oP.povs.length === 1 && oP.jalan === BARU.jalan,
     'dipulihkan lengkap dengan POV dan atributnya');

  console.log(`\n${pass} lulus, ${fail} gagal\n`);
  A.ws.close(); B.ws.close(); bersih();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nGAGAL: ' + e.message + '\n'); process.exit(1); });
