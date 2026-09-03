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


console.log('\npemasangan BARU (SS_TETAP kosong) — membuat Spreadsheet-nya sendiri');
{
  // Hanya berlaku saat belum ada berkas sama sekali. Pada pemasangan yang
  // sudah jalan, SS_TETAP terisi dan pembuatan otomatis tidak boleh terjadi.
  const g3 = load(path.join(__dirname, '..', 'apps-script', 'Code.gs'),
    { standalone: true, transform: k => k.replace(/var SS_TETAP = '[^']*'/, "var SS_TETAP = ''") });
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


console.log('\nhapus titik — hasil kerja TIDAK ikut terbuang');
{
  const g=load(path.join(__dirname,'..','apps-script','Code.gs'));
  const c=req=>JSON.parse(g.sandbox.doPost({postData:{contents:JSON.stringify(req)}}).getContent());
  c({op:'ping'}); const K=g.props.ACCESS_CODE;
  const bu={code:K,name:'Budi'}, sa={code:K,name:'Sari'};

  // Budi menggarap sebuah titik
  let r=c(Object.assign({op:'push',items:[{id:'H-1',baseRev:0,state:'edit',
    povs:[[1.1,104.1],[1.2,104.2,2]],rlat:1,rlon:104}]},bu));
  const revEdit=r.accepted[0].rev;

  // lalu menghapusnya, mengirim POV yang sama
  r=c(Object.assign({op:'push',items:[{id:'H-1',baseRev:revEdit,state:'hapus',
    povs:[[1.1,104.1],[1.2,104.2,2]],rlat:1,rlon:104}]},bu));
  ok(r.accepted.length===1,'penghapusan diterima');
  const revHapus=r.accepted[0].rev;

  let ch=c(Object.assign({op:'pull',since:0},sa)).changes.find(x=>x.id==='H-1');
  ok(ch.state==='hapus','ditandai hapus');
  ok(ch.povs.length===2,'POV tetap tersimpan, tidak dibuang');
  ok(ch.povs[1][2]===2,'penanda POV baru pun utuh');
  ok(ch.rlat===1,'koordinat reklame tetap');

  console.log('\npenghapusan LENGKET — tab versi lama tidak bisa menghidupkannya lagi');
  // Persis yang dilakukan klien lama: menyimpan biasa, tanpa tahu soal hapus
  const lama=c(Object.assign({op:'push',items:[{id:'H-1',baseRev:revHapus,state:'edit',
    povs:[[9,99]],rlat:9,rlon:99}]},sa));
  ok(lama.accepted.length===0,'penyimpanan biasa ditolak');
  ok(lama.conflicts.length===1&&lama.conflicts[0].alasan==='terhapus','ditolak dengan alasan terhapus');
  ch=c(Object.assign({op:'pull',since:0},sa)).changes.find(x=>x.id==='H-1');
  ok(ch.state==='hapus'&&ch.povs.length===2,'titik tetap terhapus & isinya utuh');

  console.log('\npemulihan yang disengaja');
  const pulih=c(Object.assign({op:'push',items:[{id:'H-1',baseRev:revHapus,state:'edit',
    undelete:true,povs:[[1.1,104.1],[1.2,104.2,2]],rlat:1,rlon:104}]},sa));
  ok(pulih.accepted.length===1,'pemulihan diterima');
  ch=c(Object.assign({op:'pull',since:0},sa)).changes.find(x=>x.id==='H-1');
  ok(ch.state==='edit','kembali aktif');
  ok(ch.povs.length===2,'POV kembali lengkap seperti sebelum dihapus');

  console.log('\njejak di sheet log');
  const log=g.sheets.log.getRange(1,1,g.sheets.log.getLastRow(),5).getValues();
  const aksi=log.slice(1).filter(l=>l[2]==='H-1').map(l=>l[3]);
  ok(aksi.indexOf('hapus titik')>=0,'penghapusan tercatat');
  ok(aksi.indexOf('pulihkan titik')>=0,'pemulihan tercatat');

  console.log('\nversi protokol dikabarkan ke klien');
  ok(c(Object.assign({op:'hello'},bu)).ver===2,'hello membawa versi');
  ok(c(Object.assign({op:'pull',since:0},bu)).ver===2,'pull membawa versi');
}


console.log('\nREGRESI 3 Sep 2026 — gagal membuka Spreadsheet TIDAK boleh bikin yang baru');
{
  // Insiden nyata: openById gagal sesaat, kode lama menghapus SS_ID lalu
  // membuat spreadsheet baru yang kosong. 250 editan tim jadi yatim di
  // berkas lama dan aplikasi seolah kehilangan semuanya.
  const g = load(path.join(__dirname,'..','apps-script','Code.gs'), { openByIdGagal: true });
  const c = req => JSON.parse(g.sandbox.doPost({postData:{contents:JSON.stringify(req)}}).getContent());
  const res = c({ op:'ping' });
  ok(res.ok === false, 'permintaan gagal dengan jujur, bukan pura-pura berhasil');
  ok(g.dibuat() === 0, 'TIDAK ada spreadsheet baru yang dibuat');
  ok(/gagal membuka/i.test(res.error || ''), 'galatnya menyebut sebabnya: ' + JSON.stringify((res.error||'').slice(0,40)));
}

console.log('\nspreadsheet yang dipakai selalu yang dikunci, sekali pun SS_ID meleset');
{
  const g = load(path.join(__dirname,'..','apps-script','Code.gs'));
  const c = req => JSON.parse(g.sandbox.doPost({postData:{contents:JSON.stringify(req)}}).getContent());
  g.props.SS_ID = 'berkas-salah-yang-kosong';        // meniru keadaan rusak
  g.props.READY = '1';
  ok(c({ op:'ping' }).ok, 'tetap melayani');
  const tetap = /var SS_TETAP = '([^']*)'/.exec(
    require('fs').readFileSync(path.join(__dirname,'..','apps-script','Code.gs'),'utf8'))[1];
  ok(g.props.SS_ID === tetap, 'SS_ID dibetulkan sendiri ke berkas yang dikunci');
  ok(g.dibukaId.every(x => x === tetap), 'hanya berkas terkunci yang pernah dibuka');
  ok(g.dibuat() === 0, 'tidak membuat berkas baru');
  ok(!!g.sheets.edits, 'sheet kerja dipasang ulang otomatis');
}

console.log(`\n${pass} lulus, ${fail} gagal\n`);
process.exit(fail ? 1 : 0);
