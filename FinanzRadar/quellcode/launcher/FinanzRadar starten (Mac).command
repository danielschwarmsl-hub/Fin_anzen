#!/bin/bash
# FinanzRadar – lokaler Start (macOS). Doppelklick genügt.
cd "$(dirname "$0")/app" || exit 1
PORT=8765
URL="http://localhost:$PORT/"
echo "FinanzRadar läuft auf $URL  (Fenster offen lassen, Beenden mit Ctrl+C)"
( sleep 1.2; open "$URL" ) &
# Bevorzugt server.py (App + Outlook-Brücke), sonst server.mjs (ebenfalls mit Brücke), sonst nur statisch
if [ -f ../server.py ] && command -v python3 >/dev/null 2>&1 && python3 -c "import sys, http.server; sys.exit(sys.version_info < (3, 7))" >/dev/null 2>&1; then
  exec python3 ../server.py $PORT
elif [ -f ../server.mjs ] && command -v node >/dev/null 2>&1; then
  exec node ../server.mjs $PORT
elif command -v python3 >/dev/null 2>&1 && python3 -c "import http.server" >/dev/null 2>&1; then
  exec python3 -m http.server $PORT --bind 127.0.0.1
elif command -v ruby >/dev/null 2>&1; then
  exec ruby -run -e httpd . -p $PORT -b 127.0.0.1
elif command -v php >/dev/null 2>&1; then
  exec php -S 127.0.0.1:$PORT
elif command -v node >/dev/null 2>&1; then
  exec node ../server.mjs $PORT
else
  osascript -e 'display alert "FinanzRadar" message "Kein Python/Ruby/Node gefunden. Bitte Python 3 von python.org installieren."'
fi
