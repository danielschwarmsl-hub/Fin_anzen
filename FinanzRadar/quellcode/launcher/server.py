#!/usr/bin/env python3
"""FinanzRadar – lokaler Start-Server (nur Python-Standardbibliothek): python3 server.py [port]

Liefert die App aus ./app aus und bietet unter /api/outlook/* eine Brücke zum klassischen Outlook
auf dem Mac (AppleScript über osascript, siehe outlook.applescript). Lauscht nur auf 127.0.0.1,
prüft den Host-Header (Schutz gegen DNS-Rebinding) und setzt keine CORS-Header.

Testmodus ohne Outlook: FINANZRADAR_OUTLOOK_MOCK=<json-datei> (Format siehe tests/fixtures/outlook-mock.json).
"""
import base64
import datetime as dt
import html.parser
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.environ.get('FINANZRADAR_APP_DIR') or os.path.join(HERE, 'app')
SCRIPT = os.path.join(HERE, 'outlook.applescript')
OSASCRIPT = '/usr/bin/osascript'
RS, US = '\x1e', '\x1f'
TIMEOUTS = {'folders': 120, 'messages': 180, 'attachments': 180, 'body': 60, 'save': 120}
MAX_LIMIT = 5000

MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic', '.heif': 'image/heif',
    '.tif': 'image/tiff', '.tiff': 'image/tiff', '.wasm': 'application/wasm', '.pdf': 'application/pdf',
    '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.txt': 'text/plain; charset=utf-8',
    '.xml': 'application/xml', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls': 'application/vnd.ms-excel', '.gz': 'application/gzip', '.ttf': 'font/ttf', '.md': 'text/markdown',
}


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def mime_for(name):
    return MIME.get(os.path.splitext(name or '')[1].lower(), 'application/octet-stream')


class _HtmlText(html.parser.HTMLParser):
    """HTML-Mail → Klartext (Zeilenumbrüche an Block-Elementen, ohne style/script)."""
    BLOCK = {'br', 'p', 'div', 'tr', 'li', 'h1', 'h2', 'h3', 'h4', 'table', 'section'}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out, self.skip = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ('style', 'script', 'head'):
            self.skip += 1
        elif tag in self.BLOCK:
            self.out.append('\n')
        elif tag == 'td':
            self.out.append('\t')

    def handle_endtag(self, tag):
        if tag in ('style', 'script', 'head'):
            self.skip = max(0, self.skip - 1)
        elif tag in self.BLOCK:
            self.out.append('\n')

    def handle_data(self, data):
        if not self.skip:
            self.out.append(data)


def html_to_text(src):
    p = _HtmlText()
    try:
        p.feed(src)
        p.close()
    except Exception:  # kaputtes HTML: Rohtext ohne Tags
        return re.sub(r'<[^>]+>', ' ', src)
    text = ''.join(p.out).replace('\xa0', ' ')
    text = re.sub(r'[ \t]+\n', '\n', text)
    return re.sub(r'\n{3,}', '\n\n', text).strip()


def de_date(iso):
    try:
        return dt.datetime.fromisoformat(iso[:19]).strftime('%d.%m.%Y %H:%M')
    except ValueError:
        return iso


def body_text(subject, sender, date, text):
    return f'Von: {sender}\nBetreff: {subject}\nDatum: {de_date(date)}\n\n{text}'


# ---------------------------------------------------------------- Backends

