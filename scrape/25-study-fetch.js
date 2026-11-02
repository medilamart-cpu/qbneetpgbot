/* 25-study-fetch.js — study companion (any account, normal study pace)
 *
 * Three ways to save content, all within normal usage:
 *
 *   qbStudy.capture(true)     PASSIVE: saves every test YOU open in the app.
 *                             Hooks fetch/XHR — when the app downloads a test
 *                             blob, we decrypt the SAME response and store it.
 *                             Zero extra network requests (uses the app's own
 *                             key + blob responses).
 *
 *   qbStudy.search("query")   Search the index for file paths (run 14 first)
 *   qbStudy.fetch("<path>")   Fetch ONE file on demand (2 requests = exactly
 *                             what the app uses to open one test)
 *
 *   qbStudy.list()            files saved this session
 *   qbStudy.status()          total in IndexedDB, per-bank table
 *   qbStudy.export()          download everything as one JSON
 *   qbStudy.help()            show this help
 *
 * Storage: same IndexedDB (qbFetchDB) as scripts 20/21/23/24 — everything merges.
 *
 * NOTES
 *   - Works only while logged in. If your account is paused (403), on-demand
 *     fetch stops and tells you — that's the server, not this script.
 *   - Passive capture depends on the app using fetch/XHR (most SPAs do). If a
 *     test opens but no toast appears, use qbStudy.fetch() instead.
 *   - Keep to real study pace: opening hundreds of tests per hour is the same
 *     volume signal as any bulk tool, on any account.
 */
