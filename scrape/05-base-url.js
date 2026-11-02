/* 05-base-url.js — recover the catalog's real base origin + master course list.
 *
 * Bundle mining showed the app loads its catalog through a helper xt(path):
 *     xt("courses.json")                     -> master course list
 *     `manifest_${course}.json`              -> per-course manifest
 *     `/data/${x}.manifest.json`             -> {shards:[...]}
 *     `search/${course}/manifest.json`       -> search shards
 * Those are NOT fetched from the site root (probing them there returns the SPA
 * fallback HTML). The bundle references s3.ap-south-1.amazonaws.com, so xt()
 * prefixes a CDN/S3 base. This script:
 *   1. Downloads the JS bundles and extracts the base-URL construction + the
 *      hardcoded fallback course catalog, with surrounding code as evidence.
 *   2. Hooks fetch/XHR to log EVERY request (any origin) so browsing reveals
 *      the true absolute URLs the app actually uses.
 *   3. Tries a list of candidate bases for courses.json and reports which one
 *      returns real JSON.
 *
 * HOW TO USE
 * 1. Signed in at qb.neetpgbot.in, YOUR OWN Chrome.
 * 2. F12 -> Console (allow pasting if warned). Clear input, paste, Enter.
 *      You should see:  [base] ready
 * 3. WITHOUT reloading, click around for ~30s: open a bank, a folder, a test,
 *    the New Tests page, the course switcher. Every JSON request gets logged.
 * 4. Then copy and paste back:
 *
 *        copy(window.qbBaseReport())
 */
(async () => {
  const log = (...a) => console.log("%c[base]", "color:#f0f;font-weight:bold", ...a);

  // ---------- 1) hook fetch + XHR to log EVERY absolute URL ----------
  if (!window.__qbAllReq) {
    window.__qbAllReq = new Map(); // url -> count
    const bump = (u) => window.__qbAllReq.set(u, (window.__qbAllReq.get(u) || 0) + 1);
    const of = window.fetch;
    window.fetch = function (...args) {
      try {
        const u = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
        if (u) bump(new URL(u, location.href).href);
      } catch (e) { /* ignore */ }
      return of.apply(this, args);
    };
    const oo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) { try { if (u) bump(new URL(u, location.href).href); } catch (e) {} return oo.apply(this, arguments); };
    log("request logger installed — now click around the app");
  }

  // ---------- 2) grab the bundles ----------
  const bundleNames = ["index-BIQSOdrK.js", "ui-C03EVDcF.js"];
  const texts = {};
  for (const n of bundleNames) {
    try {
      const r = await fetch("/assets/" + n, { credentials: "include" });
      if (r.ok) texts[n] = await r.text();
    } catch (e) { /* try alternate path below */ }
    if (!texts[n]) {
      try {
        const r = await fetch(n, { credentials: "include" });
        if (r.ok) texts[n] = await r.text();
      } catch (e) { /* ignore */ }
    }
    log(n, texts[n] ? texts[n].length + " chars" : "NOT FOUND");
  }
  const all = Object.values(texts).join("\n");

  // ---------- 3) extract base-url + catalog context ----------
  const anchors = [
    /s3\.ap-south-1[A-Za-z0-9._\-\/]*/g,
    /\bxt\s*=\s*/g,
    /function\s+xt\b/g,
    /manifest_\$\{/g,
    /question_index_/g,
    /\/data\/\$\{/g,
    /courses\.json/g,
    /search\/\$\{/g,
    /(CDN|BASE_URL|ASSET|ORIGIN|BUCKET|S3_)/g
  ];
  const ctx = (idx, before, after) => all.slice(Math.max(0, idx - before), idx + after).replace(/\s+/g, " ");

  const found = {};
  for (const re of anchors) {
    const key = String(re);
    found[key] = [];
    let m, guard = 0;
    while ((m = re.exec(all)) && guard++ < 12) {
      found[key].push(ctx(m.index, 140, 220));
    }
  }

  // pull the hardcoded fallback course catalog (array of {id,name,prefix,folders})
  const catIdx = all.indexOf('folders:["');
  const catCtx = catIdx >= 0 ? ctx(Math.max(0, catIdx - 900), 0, 1400) : "(not found)";

  window.__qbBundleText = all;

  // ---------- 4) candidate bases for courses.json ----------
  const candidates = [
    "https://cdn.neetpgbot.in",
    "https://static.neetpgbot.in",
    "https://qb-cdn.neetpgbot.in",
    "https://qb.neetpgbot.in/catalog",
    "https://qb.neetpgbot.in/data",
    "https://qb.neetpgbot.in/static",
    "https://qb.neetpgbot.in/assets",
    "https://neetpgbot.in",
    "https://app-catalog.s3.ap-south-1.amazonaws.com",
    "https://qb-catalog.s3.ap-south-1.amazonaws.com",
    "https://studyos-catalog.s3.ap-south-1.amazonaws.com"
  ];
  const probed = [];
  for (const b of candidates) {
    try {
      const r = await fetch(b.replace(/\/$/, "") + "/courses.json", { mode: "cors" });
      const t = await r.text();
      const isJson = /^[{[]/.test(t.trim());
      probed.push({ base: b, status: r.status, len: t.length, json: isJson, head: t.trim().slice(0, 90) });
      if (isJson) window.__qbCourses = t;
    } catch (e) { probed.push({ base: b, status: "ERR/CORS", len: 0, json: false, head: String(e).slice(0, 60) }); }
    await new Promise((r) => setTimeout(r, 60));
  }

  // ---------- report ----------
  window.qbBaseReport = () => JSON.stringify({
    bundleSizes: Object.fromEntries(Object.entries(texts).map(([k, v]) => [k, v.length])),
    baseUrlContexts: found,
    fallbackCatalogExcerpt: catCtx,
    candidateProbe: probed,
    capturedRequestsSoFar: [...window.__qbAllReq.entries()]
      .filter(([u]) => /\.json|manifest|\/data\/|courses|search/.test(u))
      .sort()
  }, null, 2);

  console.table(probed);
  log("bundle saved to window.__qbBundleText — you can grep it live, e.g.:");
  log("  __qbBundleText.match(/https?:\\/\\/[^\"'`]{0,80}/g)");
  log("DONE step 1. NOW click around the app for ~30s, then:  copy(window.qbBaseReport())");
})();
