#!/usr/bin/env python3
"""QB uplink relay — run this on your VPS (Python 3.8+, zero dependencies).

Receives fetched qbank files + progress events from the browser script
(24-allbanks-uplink.js), saves files to disk, forwards events to Telegram,
and serves a status page you can open from your phone.

SETUP
  export QB_TOKEN="$(openssl rand -hex 24)"     # shared secret with the browser
  export TG_TOKEN="123456:ABC-DEF..."           # optional, from @BotFather
  export TG_CHAT="123456789"                    # optional, your chat id
  export PORT=8787                              # optional, default 8787
  export QB_DATA="$HOME/qb-data"                # optional, default ~/qb-data
  nohup python3 vps-relay.py >> relay.log 2>&1 &

ENDPOINTS
  POST /qb/upload?path=<qbank/path.json>  (X-QB-Token)  raw JSON body -> saved file
  POST /qb/event                          (X-QB-Token)  {text, level} -> log + Telegram
  GET  /qb/paths                          (X-QB-Token)  {paths:[...]} -> manifest (for resume)
  GET  /qb/status                                        JSON status (counts, recent activity)
  GET  /                                                   HTML status page (auto-refresh 30s)

IMPORTANT: the browser can only call this over https (mixed-content rules).
If you have no domain/cert, use a Cloudflare quick tunnel:
    cloudflared tunnel --url http://localhost:8787
and use the https://....trycloudflare.com URL as VPS_URL.
"""
import json
import os
import threading
import time
import hmac
import urllib.parse
import urllib.request
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = int(os.environ.get("PORT", "8787"))
QB_TOKEN = os.environ.get("QB_TOKEN", "")
TG_TOKEN = os.environ.get("TG_TOKEN", "")
TG_CHAT = os.environ.get("TG_CHAT", "")
ALLOW_ORIGIN = os.environ.get("ALLOW_ORIGIN", "*")
DATA_DIR = Path(os.environ.get("QB_DATA", str(Path.home() / "qb-data")))
MAX_BODY = 60 * 1024 * 1024  # 60 MB safety cap

DATA_DIR.mkdir(parents=True, exist_ok=True)
MANIFEST = DATA_DIR / "manifest.jsonl"
EVENTS_LOG = DATA_DIR / "events.log"

lock = threading.Lock()
paths = set()               # uploaded file paths
sizes = {}                  # path -> bytes
recent_uploads = deque(maxlen=200)
recent_events = deque(maxlen=50)
last_upload_at = None
last_event_at = None
started_at = time.time()


