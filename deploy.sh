#!/usr/bin/env bash
# Deploy WebGIS Titik POV: Apps Script (backend) + GitHub Pages (halaman).
#
#   ./deploy.sh [nama-repo]        default: titikpovreklame
#
# Aman dijalankan berulang: langkah yang sudah selesai akan dilewati.
set -uo pipefail
cd "$(dirname "$0")"

REPO="${1:-titikpovreklame}"
AKUN_GITHUB="resahr"
JUDUL="Reklame POV — Data Editan"

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
info()  { printf '  %s\n' "$*"; }
oke()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
gagal() { printf '\n\033[31m✗ %s\033[0m\n\n' "$*"; exit 1; }

# ─────────────────────────────────────────────────────────────
bold $'\n1/6  Memeriksa login Google (clasp)'

# clasp selalu keluar dengan status 0, jadi status login dibaca dari isinya.
if [ "$(clasp --json show-authorized-user 2>/dev/null \
        | python3 -c 'import json,sys;print(json.load(sys.stdin).get("loggedIn"))' 2>/dev/null)" != "True" ]; then
  cat <<'EOF'

  Belum login ke Google. Dua hal yang harus Anda lakukan sendiri:

  a) Aktifkan Apps Script API — buka sekali, geser tombolnya ke ON:
       https://script.google.com/home/usersettings

  b) Login clasp (akan membuka browser):
       clasp login

  Lalu jalankan ./deploy.sh lagi.

EOF
  exit 1
fi
AKUN_GOOGLE=$(clasp --json show-authorized-user 2>/dev/null \
  | python3 -c 'import json,sys;print(json.load(sys.stdin).get("email",""))' 2>/dev/null)
oke "login Google sebagai ${AKUN_GOOGLE:-(tidak terbaca)}"
info "Spreadsheet data akan lahir di akun ini. Salah akun? clasp logout && clasp login"

# ─────────────────────────────────────────────────────────────
bold $'\n2/6  Membuat project Apps Script + Spreadsheet'

if [ -f .clasp.json ]; then
  oke "project sudah ada (.clasp.json), dilewati"
else
  # Sengaja 'standalone', bukan '--type sheets': skrip menempel butuh izin
  # Google Drive yang tidak diminta oleh 'clasp login'. Spreadsheet-nya
  # dibuat oleh skrip itu sendiri saat Anda memberi izin di langkah akhir.
  if ! clasp create-script --title "$JUDUL" --rootDir apps-script 2>&1 | tee /tmp/clasp-create.log; then
    if grep -qi 'Apps Script API' /tmp/clasp-create.log; then
      gagal "Apps Script API belum aktif. Buka https://script.google.com/home/usersettings, geser ke ON, lalu ulangi."
    fi
    if grep -qi 'insufficient authentication scopes' /tmp/clasp-create.log; then
      gagal "Izin login Google kurang. Jalankan:  clasp logout && clasp login  lalu ulangi."
    fi
    gagal "Gagal membuat project. Lihat /tmp/clasp-create.log"
  fi
  oke "project Apps Script dibuat"
fi

SCRIPT_ID=$(python3 -c "import json;print(json.load(open('.clasp.json'))['scriptId'])" 2>/dev/null) \
  || gagal "scriptId tidak terbaca dari .clasp.json"
info "scriptId: $SCRIPT_ID"

# clasp create-script MENIMPA appsscript.json dengan manifest bawaan Google,
# yang tidak punya blok "webapp". Tanpa blok itu, yang terbit bukan web app
# melainkan library — dan URL /exec menjawab "Page Not Found".
# Karena itu manifest ditulis ulang di sini, SEBELUM push, setiap kali.
cat > apps-script/appsscript.json <<'MANIFEST'
{
  "timeZone": "Asia/Jakarta",
  "dependencies": {},
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8",
  "webapp": {
    "executeAs": "USER_DEPLOYING",
    "access": "ANYONE_ANONYMOUS"
  }
}
MANIFEST
oke "manifest web app dipulihkan"

# ─────────────────────────────────────────────────────────────
bold $'\n3/6  Mengunggah kode backend'

clasp push -f >/dev/null 2>&1 || gagal "clasp push gagal"
oke "Code.gs + appsscript.json terunggah"

# ─────────────────────────────────────────────────────────────
bold $'\n4/6  Menerbitkan sebagai Web App'

