/* 13-links.js (v2) — simpler: blob ONLY decrypts, main context builds links.
 *
 * The previous version timed out (complex orchestration inside the blob).
 * This version: blob decrypts the manifest and stores the raw .b map on window;
 * the main context then builds the entries array. Easier to debug.
 *
 * HOW TO USE
 *   Console healthy. Clear input, paste, Enter. Wait ~15-45s.
 *   Then:   copy(window.qbLinks.csv())   -> links.csv
 *           copy(window.qbLinks.json())  -> links.json
 */
(async () => {
  const log = (...a) => console.log("%c[LINKS]", "color:#f60;font-weight:bold", ...a);
  const err = (...a) => console.log("%c[LINKS]", "color:#f33;font-weight:bold", ...a);

  // reuse extracted helpers if present
  let srcs = window.__qbExtracted;
  if (!srcs || !srcs.wk) {
    let bundle = "";
    const discoverBundleUrl13 = () => {
      try { const s = document.querySelector('script[src*="index-"][src$=".js"]'); if (s && s.src) return s.src; } catch (e) {}
      try { const e = performance.getEntriesByType("resource").find((x) => /\/assets\/index-[A-Za-z0-9_-]+\.js/.test(x.name)); if (e) return e.name; } catch (e) {}
      return null;
    };
    const bundleCandidates13 = [];
    const discovered13 = discoverBundleUrl13();
    if (discovered13) bundleCandidates13.push(discovered13);
    bundleCandidates13.push("/assets/index-BIQSOdrK.js", "/index-BIQSOdrK.js", "index-BIQSOdrK.js");
    for (const p of bundleCandidates13) {
      try { const r = await fetch(p, { credentials: "include" }); if (r.ok) { bundle = await r.text(); break; } } catch (e) {}
    }
    if (!bundle) { err("no bundle"); return; }
    const matchDelims = (str, start) => { const open = str[start]; const close = open === "{" ? "}" : open === "[" ? "]" : ")"; let depth = 0, i = start, inStr = null; while (i < str.length) { const c = str[i]; if (inStr) { if (c === "\\") { i += 2; continue; } if (c === inStr) inStr = null; i++; continue; } if (c === '"' || c === "'" || c === "`") { inStr = c; i++; continue; } if (c === open) depth++; else if (c === close) { depth--; if (depth === 0) return i + 1; } i++; } return -1; };
    const extractAssign = (sym) => { const re = new RegExp("(?:^|[^A-Za-z0-9_$])" + sym.replace(/\$/g, "\\$") + "="); const m = re.exec(bundle); if (!m) return null; const idx = m.index + m[0].length - sym.length - 1; let i = idx + sym.length + 1; while (bundle[i] === " ") i++; if (bundle.startsWith("async", i)) { i += 5; while (bundle[i] === " ") i++; } if (bundle.startsWith("function", i)) { const b = bundle.indexOf("{", i); return bundle.slice(idx, matchDelims(bundle, b)); } const arrow = bundle.indexOf("=>", i); if (arrow > -1 && arrow - i < 30) { let j = arrow + 2; while (bundle[j] === " ") j++; if (bundle[j] === "{") return bundle.slice(idx, matchDelims(bundle, j)); let k = j, depth = 0, inStr = null; while (k < bundle.length) { const c = bundle[k]; if (inStr) { if (c === "\\") { k += 2; continue; } if (c === inStr) inStr = null; k++; continue; } if (c === '"' || c === "'" || c === "`") { inStr = c; k++; continue; } if ("([{".includes(c)) depth++; else if (")]}".includes(c)) depth--; else if ((c === "," || c === ";") && depth <= 0) break; k++; } return bundle.slice(idx, k); } const c = bundle[i]; if (c === "{" || c === "[" || c === "(") return bundle.slice(idx, matchDelims(bundle, i)); if (c === '"' || c === "'" || c === "`") { let k = i + 1; while (k < bundle.length) { const ch = bundle[k]; if (ch === "\\") { k += 2; continue; } if (ch === c) break; k++; } return bundle.slice(idx, k + 1); } let k = i; while (k < bundle.length && !",;\n}".includes(bundle[k])) k++; return bundle.slice(idx, k); };
    const requiredSyms13 = ["Lk", "Fk", "xi", "mg", "Yk"];
    const optionalSyms13 = ["Rf"];
    srcs = {};
    for (const s of requiredSyms13) srcs[s] = extractAssign(s);
    for (const s of optionalSyms13) { const v = extractAssign(s); if (v) srcs[s] = v; }
    // keep old-name aliases for downstream checks
    srcs.wk = srcs.Lk; srcs.vk = srcs.Fk; srcs.Zp = srcs.xi; srcs.Li = srcs.mg; srcs.Ck = srcs.Yk;
    window.__qbExtracted = srcs;
  }
  if (!srcs.Lk) { err("extraction failed"); return; }

  // blob: ONLY decrypt + store raw .b map
  const blobSrc = [
    "let wr=null;",
    srcs.Lk, srcs.Fk, srcs.xi, srcs.mg, srcs.Yk,
    'var wk=Lk, vk=Fk, Zp=xi, Li=mg, Ck=Yk;',
    'var jk="5b908a4bbef284d44ab65836eee87cb5375976b1";',
    'var kk="/c";',
    'function Rd(e){return kk+"/"+e.slice(0,2)+"/"+e.slice(2);}',
    'async function Xp(e,t){var s=new Uint8Array(e),r=s.subarray(0,12),o=s.subarray(12);var a=await crypto.subtle.importKey("raw",t,"AES-GCM",false,["decrypt"]);return new Uint8Array(await crypto.subtle.decrypt({name:"AES-GCM",iv:r,tagLength:128},a,o));}',
    'async function Jp(e){return new Response(new Blob([e]).stream().pipeThrough(new DecompressionStream("gzip"))).text();}',
    '(async function(){try{',
    '  var url=Rd(jk);',
    '  var headers={}; try{ headers=await Li(url); }catch(e){}',
    '  var resp=await fetch(url,{cache:"force-cache",headers:headers||{}});',
    '  if(!resp.ok){ window.__qbLinksError="bootstrap fetch "+resp.status; window.__qbLinksDone=true; return; }',
    '  var buf=await resp.arrayBuffer();',
    '  var key=await Ck();',
    '  var plain=await Xp(buf,key);',
    '  var text=await Jp(plain);',
    '  var manifest=JSON.parse(text);',
    '  window.__qbLinksRaw=manifest&&manifest.b;',
    '  window.__qbLinksDone=true;',
    '}catch(e){ window.__qbLinksError=String(e); window.__qbLinksDone=true; }',
    '})();'
  ].join("\n");

  window.__qbLinksDone = false;
  window.__qbLinksError = null;
  window.__qbLinksRaw = null;
  try {
    const s = document.createElement("script");
    s.src = URL.createObjectURL(new Blob([blobSrc], { type: "text/javascript" }));
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
    log("blob injected - decrypting...");
  } catch (e) { err("inject failed:", String(e)); return; }

  const t0 = Date.now();
  while (!window.__qbLinksDone && Date.now() - t0 < 90000) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!window.__qbLinksDone) { err("timed out"); return; }
  if (window.__qbLinksError) { err("ERROR:", window.__qbLinksError); return; }

  const b = window.__qbLinksRaw;
  if (!b || typeof b !== "object") { err("no .b map"); return; }
  const paths = Object.keys(b);
  log("raw entries:", paths.length);

  // build entries in main context
  const entries = paths.map((p) => {
    const a = b[p] || {};
    const u = a.u || "";
    return { path: p, blobUrl: u ? "/c/" + u.slice(0, 2) + "/" + u.slice(2) : "", keyId: u, hasEmbeddedKey: !!a.k };
  }).sort((x, y) => (x.path < y.path ? -1 : 1));

  const csvLines = ["path,blobUrl,keyId,hasEmbeddedKey"];
  for (const e of entries) csvLines.push([e.path, e.blobUrl, e.keyId, e.hasEmbeddedKey].map((x) => {
    x = String(x == null ? "" : x);
    return /[",\n]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x;
  }).join(","));
  const csv = csvLines.join("\n");
  const json = JSON.stringify({ generatedAt: new Date().toISOString(), source: "bootstrap manifest (decrypted)", count: entries.length, entries }, null, 2);

  window.qbLinks = { data: { count: entries.length, entries }, csv: () => csv, json: () => json };
  log(">>> LINKS:", entries.length);
  console.log("sample:", entries[0]);
  log("run:  copy(window.qbLinks.csv())   -> links.csv");
  log("run:  copy(window.qbLinks.json())  -> links.json");
})();
