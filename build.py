#!/usr/bin/env python3
"""
Merakit index.html = mockup + lapisan kolaborasi, dan mengekstrak
dataset ter-embed menjadi data/titik.json.

Dipakai ulang setiap kali mockup direvisi:

    python3 build.py                                  # pakai API_URL tersimpan
    python3 build.py --api-url https://script.google.com/.../exec
    python3 build.py --mockup ../WebGIS_..._Editor2.html

Kalau mockup berubah bentuk sampai potongan kode yang dicari tak
ketemu, build sengaja GAGAL dengan pesan jelas — lebih baik berhenti
daripada diam-diam menghasilkan halaman rusak.
"""

import argparse, json, os, re, sys, gzip

HERE = os.path.dirname(os.path.abspath(__file__))
SRC  = os.path.join(HERE, 'src')
CFG  = os.path.join(HERE, 'config.json')

DEFAULT_MOCKUP = os.path.join(
    os.path.dirname(HERE), 'WebGIS_Jarak_Reklame_POV_Editor1.html')


def read(p):
    with open(p, encoding='utf-8') as f:
        return f.read()


def sub_once(text, old, new, label):
    """Ganti tepat satu kemunculan; gagal keras kalau tidak unik."""
    n = text.count(old)
    if n != 1:
        sys.exit(f'GAGAL [{label}]: pola ditemukan {n} kali, harus tepat 1.\n'
                 f'  Mockup kemungkinan berubah. Cari potongan ini di mockup:\n'
                 f'  ---\n{old[:300]}\n  ---')
    return text.replace(old, new, 1)


# ── potongan kode mockup yang dikaitkan ───────────────────────────

DATA_INIT_OLD = """let data=JSON.parse($('dataset').textContent);
data.forEach(r=>{r.fl=r.povs.filter(p=>p.d>FLAG).length});
const ORIG=JSON.parse(JSON.stringify(data));
const origMap={}; ORIG.forEach(r=>origMap[r.id]=r);"""

DATA_INIT_NEW = """/* Data dimuat dari data/titik.json oleh lapisan kolaborasi (lihat bawah).
   ORIG = data survei asli, dipakai oleh "Kembalikan titik ini". */
let data=[];
let ORIG=[];
const origMap={};"""

INIT_OLD = """/* ========== init ========== */
$('eUndo').disabled=true;
buildFilters(); render(); renderEditor(); setHint();
map.fitBounds(L.latLngBounds(data.map(r=>[r.rlat,r.rlon])).pad(.05));"""

EXPORT_OLD = ("  const c=document.documentElement.cloneNode(true), "
              "q=s=>c.querySelector(s);")
EXPORT_NEW = EXPORT_OLD + """
  /* arsip luring: buang gerbang masuk & bilah kolaborasi */
  ['#gate','#collabbar'].forEach(s=>{const n=q(s); if(n)n.remove();});"""

RESET_OLD = "$('btnResetAll').onclick=resetAll;"
RESET_NEW = "$('btnResetAll').onclick=reloadFromServer;"

BTN_OLD = '<button class="btn danger" id="btnResetAll">Kembalikan semua</button>'
BTN_NEW = ('<button class="btn danger" id="btnResetAll" '
           'title="Buang perubahan lokal yang belum terkirim, lalu tarik ulang '
           'keadaan terbaru dari server">Muat ulang dari server</button>')