# Deployment yang sudah dipakai tim, dibaca dari config.json.
LAMA=$(python3 -c "
import json,os,re
try:
    u=json.load(open('config.json')).get('api_url','')
    m=re.search(r'/macros/s/([A-Za-z0-9_-]+)/exec',u)
    print(m.group(1) if m else '')
except Exception: print('')" 2>/dev/null)

if [ -n "$LAMA" ]; then
  # PERBARUI deployment yang ada — URL /exec tidak berubah, sehingga
  # tab yang sedang terbuka di komputer tim tidak putus.
  # Membuat deployment baru akan mengganti URL dan memutus semua orang.
  info "memperbarui deployment yang sudah dipakai tim (URL tidak berubah)"
  clasp redeploy "$LAMA" -d "webgis-pov $(date +%Y%m%d-%H%M)" >/tmp/clasp-deploy.log 2>&1 \
    || { cat /tmp/clasp-deploy.log; gagal "redeploy gagal"; }
  DEPLOY_ID="$LAMA"
else
  info "belum ada deployment tersimpan — membuat yang pertama"
  clasp create-deployment -d "webgis-pov $(date +%Y%m%d-%H%M)" >/tmp/clasp-deploy.log 2>&1 \
    || { cat /tmp/clasp-deploy.log; gagal "deploy gagal"; }
  # ID diambil dari keluaran create-deployment ini juga ("Deployed AKfyc... @n").
  # Jangan pakai `list-deployments | tail -1`: urutannya tidak dijamin, dan
  # deployment @HEAD yang selalu ada bisa terpilih — itu bukan yang kita terbitkan.
  DEPLOY_ID=$(grep -oE 'AKfyc[A-Za-z0-9_-]+' /tmp/clasp-deploy.log | head -1)
fi
[ -n "$DEPLOY_ID" ] || { cat /tmp/clasp-deploy.log; gagal "deploymentId tidak terbaca"; }

API_URL="https://script.google.com/macros/s/${DEPLOY_ID}/exec"
oke "web app terbit"
info "$API_URL"

# ─────────────────────────────────────────────────────────────
bold $'\n5/6  Menanam URL ke halaman'

python3 build.py --api-url "$API_URL" >/dev/null || gagal "build.py gagal"
grep -q "$DEPLOY_ID" index.html || gagal "API_URL tidak masuk ke index.html"
oke "index.html menunjuk ke backend Anda"

# ─────────────────────────────────────────────────────────────
bold $'\n6/6  Mengunggah ke GitHub Pages'

if ! gh auth status >/dev/null 2>&1; then
  cat <<'EOF'

  Belum login GitHub. Jalankan (akan membuka browser):

       gh auth login

  Pilih: GitHub.com -> HTTPS -> Login with a web browser.
  Lalu jalankan ./deploy.sh lagi — langkah 1-5 akan dilewati.

EOF
  exit 1
fi
OWNER=$(gh api user -q .login)
if [ "$OWNER" != "$AKUN_GITHUB" ]; then
  gagal "Login GitHub sebagai '$OWNER', padahal repo diminta di akun '$AKUN_GITHUB'.
     Ganti akun:  gh auth logout --hostname github.com  lalu  ./login.sh
     Atau ubah AKUN_GITHUB di bagian atas deploy.sh."
fi
oke "login GitHub sebagai $OWNER"

[ -d .git ] || { git init -q; git branch -M main; }

# Perkakas ikut masuk repo supaya bisa dibangun ulang dari mesin mana pun.
# Tidak ada rahasia di dalamnya: kode akses tim tinggal di Spreadsheet,
# dan API_URL memang harus publik karena browser yang memanggilnya.
cat > .gitignore <<'EOF'
.clasp.json
config.json
node_modules/
index.test.html
.DS_Store
EOF

git add -A >/dev/null 2>&1
git commit -qm "WebGIS titik POV kolaboratif — 2.420 titik" >/dev/null 2>&1 \
  || info "tidak ada perubahan baru untuk di-commit"

if gh repo view "$REPO" >/dev/null 2>&1; then
  info "repo $REPO sudah ada, mendorong perubahan"
  git remote get-url origin >/dev/null 2>&1 || \
    git remote add origin "$(gh repo view "$REPO" --json url -q .url).git"
  git push -q -u origin main --force-with-lease || gagal "git push gagal"
else
  gh repo create "$REPO" --public --source=. --remote=origin --push >/dev/null 2>&1 \
    || gagal "gh repo create gagal"
fi
oke "kode terdorong ke GitHub"

gh api -X POST "repos/$OWNER/$REPO/pages" \
  -f 'source[branch]=main' -f 'source[path]=/' >/dev/null 2>&1 \
  && oke "GitHub Pages diaktifkan" \
  || info "Pages sudah aktif (atau perlu diaktifkan manual di Settings › Pages)"

PAGES="https://${OWNER}.github.io/${REPO}/"

# ─────────────────────────────────────────────────────────────
cat <<EOF

$(bold 'SELESAI')

  Tautan WebGIS   : ${PAGES}
  Backend         : ${API_URL}
  Spreadsheet     : dibuat otomatis di Drive ${AKUN_GOOGLE} setelah langkah 1 di bawah

  $(bold 'Dua langkah terakhir — sekali saja:')

  1. Buka ${API_URL} di browser, login dengan akun Google Anda.
     Google akan minta izin sekali (Advanced › Go to … › Allow).
     Setelah itu backend hidup dan Spreadsheet-nya terisi otomatis.

  2. Buka Spreadsheet "${JUDUL}", lihat sheet 'info'.
     Di sana tertulis KODE AKSES TIM.
     Bagikan kode itu bersama tautan di atas ke tim Anda.

  GitHub Pages butuh 1-3 menit sebelum tautannya hidup.

EOF