(() => {
  const log = (...a) => console.log("%c[STUDY]", "color:#0f0;font-weight:bold", ...a);
  const err = (...a) => console.log("%c[STUDY]", "color:#f33;font-weight:bold", ...a);
  const warn = (...a) => console.log("%c[STUDY]", "color:#fa0;font-weight:bold", ...a);

  if (window.qbStudy) { log("already installed — see qbStudy.help()"); return; }

  const sessionSaved = [];
  const keyCache = new Map();
  let captureOn = false;

  // stamp (X-SOS-Stamp header, now required by backend)
  let __stampCache25 = null;
  const getStamp25 = async () => {
    const today = new Date().toISOString().slice(0, 10);
    if (__stampCache25 && __stampCache25.day === today) return __stampCache25;
    const r = await origFetch("/qbapi/stamp", { credentials: "include", cache: "no-store" });
    const t = await r.json();
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(t.k), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    __stampCache25 = { key, day: t.day, offset: (t.now ? t.now * 1000 : Date.now()) - Date.now() };
    return __stampCache25;
  };
  const stampHeaderFor25 = async (url) => {
    const s = await getStamp25();
    const n = Math.floor((Date.now() + s.offset) / 1000);
    if (s.day && new Date(n * 1000).toISOString().slice(0, 10) !== s.day) {
      __stampCache25 = null;
      return stampHeaderFor25(url);
    }
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", s.key, new TextEncoder().encode(n + "|" + url)));
    const hex = Array.from(sig.subarray(0, 16), (i) => i.toString(16).padStart(2, "0")).join("");
    return { "X-SOS-Stamp": n + "." + hex };
  };
  let lastKey = { id: null, at: 0 };

  // ================= IndexedDB (same store as other scripts) =================
  const DB_NAME = "qbFetchDB";
  const STORE_NAME = "questions";
  const dbP = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains(STORE_NAME)) d.createObjectStore(STORE_NAME, { keyPath: "path" });
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
  const idbPut = async (rec) => {
    const db = await dbP;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const rq = tx.objectStore(STORE_NAME).put(rec);
      rq.onsuccess = () => resolve();
      rq.onerror = () => reject(rq.error);
    });
  };
  const idbAll = async () => {
    const db = await dbP;
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const rq = tx.objectStore(STORE_NAME).getAll();
      rq.onsuccess = () => resolve(rq.result || []);
      rq.onerror = () => resolve([]);
    });
  };

  // ================= decrypt pipeline (proven in 16/23) =================
  const decrypt = async (kHex, buf) => {
    const raw = new Uint8Array(buf);
    const iv = raw.subarray(0, 12);
    const ct = raw.subarray(12);
    const kb = new Uint8Array(kHex.length / 2);
    for (let i = 0; i < kb.length; i++) kb[i] = parseInt(kHex.substr(i * 2, 2), 16);
    const ck = await crypto.subtle.importKey("raw", kb, "AES-GCM", false, ["decrypt"]);
    const dec = await crypto.subtle.decrypt({ name: "AES-GCM", iv, tagLength: 128 }, ck, ct);
    const plain = new Uint8Array(dec);
    const text = await new Response(new Blob([plain]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
    return JSON.parse(text);
  };

  // ================= index lookup =================
  const entries = () =>
    (window.qbLinks && window.qbLinks.data && window.qbLinks.data.entries) || [];
  const findByBlob = (url) => {
    const norm = String(url).split("?")[0];
    return entries().find((e) => String(e.blobUrl).split("?")[0] === norm) || null;
  };
  const findByPath = (p) => {
    const want = String(p).replace(/\\/g, "/").replace(/^\/+/, "");
    const all = entries();
    return all.find((e) => e.path === want) || all.find((e) => e.path.toLowerCase() === want.toLowerCase()) || null;
  };

  // ================= save + toast =================
  let toastEl = null;
  const toast = (path, ok) => {
    try {
      if (!toastEl) {
        toastEl = document.createElement("div");
        Object.assign(toastEl.style, {
          position: "fixed", right: "12px", bottom: "12px", zIndex: 2147483647,
          padding: "8px 12px", borderRadius: "10px", font: "600 13px/1.4 system-ui,sans-serif",
          background: "#0b1220", color: "#d1fae5", border: "1px solid #059669",
          boxShadow: "0 8px 24px rgba(0,0,0,.4)", maxWidth: "320px", display: "none",
          wordBreak: "break-all", transition: "opacity .3s"
        });
        document.body.appendChild(toastEl);
      }
      toastEl.style.border = "1px solid " + (ok === false ? "#dc2626" : "#059669");
      toastEl.style.color = ok === false ? "#fecaca" : "#d1fae5";
      toastEl.textContent = (ok === false ? "✗ " : "✓ ") + String(path).split("/").pop().replace(/\.json$/, "") +
        (ok === false ? "" : "  ·  saved " + sessionSaved.length);
      toastEl.style.display = "block";
      clearTimeout(toastEl._t);
      toastEl._t = setTimeout(() => { toastEl.style.display = "none"; }, 4000);
    } catch (e) { /* no DOM, no toast */ }
  };

  const save = async (path, data) => {
    await idbPut({ path, data, fetchedAt: new Date().toISOString() });
    sessionSaved.push(path);
    toast(path, true);
    log("saved:", path, "(" + (data.total_questions || (data.questions && data.questions.length) || "?") +
      " Q) | this session:", sessionSaved.length);
  };

  // ================= capture a blob the APP downloaded =================
  const handleBlob = async (url, arrayBufferPromise) => {
    try {
      const entry = findByBlob(url);
      // keyId: from the index if we have it, else the app's most recent key call
      let keyId = entry ? entry.keyId : (Date.now() - lastKey.at < 8000 ? lastKey.id : null);
      if (!keyId) {
        warn("blob seen but no keyId — run 14-links-reuse.js for full path mapping:", String(url).slice(0, 90));
        return;
      }
      let k = keyCache.get(keyId);
      if (!k) {
        const kr = await origFetch("/qbapi/key?u=" + keyId, { credentials: "include", cache: "no-store", headers: await stampHeaderFor25("/c/" + keyId.slice(0, 2) + "/" + keyId.slice(2)) });
        if (kr.status === 403) { err("account paused (403) — nothing can be opened until @neet_pg_bot lifts it."); return; }
        if (!kr.ok) { warn("key HTTP " + kr.status); return; }
        k = (await kr.json()).k;
        keyCache.set(keyId, k);
      }
      const buf = await arrayBufferPromise;
      const data = await decrypt(k, buf);
      if (!data || !Array.isArray(data.questions)) {
        log("captured blob is not a test file — skipped:", String(url).slice(-60));
        return;
      }
      const path = entry ? entry.path : "captured/" + String(url).split("/").pop();
      await save(path, data);
    } catch (e) {
      err("capture failed:", String(e).slice(0, 120));
    }
  };

  // ================= hooks: fetch + XHR =================
  const origFetch = window.fetch.bind(window);
  const noteKey = (url) => {
    try {
      const kid = decodeURIComponent(String(url).split("u=")[1] || "");
      if (kid) lastKey = { id: kid, at: Date.now() };
      return kid;
    } catch (e) { return null; }
  };

  window.fetch = async function (input, init) {
    const res = await origFetch(input, init);
    try {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      if (url.includes("/qbapi/key?u=")) {
        const kid = noteKey(url);
        res.clone().json().then((d) => { if (d && d.k && kid) keyCache.set(kid, d.k); }).catch(() => {});
      } else if (captureOn && /\/c\//.test(url) && !url.includes("/qbapi/")) {
        handleBlob(url, res.clone().arrayBuffer());
      }
    } catch (e) { /* never break the app's request */ }
    return res;
  };

  try {
    const xhrOpen = XMLHttpRequest.prototype.open;
    const xhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__qbUrl = url;
      return xhrOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      try {
        const url = String(this.__qbUrl || "");
        if (url.includes("/qbapi/key?u=")) {
          noteKey(url);
          this.addEventListener("load", () => {
            try {
              const kid = decodeURIComponent(url.split("u=")[1] || "");
              const d = this.responseType === "json" ? this.response : JSON.parse(this.responseText);
              if (d && d.k && kid) keyCache.set(kid, d.k);
            } catch (e) { /* not json */ }
          });
        } else if (captureOn && /\/c\//.test(url) && !url.includes("/qbapi/")) {
          this.addEventListener("load", () => {
            if (this.status !== 200) return;
            let p = null;
            if (this.responseType === "arraybuffer" && this.response) p = Promise.resolve(this.response);
            else if (this.responseType === "blob" && this.response) p = this.response.arrayBuffer();
            if (p) handleBlob(url, p);
          });
        }
      } catch (e) { /* never break the app's request */ }
      return xhrSend.apply(this, arguments);
    };
  } catch (e) { warn("XHR hook failed:", String(e).slice(0, 80)); }

  // ================= download helper =================
  const download = (obj, filename) => {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // ================= public commands =================
  window.qbStudy = {
    capture: (on) => {
      captureOn = on !== false;
      log("passive capture:", captureOn
        ? "ON — open tests normally in the app; each one you open is saved automatically"
        : "OFF");
      if (captureOn && entries().length === 0) {
        warn("tip: run 14-links-reuse.js to enable exact file paths (optional but better)");
      }
      return captureOn;
    },

    search: (q) => {
      if (!q) { err("usage: qbStudy.search(\"anatomy\")"); return []; }
      const needle = String(q).toLowerCase();
      const hits = entries().filter((e) => e.path.toLowerCase().includes(needle));
      log("matches for \"" + q + "\":", hits.length);
      hits.slice(0, 60).forEach((e, i) => log("  " + (i + 1) + ". " + e.path));
      if (hits.length > 60) log("  ... and " + (hits.length - 60) + " more (refine your query)");
      return hits.map((e) => e.path);
    },

    fetch: async (path, alsoDownload) => {
      if (!path) { err("usage: qbStudy.fetch(\"Marrow/marrow_NEET PG/...\")"); return null; }
      const entry = findByPath(path);
      if (!entry) {
        err("path not in index. Run 14-links-reuse.js first, then qbStudy.search(\"...\") to find it.");
        return null;
      }
      log("fetching:", entry.path, "...");
      try {
        const kr = await origFetch("/qbapi/key?u=" + entry.keyId, { credentials: "include", cache: "no-store", headers: await stampHeaderFor25("/c/" + entry.keyId.slice(0, 2) + "/" + entry.keyId.slice(2)) });
        if (kr.status === 403) { err("account paused (403) — nothing can be opened until @neet_pg_bot lifts it."); return null; }
        if (kr.status === 429) { err("rate limited (429) — wait a few minutes, try again."); return null; }
        if (!kr.ok) { err("key HTTP " + kr.status); return null; }
        const k = (await kr.json()).k;
        keyCache.set(entry.keyId, k);

        const br = await origFetch(entry.blobUrl, { credentials: "include", cache: "force-cache", headers: await stampHeaderFor25(entry.blobUrl) });
        if (br.status === 403) { err("account paused (403) on blob."); return null; }
        if (br.status === 429) { err("rate limited (429) on blob."); return null; }
        if (!br.ok) { err("blob HTTP " + br.status); return null; }

        const data = await decrypt(k, await br.arrayBuffer());
        await save(entry.path, data);
        if (alsoDownload) {
          download({ path: entry.path, data, fetchedAt: new Date().toISOString() },
            entry.path.split("/").pop().replace(/\.json$/, "") + ".json");
          log("also downloaded as file");
        }
        return data;
      } catch (e) {
        err("fetch failed:", String(e).slice(0, 120));
        return null;
      }
    },

    list: () => {
      log("saved this session (" + sessionSaved.length + "):");
      sessionSaved.forEach((p, i) => log("  " + (i + 1) + ". " + p));
      return sessionSaved.slice();
    },

    status: async () => {
      const all = await idbAll();
      const banks = {};
      for (const item of all) { const b = item.path.split("/")[0]; banks[b] = (banks[b] || 0) + 1; }
      log("capture:", captureOn ? "ON" : "OFF", "| IndexedDB total:", all.length, "files | session:", sessionSaved.length);
      console.table(banks);
      return { total: all.length, session: sessionSaved.length, capture: captureOn, banks };
    },

    export: async () => {
      const all = await idbAll();
      log("exporting", all.length, "files...");
      download({
        generatedAt: new Date().toISOString(),
        count: all.length,
        files: all.map((i) => ({ path: i.path, data: i.data, fetchedAt: i.fetchedAt }))
      }, "qbank-content.json");
      log("done");
      return all.length;
    },

    help: () => {
      console.log("%c[STUDY] commands", "color:#0f0;font-size:13px");
      log("qbStudy.capture(true)    — passive: save every test you open in the app (0 extra requests)");
      log("qbStudy.search(\"q\")      — find file paths in the index (needs 14-links-reuse.js)");
      log("qbStudy.fetch(\"path\")    — fetch one file on demand (2 requests, like opening a test)");
      log("qbStudy.fetch(\"path\", true) — same, plus download the JSON file");
      log("qbStudy.list()           — what's saved this session");
      log("qbStudy.status()         — IndexedDB totals per bank");
      log("qbStudy.export()         — download everything as one JSON");
    }
  };

  log("ready. qbStudy.capture(true) to start passive saving, or qbStudy.help() for all commands");
})();
