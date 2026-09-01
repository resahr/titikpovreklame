#!/usr/bin/env bash
# Menuntun tiga langkah otentikasi, satu per satu, dan MEMERIKSA hasilnya.
# Jalankan: ./login.sh
set -uo pipefail
cd "$(dirname "$0")"

AKUN_GITHUB="resahr"
AKUN_GOOGLE="biosphereplus.official@gmail.com"   # pemilik project Apps Script + Spreadsheet data

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
oke()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn()  { printf '  \033[33m!\033[0m %s\n' "$*"; }
bad()   { printf '  \033[31m✗\033[0m %s\n' "$*"; }

# ── periksa izin Google yang benar-benar diberikan ──
# clasp tidak menyimpan daftar scope, jadi ditanyakan langsung ke Google.
cek_google() {   # -> "email|ok" / "email|kurang" / "|belum"
  local tok email scope
  tok=$(python3 -c "
import json,os
try:
    print(json.load(open(os.path.expanduser('~/.clasprc.json')))['tokens']['default']['access_token'])
except Exception: pass" 2>/dev/null)
  [ -n "$tok" ] || { echo "|belum"; return; }
  curl -s --max-time 20 "https://oauth2.googleapis.com/tokeninfo?access_token=${tok}" \
    | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print('|belum'); raise SystemExit
if 'error' in d: print('|belum'); raise SystemExit
got=set(d.get('scope','').split())
perlu={'https://www.googleapis.com/auth/script.projects',
       'https://www.googleapis.com/auth/script.deployments'}
print(d.get('email','')+'|'+('ok' if perlu<=got else 'kurang'))" 2>/dev/null || echo "|belum"
}

printf '\n'
bold '════ LANGKAH 1 dari 3 — Aktifkan Apps Script API ════'
cat <<'EOF'

  Browser akan terbuka ke pengaturan Google Apps Script.
  Ada SATU tombol geser: "Google Apps Script API"  ->  geser ke ON (biru).

  PENTING: pastikan Anda sedang login sebagai akun yang benar.
  Cek pojok kanan atas halaman itu.
EOF
printf '\n  Tekan ENTER untuk membuka... '; read -r _
open "https://script.google.com/home/usersettings" 2>/dev/null || \
  echo "  Buka manual: https://script.google.com/home/usersettings"
printf '\n  Sudah ON? Tekan ENTER untuk lanjut... '; read -r _

printf '\n'
bold '════ LANGKAH 2 dari 3 — Login Google ════'

STATUS=$(cek_google); EMAIL="${STATUS%%|*}"; HASIL="${STATUS##*|}"

if [ "$HASIL" = "ok" ] && [ "$EMAIL" = "$AKUN_GOOGLE" ]; then
  oke "sudah login sebagai $EMAIL dengan izin lengkap"
else
  [ "$HASIL" = "kurang" ] && bad "login sebagai $EMAIL, tapi izin Apps Script TIDAK diberikan"
  [ "$HASIL" = "ok" ] && [ "$EMAIL" != "$AKUN_GOOGLE" ] && \
    warn "login sebagai $EMAIL, padahal Drive pekerjaan ini milik $AKUN_GOOGLE"

  cat <<EOF

  Login ulang. Dua hal yang sering terlewat:

    1. Pilih akun  ${AKUN_GOOGLE}
       (pemilik Google Drive tempat berkas reklame ini).

    2. Di layar izin, Google menampilkan beberapa KOTAK CENTANG.
       >>> CENTANG SEMUANYA <<<  atau klik "Select all".
       Kalau tidak dicentang, Google tetap lanjut tapi tanpa izin
       membuat Apps Script — itu yang membuat percobaan tadi gagal.

    3. Kalau muncul "Google hasn't verified this app":
       Advanced  ->  Go to clasp (unsafe)  ->  Allow

EOF
  printf '  Tekan ENTER untuk login ulang... '; read -r _
  clasp logout >/dev/null 2>&1
  clasp login

  STATUS=$(cek_google); EMAIL="${STATUS%%|*}"; HASIL="${STATUS##*|}"
  if [ "$HASIL" != "ok" ]; then
    bad "izin Apps Script masih belum diberikan (akun: ${EMAIL:-tidak terbaca})"
    echo
    echo "  Ulangi ./login.sh dan pastikan SEMUA kotak centang tercentang."
    exit 1
  fi
  oke "login Google berhasil sebagai $EMAIL — izin lengkap"
  [ "$EMAIL" != "$AKUN_GOOGLE" ] && \
    warn "catatan: Spreadsheet data nanti lahir di Drive $EMAIL"
fi

printf '\n'
bold '════ LANGKAH 3 dari 3 — Login GitHub ════'
if gh auth status >/dev/null 2>&1; then
  SIAPA=$(gh api user -q .login 2>/dev/null)
  if [ "$SIAPA" = "$AKUN_GITHUB" ]; then
    oke "sudah login GitHub sebagai $SIAPA"
  else
    warn "login sebagai '$SIAPA', bukan '$AKUN_GITHUB'"
    printf '\n  Ganti akun? [y/N] '; read -r JWB
    case "$JWB" in
      y|Y) gh auth logout --hostname github.com 2>/dev/null
           gh auth login --hostname github.com --git-protocol https --web ;;
    esac
  fi
else
  cat <<EOF

  Terminal akan menampilkan KODE seperti "1A2B-3C4D".
  Salin kode itu, tekan ENTER, lalu tempel di browser.

  PENTING: login sebagai akun  ${AKUN_GITHUB}
  Kalau browser sudah login akun lain, pakai jendela Samaran/Incognito.

EOF
  printf '  Tekan ENTER untuk mulai... '; read -r _
  gh auth login --hostname github.com --git-protocol https --web
fi

if ! gh auth status >/dev/null 2>&1; then
  bad "login GitHub belum berhasil — ulangi ./login.sh"; exit 1
fi
oke "login GitHub sebagai $(gh api user -q .login 2>/dev/null)"

printf '\n'
bold '════ SEMUA SIAP ════'
printf '\n  Sekarang jalankan:\n\n      ./deploy.sh\n\n'
