/* 15-one-link.js (v3) — wrap everything in an IIFE to avoid `wr` redeclaration.
 *
 * Root cause of the "already declared" error: each blob script runs in the same
 * global scope, so `let wr=null;` from a previous run conflicts. Fix: wrap the
 * ENTIRE blob in an async IIFE so `wr` is local to that scope. Each blob gets
 * its own `wr` — no conflict.
 *
 * HOW TO USE
 *   Console healthy. Clear input, paste, Enter. Wait ~15-45s.
 *   You should see:  [ONE] sample link: { path, blobUrl, keyId, hasEmbeddedKey }
 */
(async () => {
  const log = (...a) => console.log("%c[ONE]", "color:#f60;font-weight:bold", ...a);
  const err = (...a) => console.log("%c[ONE]", "color:#f33;font-weight:bold", ...a);

  let bundle = "";
  const discoverBundleUrl15 = () => {
    try { const s = document.querySelector('script[src*="index-"][src$=".js"]'); if (s && s.src) return s.src; } catch (e) {}
    try { const e = performance.getEntriesByType("resource").find((x) => /\/assets\/index-[A-Za-z0-9_-]+\.js/.test(x.name)); if (e) return e.name; } catch (e) {}
    return null;
  };
  const bundleCandidates15 = [];
  const discovered15 = discoverBundleUrl15();
  if (discovered15) bundleCandidates15.push(discovered15);
  bundleCandidates15.push("/assets/index-BIQSOdrK.js", "/index-BIQSOdrK.js", "index-BIQSOdrK.js");
  for (const p of bundleCandidates15) {
    try { const r = await fetch(p, { credentials: "include" }); if (r.ok) { bundle = await r.text(); break; } } catch (e) {}
  }
  if (!bundle) { err("no bundle"); return; }

  const matchDelims = (str, start) => { const open = str[start]; const close = open === "{" ? "}" : open === "[" ? "]" : ")"; let depth = 0, i = start, inStr = null; while (i < str.length) { const c = str[i]; if (inStr) { if (c === "\\") { i += 2; continue; } if (c === inStr) inStr = null; i++; continue; } if (c === '"' || c === "'" || c === "`") { inStr = c; i++; continue; } if (c === open) depth++; else if (c === close) { depth--; if (depth === 0) return i + 1; } i++; } return -1; };
  const extractAssign = (sym) => { const re = new RegExp("(?:^|[^A-Za-z0-9_$])" + sym.replace(/\$/g, "\\$") + "="); const m = re.exec(bundle); if (!m) return null; const idx = m.index + m[0].length - sym.length - 1; let i = idx + sym.length + 1; while (bundle[i] === " ") i++; if (bundle.startsWith("async", i)) { i += 5; while (bundle[i] === " ") i++; } if (bundle.startsWith("function", i)) { const b = bundle.indexOf("{", i); return bundle.slice(idx, matchDelims(bundle, b)); } const arrow = bundle.indexOf("=>", i); if (arrow > -1 && arrow - i < 30) { let j = arrow + 2; while (bundle[j] === " ") j++; if (bundle[j] === "{") return bundle.slice(idx, matchDelims(bundle, j)); let k = j, depth = 0, inStr = null; while (k < bundle.length) { const c = bundle[k]; if (inStr) { if (c === "\\") { k += 2; continue; } if (c === inStr) inStr = null; k++; continue; } if (c === '"' || c === "'" || c === "`") { inStr = c; k++; continue; } if ("([{".includes(c)) depth++; else if (")]}".includes(c)) depth--; else if ((c === "," || c === ";") && depth <= 0) break; k++; } return bundle.slice(idx, k); } const c = bundle[i]; if (c === "{" || c === "[" || c === "(") return bundle.slice(idx, matchDelims(bundle, i)); if (c === '"' || c === "'" || c === "`") { let k = i + 1; while (k < bundle.length) { const ch = bundle[k]; if (ch === "\\") { k += 2; continue; } if (ch === c) break; k++; } return bundle.slice(idx, k + 1); } let k = i; while (k < bundle.length && !",;\n}".includes(bundle[k])) k++; return bundle.slice(idx, k); };
  const requiredSyms15 = ["Lk", "Fk", "xi", "mg", "Yk"];
  const optionalSyms15 = ["Rf"];
  const srcs = {};
  for (const s of requiredSyms15) srcs[s] = extractAssign(s);
  for (const s of optionalSyms15) { const v = extractAssign(s); if (v) srcs[s] = v; }
  srcs.wk = srcs.Lk; srcs.vk = srcs.Fk; srcs.Zp = srcs.xi; srcs.Li = srcs.mg; srcs.Ck = srcs.Yk;
  if (!srcs.Lk) { err("extraction failed"); return; }

  // Wrap EVERYTHING in an async IIFE so `wr` is local (no global redeclaration conflict)
  const inner = [
    "let wr = null;",
    srcs.Lk, srcs.Fk, srcs.xi, srcs.mg, srcs.Yk,
    'var wk=Lk, vk=Fk, Zp=xi, Li=mg, Ck=Yk;',
    'var jk="5b908a4bbef284d44ab65836eee87cb5375976b1";',
    'var kk="/c";',
    'function Rd(e){return kk+"/"+e.slice(0,2)+"/"+e.slice(2);}',
    'async function Xp(e,t){var s=new Uint8Array(e),r=s.subarray(0,12),o=s.subarray(12);var a=await crypto.subtle.importKey("raw",t,"AES-GCM",false,["decrypt"]);return new Uint8Array(await crypto.subtle.decrypt({name:"AES-GCM",iv:r,tagLength:128},a,o));}',
    'async function Jp(e){return new Response(new Blob([e]).stream().pipeThrough(new DecompressionStream("gzip"))).text();}',
    'try {',
    '  var url=Rd(jk);',
    '  var headers={}; try{ headers=await Li(url); }catch(e){}',
    '  var resp=await fetch(url,{cache:"force-cache",headers:headers||{}});',
    '  if(!resp.ok){ window.__qbOneError="fetch "+resp.status; window.__qbOneDone=true; return; }',
    '  var buf=await resp.arrayBuffer();',
    '  var key=await Ck();',
    '  var plain=await Xp(buf,key);',
    '  var text=await Jp(plain);',
    '  var manifest=JSON.parse(text);',
    '  var b=manifest&&manifest.b;',
    '  if(!b||typeof b!=="object"){ window.__qbOneError="no .b map"; window.__qbOneDone=true; return; }',
    '  window.__qbOneRaw=b;',
    '  window.__qbOneDone=true;',
    '}catch(e){ window.__qbOneError=String(e); window.__qbOneDone=true; }'
  ].join("\n");

  const blobSrc = "(async function() {\n" + inner + "\n})();";

  window.__qbOneDone = false;
  window.__qbOneError = null;
  window.__qbOneRaw = null;
  try {
    const s = document.createElement("script");
    s.src = URL.createObjectURL(new Blob([blobSrc], { type: "text/javascript" }));
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
    log("blob injected - decrypting one entry...");
  } catch (e) { err("inject failed:", String(e)); return; }

  const t0 = Date.now();
  while (!window.__qbOneDone && Date.now() - t0 < 90000) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!window.__qbOneDone) { err("timed out"); return; }
  if (window.__qbOneError) { err("ERROR:", window.__qbOneError); return; }

  const b = window.__qbOneRaw;
  if (!b || typeof b !== "object") { err("no .b map"); return; }
  const paths = Object.keys(b);
  log("total entries in manifest:", paths.length);

  const p = paths[0];
  const a = b[p] || {};
  const u = a.u || "";
  const sample = { path: p, blobUrl: u ? "/c/" + u.slice(0, 2) + "/" + u.slice(2) : "", keyId: u, hasEmbeddedKey: !!a.k };
  console.log("[ONE] sample link:", sample);
  console.log("[ONE] manifest entry keys:", Object.keys(a));
  log("decryption works. Full builder can now run.");
})();
