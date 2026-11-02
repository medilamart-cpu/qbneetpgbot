/* 23-allbanks-v2.js — polite fetcher v2 (replaces 21-allbanks-idb.js)
 *
 * Improvements over v1:
 *   1. Randomized delay 5–15s between files + occasional 30–60s "human" pause
 *   2. 429 handling: respects Retry-After, else exponential backoff 30/60/120/240s
 *      (max 5 waits per burst, counter resets on success) — then stops cleanly
 *   3. Auto-resume: skips everything already in IndexedDB (no manual rerun logic)
 *   4. Transient errors (network / 5xx): retried up to 3x with backoff, then skipped
 *   5. Bank-wise progress: per-bank stats + periodic console.table
 *   6. 403 = ACCOUNT PAUSED → immediate hard stop, zero retries
 *   7. Session check every 25 files (was every 10 — fewer wasted requests)
 *   8. window.qbStop() — graceful stop without closing the tab
 *   9. Priority banks first (Core_BTR, PrepLadder) so session expiry can't eat them
 *
 * HOW TO USE
 *   1. Run 14-links-reuse.js first (populate window.qbLinks)
 *   2. Paste this, Enter. It runs automatically.
 *   3. Leave tab open (minimize OK). Don't reload.
 *   4. Stop early:   window.qbStop()
 *   5. When done:    window.qbIdb.downloadAll()
 *
 * RESUME: just re-run this script — IndexedDB already-stored paths are skipped.
 */
