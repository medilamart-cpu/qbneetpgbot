/* 06-vault.js — decode the encrypted-catalog loader + install a reload-proof hook.
 *
 * Finding: courses.json / manifest_*.json are ENCRYPTED blobs. xt(path) does:
 *     fetch(blob) -> decrypt(key) -> decompress -> JSON.parse
 * So there is no plain URL to guess. Instead we (a) read the loader's own source
 * out of the already-downloaded bundle to learn the exact URL + crypto, and
 * (b) install a persistent fetch hook (via a blob: script, allowed by the CSP)
 * that logs every request to localStorage so it SURVIVES a page reload.
 *
 * HOW TO USE
 * 1. Signed in, YOUR OWN Chrome, F12 -> Console (allow pasting if warned).
 * 2. Clear input, paste all of this, Enter.  You should see:  [vault] ready
 * 3. Read the printed "LOADER SOURCE" + "DOMAINS" sections.
 * 4. Now RELOAD the page (F5) — the hook persists. Click into one bank + one
 *    folder + one test so the catalog loads.
 * 5. Then run:   copy(window.qbVaultReport())
 */
(async () => {
  const log = (...a) => console.log("%c[vault]", "color:#f60;font-weight:bold", ...a);

  // ---------- PART A: pull the loader source out of the saved bundle ----------
  let all = window.__qbBundleText;
  if (!all) {
    log("no saved bundle — refetching index bundle");
    try { const r = await fetch("/assets/index-BIQSOdrK.js", { credentials: "include" }); all = await r.text(); } catch (e) { all = ""; }
    window.__qbBundleText = all;
  }
  log("bundle length:", all.length);

  const grabFn = (name) => {
    // find `name=` or `name =` then take a generous slice
    const re = new RegExp("(?:^|[,;{\\s])" + name.replace(/\$/g, "\\$") + "\\s*=\\s*");
    const m = re.exec(all);
    if (!m) return "(not found: " + name + ")";
    const start = m.index + m[0].length - 1;
    return all.slice(start, start + 900).replace(/\s+/g, " ");
  };
  const fns = {};
  for (const n of ["Ak", "Dd", "Ok", "Jp", "Xp", "Sk", "$d", "El", "Va", "c", "l", "u"]) fns[n] = grabFn(n);

  // every fetch( call site, with context
  const fetchCtx = [];
  for (const m of all.matchAll(/fetch\(/g)) {
    fetchCtx.push(all.slice(Math.max(0, m.index - 120), m.index + 200).replace(/\s+/g, " "));
    if (fetchCtx.length > 25) break;
  }

  // all distinct hostnames / URL-ish literals in the bundle
  const domains = new Set();
  for (const m of all.matchAll(/https?:\/\/([A-Za-z0-9._-]+)/g)) domains.add(m[1]);
  for (const m of all.matchAll(/["'`]\/(?:c|data|qbapi|search|assets)\/[^"'`]{0,40}/g)) domains.add("PATH " + m[0]);

  // ---------- PART B: probe the two real asset domains ----------
  const probes = [];
  for (const base of [
    "https://corebtr-assets-production.s3.ap-south-1.amazonaws.com",
    "https://assets.corebtr.com"
  ]) {
    for (const f of ["courses.json", "manifest_neetpg.json"]) {
      try {
        const r = await fetch(base + "/" + f, { mode: "no-cors" }); // opaque ok, tells us reachability
        probes.push({ url: base + "/" + f, status: r.status, type: r.type });
      } catch (e) { probes.push({ url: base + "/" + f, status: "ERR", head: String(e).slice(0, 50) }); }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  console.table(probes);

  // ---------- PART C: persistent hook (survives reload via blob: script) ----------
  // Records every request URL + (for catalog-ish JSON) a small response preview
  // into localStorage, so it survives the F5 that clears the console.
  const hookCode = `
(function(){
  if (window.__qbHooked) return; window.__qbHooked = true;
  var K = "__qbURLLOG__";
  var log = JSON.parse(localStorage.getItem(K) || "[]");
  var save = function(){ try { localStorage.setItem(K, JSON.stringify(log.slice(-800))); } catch(e){} };
  var push = function(url, kind, info){ log.push({u:url, k:kind, i:info||"", t:Date.now()}); save(); };
  var of = window.fetch;
  window.fetch = function(){
    var args = arguments;
    var url = "";
    try { url = typeof args[0]==="string" ? args[0] : (args[0] && args[0].url) || ""; } catch(e){}
    var abs = url;
    try { abs = new URL(url, location.href).href; } catch(e){}
    var isCat = /courses\\.json|manifest_|question_index|subject_topic|\\/data\\/|\\/c\\/|qbapi\\/key|search\\//.test(abs);
    return of.apply(this, args).then(function(res){
      if (isCat) {
        push(abs, "res", res.status + " " + (res.headers.get("content-type")||"") + " len=" + (res.headers.get("content-length")||"?"));
        try {
          res.clone().arrayBuffer().then(function(buf){
            var b = new Uint8Array(buf.slice(0, 24));
            var hex = Array.from(b).map(function(x){return ("0"+x.toString(16)).slice(-2);}).join("");
            var asc = Array.from(b).map(function(x){return (x>=32&&x<127)?String.fromCharCode(x):".";}).join("");
            push(abs, "head", "hex="+hex+" ascii="+asc+" total="+buf.byteLength);
          }).catch(function(){});
        } catch(e){}
      } else {
        push(abs, "req", "");
      }
      return res;
    }).catch(function(e){ push(abs, "err", String(e)); throw e; });
  };
  var oo = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(m,u){ try{ this.__abs = new URL(u, location.href).href; }catch(e){ this.__abs = u; } return oo.apply(this, arguments); };
  console.log("%c[vault-hook] installed, logging to localStorage.__qbURLLOG__", "color:#0f0");
})();`;

  try {
    const s = document.createElement("script");
    s.src = URL.createObjectURL(new Blob([hookCode], { type: "text/javascript" }));
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
    log("persistent hook injected (blob: script). It will survive an F5.");
  } catch (e) {
    log("could not inject hook:", String(e));
    // fall back to inline patch so at least this session logs
    try { eval(hookCode); } catch (e2) { log("inline fallback failed:", String(e2)); }
  }

  // ---------- report ----------
  window.qbVaultReport = () => {
    const urlLog = JSON.parse(localStorage.getItem("__qbURLLOG__") || "[]");
    const catalogish = urlLog.filter((e) => e.k === "res" || e.k === "head");
    return JSON.stringify({
      domainsInBundle: [...domains].sort(),
      fetchCallSites: fetchCtx.slice(0, 15),
      loaderSource: fns,
      probes,
      capturedCatalogRequests: catalogish.slice(-120),
      totalLoggedUrls: urlLog.length
    }, null, 2);
  };

  // print the most useful bits right now
  console.log("%c--- LOADER: Ak (the vault read) ---", "color:#ff0");
  console.log(fns.Ak);
  console.log("%c--- LOADER: Dd (key/index source) ---", "color:#ff0");
  console.log(fns.Dd);
  console.log("%c--- LOADER: key var c ---", "color:#ff0");
  console.log(fns.c);
  console.log("%c--- DOMAINS in bundle ---", "color:#ff0");
  console.log([...domains].sort().join("\n"));
  log("NOW: reload (F5), click one bank > folder > test, then  copy(window.qbVaultReport())");
})();