class MockBackend:
    """Testdaten aus einer JSON-Datei – damit die HTTP-API ohne Outlook prüfbar ist."""

    def __init__(self, path):
        with open(path, encoding='utf-8') as fh:
            self.data = json.load(fh)
        self.platform = self.data.get('platform', 'mac')

    def status(self):
        st = {'available': True, 'platform': self.platform}
        st.update(self.data.get('status') or {})
        return st

    def folders(self):
        return [{'id': str(f['id']), 'name': f['name'], 'path': f.get('path', f['name']),
                 'count': f.get('count', 0), 'inbox': bool(f.get('inbox'))} for f in self.data.get('folders', [])]

    def _msg(self, mid):
        for m in self.data.get('messages', []):
            if str(m['id']) == mid:
                return m
        raise ApiError(404, 'Mail nicht gefunden')

    @staticmethod
    def _att_bytes(a):
        if 'base64' in a:
            return base64.b64decode(a['base64'])
        return (a.get('text') or '').encode('utf-8')

    def messages(self, folder, since, limit):
        if not any(str(f['id']) == folder for f in self.data.get('folders', [])):
            raise ApiError(404, 'Ordner nicht gefunden')
        rows = [m for m in self.data.get('messages', []) if str(m.get('folder')) == folder and m['date'][:10] >= since]
        rows.sort(key=lambda m: m['date'], reverse=True)
        return [{
            'id': str(m['id']), 'subject': m.get('subject', ''), 'from': m.get('from', ''), 'date': m['date'],
            'hasBody': bool(m.get('body') or m.get('html')),
            'attachments': [{'index': i + 1, 'name': a['name'], 'size': a.get('size', len(self._att_bytes(a)))}
                            for i, a in enumerate(m.get('attachments', []))],
        } for m in rows[:limit]]

    def body(self, mid):
        m = self._msg(mid)
        text = m.get('body') or html_to_text(m.get('html') or '')
        return body_text(m.get('subject', ''), m.get('from', ''), m['date'], text)

    def attachment(self, mid, index):
        atts = self._msg(mid).get('attachments', [])
        if index > len(atts):
            raise ApiError(404, 'Anhang nicht gefunden')
        a = atts[index - 1]
        return a['name'], self._att_bytes(a)


def _outlook_installed():
    home = os.path.expanduser('~')
    for p in ('/Applications/Microsoft Outlook.app', os.path.join(home, 'Applications/Microsoft Outlook.app')):
        if os.path.isdir(p):
            return True
    try:  # an anderer Stelle installiert? Spotlight fragen
        r = subprocess.run(['/usr/bin/mdfind', "kMDItemCFBundleIdentifier == 'com.microsoft.Outlook'"],
                           capture_output=True, text=True, timeout=10)
        return bool(r.stdout.strip())
    except (OSError, subprocess.SubprocessError):
        return False


def _new_outlook_active():
    try:
        r = subprocess.run(['/usr/bin/defaults', 'read', 'com.microsoft.Outlook', 'IsRunningNewOutlook'],
                           capture_output=True, text=True, timeout=10)
        return r.returncode == 0 and r.stdout.strip() in ('1', 'true', 'YES')
    except (OSError, subprocess.SubprocessError):
        return False


NEW_OUTLOOK = ('„Neues Outlook“ ist aktiv – es unterstützt keine Skript-Anbindung. '
               'In Outlook im Menü „Outlook“ das „Neue Outlook“ ausschalten (Legacy-Outlook).')


def _osascript_error(stderr):
    s = stderr or ''
    if '-1743' in s or 'Not authorized' in s or 'nicht berechtigt' in s:
        return ApiError(403, 'Zugriff auf Outlook nicht erlaubt: Systemeinstellungen → Datenschutz & Sicherheit → '
                             'Automation → Terminal (bzw. Python) → „Microsoft Outlook“ aktivieren.')
    if '-1728' in s or '-1700' in s:
        return ApiError(404, 'Objekt in Outlook nicht gefunden (Mail oder Ordner gelöscht/verschoben?)')
    if '-1708' in s or '-10000' in s:
        return ApiError(503, NEW_OUTLOOK)
    if '-600' in s or '-609' in s:
        return ApiError(503, 'Outlook läuft nicht bzw. antwortet nicht.')
    line = s.strip().splitlines()[-1] if s.strip() else 'unbekannter Fehler'
    return ApiError(502, 'Outlook-Fehler: ' + line[:300])