(async () => {
  const log = (...a) => console.log("%c[V2]", "color:#0f0;font-weight:bold", ...a);
  const err = (...a) => console.log("%c[V2]", "color:#f33;font-weight:bold", ...a);
  const warn = (...a) => console.log("%c[V2]", "color:#fa0;font-weight:bold", ...a);

  // ================= CONFIG =================
  const DELAY_MIN_MS = 15000;           // random gap floor (15s)
  const DELAY_MAX_MS = 45000;           // random gap ceiling (45s)
  const LONG_PAUSE_CHANCE = 0.10;       // 10% chance of a long break
  const LONG_PAUSE_MIN_MS = 60000;      // 60s
  const LONG_PAUSE_MAX_MS = 180000;     // 3 min
  const MAX_429_WAITS = 5;              // max consecutive rate-limit waits per burst
  const BACKOFF_BASE_MS = 30000;        // 30s -> 60s -> 120s -> 240s
  const MAX_WAIT_MS = 15 * 60 * 1000;   // never wait longer than 15 min per 429
  const MAX_TRANSIENT_RETRIES = 3;      // network / 5xx retries per file
  const SESSION_CHECK_EVERY = 100;      // files between /qbapi/me checks (trimmed overhead)
  const PROGRESS_TABLE_EVERY = 50;      // files between progress tables
  const BANKS = ["AMBOSS", "Cerebellum", "Core_BTR", "DAMS", "DocTutorials", "Osmosis", "PrepLadder", "Reflex", "Speed", "eGurukul", "medsynapse"]; // Marrow excluded (already fetched)
  // Priority order: your study priorities first, in case the session window runs out
  const BANK_ORDER = ["Core_BTR", "PrepLadder", "Cerebellum", "DAMS", "AMBOSS", "Speed", "eGurukul", "DocTutorials", "medsynapse", "Reflex", "Osmosis"];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rnd = (min, max) => min + Math.random() * (max - min);

  // ================= STAMP (X-SOS-Stamp header, now required by the backend) =================
  let __stampCache23 = null;
  const getStamp23 = async () => {
    const today = new Date().toISOString().slice(0, 10);
    if (__stampCache23 && __stampCache23.day === today) return __stampCache23;
    const r = await fetch("/qbapi/stamp", { credentials: "include", cache: "no-store" });
    const t = await r.json();
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(t.k), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    __stampCache23 = { key, day: t.day, offset: (t.now ? t.now * 1000 : Date.now()) - Date.now() };
    return __stampCache23;
  };
  const stampHeaderFor23 = async (url, _depth) => {
    _depth = _depth || 0;
    if (_depth > 2) throw new Error("stamp day mismatch loop");
    const s = await getStamp23();
    const n = Math.floor((Date.now() + s.offset) / 1000);
    if (s.day && new Date(n * 1000).toISOString().slice(0, 10) !== s.day) {
      __stampCache23 = null;
      return stampHeaderFor23(url, _depth + 1);
    }
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", s.key, new TextEncoder().encode(n + "|" + url)));
    const hex = Array.from(sig.subarray(0, 16), (i) => i.toString(16).padStart(2, "0")).join("");
    return { "X-SOS-Stamp": n + "." + hex };
  };
  window.__qbStopRequested = false;
  window.qbStop = () => {
    window.__qbStopRequested = true;
    warn("stop requested — finishing current file, then halting...");
  };

  // ================= SESSION CHECK =================
  log("Checking session...");
  let me;
  try {
    const r = await fetch("/qbapi/me", { credentials: "include", cache: "no-store" });
    me = await r.json();
  } catch (e) { err("cannot reach /qbapi/me:", String(e)); return; }
  if (!me || me.code === undefined) { err("not logged in or session expired"); return; }
  const sessionExpiry = me.expires ? new Date(me.expires * 1000) : null;
  const codeExpiry = me.code_expires ? new Date(me.code_expires * 1000) : null;
  log("user:", me.name || me.nickname);
  log("session expires:", sessionExpiry ? sessionExpiry.toISOString() : "unknown");
  log("code expires:", codeExpiry ? codeExpiry.toISOString() : "unknown");
  if (codeExpiry && codeExpiry.getTime() < Date.now()) warn("code expired — session is your only access now. Keep this tab alive.");
  if (sessionExpiry && sessionExpiry.getTime() < Date.now()) { err("SESSION EXPIRED."); return; }
  if (sessionExpiry) log("session window left:", ((sessionExpiry.getTime() - Date.now()) / 3600000).toFixed(1), "hours");

  // ================= INDEXEDDB (opened early so helpers are available on early returns) =================
  const DB_NAME = "qbFetchDB";
  const STORE_NAME = "questions";
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains(STORE_NAME)) d.createObjectStore(STORE_NAME, { keyPath: "path" });
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });

  // ================= LINKS =================
  if (!window.qbLinks || !window.qbLinks.data || !window.qbLinks.data.entries) {
    err("No links in memory. Run 14-links-reuse.js first.");
    setupHelpers(db, STORE_NAME);
    return;
  }
  let allLinks = window.qbLinks.data.entries;
  if (BANKS) allLinks = allLinks.filter((e) => BANKS.includes(e.path.split("/")[0]));
  // Priority banks first (stable order within each bank)
  const orderIndex = (p) => {
    const b = p.split("/")[0];
    const i = BANK_ORDER.indexOf(b);
    return i === -1 ? BANK_ORDER.length : i;
  };
  allLinks = allLinks.slice().sort((a, b) => orderIndex(a.path) - orderIndex(b.path));
  log("total files in scope:", allLinks.length);
  const bankCounts = {};
  for (const e of allLinks) { const b = e.path.split("/")[0]; bankCounts[b] = (bankCounts[b] || 0) + 1; }
  console.table(bankCounts);

  const idb = (mode, fn) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    const out = fn(store);
    out.onsuccess = () => resolve(out.result);
    out.onerror = () => reject(out.error);
  });
  const countStored = () => idb("readonly", (s) => s.count()).catch(() => 0);
  const getStoredPaths = () => idb("readonly", (s) => s.getAllKeys()).catch(() => []);

  // expose internals for debugging / instrumentation
  window.__qb = {
    getStamp23, stampHeaderFor23, db, STORE_NAME, countStored, getStoredPaths,
    probe: async () => {
      const e = (window.qbLinks && window.qbLinks.data && window.qbLinks.data.entries && window.qbLinks.data.entries[0]) || null;
      if (!e) { console.log("no links loaded"); return; }
      const h = await stampHeaderFor23(e.blobUrl);
      const r = await fetch(e.blobUrl, { credentials: "include", headers: h });
      console.log("probe status", r.status, r.type);
      for (const [k, v] of r.headers) console.log("  ", k, "=", v);
    }
  };

  const alreadyStored = await countStored();
  const storedPaths = new Set(await getStoredPaths());
  const remaining = allLinks.filter((e) => !storedPaths.has(e.path));
  log("already stored:", alreadyStored, "| remaining:", remaining.length);

  // bank-wise stats (inScope = total in scope, done = already in IDB)
  const bankStats = {};
  for (const e of allLinks) {
    const b = e.path.split("/")[0];
    if (!bankStats[b]) bankStats[b] = { inScope: 0, done: 0, errors: 0 };
    bankStats[b].inScope++;
  }
  const pre = {};
  for (const p of storedPaths) { const b = p.split("/")[0]; pre[b] = (pre[b] || 0) + 1; }
  for (const b of Object.keys(bankStats)) bankStats[b].done = pre[b] || 0;

  if (remaining.length === 0) {
    log("ALL FILES ALREADY IN IDB. Run window.qbIdb.downloadAll() to export.");
    setupHelpers(db, STORE_NAME);
    return;
  }

  // ETA at configured pace
  const avgDelay = (DELAY_MIN_MS + DELAY_MAX_MS) / 2 + LONG_PAUSE_CHANCE * ((LONG_PAUSE_MIN_MS + LONG_PAUSE_MAX_MS) / 2);
  const etaH = (remaining.length * avgDelay) / 3600000;
  log("pace: " + (DELAY_MIN_MS / 1000) + "-" + (DELAY_MAX_MS / 1000) + "s/file + " + Math.round(LONG_PAUSE_CHANCE * 100) + "% long pauses | ETA ~" + etaH.toFixed(1) + " hours");

  // ================= KEEP-ALIVE =================
  log("Starting keep-alive (30s pings)...");
  const kaInterval = setInterval(async () => {
    try { await fetch("/qbapi/me", { credentials: "include", cache: "no-store" }); } catch (e) {}
  }, 300000);  // 5 min (was 30s) — trimmed overhead

  // ================= 429 / ERROR HELPERS =================
  let bursts429 = 0;          // consecutive 429 waits in current burst
  let totalWaits429 = 0;
  let stopReason = null;

  const calc429Wait = (res, attempt) => {
    const ra = res.headers.get("Retry-After");
    if (ra) {
      const s = parseInt(ra, 10);
      if (!isNaN(s)) return Math.min(s * 1000, MAX_WAIT_MS);
    }
    return Math.min(BACKOFF_BASE_MS * Math.pow(2, attempt - 1), MAX_WAIT_MS);
  };

  // ================= RANDOM GAP =================
  const randomGap = async (isLast) => {
    if (isLast) return;
    if (Math.random() < LONG_PAUSE_CHANCE) {
      const lp = Math.round(rnd(LONG_PAUSE_MIN_MS, LONG_PAUSE_MAX_MS) / 1000);
      log("... long pause " + lp + "s (human-like break)");
      await sleep(lp * 1000);
    }
    await sleep(Math.round(rnd(DELAY_MIN_MS, DELAY_MAX_MS)));
  };

  // ================= FETCH ONE FILE =================
  // returns: 'ok' | 'skip' | 'stop-403' | 'stop-429' | 'stop-session' | 'stop-user'
  const fetchOne = async (entry) => {
    let netTransient = 0, decTransient = 0;  // split: network vs decrypt retries
    for (let a = 1; a <= 20; a++) {
      if (window.__qbStopRequested) return "stop-user";

      // --- key request ---
      let kr;
      try {
        kr = await fetch("/qbapi/key?u=" + entry.keyId, { credentials: "include", cache: "no-store", headers: await stampHeaderFor23("/c/" + entry.keyId.slice(0, 2) + "/" + entry.keyId.slice(2)) });
      } catch (e) {
        netTransient++;
        if (netTransient > MAX_TRANSIENT_RETRIES) { err("network fail x" + netTransient + " on key, skipping " + entry.path); return "skip"; }
        warn("network error on key (try " + netTransient + "):", String(e).slice(0, 60));
        await sleep(10000 * netTransient);
        continue;
      }
      if (kr.status === 403) return "stop-403";
      if (kr.status === 429) {
        bursts429++;
        totalWaits429++;
        if (bursts429 > MAX_429_WAITS) return "stop-429";
        const ms = calc429Wait(kr, bursts429);
        err("429 on key (" + entry.path.split("/").pop() + ") — wait " + bursts429 + "/" + MAX_429_WAITS + ", sleeping " + Math.round(ms / 1000) + "s");
        await sleep(ms);
        continue; // retry SAME file
      }
      if (!kr.ok) {
        if (kr.status >= 500) {
          netTransient++;
          if (netTransient > MAX_TRANSIENT_RETRIES) { err("server error x" + kr.status + " on key, skipping"); return "skip"; }
          await sleep(10000 * netTransient);
          continue;
        }
        err("key HTTP " + kr.status + " for " + entry.path);
        bankStats[entry.path.split("/")[0]].errors++;
        return "skip";
      }
      let kd;
      try { kd = await kr.json(); } catch (e) { netTransient++; if (netTransient > MAX_TRANSIENT_RETRIES) return "skip"; await sleep(5000); continue; }

      // --- blob request ---
      let br;
      try {
        br = await fetch(entry.blobUrl, { credentials: "include", cache: "force-cache", headers: await stampHeaderFor23(entry.blobUrl) });
      } catch (e) {
        netTransient++;
        if (netTransient > MAX_TRANSIENT_RETRIES) { err("network fail on blob, skipping " + entry.path); return "skip"; }
        warn("network error on blob (try " + netTransient + "):", String(e).slice(0, 60));
        await sleep(10000 * netTransient);
        continue;
      }
      if (br.status === 403) return "stop-403";
      if (br.status === 429) {
        bursts429++;
        totalWaits429++;
        if (bursts429 > MAX_429_WAITS) return "stop-429";
        const ms = calc429Wait(br, bursts429);
        err("429 on blob — wait " + bursts429 + "/" + MAX_429_WAITS + ", sleeping " + Math.round(ms / 1000) + "s");
        await sleep(ms);
        continue;
      }
      if (!br.ok) {
        if (br.status >= 500) {
          netTransient++;
          if (netTransient > MAX_TRANSIENT_RETRIES) { err("server error on blob, skipping"); return "skip"; }
          await sleep(10000 * netTransient);
          continue;
        }
        err("blob HTTP " + br.status + " for " + entry.path);
        bankStats[entry.path.split("/")[0]].errors++;
        return "skip";
      }

      // --- decrypt + store ---
      try {
        const buf = await br.arrayBuffer();
        const raw = new Uint8Array(buf);
        const iv = raw.subarray(0, 12);
        const ct = raw.subarray(12);
        const keyBytes = new Uint8Array(kd.k.length / 2);
        for (let j = 0; j < keyBytes.length; j++) keyBytes[j] = parseInt(kd.k.substr(j * 2, 2), 16);
        const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
        const dec = await crypto.subtle.decrypt({ name: "AES-GCM", iv, tagLength: 128 }, cryptoKey, ct);
        const plain = new Uint8Array(dec);
        const text = await new Response(new Blob([plain]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
        const data = JSON.parse(text);

        await idb("readwrite", (s) => s.put({ path: entry.path, data: data, fetchedAt: new Date().toISOString() }));

        bursts429 = 0; // success resets the 429 burst counter
        return { status: "ok", data: data };
      } catch (e) {
        decTransient++;
        if (decTransient > MAX_TRANSIENT_RETRIES) {
          err("decrypt/store failed, skipping " + entry.path + ":", String(e).slice(0, 80));
          bankStats[entry.path.split("/")[0]].errors++;
          return "skip";
        }
        await sleep(5000 * decTransient);
        continue;
      }
    }
    return "skip";
  };

  // ================= MAIN LOOP =================
  const t0 = Date.now();
  let fetched = 0, skipped = 0, filesSinceSessionCheck = 0, filesSinceTable = 0;
  const RUN_KEY = "__qbRunState__";

  log("=== STARTING FETCH (" + remaining.length + " files) ===");
  log("stop anytime: window.qbStop()");

  let stop = null;
  for (let i = 0; i < remaining.length; i++) {
    const entry = remaining[i];
    const bank = entry.path.split("/")[0];

    // session check
    if (filesSinceSessionCheck >= SESSION_CHECK_EVERY) {
      filesSinceSessionCheck = 0;
      try {
        const mr = await fetch("/qbapi/me", { credentials: "include", cache: "no-store" });
        const md = await mr.json();
        if (!md || md.code === undefined) { stop = "stop-session"; break; }
      } catch (e) { err("session check failed — halting for safety"); stop = "stop-session"; break; }
    }

    const result = await fetchOne(entry);

    if (result === "stop-403") { stop = "stop-403"; break; }
    if (result === "stop-429") { stop = "stop-429"; break; }
    if (result === "stop-session") { stop = "stop-session"; break; }
    if (result === "stop-user") { stop = "stop-user"; break; }

    if (result === "skip") {
      skipped++;
      filesSinceSessionCheck++;
      await randomGap(i === remaining.length - 1);
      continue;
    }

    // success
    fetched++;
    bankStats[bank].done++;
    filesSinceSessionCheck++;
    filesSinceTable++;
    const elapsed = Math.round((Date.now() - t0) / 1000);
    const rate = fetched > 0 ? ((fetched / elapsed) * 3600).toFixed(0) : "0";
    const totalStoredNow = alreadyStored + fetched;
    log("[" + totalStoredNow + "/" + allLinks.length + "] " + bank + " | " + entry.path.split("/").pop().replace(".json", "") + " (" + (result.data.total_questions || (result.data.questions && result.data.questions.length) || "?") + " Q) | " + rate + "/hr");

    try {
      localStorage.setItem(RUN_KEY, JSON.stringify({
        startedAt: new Date(t0).toISOString(),
        updatedAt: new Date().toISOString(),
        stopReason: null,
        lastPath: entry.path,
        thisRun: fetched,
        totalStored: totalStoredNow,
        ofTotal: allLinks.length
      }));
    } catch (e) {}

    if (filesSinceTable >= PROGRESS_TABLE_EVERY) {
      filesSinceTable = 0;
      const rows = {};
      for (const b of Object.keys(bankStats)) rows[b] = { ...bankStats[b], remaining: bankStats[b].inScope - bankStats[b].done };
      console.log("%c--- progress ---", "color:#0ff");
      console.table(rows);
    }

    await randomGap(i === remaining.length - 1);
  }

  // ================= SHUTDOWN =================
  clearInterval(kaInterval);
  stopReason = stop || "complete";

  const totalStored = await countStored();
  const totalMin = Math.round((Date.now() - t0) / 60000);

  try {
    const prev = JSON.parse(localStorage.getItem(RUN_KEY) || "{}");
    localStorage.setItem(RUN_KEY, JSON.stringify({
      ...prev,
      updatedAt: new Date().toISOString(),
      stopReason: stopReason,
      thisRun: fetched,
      totalStored: totalStored
    }));
  } catch (e) {}

  const rows = {};
  for (const b of Object.keys(bankStats)) rows[b] = { ...bankStats[b], remaining: bankStats[b].inScope - bankStats[b].done };

  console.log("%c=== RUN FINISHED ===", "color:#0f0;font-size:13px");
  console.log("stop reason:", stopReason);
  console.log("fetched this run:", fetched, "| skipped:", skipped, "| 429 waits:", totalWaits429, "| elapsed:", totalMin, "min");
  console.log("total in IDB:", totalStored, "of", allLinks.length, "in scope");
  console.table(rows);

  if (stopReason === "stop-403") {
    err("ACCOUNT PAUSED (403). This is account-level — do NOT retry.");
    err("Message @neet_pg_bot to request un-pause. Re-running will only extend the flag.");
    err("Your IndexedDB data is safe. Nothing else to do until the owner responds.");
  } else if (stopReason === "stop-429") {
    err("Rate limited after " + MAX_429_WAITS + " waits. Wait ~10-15 min, then re-run (auto-resumes).");
  } else if (stopReason === "stop-session") {
    err("Session died. Code is expired — you cannot re-login until a new code is issued.");
  } else if (stopReason === "stop-user") {
    log("Stopped by user. Re-run to resume.");
  } else if (totalStored >= allLinks.length) {
    log("ALL FILES FETCHED! Run window.qbIdb.downloadAll() to export.");
  } else {
    log("REMAINING:", allLinks.length - totalStored, "files. Re-run to continue.");
  }

  setupHelpers(db, STORE_NAME);
})();

