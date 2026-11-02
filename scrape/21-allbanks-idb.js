/* 21-allbanks-idb.js — fetch ALL question banks + store in IndexedDB.
 *
 * Fetches every question file from ALL banks (not just Marrow) and stores
 * them in IndexedDB — NO download prompts, NO user interaction needed.
 * Runs fully unattended. When done, one download exports everything.
 *
 * HOW TO USE
 *   1. Run 14-links-reuse.js first (populate window.qbLinks)
 *   2. Paste this, Enter. It runs automatically.
 *   3. Leave tab open (minimize OK). Don't reload.
 *   4. When you return: window.qbIdb.downloadAll()
 *
 * CONFIGURATION:
 *   DELAY_MS: delay between files (default 2500)
 *   BANKS: which banks to fetch (default ALL)
 */
(async () => {
  const log = (...a) => console.log("%c[ALL]", "color:#0f0;font-weight:bold", ...a);
  const err = (...a) => console.log("%c[ALL]", "color:#f33;font-weight:bold", ...a);
  const warn = (...a) => console.log("%c[ALL]", "color:#fa0;font-weight:bold", ...a);

  const DELAY_MS = 2500;
  const BANKS = ["AMBOSS", "Cerebellum", "Core_BTR", "DAMS", "DocTutorials", "Osmosis", "PrepLadder", "Reflex", "Speed", "eGurukul", "medsynapse"]; // Marrow excluded (already fetched)

  // ===== Session check =====
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

  // ===== Get links =====
  if (!window.qbLinks || !window.qbLinks.data || !window.qbLinks.data.entries) {
    err("No links in memory. Run 14-links-reuse.js first.");
    return;
  }
  let allLinks = window.qbLinks.data.entries;
  if (BANKS) {
    allLinks = allLinks.filter((e) => BANKS.includes(e.path.split("/")[0]));
  }
  log("total files to fetch:", allLinks.length);
  const bankCounts = {};
  for (const e of allLinks) { const b = e.path.split("/")[0]; bankCounts[b] = (bankCounts[b] || 0) + 1; }
  console.table(bankCounts);

  // ===== Open IndexedDB =====
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

  const countStored = () => new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(0);
  });
  const getStoredPaths = () => new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAllKeys();
    req.onsuccess = () => resolve(new Set(req.result));
    req.onerror = () => resolve(new Set());
  });

  const alreadyStored = await countStored();
  const storedPaths = await getStoredPaths();
  const remaining = allLinks.filter((e) => !storedPaths.has(e.path));
  log("already stored:", alreadyStored, "| remaining:", remaining.length);

  if (remaining.length === 0) {
    log("ALL FILES ALREADY IN IDB. Run window.qbIdb.downloadAll() to export.");
    setupHelpers(db, STORE_NAME);
    return;
  }

  // ===== Keep-alive =====
  log("Starting keep-alive...");
  const kaInterval = setInterval(async () => {
    try { await fetch("/qbapi/ping", { credentials: "include", cache: "no-store" }); } catch (e) {}
  }, 30000);

  // ===== STAMP (X-SOS-Stamp header, now required by backend) =====
  let __stampCache21 = null;
  const getStamp21 = async () => {
    const today = new Date().toISOString().slice(0, 10);
    if (__stampCache21 && __stampCache21.day === today) return __stampCache21;
    const r = await fetch("/qbapi/stamp", { credentials: "include", cache: "no-store" });
    const t = await r.json();
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(t.k), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    __stampCache21 = { key, day: t.day, offset: (t.now ? t.now * 1000 : Date.now()) - Date.now() };
    return __stampCache21;
  };
  const stampHeaderFor21 = async (url) => {
    const s = await getStamp21();
    const n = Math.floor((Date.now() + s.offset) / 1000);
    if (s.day && new Date(n * 1000).toISOString().slice(0, 10) !== s.day) {
      __stampCache21 = null;
      return stampHeaderFor21(url);
    }
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", s.key, new TextEncoder().encode(n + "|" + url)));
    const hex = Array.from(sig.subarray(0, 16), (i) => i.toString(16).padStart(2, "0")).join("");
    return { "X-SOS-Stamp": n + "." + hex };
  };

  // ===== Fetch loop =====
  let fetched = 0, errors = 0, rateLimited = false;
  const t0 = Date.now();

  for (let i = 0; i < remaining.length; i++) {
    const entry = remaining[i];

    if (i > 0 && i % 10 === 0) {
      try {
        const mr = await fetch("/qbapi/me", { credentials: "include", cache: "no-store" });
        const md = await mr.json();
        if (!md || md.code === undefined) { err("session died at file " + i); rateLimited = true; break; }
      } catch (e) { err("session check failed:", String(e)); rateLimited = true; break; }
    }

    try {
      const kr = await fetch("/qbapi/key?u=" + entry.keyId, { credentials: "include", cache: "no-store", headers: await stampHeaderFor21("/c/" + entry.keyId.slice(0, 2) + "/" + entry.keyId.slice(2)) });
      if (kr.status === 429 || kr.status === 403) {
        const retryAfter = kr.headers.get("Retry-After");
        err("RATE LIMITED (" + kr.status + ") on " + entry.path);
        err("Retry-After: " + (retryAfter || "unknown (default 10min)"));
        rateLimited = true;
        break;
      }
      if (!kr.ok) { err("key fetch " + kr.status + " for " + entry.path); errors++; continue; }
      const kd = await kr.json();

      const br = await fetch(entry.blobUrl, { credentials: "include", cache: "force-cache", headers: await stampHeaderFor21(entry.blobUrl) });
      if (br.status === 429 || br.status === 403) {
        err("RATE LIMITED (" + br.status + ") on blob " + entry.path);
        rateLimited = true;
        break;
      }
      if (!br.ok) { err("blob fetch " + br.status + " for " + entry.path); errors++; continue; }
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
      log("[" + totalStored + "/" + allLinks.length + "] " + entry.path.split("/").pop().replace(".json", "") + " (" + (data.total_questions || (data.questions && data.questions.length) || "?") + " Q) | " + rate + "/hr");

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
  log("total in IDB:", totalStored, "of", allLinks.length);
  log("time elapsed:", totalElapsed, "minutes");
  if (rateLimited) {
    err("STOPPED due to rate limiting. Wait, then re-run (resumes automatically).");
  }
  if (totalStored < allLinks.length) {
    log("REMAINING:", allLinks.length - totalStored, "files. Re-run to continue.");
  } else {
    log("ALL FILES FETCHED!");
  }

  setupHelpers(db, STORE_NAME);
  log("Run window.qbIdb.downloadAll() to export everything as one file.");
})();

function setupHelpers(db, STORE_NAME) {
  window.qbIdb = {
    status: async () => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.count();
      const all = await new Promise((r) => { const rq = store.getAll(); rq.onsuccess = () => r(rq.result); rq.onerror = () => r([]); });
      const banks = {};
      for (const item of all) { const b = item.path.split("/")[0]; banks[b] = (banks[b] || 0) + 1; }
      console.log("[IDB] stored:", all.length, "files");
      console.table(banks);
    },
    downloadAll: async () => {
      console.log("[IDB] reading all stored files...");
      const all = await new Promise((r) => { const tx = db.transaction(STORE_NAME, "readonly"); const store = tx.objectStore(STORE_NAME); const rq = store.getAll(); rq.onsuccess = () => r(rq.result); rq.onerror = () => r([]); });
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
  console.log("[IDB] download helpers ready: window.qbIdb.downloadAll(), .status(), .exportCSV(), .clear()");
  window.qbIdb.status();
}
