/**
 * Uji semantik edit paralel pada apps-script/Code.gs.
 * Menjalankan kode backend yang SESUNGGUHNYA di Node, dengan
 * Spreadsheet/Properties/Lock/Cache tiruan di memori.
 *
 *   node tests/backend.test.js
 */
'use strict';
const path = require('path');

/* ───────── backend asli di atas layanan Google tiruan ───────── */
const { load } = require('./fake-google');
const _g = load(path.join(__dirname, '..', 'apps-script', 'Code.gs'));
const sandbox = _g.sandbox, sheets = _g.sheets;

/* ───────── util uji ───────── */

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label); }
}
function call(req) {
  const out = sandbox.doPost({ postData: { contents: JSON.stringify(req) } });
  return JSON.parse(out.getContent());
}

/* ───────── mulai ───────── */

console.log('\nsetup');
const CODE = sandbox.setup();
ok(!!sheets.edits && !!sheets.presence && !!sheets.log, 'tiga sheet dibuat');
ok(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(CODE), 'kode akses dibuat: ' + CODE);

console.log('\nkode akses');
ok(call({ op: 'hello', code: 'SALAH', name: 'Budi' }).code === 'BAD_CODE', 'kode salah ditolak');
ok(call({ op: 'hello', code: CODE.toLowerCase(), name: 'Budi' }).ok, 'kode tidak peka huruf besar/kecil');
ok(call({ op: 'ping' }).ok, 'ping tidak butuh kode');

const budi = { code: CODE, name: 'Budi' };
const sari = { code: CODE, name: 'Sari' };

console.log('\nnama dengan spasi & tanda hubung dipertahankan');
ok(call({ op: 'hello', code: CODE, name: 'Budi Santoso' }).name === 'Budi Santoso', 'spasi utuh');
ok(call({ op: 'hello', code: CODE, name: 'Tim-A' }).name === 'Tim-A', 'tanda hubung utuh');

console.log('\ndua orang, titik BERBEDA — tidak boleh bentrok');
const p1 = call(Object.assign({ op: 'push', items: [
  { id: 'A-001', baseRev: 0, state: 'edit', povs: [[1.1, 104.1], [1.2, 104.2, 2]], rlat: 1.0, rlon: 104.0 }] }, budi));
const p2 = call(Object.assign({ op: 'push', items: [
  { id: 'B-002', baseRev: 0, state: 'edit', povs: [[1.3, 104.3]], rlat: 1.4, rlon: 104.4 }] }, sari));
ok(p1.ok && p1.accepted.length === 1 && !p1.conflicts.length, 'Budi diterima');
ok(p2.ok && p2.accepted.length === 1 && !p2.conflicts.length, 'Sari diterima');
ok(p1.accepted[0].rev !== p2.accepted[0].rev, 'rev unik per editan');

console.log('\ndua orang, titik SAMA — yang basi ditolak, bukan ditimpa diam-diam');
const revA = p1.accepted[0].rev;
const okPush = call(Object.assign({ op: 'push', items: [
  { id: 'A-001', baseRev: revA, state: 'edit', povs: [[9.9, 99.9]], rlat: 1.0, rlon: 104.0 }] }, sari));
ok(okPush.accepted.length === 1, 'Sari dengan baseRev terkini diterima');
const stale = call(Object.assign({ op: 'push', items: [
  { id: 'A-001', baseRev: revA, state: 'edit', povs: [[5.5, 55.5]], rlat: 1.0, rlon: 104.0 }] }, budi));
ok(stale.accepted.length === 0 && stale.conflicts.length === 1, 'Budi yang basi ditolak');
ok(stale.conflicts[0].server.editor === 'Sari', 'versi server dikembalikan, editor = Sari');
ok(stale.conflicts[0].server.povs[0][0] === 9.9, 'isi versi server ikut dikirim balik');

console.log('\npenanda POV (0 asli / 1 digeser / 2 baru) bertahan bolak-balik');
const pulled = call(Object.assign({ op: 'pull', since: 0 }, budi));
const a1 = pulled.changes.find(c => c.id === 'A-001');
const b2 = pulled.changes.find(c => c.id === 'B-002');
ok(!!a1 && !!b2, 'kedua titik terbawa di pull');
const p1povs = call(Object.assign({ op: 'push', items: [
  { id: 'C-003', baseRev: 0, state: 'edit', povs: [[1.1, 104.1], [1.2, 104.2, 1], [1.3, 104.3, 2]], rlat: 1, rlon: 104 }] }, budi));
const c3 = call(Object.assign({ op: 'pull', since: p1povs.rev - 1 }, budi)).changes.find(c => c.id === 'C-003');
ok(c3 && c3.povs.length === 3, 'tiga POV tersimpan');
ok(c3 && c3.povs[0].length === 2 && c3.povs[1][2] === 1 && c3.povs[2][2] === 2, 'penanda st utuh');

console.log('\npull hanya membawa yang baru (delta)');
const revNow = call(Object.assign({ op: 'pull', since: 0 }, budi)).rev;
const empty = call(Object.assign({ op: 'pull', since: revNow }, budi));
ok(empty.changes.length === 0, 'tidak ada perubahan sejak rev terkini');
call(Object.assign({ op: 'push', items: [
  { id: 'D-004', baseRev: 0, state: 'edit', povs: [[2, 105]], rlat: 2, rlon: 105 }] }, sari));
const delta = call(Object.assign({ op: 'pull', since: revNow }, budi));
ok(delta.changes.length === 1 && delta.changes[0].id === 'D-004', 'hanya D-004 terbawa');

console.log('\nkembalikan ke data survei (state orig)');
call(Object.assign({ op: 'push', items: [
  { id: 'D-004', baseRev: delta.changes[0].rev, state: 'orig' }] }, budi));
