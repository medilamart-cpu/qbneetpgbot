/* 20-marrow-idb.js — fetch Marrow + store in IndexedDB (NO download prompts).
 *
 * Unlike 19-marrow-auto.js (which auto-downloads each chunk and triggers
 * Chrome "Save" dialogs), this stores fetched data in IndexedDB — a
 * browser database with GBs of capacity, no download prompts, no user
 * interaction needed. Perfect for unattended overnight runs.
 *
 * After the run (or anytime), run:
 *   window.qbIdb.downloadAll()   -> downloads everything as one JSON file
 *   window.qbIdb.status()         -> shows progress
 *   window.qbIdb.exportCSV()     -> downloads as CSV
 *
 * HOW TO USE
 *   1. Run 14-links-reuse.js first (populate window.qbLinks)
 *   2. Paste this, Enter. It runs automatically.
 *   3. Leave tab open (minimize OK). Don't reload.
 *   4. When you return: window.qbIdb.downloadAll()
 *
 * CONFIGURATION:
 *   DELAY_MS: delay between files (default 2500)
 *   BANK_FILTER: which bank to fetch (default "Marrow")
 */
(async () => {
  const log = (...a) => console.log("%c[IDB]", "color:#0f0;font-weight:bold", ...a);
  const err = (...a) => console.log("%c[IDB]", "color:#f33;font-weight:bold", ...a);
  const warn = (...a) => console.log("%c[IDB]", "color:#fa0;font-weight:bold", ...a);

  const DELAY_MS = 2500;
  const BANK_FILTER = "Marrow";

  // ===== STEP 1: Session check =====
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
  if (codeExpiry && codeExpiry.getTime() < Date.now()) { err("CODE EXPIRED."); return; }
  if (sessionExpiry && sessionExpiry.getTime() < Date.now()) { err("SESSION EXPIRED."); return; }
  log("session outlives code by:", Math.round((sessionExpiry.getTime() - codeExpiry.getTime()) / 3600000), "hours");

  // ===== STEP 2: Get links =====
  if (!window.qbLinks || !window.qbLinks.data || !window.qbLinks.data.entries) {
    err("No links in memory. Run 14-links-reuse.js first.");
    return;
  }
  const bankLinks = window.qbLinks.data.entries.filter((e) => e.path.startsWith(BANK_FILTER));
  log(BANK_FILTER + " files total:", bankLinks.length);
  if (bankLinks.length === 0) { err("No files found for " + BANK_FILTER); return; }

  // ===== STEP 3: Open IndexedDB =====
  const DB_NAME = "qbFetchDB";
  const STORE_NAME = "questions";
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "path" });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
  log("IndexedDB opened:", DB_NAME);

  // Count already stored
  const countStored = () => new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(0);
  });
  const alreadyStored = await countStored();
  log("already stored in IDB:", alreadyStored);

  // Get set of stored paths
  const getStoredPaths = () => new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAllKeys();
    req.onsuccess = () => resolve(new Set(req.result));
    req.onerror = () => resolve(new Set());
  });
  const storedPaths = await getStoredPaths();
  const remaining = bankLinks.filter((e) => !storedPaths.has(e.path));
  log("remaining to fetch:", remaining.length);

  if (remaining.length === 0) {
    log("ALL " + BANK_FILTER + " FILES ALREADY IN IDB. Run window.qbIdb.downloadAll() to export.");
    setupDownloadHelpers(db, STORE_NAME, BANK_FILTER);
    return;
  }

  // ===== STEP 4: Keep-alive =====
  log("Starting keep-alive...");
  const kaInterval = setInterval(async () => {
    try { await fetch("/qbapi/ping", { credentials: "include", cache: "no-store" }); } catch (e) {}
  }, 30000);

  // ===== STEP 5: Fetch loop =====
  let fetched = 0, errors = 0, rateLimited = false;
  const t0 = Date.now();

  for (let i = 0; i < remaining.length; i++) {
    const entry = remaining[i];

    // Session check every 10 files
    if (i > 0 && i % 10 === 0) {
      try {
        const mr = await fetch("/qbapi/me", { credentials: "include", cache: "no-store" });
        const md = await mr.json();
        if (!md || md.code === undefined) { err("session died at file " + i); rateLimited = true; break; }
      } catch (e) { err("session check failed:", String(e)); rateLimited = true; break; }
    }

    try {
      // fetch key
      const kr = await fetch("/qbapi/key?u=" + entry.keyId, { credentials: "include", cache: "no-store" });
      if (kr.status === 429 || kr.status === 403) {
        const retryAfter = kr.headers.get("Retry-After");
        err("RATE LIMITED (" + kr.status + ") on " + entry.path);
        err("Retry-After: " + (retryAfter || "unknown (default 10min)"));
        rateLimited = true;
        break;
      }
      if (!kr.ok) { err("key fetch " + kr.status + " for " + entry.path); errors++; continue; }
      const kd = await kr.json();

      // fetch blob
      const br = await fetch(entry.blobUrl, { credentials: "include", cache: "force-cache" });
      if (br.status === 429 || br.status === 403) {
        err("RATE LIMITED (" + br.status + ") on blob " + entry.path);
        rateLimited = true;
        break;
      }
      if (!br.ok) { err("blob fetch " + br.status + " for " + entry.path); errors++; continue; }
      const buf = await br.arrayBuffer();

      // decrypt
      const raw = new Uint8Array(buf);
      const iv = raw.subarray(0, 12);
      const ct = raw.subarray(12);
      const keyBytes = new Uint8Array(kd.k.length / 2);
      for (let j = 0; j < keyBytes.length; j++) keyBytes[j] = parseInt(kd.k.substr(j * 2, 2), 16);
      const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
      const dec = await crypto.subtle.decrypt({ name: "AES-GCM", iv, tagLength: 128 }, cryptoKey, ct);
      const plain = new Uint8Array(dec);

      // gunzip
      const text = await new Response(new Blob([plain]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
      const data = JSON.parse(text);

      // store in IndexedDB
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const req = store.put({ path: entry.path, data: data, fetchedAt: new Date().toISOString() });
        req.onsuccess = () => resolve();
        req.onerror = (e) => reject(e.target.error);
      });

      fetched++;
      const elapsed = Math.round((Date.now() - t0) / 1000);
      const rate = fetched > 0 ? (fetched / elapsed * 3600).toFixed(0) : "0";
      const totalStored = alreadyStored + fetched;
      log("[" + totalStored + "/" + bankLinks.length + "] " + entry.path.split("/").pop().replace(".json", "") + " (" + (data.total_questions || (data.questions && data.questions.length) || "?") + " Q) | " + rate + "/hr");

    } catch (e) {
      err("error on " + entry.path + ":", String(e).slice(0, 100));
      errors++;
    }

    if (i < remaining.length - 1) await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  clearInterval(kaInterval);

  const totalStored = await countStored();
  const totalElapsed = Math.round((Date.now() - t0) / 60000);
  log("=== FETCH COMPLETE ===");
  log("fetched this run:", fetched, "| errors:", errors, "| rate limited:", rateLimited);
  log("total in IDB:", totalStored, "of", bankLinks.length);
  log("time elapsed:", totalElapsed, "minutes");
  if (rateLimited) {
    err("STOPPED due to rate limiting. Wait, then re-run (resumes automatically).");
  }
  if (totalStored < bankLinks.length) {
    log("REMAINING:", bankLinks.length - totalStored, "files. Re-run to continue.");
  } else {
    log("ALL " + BANK_FILTER + " FILES FETCHED!");
    log("Run window.qbIdb.downloadAll() to export everything.");
  }

  // ===== Download helpers =====
  setupDownloadHelpers(db, STORE_NAME, BANK_FILTER, totalStored);
})();

