/* 03-manifest-probe.js — find the FULL library catalog.
 *
 * Findings so far: /qbapi/sync only holds YOUR personal state (custom modules,
 * attempts). The full banks -> subjects -> folders -> tests tree must come from
 * either (a) a static manifest at the site root, next to /new-tests.json, or
 * (b) the service-worker cache / IndexedDB, which the app populates when it
 * builds the tree you browse.
 *
 * This script does three things, all read-only:
 *   1. Dumps /new-tests.json in full (the known-good sample of the format).
 *   2. Probes root-level + /qbapi/* candidate manifest endpoints WHILE
 *      AUTHENTICATED (session cookie included) and classifies each response.
 *   3. Scans the service-worker cache and IndexedDB for any stored JSON that
 *      contains many ".json" file paths (that would be the catalog).
 *
 * HOW TO USE
 * 1. Sign in at qb.neetpgbot.in in YOUR OWN Chrome.
 * 2. F12 -> Console (type  allow pasting  if warned). Clear input, paste, Enter.
 *      You should see:  [probe] ready
 * 3. Let it run (~10-25s, it self-drives). Then copy and paste back:
 *
 *        copy(window.qbProbeReport())
 */
(async () => {
  const log = (...a) => console.log("%c[probe]", "color:#0c8;font-weight:bold", ...a);

  const roots = [
    "new-tests.json", "tests.json", "all-tests.json", "index.json", "tree.json",
    "manifest.json", "catalog.json", "files.json", "banks.json", "courses.json",
    "library.json", "qb.json", "new-videos.json", "videos.json", "list.json",
    "new-tests.json?days=99999", "new-tests.json?days=36500", "new-tests.json?all=1",
    "new-tests.json?full=1", "new-tests.json?since=0"
  ];
  const apis = [
    "/qbapi/files", "/qbapi/tree", "/qbapi/index", "/qbapi/library", "/qbapi/libraries",
    "/qbapi/banks", "/qbapi/catalog", "/qbapi/manifest", "/qbapi/tests", "/qbapi/list",
    "/qbapi/questions", "/qbapi/refs", "/qbapi/extra-tests", "/qbapi/videos/new"
  ];

  const hits = [];
  const scan = (tag, url, status, txt) => {
    const t = String(txt || "");
    const trimmed = t.trim();
    const isJson = /^[{[]/.test(trimmed);
    const isHtml = /^<!doctype|^<html/i.test(trimmed);
    // count how many ".json" path strings appear — a real catalog has many
    const pathMatches = isJson ? (trimmed.match(/[A-Za-z0-9 _().+-]+\/[^"\\]*\.json/g) || []).length : 0;
    hits.push({ tag, url, status, len: t.length, json: isJson, html: isHtml, paths: pathMatches, head: trimmed.slice(0, 120) });
  };

  const get = async (u) => {
    try {
      const r = await fetch(u, { credentials: "include" });
      const t = await r.text();
      scan("GET", u, r.status, t);
      return t;
    } catch (e) { hits.push({ tag: "GET", url: u, status: "ERR", len: 0, json: false, html: false, paths: 0, head: String(e) }); return ""; }
  };

  // ---- 1) the known-good sample, in full ----
  log("fetching /new-tests.json ...");
  const newTests = await get("new-tests.json");
  let newTestsParsed = null; try { newTestsParsed = JSON.parse(newTests); } catch (e) {}

  // ---- 2) probe candidate manifests ----
  log("probing root manifests ...");
  for (const u of roots) { await get(u); await new Promise((r) => setTimeout(r, 60)); }
  log("probing /qbapi listing endpoints ...");
  for (const u of apis) { await get(u); await new Promise((r) => setTimeout(r, 60)); }

  const realJson = hits.filter((h) => h.json && !h.html && h.status === 200);
  const withPaths = realJson.filter((h) => h.paths > 5);

  // ---- 3) scan service-worker cache + IndexedDB for the catalog ----
  log("scanning service-worker cache ...");
  const cacheFindings = [];
  try {
    const names = await caches.keys();
    for (const n of names) {
      const c = await caches.open(n);
      const reqs = await c.keys();
      for (const req of reqs) {
        try {
          const res = await c.match(req);
          const t = await res.text();
          const pathCount = (t.match(/[A-Za-z0-9 _().+-]+\/[^"\\]*\.json/g) || []).length;
          if (pathCount > 5 || (t.length > 20000 && /^[{[]/.test(t.trim()))) {
            cacheFindings.push({ cache: n, url: new URL(req.url).pathname, len: t.length, paths: pathCount });
            if (pathCount > 5) window.__qbCatalogCache = t; // keep the richest one
          }
        } catch (e) { /* skip */ }
      }
    }
  } catch (e) { cacheFindings.push({ error: String(e) }); }
  log("cache findings:", cacheFindings.length, cacheFindings);

  log("scanning IndexedDB ...");
  const idbFindings = [];
  try {
    const dbs = await new Promise((res) => {
      const rq = indexedDB.databases();
      if (rq && rq.then) rq.then(res).catch(() => res([])); else res([]);
    });
    for (const d of dbs) {
      try {
        const db = await new Promise((res, rej) => { const rq = indexedDB.open(d.name); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
        for (const store of [...db.objectStoreNames]) {
          const tx = db.transaction(store, "readonly");
          const obj = tx.objectStore(store);
          const all = await new Promise((res) => { const rq = obj.getAll(); rq.onsuccess = () => res(rq.result); rq.onerror = () => res([]); });
          const blob = JSON.stringify(all || []);
          const pathCount = (blob.match(/[A-Za-z0-9 _().+-]+\/[^"\\]*\.json/g) || []).length;
          if (pathCount > 5) idbFindings.push({ db: d.name, store, count: (all || []).length, len: blob.length, paths: pathCount });
          if (pathCount > 20) window.__qbCatalogIdb = blob;
        }
        db.close();
      } catch (e) { /* skip db */ }
    }
  } catch (e) { idbFindings.push({ error: String(e) }); }
  log("idb findings:", idbFindings.length, idbFindings);

  // ---- report ----
  window.qbProbeReport = () => JSON.stringify({
    newTestsShape: newTestsParsed ? {
      topKeys: Object.keys(newTestsParsed),
      days: newTestsParsed.days,
      testCount: Array.isArray(newTestsParsed.tests) ? newTestsParsed.tests.length : null,
      firstTests: Array.isArray(newTestsParsed.tests) ? newTestsParsed.tests.slice(0, 5) : null
    } : ("NOT JSON: " + newTests.slice(0, 100)),
    endpointsWithRealJson: realJson.map((h) => ({ url: h.url, status: h.status, len: h.len, paths: h.paths })),
    endpointsWithManyPaths: withPaths.map((h) => ({ url: h.url, len: h.len, paths: h.paths, head: h.head })),
    cacheFindings,
    idbFindings,
    catalogFromCache: window.__qbCatalogCache ? ("present, len=" + window.__qbCatalogCache.length) : "none",
    catalogFromIdb: window.__qbCatalogIdb ? ("present, len=" + window.__qbCatalogIdb.length) : "none"
  }, null, 2);

  console.table(realJson.map((h) => ({ status: h.status, len: h.len, paths: h.paths, url: h.url })));
  log("DONE. run:  copy(window.qbProbeReport())");
})();
