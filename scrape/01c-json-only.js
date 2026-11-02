/* 01c-json-only.js — find the bank → folder → test tree inside the JSON the
 * site already loads, and summarise it small enough to paste back.
 *
 * What it keeps: file paths, names, ids, question counts, kinds, dates.
 * What it never keeps: question text, options, answers, explanations,
 * tokens, codes, or the per-user key. Only whitelisted metadata fields are
 * read; everything else in a payload is walked for path-like strings only.
 *
 * Same rules as 01b: you are logged in, in your own Chrome. This script only
 * watches requests the page already makes. Nothing is spoofed.
 *
 * 1. Logged in on qb.neetpgbot.in, on the page where the tree renders.
 * 2. F12 → Console. Ctrl+A, Delete, paste all of this file, Enter.
 *    You should see:  [qbt] ready
 * 3. Click through 2–3 banks: bank → folder → test (open, don't Start) → back.
 *    Lines like  [qbt] GET /qbapi/sync 200 412KB  scroll past.
 * 4. Run this one line and paste the result here:
 *
 *        copy(JSON.stringify(await __qbTree.deep(), null, 2))
 *
 *    deep() also reads the service-worker cache and IndexedDB, so it still
 *    works if the tree was already loaded before you pasted this.
 * 5. Only if the report says  files: 0 , also try:
 *
 *        copy(JSON.stringify(__qbTree.paths().slice(0, 200), null, 2))
 */