function setupDownloadHelpers(db, STORE_NAME, BANK_FILTER, totalStored) {
  window.qbIdb = {
    status: async () => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.count();
      req.onsuccess = () => console.log("[IDB] stored:", req.result, "files");
      const all = await new Promise((r) => { const rq = store.getAll(); rq.onsuccess = () => r(rq.result); rq.onerror = () => r([]); });
      const banks = {};
      for (const item of all) { const b = item.path.split("/")[0]; banks[b] = (banks[b] || 0) + 1; }
      console.table(banks);
    },
    downloadAll: async () => {
      console.log("[IDB] reading all stored files...");
      const all = await new Promise((r) => { const tx = db.transaction(STORE_NAME, "readonly"); const store = tx.objectStore(STORE_NAME); const rq = store.getAll(); rq.onsuccess = () => r(rq.result); rq.onerror = () => r([]); });
      console.log("[IDB] found", all.length, "files. Building export...");
      const out = { generatedAt: new Date().toISOString(), bank: BANK_FILTER, count: all.length, files: all.map((item) => ({ path: item.path, data: item.data, fetchedAt: item.fetchedAt })) };
      const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = BANK_FILTER.toLowerCase() + "-full-content.json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      console.log("[IDB] downloaded", all.length, "files as", a.download);
    },
    exportCSV: async () => {
      const all = await new Promise((r) => { const tx = db.transaction(STORE_NAME, "readonly"); const store = tx.objectStore(STORE_NAME); const rq = store.getAll(); rq.onsuccess = () => r(rq.result); rq.onerror = () => r([]); });
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
      a.download = BANK_FILTER.toLowerCase() + "-index.csv";
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
  console.log("[IDB] download helpers ready: window.qbIdb.downloadAll(), .status(), .exportCSV(), .clear()");
  window.qbIdb.status();
}
