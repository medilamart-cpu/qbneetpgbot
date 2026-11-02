/* 10-bootstrap-src.js — extract the exact helpers needed to replicate Dd().
 *
 * The vault is decoded. The full library index is ONE encrypted bootstrap
 * manifest, loaded by:
 *     Dd = () => { fetch(Rd(jk), {headers: Li(...)}) -> Xp(buf, Ck()) -> Jp() -> JSON }
 * Its parsed shape is { b: { "<path>": { u: <blobId>, k: <key?> } }, ... }.
 * The KEYS of `.b` are the complete list of every file path in the library.
 *
 * To replicate Dd() we need the exact source of these minified helpers:
 *     jk  (constant: the bootstrap manifest id/path)
 *     Rd  (id -> fetch URL)
 *     Li  (builds the X-SOS-Stamp request header)
 *     Xp  (decrypt: ArrayBuffer + key -> plaintext)
 *     Sk  (key schedule: raw key bytes -> CryptoKey)
 *     Jp  (decompress -> string)
 *     vk  (HMAC secret material for Ck)
 * This script refetches the bundle and prints each helper verbatim.
 *
 * HOW TO USE
 *   F12 -> Console (allow pasting). Clear input, paste, Enter.
 *   It prints each helper. Then:  copy(window.qbBootSrc())
 *   Paste that back.
 */
(async () => {
  const log = (...a) => console.log("%c[boot]", "color:#0ff;font-weight:bold", ...a);

  let bundle = "";
  const discoverBundleUrl10 = () => {
    try { const s = document.querySelector('script[src*="index-"][src$=".js"]'); if (s && s.src) return s.src; } catch (e) {}
    try { const e = performance.getEntriesByType("resource").find((x) => /\/assets\/index-[A-Za-z0-9_-]+\.js/.test(x.name)); if (e) return e.name; } catch (e) {}
    return null;
  };
  const bundleCandidates10 = [];
  const discovered10 = discoverBundleUrl10();
  if (discovered10) bundleCandidates10.push(discovered10);
  bundleCandidates10.push("/assets/index-BIQSOdrK.js", "/index-BIQSOdrK.js", "index-BIQSOdrK.js");
  for (const p of bundleCandidates10) {
    try { const r = await fetch(p, { credentials: "include" }); if (r.ok) { bundle = await r.text(); break; } } catch (e) {}
  }
  log("bundle length:", bundle.length);
  window.__qbBundleText = bundle;

  // grab a generous slice starting at a symbol's definition
  const defn = (sym, len) => {
    const re = new RegExp("(?:^|[^A-Za-z0-9_$])" + sym.replace(/\$/g, "\\$") + "\\s*=\\s*");
    const m = re.exec(bundle);
    if (!m) return "(not found: " + sym + ")";
    const start = m.index + m[0].length - 1;
    return bundle.slice(start, start + (len || 700)).replace(/\s+/g, " ");
  };
  // find ALL occurrences (some symbols are assigned in multiple spots)
  const defnAll = (sym, len, max) => {
    const re = new RegExp("(?:^|[^A-Za-z0-9_$])" + sym.replace(/\$/g, "\\$") + "\\s*=\\s*", "g");
    const out = [];
    let m, n = 0;
    while ((m = re.exec(bundle)) && n++ < (max || 3)) {
      out.push(bundle.slice(m.index, m.index + (len || 700)).replace(/\s+/g, " "));
    }
    return out.length ? out : ["(not found: " + sym + ")"];
  };

  const src = {
    jk: defn("jk", 300),
    Rd: defnAll("Rd", 600, 2),
    Li: defnAll("Li", 800, 2),
    Xp: defnAll("Xp", 800, 2),
    Sk: defnAll("Sk", 600, 2),
    Jp: defnAll("Jp", 600, 2),
    vk: defnAll("vk", 600, 2),
    Ck: defnAll("Ck", 500, 2),
    // the X-SOS-Stamp builder lives inside Li; grab it too
    sosStamp: (() => { const i = bundle.indexOf("X-SOS-Stamp"); return i < 0 ? "(not found)" : bundle.slice(Math.max(0, i - 400), i + 200).replace(/\s+/g, " "); })(),
    // DecompressionStream gunzip (likely Jp's body)
    gunzip: (() => { const i = bundle.indexOf("DecompressionStream"); return i < 0 ? "(not found)" : bundle.slice(Math.max(0, i - 300), i + 300).replace(/\s+/g, " "); })()
  };

  for (const k of ["jk", "Rd", "Li", "sosStamp", "Xp", "Sk", "Jp", "gunzip", "vk", "Ck"]) {
    console.log("%c--- " + k + " ---", "color:#ff0");
    console.log(Array.isArray(src[k]) ? src[k].join("\n\n") : src[k]);
  }

  window.qbBootSrc = () => JSON.stringify(src, null, 2);
  log("DONE. run:  copy(window.qbBootSrc())  and paste it back");
})();