const back = call(Object.assign({ op: 'pull', since: delta.changes[0].rev }, sari));
const d4 = back.changes.find(c => c.id === 'D-004');
ok(d4 && d4.state === 'orig' && d4.povs.length === 0, 'ditandai orig, POV dikosongkan');

console.log('\nid ganda dalam satu batch (bug baris -1)');
const dupPush = call(Object.assign({ op: 'push', items: [
  { id: 'E-005', baseRev: 0, state: 'edit', povs: [[1, 1]], rlat: 1, rlon: 1 },
  { id: 'E-005', baseRev: 0, state: 'edit', povs: [[2, 2], [3, 3]], rlat: 2, rlon: 2 }] }, budi));
ok(dupPush.ok, 'tidak melempar galat');
ok(dupPush.accepted.length === 1, 'satu id = satu penerimaan');
const e5 = call(Object.assign({ op: 'pull', since: 0 }, budi)).changes.find(c => c.id === 'E-005');
ok(e5 && e5.povs.length === 2, 'versi terakhir dalam batch yang menang');

console.log('\nkehadiran / kunci lunak');
call(Object.assign({ op: 'pull', since: 0, claim: 'A-001' }, budi));
const pres = call(Object.assign({ op: 'pull', since: 0, claim: 'B-002' }, sari)).presence;
ok(pres.length === 2, 'dua editor tercatat online');
ok(pres.find(p => p.editor === 'Budi').titik === 'A-001', 'Budi memegang A-001');
ok(pres.find(p => p.editor === 'Sari').titik === 'B-002', 'Sari memegang B-002');
const rel = call(Object.assign({ op: 'release' }, budi)).presence;
ok(rel.find(p => p.editor === 'Budi').titik === '', 'klaim Budi dilepas');

console.log('\nkoordinat dibulatkan 6 desimal');
call(Object.assign({ op: 'push', items: [
  { id: 'F-006', baseRev: 0, state: 'edit', povs: [[1.12345678, 104.87654321]], rlat: 1.11111111, rlon: 104.9999999 }] }, budi));
const f6 = call(Object.assign({ op: 'pull', since: 0 }, budi)).changes.find(c => c.id === 'F-006');
ok(f6.povs[0][0] === 1.123457 && f6.rlat === 1.111111, 'pembulatan konsisten');

console.log('\nPOV tak masuk akal ditolak diam-diam');
call(Object.assign({ op: 'push', items: [
  { id: 'G-007', baseRev: 0, state: 'edit', povs: [[1, 104], ['x', 'y'], [null, null]], rlat: 1, rlon: 104 }] }, budi));
const g7 = call(Object.assign({ op: 'pull', since: 0 }, budi)).changes.find(c => c.id === 'G-007');
ok(g7.povs.length === 1, 'hanya POV bernomor valid yang disimpan');


console.log('\npemasangan otomatis pada permintaan pertama (tanpa Run setup manual)');
{
  const g2 = load(path.join(__dirname, '..', 'apps-script', 'Code.gs'));
  const call2 = req => JSON.parse(g2.sandbox.doPost({ postData: { contents: JSON.stringify(req) } }).getContent());
  ok(call2({ op: 'ping' }).ok, 'ping memicu pemasangan');
  ok(!!g2.sheets.edits && !!g2.sheets.info, 'sheet edits & info terbentuk sendiri');
  const kode = g2.props.ACCESS_CODE;
  ok(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(kode), 'kode akses ikut dibuat');
  const info = g2.sheets.info.getRange(1, 1, 1, 2).getValues()[0];
  ok(info[0] === 'KODE AKSES TIM' && info[1] === kode, 'kode tertulis di sheet info, bukan di berkas kode');
  ok(call2({ op: 'hello', code: kode, name: 'Rina' }).ok, 'langsung bisa dipakai masuk');
  const before = g2.props.REV;
  call2({ op: 'ping' });
  ok(g2.props.READY === '1' && g2.props.REV === before, 'pemasangan hanya sekali, tidak berulang');
}


console.log('\nskrip berdiri sendiri — membuat Spreadsheet-nya sendiri');
{
  const g3 = load(path.join(__dirname, '..', 'apps-script', 'Code.gs'), { standalone: true });
  const call3 = req => JSON.parse(g3.sandbox.doPost({ postData: { contents: JSON.stringify(req) } }).getContent());

  ok(call3({ op: 'ping' }).ok, 'jalan walau tidak menempel pada Sheet');
  ok(g3.dibuat() === 1, 'Spreadsheet dibuat sendiri, tepat sekali');
  ok(!!g3.props.SS_ID && !!g3.props.SS_URL, 'id & tautan Spreadsheet diingat');
  ok(!!g3.sheets.edits && !!g3.sheets.info, 'sheet kerja terbentuk di dalamnya');

  const kode = g3.props.ACCESS_CODE;
  const halo = call3({ op: 'hello', code: kode, name: 'Resa' });
  ok(halo.ok && halo.sheet === g3.props.SS_URL, 'tautan Spreadsheet dikembalikan saat masuk');

  // dipakai lagi: tidak boleh membuat Spreadsheet kedua
  call3({ op: 'push', items: [{ id: 'X-1', baseRev: 0, state: 'edit',
    povs: [[1.1, 104.1]], rlat: 1.1, rlon: 104.1 }], code: kode, name: 'Resa' });
  ok(g3.dibuat() === 1, 'permintaan berikutnya memakai Spreadsheet yang sama');
  ok(call3({ op: 'pull', since: 0, code: kode, name: 'Resa' }).changes.length === 1, 'data tersimpan normal');
}

console.log(`\n${pass} lulus, ${fail} gagal\n`);
process.exit(fail ? 1 : 0);
