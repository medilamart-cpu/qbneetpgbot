/* 04-bundle-mining.js — read the app's own JS to find the full catalog source.
 *
 * Confirmed so far: /new-tests.json = 2486 tests with full paths + question
 * counts, but it is a 30-day build snapshot (days param is ignored, every row
 * shares one build timestamp). The complete library tree that the app renders
 * when you click a bank must be loaded from somewhere else.
 *
 * Rather than keep guessing endpoints, this script fetches the app's own
 * JavaScript bundles and greps them for:
 *   - every /qbapi/... route
 *   - every  ....json  filename literal
 *   - catalog-ish keywords (manifest, catalog, tree, index, refs, banks, ...)
 * It also re-lists the exact sync REQUEST body the app sends, if any fired.
 *
 * HOW TO USE
 * 1. Signed in at qb.neetpgbot.in, YOUR OWN Chrome.
 * 2. F12 -> Console (allow pasting if warned). Clear input, paste, Enter.
 *      You should see:  [mine] ready
 * 3. Let it run (~10-30s). Then copy and paste back:
 *
 *        copy(window.qbMineReport())
 */
(async () => {
  const log = (...a) => console.log("%c[mine]", "color:#f80;font-weight:bold", ...a);

  // ---- 1) find the app's script URLs ----
  const scriptUrls = new Set();
  for (const s of document.scripts) if (s.src) scriptUrls.add(s.src);
  try {
    for (const e of performance.getEntriesByType("resource")) {
      if (e.name && /\.js(\?|$)/.test(e.name)) scriptUrls.add(e.name);
    }
  } catch (e) { /* ignore */ }

  log("script candidates:", [...scriptUrls]);

  // ---- 2) fetch each bundle and mine it ----
  const routes = new Set();
  const jsonFiles = new Set();
  const keywords = new Map(); // keyword -> [contexts]
  const KW = /(manifest|catalog|tree|index|refs|banks|library|libraries|courses|questions|structure|outline|browse|files)/gi;

  const LIMIT = 6_000_000;
  for (const url of scriptUrls) {
    let txt = "";
    try {
      const r = await fetch(url, { credentials: "include" });
      txt = await r.text();
    } catch (e) { log("could not fetch", url, String(e)); continue; }
    if (txt.length > LIMIT) txt = txt.slice(0, LIMIT);
    log("mining", url, txt.length, "chars");

    // /qbapi/ routes
    for (const m of txt.matchAll(/\/qbapi\/[A-Za-z0-9._\-\/]*/g)) routes.add(m[0]);
    // root-level and nested .json filenames (string literals)
    for (const m of txt.matchAll(/["'`]([A-Za-z0-9 _().+\-\/]{2,120}\.json)["'`]/g)) jsonFiles.add(m[1]);
    // keyword contexts
    for (const m of txt.matchAll(KW)) {
      const kw = m[1].toLowerCase();
      const start = Math.max(0, m.index - 60);
      const ctx = txt.slice(start, m.index + 80).replace(/\s+/g, " ");
      if (!keywords.has(kw)) keywords.set(kw, []);
      if (keywords.get(kw).length < 6) keywords.get(kw).push({ file: url.split("/").pop(), ctx });
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  log("distinct /qbapi routes:", routes.size);
  log("distinct .json literals:", jsonFiles.size);

  // ---- 3) probe any NEW .json literals we discovered, authenticated ----
  const known = new Set(["new-tests.json"]);
  const fresh = [...jsonFiles].filter((f) => !known.has(f) && !f.includes("$") && !f.includes("{"));
  const probed = [];
  for (const f of fresh.slice(0, 40)) {
    try {
      const r = await fetch(f, { credentials: "include" });
      const t = await r.text();
      const isJson = /^[{[]/.test(t.trim());
      const paths = isJson ? (t.match(/[A-Za-z0-9 _().+\-]+\/[^"\\]*\.json/g) || []).length : 0;
      probed.push({ file: f, status: r.status, len: t.length, json: isJson, paths });
      if (isJson && paths > 50) window["__qbCat_" + f.replace(/[^a-z0-9]/gi, "_")] = t;
    } catch (e) { probed.push({ file: f, status: "ERR", len: 0, json: false, paths: 0 }); }
    await new Promise((r) => setTimeout(r, 60));
  }

  // ---- 4) probe /qbapi routes that look like listing endpoints, unauth-safe ----
  const listy = [...routes].filter((r) => /(tree|index|catalog|manifest|list|files|bank|library|course|question|ref|test)/i.test(r));
  const apiProbed = [];
  for (const u of listy.slice(0, 30)) {
    try {
      const r = await fetch(u, { credentials: "include" });
      const t = await r.text();
      const isJson = /^[{[]/.test(t.trim());
      const paths = isJson ? (t.match(/[A-Za-z0-9 _().+\-]+\/[^"\\]*\.json/g) || []).length : 0;
      apiProbed.push({ url: u, status: r.status, len: t.length, json: isJson, paths, head: t.trim().slice(0, 100) });
      if (isJson && paths > 50) window["__qbApi_" + u.replace(/[^a-z0-9]/gi, "_")] = t;
    } catch (e) { apiProbed.push({ url: u, status: "ERR", len: 0, json: false, paths: 0 }); }
    await new Promise((r) => setTimeout(r, 60));
  }

  // ---- report ----
  const kwOut = {};
  for (const [k, v] of keywords) kwOut[k] = v;

  window.qbMineReport = () => JSON.stringify({
    scriptFiles: [...scriptUrls].map((u) => u.split("/").pop()),
    routes: [...routes].sort(),
    jsonLiterals: [...jsonFiles].sort(),
    probedJsonFiles: probed.filter((p) => p.json || p.status === 200),
    probedApiRoutes: apiProbed.filter((p) => p.json || p.paths > 0),
    keywordContexts: kwOut
  }, null, 2);

  console.table(probed.filter((p) => p.json));
  console.table(apiProbed.filter((p) => p.json));
  log("DONE. run:  copy(window.qbMineReport())");
})();