(() => {
  if (window.__qbTree) {
    console.log("[qbt] already loaded — run: copy(JSON.stringify(await __qbTree.deep(), null, 2))");
    return;
  }

  const MAX_ONE = 8_000_000; // one response body, chars
  const MAX_ALL = 64_000_000; // everything held in memory
  const MAX_TEXT = 4_000_000; // one cache / storage value scanned
  const MAX_NODES = 600_000; // objects visited per run
  const MAX_DEPTH = 16;

  const SKIP = /\.(png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|css|map|mp4|webm|m4s|mp3|js)$/i;
  const BLOB = /^\/c\/[0-9a-f]{2}\/[0-9a-f]{40}$/i;
  // Never hold the per-user decryption key, not even in memory.
  const SECRET_PATH = /\/qbapi\/key\b/i;
  const PATH_G = /[A-Za-z0-9][A-Za-z0-9 .()+&,'_#@-]*(?:\/[A-Za-z0-9 .()+&,'_#@-]+)+\.json/g;

  // Fields we are allowed to read out of an object. Anything else (text,
  // options, answer, explanation, token, key, code, email…) is never copied.
  const META = new Set([
    "name", "title", "label", "file", "path", "href",
    "kind", "at", "questions", "count", "id", "slug",
  ]);

  const bodies = new Map(); // key -> { key, status, bytes, text }
  let held = 0;
  let blobs = 0;

  // ---- request capture ---------------------------------------------------
  const isJsonish = (t) => {
    const s = t.replace(/^\uFEFF/, "").trimStart();
    return s.startsWith("{") || s.startsWith("[");
  };

  const keep = (key, status, text) => {
    if (typeof text !== "string" || text.length < 2 || text.length > MAX_ONE) return;
    if (!isJsonish(text) && !/\.json(?:$|\?)/.test(key)) return;
    const prev = bodies.get(key);
    const delta = text.length - (prev ? prev.text.length : 0);
    if (delta > 0 && held + delta > MAX_ALL) return;
    held += delta;
    bodies.set(key, { key, status, bytes: text.length, text });
  };

  const keepKB = (n) => (n > 1024 ? Math.round(n / 1024) + "KB" : n + "B");

  const absorb = (method, url, status, text) => {
    let p;
    try {
      p = new URL(url, location.href);
    } catch {
      return;
    }
    if (p.origin !== location.origin) return;
    if (SKIP.test(p.pathname)) return;
    if (SECRET_PATH.test(p.pathname)) return;
    if (BLOB.test(p.pathname)) {
      blobs++;
      return;
    }
    const key = method + " " + p.pathname;
    const before = bodies.get(key);
    keep(key, status, text);
    const after = bodies.get(key);
    if (after && (!before || after.text.length > before.text.length)) {
      console.log("[qbt]", method, p.pathname, status, keepKB(after.bytes));
    }
  };

  const origFetch = window.fetch;
  window.fetch = function qbtFetch(input, init) {
    const out = origFetch.apply(this, arguments);
    try {
      const req = typeof Request !== "undefined" && input instanceof Request ? input : null;
      const url = req ? req.url : String(input);
      const method = String((init && init.method) || (req && req.method) || "GET").toUpperCase();
      out
        .then((res) =>
          res
            .clone()
            .text()
            .then((t) => absorb(method, url, res.status, t))
            .catch(() => {})
        )
        .catch(() => {});
    } catch {
      /* ignore */
    }
    return out;
  };

  const XHR = window.XMLHttpRequest;
  const origOpen = XHR.prototype.open;
  const origSend = XHR.prototype.send;

  XHR.prototype.open = function qbtOpen(method, url) {
    this.__qbt = { method: String(method || "GET").toUpperCase(), url: String(url) };
    return origOpen.apply(this, arguments);
  };

  XHR.prototype.send = function qbtSend() {
    const meta = this.__qbt;
    if (meta) {
      this.addEventListener("loadend", () => {
        try {
          const t = this.responseType === "" || this.responseType === "text" ? this.responseText : "";
          absorb(meta.method, meta.url, this.status, t);
        } catch {
          /* ignore */
        }
      });
    }
    return origSend.apply(this, arguments);
  };

  // ---- tree collection ---------------------------------------------------
  let files, links, metas, parsed, raw, notes, seen, nodes, capped;

  const reset = () => {
    files = new Set();
    links = new Set();
    metas = [];
    notes = [];
    parsed = 0;
    raw = 0;
    seen = new WeakSet();
    nodes = 0;
    capped = false;
  };

  const note = (s) => {
    if (notes.length < 40 && !notes.includes(s)) notes.push(s);
  };

  const isRelJson = (s) => {
    if (s.length < 6 || s.length > 500) return false;
    if (s[0] === "/" || s[0] === ".") return false;
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return false;
    if (!/\.json$/i.test(s)) return false;
    if (!s.includes("/")) return false;
    if (/[\r\n\t"{}<>\\]/.test(s)) return false;
    return true;
  };

  const takePath = (rawStr) => {
    if (typeof rawStr !== "string" || rawStr.length < 6) return;
    let s = rawStr;
    if (/^https?:/i.test(s)) {
      try {
        const u = new URL(s);
        if (u.origin !== location.origin) return;
        s = decodeURIComponent(u.pathname);
      } catch {
        return;
      }
    }
    s = s.replace(/^\/+/, "").replace(/^\.\//, "");
    if (!isRelJson(s)) return;
    if (/^(qbapi|api)\//i.test(s)) return;
    files.add(s);
  };

  const takeLink = (s) => {
    if (typeof s !== "string" || !s.includes("/take-test/")) return;
    const clean = s.split("?")[0].split("#")[0];
    if (clean.length < 12 || clean.length > 300) return;
    links.add(clean.replace(/^https?:\/\/[^/]+/i, ""));
  };

  const walk = (v, depth) => {
    if (depth > MAX_DEPTH) return;
    if (typeof v === "string") {
      takeLink(v);
      if (v.length <= 500) takePath(v);
      return;
    }
    if (!v || typeof v !== "object") return;
    if (nodes > MAX_NODES) {
      if (!capped) {
        capped = true;
        note("node cap reached — this report is partial");
      }
      return;
    }
    nodes++;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) walk(v[i], depth + 1);
      return;
    }
    if (seen.has(v)) return;
    seen.add(v);

    const meta = {};
    let hits = 0;
    for (const k in v) {
      if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
      const val = v[k];
      const kk = String(k).toLowerCase();
      if (META.has(kk)) {
        if (typeof val === "string" && val.length <= 200) {
          meta[kk] = val;
          hits++;
        } else if (typeof val === "number" || typeof val === "boolean") {
          meta[kk] = val;
          hits++;
        }
      }
      if (typeof val === "string") {
        takeLink(val);
        if (val.length <= 500) takePath(val);
      } else if (val && typeof val === "object") {
        walk(val, depth + 1);
      }
    }

    if (hits && (meta.file || meta.path || meta.href) && (meta.name || meta.title || meta.label)) {
      if (metas.length < 5000) metas.push(meta);
    }
  };

  const scanText = (t) => {
    if (typeof t !== "string" || !t || t.length > MAX_TEXT) return;
    let m,
      n = 0;
    PATH_G.lastIndex = 0;
    while ((m = PATH_G.exec(t)) !== null) {
      takePath(m[0]);
      if (++n > 20000) break;
    }
  };

  const ingest = (key, text) => {
    if (typeof text !== "string" || !text) return;
    if (SECRET_PATH.test(key)) return;
    if (isJsonish(text) && text.length <= MAX_TEXT * 2) {
      try {
        walk(JSON.parse(text), 0);
        parsed++;
        return;
      } catch {
        /* fall through to text scan */
      }
    }
    raw++;
    scanText(text);
  };

  const ingestBodies = () => {
    for (const b of bodies.values()) ingest(b.key, b.text);
  };

  const ingestStorage = () => {
    for (const store of [localStorage, sessionStorage]) {
      try {
        for (const k of Object.keys(store)) {
          const v = store.getItem(k);
          if (v) scanText(v);
        }
      } catch {
        note("storage scan blocked");
      }
    }
  };

  // ---- cache + IndexedDB -------------------------------------------------
  async function cacheScan() {
    const out = [];
    let names = [];
    try {
      names = await caches.keys();
    } catch (e) {
      note("caches: " + String(e && e.message));
      return out;
    }
    for (const name of names) {
      let c;
      try {
        c = await caches.open(name);
      } catch {
        continue;
      }
      let reqs = [];
      try {
        reqs = await c.keys();
      } catch {
        continue;
      }
      for (const req of reqs) {
        let p = "";
        try {
          const u = new URL(req.url);
          if (u.origin !== location.origin) continue;
          p = u.pathname;
        } catch {
          continue;
        }
        if (SKIP.test(p) || BLOB.test(p)) continue;
        try {
          const r = await c.match(req);
          if (!r) continue;
          const t = await r.text();
          if (t.length > MAX_TEXT) {
            out.push({ cache: name, path: p, kb: Math.round(t.length / 1024), skipped: "over cap" });
            continue;
          }
          ingest(p, t);
          out.push({ cache: name, path: p, kb: Math.round(t.length / 1024) });
        } catch {
          /* ignore */
        }
        if (out.length > 300) {
          note("cache scan stopped at 300 entries");
          break;
        }
      }
    }
    return out;
  }

  const openDb = (name) =>
    new Promise((res, rej) => {
      const r = indexedDB.open(name);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error("blocked"));
    });

  const getAll = (db, store) =>
    new Promise((res, rej) => {
      const tx = db.transaction(store, "readonly");
      const r = tx.objectStore(store).getAll();
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => rej(r.error);
    });

  async function idbScan() {
    const out = [];
    let dbs = [];
    try {
      dbs = indexedDB.databases ? await indexedDB.databases() : [];
    } catch {
      return out;
    }
    for (const d of dbs) {
      if (!d || !d.name) continue;
      let db;
      try {
        db = await openDb(d.name);
      } catch (e) {
        out.push({ db: d.name, error: String(e && e.message) });
        continue;
      }
      let n = 0;
      for (const s of Array.from(db.objectStoreNames)) {
        if (n++ > 40) break;
        try {
          const rows = await getAll(db, s);
          for (const row of rows) walk(row, 0);
          out.push({ db: d.name, store: s, rows: rows.length });
        } catch (e) {
          out.push({ db: d.name, store: s, error: String(e && e.message) });
        }
      }
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
    return out;
  }

  // ---- reporting ---------------------------------------------------------
  const build = (list) => {
    const root = { name: "", files: 0, kids: new Map() };
    for (const p of list) {
      const segs = p.split("/");
      root.files++;
      let n = root;
      for (let i = 0; i < segs.length - 1; i++) {
        const s = segs[i];
        let c = n.kids.get(s);
        if (!c) {
          c = { name: s, files: 0, kids: new Map() };
          n.kids.set(s, c);
        }
        c.files++;
        n = c;
      }
    }
    return root;
  };

  const depthOf = (n) => {
    let d = 0;
    for (const c of n.kids.values()) d = Math.max(d, 1 + depthOf(c));
    return d;
  };

  const finish = () => {
    const paths = [...files].sort();
    const root = build(paths);

    const libraries = [];
    for (const c of root.kids.values()) {
      const folders = [];
      for (const g of c.kids.values()) {
        if (folders.length < 40) folders.push(g.name);
      }
      const samples = [];
      for (const p of paths) {
        if (p.startsWith(c.name + "/")) {
          samples.push(p);
          if (samples.length === 6) break;
        }
      }
      libraries.push({
        name: c.name,
        files: c.files,
        folderCount: c.kids.size,
        depth: depthOf(c),
        folders,
        samples,
      });
    }
    libraries.sort((a, b) => b.files - a.files);

    const kinds = {};
    for (const m of metas) {
      const k = m.kind || "?";
      kinds[k] = (kinds[k] || 0) + 1;
    }

    const withQ = metas.filter((m) => typeof m.questions === "number");
    const sampleSrc = (withQ.length ? withQ : metas).slice(0, 25);
    const metaSamples = sampleSrc.map((m) => ({
      name: m.name || m.title || m.label,
      file: m.file || m.path || m.href,
      questions: m.questions,
      kind: m.kind,
      at: m.at,
    }));

    const sources = [...bodies.values()]
      .map((b) => ({ key: b.key, status: b.status, kb: Math.round(b.bytes / 1024) }))
      .sort((a, b) => b.kb - a.kb)
      .slice(0, 40);

    return {
      page: location.pathname,
      heldKB: Math.round(held / 1024),
      bodies: bodies.size,
      parsed,
      rawScanned: raw,
      blobResponses: blobs,
      files: paths.length,
      libraries,
      metaObjects: metas.length,
      metaKinds: kinds,
      metaSamples,
      takeTestLinks: { count: links.size, sample: [...links].slice(0, 10) },
      pathsSample: paths.slice(0, 40),
      sources,
      notes,
      hint: paths.length
        ? null
        : "no .json paths found — the tree is not in any captured body; check sources[] and the /c/ blobs",
    };
  };

  const runSync = () => {
    reset();
    ingestBodies();
    ingestStorage();
    return finish();
  };

  // ---- api ---------------------------------------------------------------
  const restore = () => {
    window.fetch = origFetch;
    XHR.prototype.open = origOpen;
    XHR.prototype.send = origSend;
  };

  window.__qbTree = {
    report: runSync,
    paths: () => {
      reset();
      ingestBodies();
      ingestStorage();
      return [...files].sort();
    },
    async deep() {
      reset();
      ingestBodies();
      ingestStorage();
      const cache = await cacheScan();
      const idb = await idbScan();
      const r = finish();
      r.cache = cache.slice(0, 40);
      r.idb = idb.slice(0, 40);
      return r;
    },
    stop() {
      restore();
      delete window.__qbTree;
      console.log("[qbt] stopped");
    },
  };

  console.log("%c[qbt] ready", "color:#0d9488;font-weight:bold");
  console.log("[qbt] click: bank → folder → test (open, don't Start) → back → another bank");
  console.log("[qbt] then run: copy(JSON.stringify(await __qbTree.deep(), null, 2))");
})();
