#!/bin/bash
# Baut FinanzRadar und packt eine startfertige ZIP (App + Start-Skripte + Quellcode)
set -e
cd "$(dirname "$0")/.."
OUT=${1:-release}
rm -rf "$OUT/FinanzRadar" && mkdir -p "$OUT/FinanzRadar"
npx vite build --outDir "$OUT/FinanzRadar/app" --emptyOutDir >/dev/null
cp "launcher/FinanzRadar starten (Mac).command" "launcher/FinanzRadar starten (Windows).bat" launcher/server.ps1 launcher/server.mjs "$OUT/FinanzRadar/"
chmod +x "$OUT/FinanzRadar/FinanzRadar starten (Mac).command"
cp README.md "$OUT/FinanzRadar/LIESMICH.md"
mkdir -p "$OUT/FinanzRadar/quellcode"
tar --exclude=node_modules --exclude=dist --exclude=release --exclude=public/vendor --exclude=public/samples --exclude=.git -cf - . | tar -xf - -C "$OUT/FinanzRadar/quellcode"
rm -rf "$OUT/FinanzRadar/quellcode/$OUT"
(cd "$OUT" && rm -f FinanzRadar.zip && zip -qr -X FinanzRadar.zip FinanzRadar)
du -sh "$OUT/FinanzRadar.zip"