function setupHelpers(db, STORE_NAME) {
  window.qbIdb = {
    status: async () => {
      const all = await new Promise((r) => { const tx = db.transaction(STORE_NAME, "readonly"); const rq = tx.objectStore(STORE_NAME).getAll(); rq.onsuccess = () => r(rq.result); rq.onerror = () => r([]); });
      const banks = {};
      for (const item of all) { const b = item.path.split("/")[0]; banks[b] = (banks[b] || 0) + 1; }
      console.log("[IDB] stored:", all.length, "files");
      console.table(banks);
      try { console.log("[run state]", localStorage.getItem("__qbRunState__")); } catch (e) {}
    },
    downloadAll: async () => {
      console.log("[IDB] reading all stored files...");
      const all = await new Promise((r) => { const tx = db.transaction(STORE_NAME, "readonly"); const rq = tx.objectStore(STORE_NAME).getAll(); rq.onsuccess = () => r(rq.result); rq.onerror = () => r([]); });
      console.log("[IDB] found", all.length, "files. Building export...");
      const out = { generatedAt: new Date().toISOString(), count: all.length, files: all.map((item) => ({ path: item.path, data: item.data, fetchedAt: item.fetchedAt })) };
      const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "all-qbank-content.json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      console.log("[IDB] downloaded", all.length, "files as", a.download);
    },
    exportCSV: async () => {
      const all = await new Promise((r) => { const tx = db.transaction(STORE_NAME, "readonly"); const rq = tx.objectStore(STORE_NAME).getAll(); rq.onsuccess = () => r(rq.result); rq.onerror = () => r([]); });
      const lines = ["path,total_questions,title"];
      for (const item of all) {
        const d = item.data || {};
        const title = (d.title || "").replace(/"/g, '""');
        lines.push('"' + item.path + '",' + (d.total_questions || (d.questions && d.questions.length) || 0) + ',"' + title + '"');
      }
      const blob = new Blob([lines.join("\n")], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "all-qbank-index.csv";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      console.log("[IDB] downloaded CSV with", all.length, "rows");
    },
    clear: async () => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).clear();
      console.log("[IDB] cleared all stored files");
    }
  };
  console.log("[IDB] helpers ready: window.qbIdb.downloadAll(), .status(), .exportCSV(), .clear()  |  stop: window.qbStop()");
  window.qbIdb.status();
}
