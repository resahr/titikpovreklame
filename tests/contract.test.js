/**
 * Uji kontrak serialisasi klien <-> server.
 *
 * Memakai povIn/povOut yang SESUNGGUHNYA dari src/collab.js dan
 * normPovs_ yang SESUNGGUHNYA dari apps-script/Code.gs, lalu
 * memutar data bolak-balik. Ini menangkap ketidakcocokan bentuk
 * data yang tidak terlihat kalau kedua sisi diuji sendiri-sendiri.
 *
 *   node tests/contract.test.js
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

/* ── ambil fungsi murni dari kode klien yang asli ── */
const collabSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'collab.js'), 'utf8');
function grab(name) {
  const re = new RegExp('function ' + name + '\\([\\s\\S]*?\\n}', 'm');
  const m = collabSrc.match(re);
  if (!m) throw new Error('Fungsi ' + name + ' tidak ditemukan di src/collab.js');
  return m[0];
}
const clientCtx = { };
vm.createContext(clientCtx);
vm.runInContext(
  "const ST_IN=[undefined,'ubah','baru']; const ST_OUT={ubah:1,baru:2};\n" +
  grab('povIn') + '\n' + grab('povOut'), clientCtx);
const { povIn, povOut } = clientCtx;

/* ── muat backend asli dengan tiruan minimal ── */
const props = {};
const serverCtx = {
  PropertiesService: { getScriptProperties: () => ({
    getProperty: k => (k in props ? props[k] : null),
    setProperty: (k, v) => { props[k] = String(v); } }) },
  SpreadsheetApp: {}, LockService: {}, CacheService: {},
  ContentService: { MimeType: {}, createTextOutput: () => ({ setMimeType() { return this; } }) },
  Logger: { log: () => {} }
};
vm.createContext(serverCtx);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8'),
  serverCtx, { filename: 'Code.gs' });
const normPovs_ = serverCtx.normPovs_;

/* ── util ── */
let pass = 0, fail = 0;
const ok = (c, l) => c ? (pass++, console.log('  ✓ ' + l)) : (fail++, console.log('  ✗ ' + l));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('\nputaran penuh: memori -> kirim -> server -> tarik -> memori');

const semula = [
  { lat: 1.162954, lon: 104.002404, st: undefined },   // POV asli survei
  { lat: 1.163199, lon: 104.002399, st: 'ubah' },      // digeser surveyor
  { lat: 1.162874, lon: 104.002598, st: 'baru' }       // ditambah surveyor
];

const dikirim  = semula.map(povOut);
const disimpan = normPovs_(dikirim);
const kembali  = disimpan.map(povIn);

ok(eq(dikirim, [[1.162954, 104.002404], [1.163199, 104.002399, 1], [1.162874, 104.002598, 2]]),
   'bentuk kirim benar (s dihilangkan bila 0)');
ok(eq(disimpan, dikirim), 'server menyimpan apa adanya');
ok(kembali.length === 3, 'tiga POV kembali utuh');
ok(kembali[0].st === undefined && kembali[1].st === 'ubah' && kembali[2].st === 'baru',
   'penanda asli/digeser/baru selamat bolak-balik');
ok(kembali.every((p, i) => p.lat === semula[i].lat && p.lon === semula[i].lon),
   'koordinat tidak bergeser sedikit pun');

console.log('\nserver juga menerima bentuk objek {lat,lon,st}');
const dariObjek = normPovs_(semula);
ok(eq(dariObjek, dikirim), 'objek dan larik menghasilkan penyimpanan yang sama');

console.log('\nmasukan rusak tidak menghasilkan titik palsu');
const kotor = normPovs_([
  [1.1, 104.1],
  [null, null],          // pernah lolos jadi (0,0)
  ['x', 'y'],
  undefined,
  { lat: '', lon: '' },
  [true, false],
  [999, 104.1],          // lintang di luar bumi
  [1.2, 104.2, 2]
]);
ok(kotor.length === 2, 'hanya dua yang sah dari delapan masukan');
ok(eq(kotor, [[1.1, 104.1], [1.2, 104.2, 2]]), 'yang sah lolos apa adanya');
ok(!kotor.some(p => p[0] === 0 && p[1] === 0), 'tidak ada titik nol di Teluk Guinea');

console.log('\npembulatan seragam enam desimal');
const bulat = normPovs_([[1.1234567891, 104.9876543219]]);
ok(eq(bulat, [[1.123457, 104.987654]]), 'dibulatkan konsisten');
ok(eq(povIn(bulat[0]), { lat: 1.123457, lon: 104.987654, st: undefined }), 'klien membaca angka yang sama');

console.log('\nbatas jumlah POV per titik');
const banyak = normPovs_(new Array(200).fill([1.1, 104.1]));
ok(banyak.length === 60, 'dipotong di 60 POV, tidak membanjiri sel Sheet');

console.log(`\n${pass} lulus, ${fail} gagal\n`);
process.exit(fail ? 1 : 0);
