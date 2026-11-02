/* 11-full-library.js — decrypt the bootstrap manifest = the COMPLETE library.
 * FIXED: extractAssign now starts at the symbol name (was starting at "=").
 *
 * CSP note: eval/new Function are blocked. We use a blob: script (allowed by
 * script-src 'self' blob:) containing the app's OWN verbatim helpers plus our
 * clear-logic crypto, then inject + poll.
 *
 * Output = paths/names/counts only. No content keys, no question text.
 *
 * HOW TO USE
 *   Signed in at qb.neetpgbot.in. Console must be healthy (type 1+1 Enter -> 2).
 *   Clear input, paste, Enter. Wait ~15-45s.
 *   Then:   copy(window.qbLib.json())   -> full-library.json
 */
(async () => {
  const log = (...a) => console.log("%c[LIB]", "color:#0f0;font-weight:bold", ...a);
  const err = (...a) => console.log("%c[LIB]", "color:#f33;font-weight:bold", ...a);

  // ---------- 1) grab the bundle ----------
  let bundle = "";
  // Bundle filename carries a content hash that changes per build, so discover it
  // from the live page instead of hardcoding a stale name.
  const discoverBundleUrl = () => {
    try { const s = document.querySelector('script[src*="index-"][src$=".js"]'); if (s && s.src) return s.src; } catch (e) {}
    try { const e = performance.getEntriesByType("resource").find((x) => /\/assets\/index-[A-Za-z0-9_-]+\.js/.test(x.name)); if (e) return e.name; } catch (e) {}
    return null;
  };
  const bundleCandidates = [];
  const discoveredBundle = discoverBundleUrl();
  if (discoveredBundle) { bundleCandidates.push(discoveredBundle); log("discovered bundle:", discoveredBundle); }
  bundleCandidates.push("/assets/index-BIQSOdrK.js", "/index-BIQSOdrK.js", "index-BIQSOdrK.js");
  for (const p of bundleCandidates) {
    try { const r = await fetch(p, { credentials: "include" }); if (r.ok) { bundle = await r.text(); break; } } catch (e) {}
  }
  if (!bundle) { err("could not load bundle"); return; }
  log("bundle:", bundle.length);

  // ---------- 2) balanced extractor (FIXED idx) ----------
  const matchDelims = (str, start) => {
    const open = str[start];
    const close = open === "{" ? "}" : open === "[" ? "]" : ")";
    let depth = 0, i = start, inStr = null;
    while (i < str.length) {
      const c = str[i];
      if (inStr) { if (c === "\\") { i += 2; continue; } if (c === inStr) inStr = null; i++; continue; }
      if (c === '"' || c === "'" || c === "`") { inStr = c; i++; continue; }
      if (c === open) depth++;
      else if (c === close) { depth--; if (depth === 0) return i + 1; }
      i++;
    }
    return -1;
  };
  const extractAssign = (sym) => {
    const re = new RegExp("(?:^|[^A-Za-z0-9_$])" + sym.replace(/\$/g, "\\$") + "=");
    const m = re.exec(bundle);
    if (!m) return null;
    const idx = m.index + m[0].length - sym.length - 1; // points at symbol name
    let i = idx + sym.length + 1;
    while (bundle[i] === " ") i++;
    if (bundle.startsWith("async", i)) { i += 5; while (bundle[i] === " ") i++; }
    if (bundle.startsWith("function", i)) { const b = bundle.indexOf("{", i); return bundle.slice(idx, matchDelims(bundle, b)); }
    const arrow = bundle.indexOf("=>", i);
    if (arrow > -1 && arrow - i < 30) {
      let j = arrow + 2; while (bundle[j] === " ") j++;
      if (bundle[j] === "{") return bundle.slice(idx, matchDelims(bundle, j));
      let k = j, depth = 0, inStr = null;
      while (k < bundle.length) {
        const c = bundle[k];
        if (inStr) { if (c === "\\") { k += 2; continue; } if (c === inStr) inStr = null; k++; continue; }
        if (c === '"' || c === "'" || c === "`") { inStr = c; k++; continue; }
        if ("([{".includes(c)) depth++;
        else if (")]}".includes(c)) depth--;
        else if ((c === "," || c === ";") && depth <= 0) break;
        k++;
      }
      return bundle.slice(idx, k);
    }
    const c = bundle[i];
    if (c === "{" || c === "[" || c === "(") return bundle.slice(idx, matchDelims(bundle, i));
    if (c === '"' || c === "'" || c === "`") { let k = i + 1; while (k < bundle.length) { const ch = bundle[k]; if (ch === "\\") { k += 2; continue; } if (ch === c) break; k++; } return bundle.slice(idx, k + 1); }
    let k = i; while (k < bundle.length && !",;\n}".includes(bundle[k])) k++;
    return bundle.slice(idx, k);
  };

  const requiredSyms = ["Lk", "Fk", "xi", "mg", "Yk"];
  const optionalSyms = ["Rf"];
  const srcs = {};
  for (const s of requiredSyms) srcs[s] = extractAssign(s);
  for (const s of optionalSyms) { const v = extractAssign(s); if (v) srcs[s] = v; }
  const missing = requiredSyms.filter((s) => !srcs[s]);
  if (missing.length) { err("missing symbols:", missing.join(",")); window.__qbExtracted = srcs; return; }
  for (const s of syms) log(s + ":", srcs[s].length + " chars");
  window.__qbExtracted = srcs;

  // ---------- 3) assemble blob script ----------
  const myCrypto = [
    'var jk="5b908a4bbef284d44ab65836eee87cb5375976b1";',
    'var kk="/c";',
    'function Rd(e){return kk+"/"+e.slice(0,2)+"/"+e.slice(2);}',
    'async function Xp(e,t){var s=new Uint8Array(e),r=s.subarray(0,12),o=s.subarray(12);',
    '  var a=await crypto.subtle.importKey("raw",t,"AES-GCM",false,["decrypt"]);',
    '  return new Uint8Array(await crypto.subtle.decrypt({name:"AES-GCM",iv:r,tagLength:128},a,o));}',
    'async function Jp(e){return new Response(new Blob([e]).stream().pipeThrough(new DecompressionStream("gzip"))).text();}'
  ].join("\n");

  const orchestration = [
    '(async function(){',
    '  try{',
    '    var url=Rd(jk);',
    '    var headers={};',
    '    try{ headers=await Li(url); }catch(e){ }',
    '    var resp=await fetch(url,{cache:"force-cache",headers:headers||{}});',
    '    if(!resp.ok){ window.__qbLibError="bootstrap fetch "+resp.status; window.__qbLibDone=true; return; }',
    '    var buf=await resp.arrayBuffer();',
    '    var key=await Ck();',
    '    var plain=await Xp(buf,key);',
    '    var text=await Jp(plain);',
    '    var manifest=JSON.parse(text);',
    '    var b=manifest&&manifest.b;',
    '    if(!b||typeof b!=="object"){ window.__qbLibError="no .b map: "+JSON.stringify(manifest).slice(0,300); window.__qbLibDone=true; return; }',
    '    var paths=Object.keys(b);',
    '    var tree={},stats={};',
    '    for(var pi=0;pi<paths.length;pi++){',
    '      var p=paths[pi];',
    '      var parts=p.split("/").filter(Boolean);',
    '      var file=parts.pop()||"";',
    '      var bank=parts[0]||"(root)";',
    '      var st=stats[bank]||(stats[bank]={files:0,folders:{}});',
    '      st.files++;',
    '      for(var fi=0;fi<parts.length;fi++) st.folders[parts[fi]]=1;',
    '      var node=tree[bank]=tree[bank]||{};',
    '      for(var si=1;si<parts.length;si++) node=node[parts[si]]=node[parts[si]]||{};',
    '      (node.__files=node.__files||[]).push(file.replace(/\\.json$/i,""));',
    '    }',
    '    var statsOut={};',
    '    for(var bk in stats) statsOut[bk]={files:stats[bk].files,distinctFolders:Object.keys(stats[bk].folders).length};',
    '    function clean(node){var out={};if(node.__files)out.files=node.__files;for(var k in node)if(k!=="__files")out[k]=clean(node[k]);return out;}',
    '    var cleanTree={};',
    '    for(var tb in tree) cleanTree[tb]=clean(tree[tb]);',
    '    var videos=null;',
    '    try{',
    '      var vr=await fetch("/qbapi/videos",{credentials:"include"});',
    '      var vd=await vr.json();',
    '      videos={courseCount:(vd.courses||[]).length,groups:{}};',
    '      for(var vi=0;vi<(vd.courses||[]).length;vi++){',
    '        var c=vd.courses[vi]; var g=c.group||"(none)";',
    '        var vs=videos.groups[g]||(videos.groups[g]={courses:0,sections:0,lectures:0});',
    '        vs.courses++; vs.sections+=(c.sections||[]).length;',
    '        for(var sj=0;sj<(c.sections||[]).length;sj++){var sec=c.sections[sj];',
    '          ["lectures","videos","items","episodes","lessons"].forEach(function(key){ if(Array.isArray(sec[key])) vs.lectures+=sec[key].length; });}',
    '      }',
    '    }catch(e){ videos={error:String(e)}; }',
    '    window.__qbLibData={ totalFiles:paths.length, statsOut:statsOut, cleanTree:cleanTree, paths:paths, videos:videos, manifestKeys:Object.keys(manifest) };',
    '    window.__qbLibDone=true;',
    '  }catch(e){ window.__qbLibError=String(e); window.__qbLibDone=true; }',
    '})();'
  ].join("\n");

  // join with newlines so each helper is on its own line (cleaner parse)
  const blobSrc = "(async function() {\n" + ['let wr = null;', srcs.Lk, srcs.Fk, srcs.xi, srcs.mg, srcs.Yk, 'var wk=Lk, vk=Fk, Zp=xi, Li=mg, Ck=Yk;', 'var jk="5b908a4bbef284d44ab65836eee87cb5375976b1";', 'var kk="/c";', 'function Rd(e){return kk+"/"+e.slice(0,2)+"/"+e.slice(2);}', 'async function Xp(e,t){var s=new Uint8Array(e),r=s.subarray(0,12),o=s.subarray(12);var a=await crypto.subtle.importKey("raw",t,"AES-GCM",false,["decrypt"]);return new Uint8Array(await crypto.subtle.decrypt({name:"AES-GCM",iv:r,tagLength:128},a,o));}', 'async function Jp(e){return new Response(new Blob([e]).stream().pipeThrough(new DecompressionStream("gzip"))).text();}', 'try {', '  var url=Rd(jk);', '  var headers={}; try{ headers=await Li(url); }catch(e){}', '  var resp=await fetch(url,{cache:"force-cache",headers:headers||{}});', '  if(!resp.ok){ window.__qbLibError="fetch "+resp.status; window.__qbLibDone=true; return; }', '  var buf=await resp.arrayBuffer();', '  var key=await Ck();', '  var plain=await Xp(buf,key);', '  var text=await Jp(plain);', '  var manifest=JSON.parse(text);', '  window.__qbLibRaw=manifest&&manifest.b; window.__qbLibDone=true;', '}catch(e){ window.__qbLibError=String(e); window.__qbLibDone=true; }'].join("\n") + "\n})();";
  window.__qbBlobSrc = blobSrc;

  window.__qbLibDone = false;
  window.__qbLibError = null;
  window.__qbLibData = null;
  try {
    const s = document.createElement("script");
    s.src = URL.createObjectURL(new Blob([blobSrc], { type: "text/javascript" }));
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
    log("blob script injected - decrypting...");
  } catch (e) { err("blob inject failed:", String(e)); return; }

  const t0 = Date.now();
  while (!window.__qbLibDone && Date.now() - t0 < 90000) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!window.__qbLibDone) { err("timed out. debug: copy(window.__qbBlobSrc)"); return; }
  if (window.__qbLibError) { err("ERROR:", window.__qbLibError); log("debug: copy(window.__qbBlobSrc)"); return; }

  const data = window.__qbLibData;
  log(">>> FULL LIBRARY FILES:", data.totalFiles);
  log("manifest top keys:", data.manifestKeys.join(", "));
  console.log("%c=== FILES PER BANK (FULL LIBRARY) ===", "color:#0f0;font-size:13px");
  console.table(data.statsOut);
  if (data.videos && data.videos.groups) {
    console.log("%c=== VIDEO GROUPS ===", "color:#0f0;font-size:13px");
    console.table(data.videos.groups);
  }

  window.qbLib = {
    data,
    json: () => JSON.stringify({
      generatedAt: new Date().toISOString(),
      source: "bootstrap manifest (AES-GCM decrypted) + /qbapi/videos",
      totalQuestionFiles: data.totalFiles,
      perBank: data.statsOut,
      tree: data.cleanTree,
      videoLibrary: data.videos
    }, null, 2),
    stats: () => data.statsOut,
    top: (n) => data.paths.slice(0, n || 30)
  };
  log("run:  copy(window.qbLib.json())   -> full-library.json");
})();