class MacBackend:
    platform = 'mac'

    def __init__(self):
        self.lock = threading.Lock()  # Outlook beantwortet Apple Events ohnehin nacheinander
        self.save_base = None

    def status(self):
        if not os.path.exists(OSASCRIPT):
            return {'available': False, 'platform': 'mac', 'reason': 'osascript fehlt auf diesem System.'}
        if not os.path.exists(SCRIPT):
            return {'available': False, 'platform': 'mac', 'reason': 'outlook.applescript fehlt neben server.py.'}
        if not _outlook_installed():
            return {'available': False, 'platform': 'mac', 'reason': 'Microsoft Outlook ist nicht installiert.'}
        if _new_outlook_active():
            return {'available': False, 'platform': 'mac', 'reason': NEW_OUTLOOK}
        return {'available': True, 'platform': 'mac'}

    def _run(self, cmd, *args):
        timeout = TIMEOUTS.get(cmd, 60)
        if not self.lock.acquire(timeout=timeout):
            raise ApiError(503, 'Outlook ist beschäftigt – bitte gleich erneut versuchen.')
        try:
            r = subprocess.run([OSASCRIPT, SCRIPT, cmd, *args], capture_output=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            raise ApiError(504, 'Outlook antwortet nicht (Zeitlimit überschritten).')
        except OSError as e:
            raise ApiError(500, f'osascript nicht startbar: {e}')
        finally:
            self.lock.release()
        if r.returncode != 0:
            raise _osascript_error(r.stderr.decode('utf-8', 'replace'))
        out = r.stdout.decode('utf-8', 'replace')
        return out[:-1] if out.endswith('\n') else out

    def _records(self, cmd, *args):
        out = self._run(cmd, *args)
        return [rec.split(US) for rec in out.split(RS) if rec.strip()] if out else []

    def folders(self):
        res = []
        for f in self._records('folders'):
            if len(f) < 5:
                continue
            res.append({'id': f[0], 'name': f[1], 'path': f[2], 'count': int(f[3] or 0) if f[3].isdigit() else 0,
                        'inbox': f[4] == '1'})
        if not res and _new_outlook_active():
            raise ApiError(503, NEW_OUTLOOK)
        return res

    def _attachments(self, ids):
        atts = {}
        for i in range(0, len(ids), 200):
            for a in self._records('attachments', *ids[i:i + 200]):
                if len(a) >= 4 and a[1].isdigit():
                    atts.setdefault(a[0], []).append({'index': int(a[1]), 'name': a[2],
                                                      'size': int(a[3]) if a[3].isdigit() else None})
        return atts

    @staticmethod
    def _num(v):
        if not re.fullmatch(r'\d{1,15}', v):  # Outlook (Mac) vergibt numerische IDs
            raise ApiError(400, 'Ungültige ID')
        return v

    def messages(self, folder, since, limit):
        folder = self._num(folder)
        msgs = []
        for m in self._records('messages', folder, since):
            if len(m) >= 4:
                msgs.append({'id': m[0], 'subject': m[1], 'from': m[2], 'date': m[3], 'hasBody': True})
        msgs.sort(key=lambda m: m['date'], reverse=True)
        msgs = msgs[:limit]
        atts = self._attachments([m['id'] for m in msgs]) if msgs else {}
        for m in msgs:
            m['attachments'] = atts.get(m['id'], [])
        return msgs

    def body(self, mid):
        parts = self._run('body', self._num(mid)).split(US, 4)
        if len(parts) < 5:
            raise ApiError(502, 'Unerwartete Antwort von Outlook')
        subject, sender, date, is_html, text = parts
        return body_text(subject, sender, date, html_to_text(text) if is_html == '1' else text.strip())

    def attachment(self, mid, index):
        mid = self._num(mid)
        found = [a for a in self._attachments([mid]).get(mid, []) if a['index'] == index]
        if not found:
            raise ApiError(404, 'Anhang nicht gefunden')
        name = found[0]['name'] or f'Anhang{index}'
        safe = re.sub(r'[\\/:\x00-\x1f]', '_', name).strip('. ') or f'Anhang{index}'
        # Outlook ist sandboxed und darf nicht überall schreiben: System-Temp, sonst Outlooks eigener Container,
        # sonst Downloads. Der erste funktionierende Ordner wird gemerkt.
        bases = [tempfile.gettempdir(), os.path.expanduser('~/Library/Containers/com.microsoft.Outlook/Data/tmp'),
                 os.path.expanduser('~/Downloads')]
        if self.save_base in bases:
            bases.remove(self.save_base)
            bases.insert(0, self.save_base)
        last = None
        for base in bases:
            if not os.path.isdir(base):
                continue
            tmp = tempfile.mkdtemp(prefix='finanzradar-', dir=base)
            try:
                dest = os.path.join(tmp, safe)
                self._run('save', mid, str(index), dest)
                if os.path.isfile(dest):
                    with open(dest, 'rb') as fh:
                        data = fh.read()
                    self.save_base = base
                    return name, data
                last = ApiError(502, 'Outlook hat den Anhang nicht gespeichert.')
            except ApiError as e:
                last = e
            finally:
                shutil.rmtree(tmp, ignore_errors=True)
        raise last or ApiError(500, 'Kein Temp-Ordner verfügbar')


class UnsupportedBackend:
    platform = 'windows' if sys.platform.startswith('win') else 'other'

    def status(self):
        reason = ('Unter Windows FinanzRadar über „FinanzRadar starten (Windows).bat“ öffnen.'
                  if self.platform == 'windows' else 'Outlook-Anbindung gibt es nur auf Mac und Windows.')
        return {'available': False, 'platform': self.platform, 'reason': reason}

    def _no(self, *_):
        raise ApiError(503, self.status()['reason'])

    folders = messages = body = attachment = _no


def make_backend():
    mock = os.environ.get('FINANZRADAR_OUTLOOK_MOCK')
    if mock:
        return MockBackend(mock)
    return MacBackend() if sys.platform == 'darwin' else UnsupportedBackend()


# ---------------------------------------------------------------- HTTP

ID_RE = re.compile(r'^[A-Za-z0-9._:-]{1,4096}$')


def _param(q, name):
    v = q.get(name)
    return v[0] if v else None


def _id(q, name='id'):
    v = _param(q, name)
    if not v or not ID_RE.match(v):
        raise ApiError(400, f'Ungültiger Parameter: {name}')
    return v


def _since(q):
    v = _param(q, 'since')
    if not v:
        return (dt.date.today() - dt.timedelta(days=365)).isoformat()
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', v):
        _bad('since')
    try:
        return dt.date.fromisoformat(v).isoformat()
    except ValueError:
        _bad('since')


def _int(q, name, default, lo, hi):
    v = _param(q, name)
    if v is None:
        return default
    if not re.fullmatch(r'\d{1,6}', v) or not lo <= int(v) <= hi:
        _bad(name)
    return int(v)


def _bad(name):
    raise ApiError(400, f'Ungültiger Parameter: {name}')


class Handler(SimpleHTTPRequestHandler):
    backend = None
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, **MIME}

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def _allowed_hosts(self):
        port = self.server.server_address[1]
        return {f'localhost:{port}', f'127.0.0.1:{port}'}

    def _host_ok(self):
        return (self.headers.get('Host') or '').lower() in self._allowed_hosts()

    def _send(self, status, body, ctype):
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def _json(self, status, obj):
        self._send(status, json.dumps(obj, ensure_ascii=False).encode('utf-8'), 'application/json; charset=utf-8')

    def do_HEAD(self):
        if not self._host_ok():
            return self._send(403, b'forbidden', 'text/plain')
        super().do_HEAD()

    def do_GET(self):
        if not self._host_ok():
            return self._send(403, b'forbidden', 'text/plain')
        url = urlsplit(self.path)
        if url.path.startswith('/api/'):
            return self._api(url)
        super().do_GET()

    def _api(self, url):
        # Nur die eigene Seite darf fragen (keine CORS-Header; zusätzlich Fetch-Metadaten/Origin prüfen)
        site = self.headers.get('Sec-Fetch-Site')
        origin = self.headers.get('Origin')
        if (site and site not in ('same-origin', 'none')) or (
                origin and origin.lower() not in {'http://' + h for h in self._allowed_hosts()}):
            return self._json(403, {'error': 'Nur von FinanzRadar selbst erlaubt'})
        q = parse_qs(url.query)
        b = self.backend
        try:
            route = url.path
            if route == '/api/outlook/status':
                return self._json(200, b.status())
            if route == '/api/outlook/folders':
                return self._json(200, b.folders())
            if route == '/api/outlook/messages':
                return self._json(200, b.messages(_id(q, 'folder'), _since(q), _int(q, 'limit', 500, 1, MAX_LIMIT)))
            if route == '/api/outlook/body':
                return self._send(200, b.body(_id(q)).encode('utf-8'), 'text/plain; charset=utf-8')
            if route == '/api/outlook/attachment':
                name, data = b.attachment(_id(q), _int(q, 'index', None, 1, 999) or _bad('index'))
                return self._send(200, data, mime_for(name))
            raise ApiError(404, 'Unbekannter Endpunkt')
        except ApiError as e:
            return self._json(e.status, {'error': str(e)})
        except Exception as e:  # nie mit Stacktrace antworten
            self.log_error('API-Fehler: %r', e)
            return self._json(500, {'error': f'Interner Fehler: {e.__class__.__name__}'})

    def log_message(self, fmt, *args):
        if os.environ.get('FINANZRADAR_QUIET'):
            return
        super().log_message(fmt, *args)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    Handler.backend = make_backend()
    httpd = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    port = httpd.server_address[1]
    print(f'FinanzRadar läuft auf http://localhost:{port}/  (Fenster offen lassen, Beenden mit Ctrl+C)', flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