def load_manifest():
    if MANIFEST.exists():
        with MANIFEST.open("r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                    p = rec.get("path")
                    if p:
                        paths.add(p)
                        sizes[p] = rec.get("size", 0)
                        recent_uploads.append(p)
                except Exception:
                    pass


load_manifest()


def safe_path(raw):
    """Turn an arbitrary qbank path into a safe relative Path (no traversal)."""
    raw = str(raw).replace("\\", "/")
    parts = [x for x in raw.split("/") if x not in ("", ".", "..")]
    if not parts:
        raise ValueError("empty path")
    return Path(*parts)


def tg_send(text):
    if not TG_TOKEN or not TG_CHAT:
        return
    payload = json.dumps({"chat_id": TG_CHAT, "text": str(text)[:4000]}).encode("utf-8")
    req = urllib.request.Request(
        "https://api.telegram.org/bot%s/sendMessage" % TG_TOKEN,
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    try:
        urllib.request.urlopen(req, timeout=6).read()
    except Exception as e:  # never crash the relay over Telegram
        print("telegram error:", e, flush=True)


STATUS_HTML = """<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QB status</title>
<style>
 body{font-family:system-ui,sans-serif;background:#111;color:#ddd;margin:0;padding:16px}
 h1{font-size:20px;color:#0f0;margin:0 0 12px}
 .cards{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}
 .card{background:#1b1b1b;border:1px solid #333;border-radius:8px;padding:10px 14px;min-width:110px}
 .card b{display:block;font-size:24px;color:#fff}
 .card span{font-size:12px;color:#888}
 h2{font-size:14px;color:#0ff;margin:16px 0 6px}
 ul{list-style:none;padding:0;margin:0;font-size:13px;max-height:260px;overflow:auto}
 li{padding:3px 0;border-bottom:1px solid #222;word-break:break-all}
 .ev{color:#aaa}.ev.warn{color:#fa0}.ev.error{color:#f55}
 .tag{font-size:11px;color:#555}
</style></head><body>
<h1>QB fetch status</h1>
<div class="cards">
 <div class="card"><b id="files">-</b><span>files on VPS</span></div>
 <div class="card"><b id="mb">-</b><span>MB stored</span></div>
 <div class="card"><b id="tg">-</b><span>telegram</span></div>
 <div class="card"><b id="up">-</b><span>uptime h</span></div>
</div>
<div class="tag" id="last"></div>
<h2>Recent events</h2><ul id="events"><li>loading...</li></ul>
<h2>Recent uploads</h2><ul id="uploads"><li>loading...</li></ul>
<script>
async function tick(){
 try{
  const s = await (await fetch('/qb/status')).json();
  document.getElementById('files').textContent = s.files;
  document.getElementById('mb').textContent = (s.bytes/1048576).toFixed(1);
  document.getElementById('tg').textContent = s.telegram ? 'on' : 'off';
  document.getElementById('up').textContent = (s.uptimeSec/3600).toFixed(1);
  document.getElementById('last').textContent =
    'last upload: ' + (s.lastUploadAt||'never') + '  |  last event: ' + (s.lastEventAt||'never');
  document.getElementById('events').innerHTML = (s.recentEvents||[]).slice().reverse().map(e =>
    '<li class="ev '+e.level+'">['+e.at+'] '+esc(e.text.split('\\n')[0])+'</li>').join('') || '<li>none yet</li>';
  document.getElementById('uploads').innerHTML = (s.recentUploads||[]).slice().reverse().map(p =>
    '<li>'+esc(p)+'</li>').join('') || '<li>none yet</li>';
 }catch(e){ document.getElementById('last').textContent = 'relay unreachable: '+e; }
}
function esc(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
tick(); setInterval(tick, 30000);
</script></body></html>
"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # quiet access log

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", ALLOW_ORIGIN)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-QB-Token")
        self.send_header("Access-Control-Max-Age", "86400")

    def _send(self, body, ctype, code=200):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(json.dumps(obj).encode("utf-8"), "application/json", code)

    def _authed(self):
        tok = self.headers.get("X-QB-Token", "") or ""
        return bool(QB_TOKEN) and hmac.compare_digest(tok, QB_TOKEN)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        route = parsed.path.rstrip("/") or "/"

        if route in ("/qb/status", "/status"):
            with lock:
                obj = {
                    "ok": True,
                    "files": len(paths),
                    "bytes": sum(sizes.values()),
                    "lastUploadAt": last_upload_at,
                    "lastEventAt": last_event_at,
                    "recentEvents": list(recent_events)[-20:],
                    "recentUploads": list(recent_uploads)[-50:],
                    "uptimeSec": int(time.time() - started_at),
                    "telegram": bool(TG_TOKEN and TG_CHAT),
                    "dataDir": str(DATA_DIR),
                }
            return self._json(obj)

        if route == "/qb/paths":
            if not self._authed():
                return self._json({"error": "unauthorized"}, 401)
            with lock:
                return self._json({"paths": sorted(paths)})

        if route == "/":
            return self._send(STATUS_HTML.encode("utf-8"), "text/html; charset=utf-8")

        return self._json({"error": "not found"}, 404)

    def do_POST(self):
        if not self._authed():
            return self._json({"error": "unauthorized"}, 401)

        parsed = urllib.parse.urlparse(self.path)
        route = parsed.path.rstrip("/")

        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return self._json({"error": "empty body"}, 400)
        if length > MAX_BODY:
            return self._json({"error": "body too large"}, 413)
        raw = self.rfile.read(length)

        if route == "/qb/upload":
            q = urllib.parse.parse_qs(parsed.query)
            rel = (q.get("path") or [""])[0]
            if not rel:
                return self._json({"error": "missing ?path="}, 400)
            try:
                dest = DATA_DIR / safe_path(rel)
            except ValueError:
                return self._json({"error": "bad path"}, 400)
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(raw)
            key = str(dest.relative_to(DATA_DIR)).replace("\\", "/")
            now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            with lock:
                paths.add(key)
                sizes[key] = len(raw)
                recent_uploads.append(key)
                globals()["last_upload_at"] = now
            with MANIFEST.open("a", encoding="utf-8") as f:
                f.write(json.dumps({"path": key, "size": len(raw), "at": now}) + "\n")
            return self._json({"ok": True, "files": len(paths)})

        if route == "/qb/event":
            try:
                body = json.loads(raw.decode("utf-8"))
            except Exception:
                return self._json({"error": "bad json"}, 400)
            text = str(body.get("text", ""))[:4000]
            level = str(body.get("level", "info"))
            now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            with lock:
                recent_events.append({"at": now, "level": level, "text": text})
                globals()["last_event_at"] = now
            with EVENTS_LOG.open("a", encoding="utf-8") as f:
                f.write(json.dumps({"at": now, "level": level, "text": text}) + "\n")
            print("[event:%s] %s" % (level, text.replace("\n", " | ")), flush=True)
            if level in ("info", "warn", "error"):
                tg_send("[" + level + "] " + text)
            return self._json({"ok": True})

        return self._json({"error": "not found"}, 404)


if __name__ == "__main__":
    if not QB_TOKEN:
        print("WARNING: QB_TOKEN is empty — uploads will be rejected.")
        print('  export QB_TOKEN="$(openssl rand -hex 24)"')
    print("QB relay listening on :%d" % PORT, flush=True)
    print("  data dir : %s" % DATA_DIR, flush=True)
    print("  telegram : %s" % ("ON" if (TG_TOKEN and TG_CHAT) else "off"), flush=True)
    print("  loaded   : %d files already in manifest" % len(paths), flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
