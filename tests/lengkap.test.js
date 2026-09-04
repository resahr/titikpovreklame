/**
 * Sheet "Data Lengkap": 172 kolom persis seperti berkas survei awal,
 * dengan hasil kerja tim ditulis balik ke kolom yang memang digarap.
 *
 *   node --experimental-websocket tests/lengkap.test.js
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
const MOCK_PORT = 8941, PORT = 8841, CDP_PORT = 9451;

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
    wait: async (x, l, t = 60000) => {
      const s = Date.now();
      while (Date.now() - s < t) { try { if (await ev(x)) return true; } catch (e) {} await sleep(300); }
      throw new Error('waktu habis: ' + (l || x));
    } };
}

(async () => {
  const atribut = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'atribut.json'), 'utf8'));
  const KOL = atribut.cols;
  const asliOf = {};
  atribut.rows.forEach(r => asliOf[r[atribut.idIdx]] = r);

  const mock = await startMock(MOCK_PORT);
  const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  fs.writeFileSync(path.join(ROOT, 'index.test.html'),
    src.replace(/https:\/\/script\.google\.com\/macros\/s\/[^'"]*/, `http://localhost:${MOCK_PORT}`));
  const srv = await serveStatic(PORT);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lengkap-'));
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
  await A.wait('SYNC.live===true', 'masuk');

  console.log('\natribut dimuat hanya saat diminta');
  ok(await A.ev('ATRIBUT===null'), 'belum dimuat saat halaman dibuka (peta tetap ringan)');
  await A.ev('muatAtribut().then(()=>true)');
  ok(await A.ev('ATRIBUT!==null && Object.keys(ATRIBUT.peta).length===2420'),
     '2.420 baris atribut termuat setelah diminta');

  console.log('\nheader persis seperti berkas survei awal');
  const head = await A.ev('JSON.stringify(barisLengkap()[0])').then(JSON.parse);
  ok(JSON.stringify(head.slice(0, KOL.length)) === JSON.stringify(KOL),
     `${KOL.length} kolom pertama sama persis, urutan sama`);
  ok(head[0] === 'UID' && head[1] === 'ID_TITIK', 'dimulai dari UID, ID_TITIK');
  ok(head[KOL.length - 2] === 'longitude' && head[KOL.length - 1] === 'latitude',
     'diakhiri longitude, latitude seperti CSV asli');
  const tambahan = head.slice(KOL.length);
  ok(tambahan.includes('POV_JARAK_MEDIAN_m') && tambahan.includes('SUMBER_BARIS'),
     'kolom hitungan POV ditambahkan di kanan: ' + tambahan.join(', '));

  console.log('\nsatu baris per titik, nilai asli disalin apa adanya');
  let baris = await A.ev('JSON.stringify(barisLengkap())').then(JSON.parse);
  ok(baris.length === 2421, '2.420 titik + 1 baris header');
  const iId = KOL.indexOf('ID_TITIK');
  const T = await A.ev('data.find(r=>r.povs.length===6).id');
  const cari = (rows, id) => rows.find(b => b[iId] === id);
  const b0 = cari(baris, T);
  const a0 = asliOf[T];
  const abaikan = new Set(['LONG_DISP', 'LAT_DISP', 'longitude', 'latitude',
    'VP1_KOORDI', 'VP2_KOORDI', 'VP3_KOORDI', 'VPK1_KOORD', 'VPK2_KOORD', 'VPK3_KOORD']);
  const beda = KOL.filter((c, i) => !abaikan.has(c) && String(b0[i]) !== String(a0[i]));
  ok(beda.length === 0, 'kolom lain tidak tersentuh sama sekali' + (beda.length ? ' — beda: ' + beda.join(',') : ''));

  console.log('\nJARAK_MEAN & JARAK_MED_ sengaja dibiarkan apa adanya');
  const iMean = KOL.indexOf('JARAK_MEAN'), iMed = KOL.indexOf('JARAK_MED_');
  ok(String(b0[iMean]) === String(a0[iMean]) && String(b0[iMed]) === String(a0[iMed]),
     `nilai berkas dipertahankan (${a0[iMed]}), bukan ditimpa hitungan POV`);
  const iPovMed = head.indexOf('POV_JARAK_MEDIAN_m');
  const medApp = await A.ev(`byId(${JSON.stringify(T)}).median`);
  ok(b0[iPovMed] === medApp, `hitungan POV ada di kolomnya sendiri (${medApp} m)`);

  console.log('\nPOV ditulis balik ke enam kolom aslinya');
  const iVP = ['VP1_KOORDI','VP2_KOORDI','VP3_KOORDI','VPK1_KOORD','VPK2_KOORD','VPK3_KOORD']
    .map(c => KOL.indexOf(c));
  const povs = await A.ev(`JSON.stringify(byId(${JSON.stringify(T)}).povs)`).then(JSON.parse);
  const cocok = iVP.every((ix, k) => b0[ix] ===
    povs[k].lat.toFixed(6) + ', ' + povs[k].lon.toFixed(6));
  ok(cocok, 'enam koordinat POV sesuai isi aplikasi, format "lat, lon"');
  ok(b0[iVP[0]] === a0[iVP[0]], 'yang belum diedit tetap sama dengan berkas asli');

  console.log('\nPOV yang digeser ikut terbawa');
  await A.ev(`(()=>{setEditMode(true);selectRec(${JSON.stringify(T)},false);
    const r=byId(${JSON.stringify(T)});snapshot(r);
    r.povs[1].lat=+(r.povs[1].lat+0.0012).toFixed(6);r.povs[1].st='ubah';r.ed=true;
    rebuild(r.id);afterEdit(r);return true})()`);
  await A.wait('Object.keys(SYNC.queue).length===0', 'editan tersimpan');
  baris = await A.ev('JSON.stringify(barisLengkap())').then(JSON.parse);
  const b1 = cari(baris, T);
  const povBaru = await A.ev(`JSON.stringify(byId(${JSON.stringify(T)}).povs[1])`).then(JSON.parse);
  ok(b1[iVP[1]] === povBaru.lat.toFixed(6) + ', ' + povBaru.lon.toFixed(6),
     'VP2_KOORDI mengikuti POV yang digeser');
  ok(b1[iVP[1]] !== a0[iVP[1]], 'nilainya memang berubah dari berkas asli');

  console.log('\ntitik reklame yang digeser memperbarui empat kolom koordinat');
  await A.ev(`(()=>{const r=byId(${JSON.stringify(T)});snapshot(r);
    r.rlat=+(r.rlat+0.0004).toFixed(6);r.ed=true;recalc(r);rebuild(r.id);afterEdit(r);return true})()`);
  await A.wait('Object.keys(SYNC.queue).length===0', 'geseran tersimpan');
  baris = await A.ev('JSON.stringify(barisLengkap())').then(JSON.parse);
  const b2 = cari(baris, T);
  const rl = await A.ev(`JSON.stringify([byId(${JSON.stringify(T)}).rlat,byId(${JSON.stringify(T)}).rlon])`).then(JSON.parse);
  ok(b2[KOL.indexOf('LAT_DISP')] === rl[0] && b2[KOL.indexOf('latitude')] === rl[0] &&
     b2[KOL.indexOf('LONG_DISP')] === rl[1] && b2[KOL.indexOf('longitude')] === rl[1],
     'LAT_DISP, LONG_DISP, latitude, longitude semuanya ikut');

  console.log('\nPOV yang dihapus mengosongkan slotnya, tidak menyisakan koordinat lama');
  await A.ev(`(()=>{const r=byId(${JSON.stringify(T)});snapshot(r);
    r.povs.splice(4,2);r.ed=true;recalc(r);rebuild(r.id);afterEdit(r);return true})()`);
  await A.wait('Object.keys(SYNC.queue).length===0', 'penghapusan POV tersimpan');
  baris = await A.ev('JSON.stringify(barisLengkap())').then(JSON.parse);
  const b3 = cari(baris, T);
  ok(b3[iVP[4]] === '' && b3[iVP[5]] === '', 'VPK2 dan VPK3 dikosongkan');
  ok(b3[head.indexOf('POV_JUMLAH')] === 4, 'POV_JUMLAH ikut turun jadi 4');

  console.log('\nPOV ke-7 dan seterusnya dapat kolom sendiri');
  await A.ev(`(()=>{const r=byId(${JSON.stringify(T)});snapshot(r);
    for(let i=0;i<4;i++)r.povs.push({lat:+(r.rlat+0.0002*(i+1)).toFixed(6),lon:+(r.rlon+0.0002).toFixed(6),d:0,st:'baru'});
    r.ed=true;recalc(r);rebuild(r.id);afterEdit(r);return true})()`);
  await A.wait('Object.keys(SYNC.queue).length===0', 'POV tambahan tersimpan');
  baris = await A.ev('JSON.stringify(barisLengkap())').then(JSON.parse);
  const head2 = baris[0], b4 = cari(baris, T);
  ok(head2.includes('POV7_KOORDI') && head2.includes('POV8_KOORDI'),
     'kolom POV7_KOORDI dan POV8_KOORDI muncul otomatis');
  ok(b4[head2.indexOf('POV7_KOORDI')] !== '', 'POV ke-7 terisi');
  ok(b4[head2.indexOf('POV_JUMLAH')] === 8, 'POV_JUMLAH = 8');

  console.log('\ntitik tambahan dapat barisnya sendiri');
  const IDB = 'ANL-BTK-HTU-KOR-991';
  await A.ev(`(()=>{
    bukaBorang(1.0850,104.0320);
    document.getElementById('tId').value=${JSON.stringify(IDB)};
    document.getElementById('tId').dispatchEvent(new Event('input'));
    document.getElementById('tJenis').value='Koridor';
    document.getElementById('tTipe').value='Halte';
    document.getElementById('tJalan').value='Jl. Uji Lengkap';
    document.getElementById('tKel').value='TANJUNG UNCANG';
    document.getElementById('tKec').value='BATU AJI';
    document.getElementById('tPrio').value='PRIORITAS 1';
    simpanTitikBaru(); return true})()`);
  await A.wait(`!!byId(${JSON.stringify(IDB)})`, 'titik baru dibuat');
  baris = await A.ev('JSON.stringify(barisLengkap())').then(JSON.parse);
  const bB = cari(baris, IDB);
  ok(!!bB, 'titik tambahan ikut terekspor');
  ok(bB && bB[KOL.indexOf('NAMA_JALAN')] === 'Jl. Uji Lengkap' &&
     bB[KOL.indexOf('KECAMATAN')] === 'BATU AJI' &&
     bB[KOL.indexOf('PRIORITAS')] === 'PRIORITAS 1', 'atribut yang diisi pemakai terbawa');
  ok(bB && bB[baris[0].indexOf('SUMBER_BARIS')] === 'tambahan', 'ditandai "tambahan"');
  ok(bB && bB[KOL.indexOf('UID')] === '', 'kolom yang tidak diketahui dibiarkan kosong');
  ok(cari(baris, T)[baris[0].indexOf('SUMBER_BARIS')] === 'survei', 'titik survei ditandai "survei"');

  console.log('\ntitik terhapus tidak ikut');
  await A.ev(`(()=>{selectRec(${JSON.stringify(IDB)},false);toggleHapus();toggleHapus();return true})()`);
  await A.wait(`byId(${JSON.stringify(IDB)}).del===true`, 'terhapus');
  baris = await A.ev('JSON.stringify(barisLengkap())').then(JSON.parse);
  ok(!cari(baris, IDB), 'baris titik terhapus dikeluarkan dari Data Lengkap');

  console.log(`\n${pass} lulus, ${fail} gagal\n`);
  A.ws.close(); bersih();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nGAGAL: ' + e.message + '\n'); process.exit(1); });
