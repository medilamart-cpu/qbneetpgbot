/* 01b-minimal.js — no panel, no buttons, no DOM. Console only.
 *
 * 1. Logged in, on the site, in Chrome. F12 -> Console.
 * 2. Ctrl+A, Delete (clear the input box), paste this whole file, Enter.
 *    You should see:  [qb] ready
 * 3. Click around ~60s:  bank -> folder -> test (open, don't Start) -> back
 *    -> a second bank.  You'll see [qb] GET /... lines scrolling.
 * 4. Run this one line (it uses DevTools' own clipboard, which no CSP blocks):
 *
 *        copy(JSON.stringify(__qb.dump(), null, 2))
 *
 *    Then Ctrl+V here.
 * 5. If that printed nothing useful, also try:
 *
 *        copy(JSON.stringify(await __qb.cache(), null, 2))
 */

(() => {
  if (window.__qb) {
    console.log("[qb] already recording — run: copy(JSON.stringify(__qb.dump(), null, 2))");
    return;
  }

  const JWT = /eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g;
  const REDACT =
    /("(?:token|secret|auth|cookie|password|otp|code|device|email|phone|jwt|session|apikey|api_key|key)"\s*:\s*)"[^"]*"/gi;
  const clean = (s) => String(s).replace(JWT, "<JWT>").replace(REDACT, '$1"<REDACTED>"');

  const SKIP = /\.(png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|css|map|mp4|webm|mp3|js)$/i;

  const rec = [];
  const seen = new Map();

  const add = (method, url, status, body) => {
    let p;
    try {
      p = new URL(url, location.href);
    } catch {
      return;
    }
    if (p.origin !== location.origin || SKIP.test(p.pathname)) return;

    const key = method + " " + p.pathname;
    const hit = seen.get(key);
    if (hit) {
      hit.n++;
      return;
    }

    const entry = {
      method,
      path: p.pathname,
      queryKeys: [...p.searchParams.keys()],
      status,
      n: 1,
    };
    if (body) entry.sample = clean(String(body).slice(0, 1500));
    seen.set(key, entry);
    rec.push(entry);
    console.log("[qb]", method, p.pathname, status);
  };

  // ---- fetch -------------------------------------------------------------
  const origFetch = window.fetch;
  window.fetch = function qbFetch(input, init) {
    const out = origFetch.apply(this, arguments);
    try {
      const req = typeof Request !== "undefined" && input instanceof Request ? input : null;
      const url = req ? req.url : String(input);
      const method = String((init && init.method) || (req && req.method) || "GET").toUpperCase();
      const reqBody = init && typeof init.body === "string" ? init.body : null;
      out
        .then((res) =>
          res
            .clone()
            .text()
            .then((t) => add(method, url, res.status, method === "GET" ? t : reqBody || t))
            .catch(() => {})
        )
        .catch(() => {});
    } catch {
      /* ignore */
    }
    return out;
  };

  // ---- XHR ---------------------------------------------------------------
  const XHR = window.XMLHttpRequest;
  const origOpen = XHR.prototype.open;
  const origSend = XHR.prototype.send;

  XHR.prototype.open = function qbOpen(method, url) {
    this.__qb = { method: String(method || "GET").toUpperCase(), url: String(url) };
    return origOpen.apply(this, arguments);
  };

  XHR.prototype.send = function qbSend(body) {
    const meta = this.__qb;
    if (meta) {
      this.addEventListener("loadend", () => {
        try {
          const t =
            this.responseType === "" || this.responseType === "text" ? this.responseText : "";
          add(meta.method, meta.url, this.status, meta.method === "GET" ? t : body || t);
        } catch {
          /* ignore */
        }
      });
    }
    return origSend.apply(this, arguments);
  };

  // ---- report ------------------------------------------------------------
  const safeKeys = (store) => {
    try {
      return Object.keys(store);
    } catch {
      return [];
    }
  };

  window.__qb = {
    rec,
    dump() {
      return {
        page: location.pathname,
        title: document.title,
        localStorageKeys: safeKeys(localStorage),
        sessionStorageKeys: safeKeys(sessionStorage),
        endpoints: rec,
      };
    },
    async cache() {
      const out = { caches: {}, indexedDb: [] };
      try {
        for (const name of await caches.keys()) {
          const c = await caches.open(name);
          out.caches[name] = (await c.keys()).map((r) => r.url);
        }
      } catch (e) {
        out.cacheError = String(e && e.message);
      }
      try {
        if (indexedDB.databases) out.indexedDb = (await indexedDB.databases()).map((d) => d.name);
      } catch (e) {
        out.idbError = String(e && e.message);
      }
      return out;
    },
    stop() {
      window.fetch = origFetch;
      XHR.prototype.open = origOpen;
      XHR.prototype.send = origSend;
      delete window.__qb;
      console.log("[qb] stopped");
    },
  };

  console.log("%c[qb] ready", "color:#0d9488;font-weight:bold");
  console.log("[qb] click: a bank -> a folder -> a test (open, don't Start) -> back -> a second bank");
  console.log("[qb] then run: copy(JSON.stringify(__qb.dump(), null, 2))");
})();