DATASET_RE = re.compile(
    r'(<script id="dataset" type="application/json">)(.*?)(</script>)', re.S)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--mockup', default=DEFAULT_MOCKUP)
    ap.add_argument('--api-url', default=None)
    ap.add_argument('--out', default=os.path.join(HERE, 'index.html'))
    a = ap.parse_args()

    cfg = json.load(open(CFG)) if os.path.exists(CFG) else {}
    if a.api_url:
        cfg['api_url'] = a.api_url
        json.dump(cfg, open(CFG, 'w'), indent=2)
    api_url = cfg.get('api_url', '__API_URL__')

    if not os.path.exists(a.mockup):
        sys.exit(f'Mockup tidak ditemukan: {a.mockup}')
    html = read(a.mockup)

    # 1 ─ keluarkan dataset ter-embed menjadi berkas terpisah
    m = DATASET_RE.search(html)
    if not m:
        sys.exit('GAGAL: tag <script id="dataset"> tidak ditemukan di mockup.')
    raw = m.group(2).strip()
    if raw:
        rows = json.loads(raw)
        out = [{
            'id': r['id'], 'tipe': r['tipe'], 'jenis': r.get('jenis', ''),
            'jalan': r['jalan'], 'kel': r['kel'], 'kec': r['kec'],
            'prio': r.get('prio', ''),
            'rlat': round(r['rlat'], 6), 'rlon': round(r['rlon'], 6),
            'povs': [[round(p['lat'], 6), round(p['lon'], 6)] for p in r['povs']],
        } for r in rows]
        os.makedirs(os.path.join(HERE, 'data'), exist_ok=True)
        dp = os.path.join(HERE, 'data', 'titik.json')
        with open(dp, 'w', encoding='utf-8') as f:
            json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
        gz = len(gzip.compress(open(dp, 'rb').read()))
        print(f'  data/titik.json  {len(out)} titik · '
              f'{os.path.getsize(dp)/1024:.0f} KB · {gz/1024:.0f} KB ter-gzip · '
              f'{sum(len(r["povs"]) for r in out)} POV')
    else:
        print('  dataset mockup sudah kosong — data/titik.json dibiarkan')

    # kosongkan tag dataset (tetap ada: dipakai fitur "Simpan HTML")
    html = DATASET_RE.sub(lambda mm: mm.group(1) + '\n' + mm.group(3), html, count=1)

    # 2 ─ gaya + markup kolaborasi
    # SheetJS untuk ekspor .xlsx dua sheet
    html = sub_once(
        html,
        '<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js"></script>',
        '<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js"></script>\n'
        '<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>',
        'muat SheetJS')

    html = sub_once(html, '</style></head><body>',
                    '\n' + read(os.path.join(SRC, 'collab.css')) +
                    '</style></head><body>', 'sisip CSS')
    html = sub_once(html, '</header>',
                    '</header>\n' + read(os.path.join(SRC, 'collab.html')).rstrip(),
                    'sisip bilah kolaborasi')
    html = sub_once(html, '<div id="toast"></div>',
                    read(os.path.join(SRC, 'gate.html')).rstrip() +
                    '\n<div id="toast"></div>', 'sisip gerbang masuk')

    # 3 ─ kaitan di JavaScript
    html = sub_once(
        html,
        '<button class="btn" id="btnCSV">Simpan CSV</button>',
        '<button class="btn" id="btnCSV">Simpan CSV</button>\n'
        '<button class="btn" id="btnXLSX" title="Excel dua sheet: rincian tiap POV, '
        'dan ringkasan jarak median per titik">Simpan Excel</button>',
        'tombol Simpan Excel')

    # CSV lama ikut mengecualikan titik terhapus, supaya sejalan dengan Excel
    html = sub_once(
        html,
        "  const rows=[['id_reklame','jenis','tipe','jalan','kelurahan','kecamatan','prioritas','reklame_lat','reklame_lon',\n"
        "    'pov_ke','pov_lat','pov_lon','jarak_m','status','perlu_dicek'].join(',')];\n"
        "  data.forEach(r=>{\n",
        "  const rows=[['id_reklame','jenis','tipe','jalan','kelurahan','kecamatan','prioritas','reklame_lat','reklame_lon',\n"
        "    'pov_ke','pov_lat','pov_lon','jarak_m','status','perlu_dicek'].join(',')];\n"
        "  data.forEach(r=>{\n"
        "    if(r.del)return;\n",
        'CSV kecualikan terhapus')

    # ── fitur hapus titik ──
    html = sub_once(
        html,
        '<button class="btn xs danger" id="eReset">Kembalikan titik ini</button>',
        '<button class="btn xs danger" id="eReset">Kembalikan titik ini</button>\n'
        '<button class="btn xs danger" id="eDel" title="Tandai titik ini terhapus. '
        'POV-nya tetap tersimpan dan bisa dipulihkan kapan saja">Hapus titik</button>',
        'tombol Hapus titik')

    html = sub_once(
        html,
        '<button type="button" data-v="flag">Perlu dicek</button>',
        '<button type="button" data-v="flag">Perlu dicek</button>\n'
        '<button type="button" data-v="deleted">Terhapus</button>',
        'filter Terhapus')

    # Titik terhapus disembunyikan dari peta, daftar, statistik, dan ekspor —
    # kecuali saat filter "Terhapus" dipilih, supaya bisa ditinjau & dipulihkan.
    html = sub_once(
        html,
        "function matches(r,skip){\n",
        "function matches(r,skip){\n"
        "  if(povMode==='deleted'){ if(!r.del)return false; }\n"
        "  else if(r.del)return false;\n",
        'saring titik terhapus')

    html = sub_once(html, DATA_INIT_OLD, DATA_INIT_NEW, 'inisialisasi data')
    html = sub_once(html, EXPORT_OLD, EXPORT_NEW, 'exportHTML')
    html = sub_once(html, RESET_OLD, RESET_NEW, 'tombol muat ulang')
    html = sub_once(html, BTN_OLD, BTN_NEW, 'label tombol')

    ekspor = read(os.path.join(SRC, 'ekspor.js'))
    collab = read(os.path.join(SRC, 'collab.js')).replace('__API_URL__', api_url)
    html = sub_once(html, INIT_OLD, ekspor + '\n' + collab, 'sisip modul ekspor + kolaborasi')

    with open(a.out, 'w', encoding='utf-8') as f:
        f.write(html)

    print(f'  index.html       {os.path.getsize(a.out)/1024:.0f} KB')
    if api_url == '__API_URL__':
        print('\n  ! API_URL belum diisi. Setelah deploy Apps Script, jalankan:')
        print('      python3 build.py --api-url https://script.google.com/macros/s/…/exec')
    else:
        print(f'  API_URL          {api_url}')


if __name__ == '__main__':
    main()
