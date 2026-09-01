/** Tiruan layanan Google Apps Script secukupnya untuk menjalankan Code.gs di Node. */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

/** "A1", "A1:B4" -> {row, col, nr, nc} berbasis 1 */
function a1(ref) {
  const part = ref.split(':');
  const cell = t => {
    const m = /^([A-Z]+)(\d+)$/.exec(t.trim().toUpperCase());
    if (!m) throw new Error('notasi A1 tidak dikenal: ' + ref);
    let c = 0;
    for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
    return { r: +m[2], c };
  };
  const a = cell(part[0]), b = part[1] ? cell(part[1]) : a;
  return { row: Math.min(a.r, b.r), col: Math.min(a.c, b.c),
           nr: Math.abs(b.r - a.r) + 1, nc: Math.abs(b.c - a.c) + 1 };
}

function makeSheet(name) {
  const cells = [];
  const at = (r, c) => {
    while (cells.length <= r) cells.push([]);
    while (cells[r].length <= c) cells[r].push('');
    return cells[r][c];
  };
  return {
    name, _cells: cells,
    getLastRow() {
      let last = 0;
      for (let r = 0; r < cells.length; r++)
        if ((cells[r] || []).some(v => v !== '' && v != null)) last = r + 1;
      return last;
    },
    getRange(row, col, nr = 1, nc = 1) {
      if (typeof row === 'string') ({ row, col, nr, nc } = a1(row));
      return {
        setFontWeight() { return this; },
        setFontSize() { return this; },
        setBackground() { return this; },
        setNumberFormat() { return this; },
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const line = [];
            for (let j = 0; j < nc; j++) line.push(at(row - 1 + i, col - 1 + j));
            out.push(line);
          }
          return out;
        },
        setValues(v) {
          for (let i = 0; i < v.length; i++)
            for (let j = 0; j < v[i].length; j++) {
              at(row - 1 + i, col - 1 + j);
              cells[row - 1 + i][col - 1 + j] = v[i][j];
            }
          return this;
        },
        clearContent() {
          for (let i = 0; i < nr; i++)
            for (let j = 0; j < nc; j++) {
              at(row - 1 + i, col - 1 + j);
              cells[row - 1 + i][col - 1 + j] = '';
            }
          return this;
        },
        setFontWeight() { return this; }
      };
    },
    setFrozenRows() {},
    setColumnWidth() {},
    setRowHeight() {},
    deleteRows(start, howMany) { cells.splice(start - 1, howMany); }
  };
}

function load(codePath, opts) {
  opts = opts || {};
  const sheets = {}, props = {}, cache = {};
  let dibuat = 0;

  const spreadsheet = {
    getId:  () => 'ss-tiruan-001',
    getUrl: () => 'https://docs.google.com/spreadsheets/d/ss-tiruan-001/edit',
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => (sheets[n] = makeSheet(n))
  };

  const sandbox = {
    console,
    // bound = menempel pada Sheet; standalone = getActive() null, skrip harus membuat sendiri
    SpreadsheetApp: {
      getActive: () => (opts.standalone ? null : spreadsheet),
      openById: id => {
        if (id !== spreadsheet.getId()) throw new Error('tidak ditemukan: ' + id);
        return spreadsheet;
      },
      create: () => { dibuat++; return spreadsheet; }
    },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in props ? props[k] : null),
      setProperty: (k, v) => { props[k] = String(v); },
      deleteProperty: k => { delete props[k]; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({
      get: k => (k in cache ? cache[k] : null),
      put: (k, v) => { cache[k] = v; } }) },
    ContentService: { MimeType: { JSON: 'json' },
      createTextOutput: s => ({ _s: s, setMimeType() { return this; }, getContent() { return this._s; } }) },
    Logger: { log: () => {} }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(codePath, 'utf8'), sandbox, { filename: path.basename(codePath) });
  return { sandbox, sheets, props, cache, dibuat: () => dibuat };
}

module.exports = { load, makeSheet };
