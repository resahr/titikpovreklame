/**
 * Server tiruan Apps Script untuk pengujian lokal.
 * Menjalankan apps-script/Code.gs yang SESUNGGUHNYA, hanya
 * Spreadsheet-nya yang di memori. Dipakai oleh e2e.test.js.
 *
 *   node tests/mock-server.js [port]      -> jalan sendiri
 */
'use strict';
const http = require('http');
const path = require('path');
const { load } = require('./fake-google');

function start(port) {
  const g = load(path.join(__dirname, '..', 'apps-script', 'Code.gs'));
  const code = g.sandbox.setup();

  const server = http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'POST,GET,OPTIONS'
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let out;
      try {
        out = g.sandbox.doPost({ postData: { contents: body } }).getContent();
      } catch (e) {
        out = JSON.stringify({ ok: false, error: String(e && e.message || e) });
      }
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
      res.end(out);
    });
  });

  return new Promise(resolve => server.listen(port, () =>
    resolve({ server, code, sandbox: g.sandbox, sheets: g.sheets })));
}

module.exports = { start };

if (require.main === module) {
  const port = Number(process.argv[2] || 8899);
  start(port).then(h => {
    console.log(`Server tiruan di http://localhost:${port}`);
    console.log(`Kode akses: ${h.code}`);
  });
}
