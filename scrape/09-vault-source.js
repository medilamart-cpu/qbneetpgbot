/* 09-vault-source.js — full video index + extract the vault loader source.
 *
 * Two goals:
 *   PART A (video): dump the COMPLETE video library structure from the plain
 *     /qbapi/videos endpoint — courses -> sections -> lectures, with ids,
 *     names, durations. This is the full catalog, not a snapshot.
 *   PART B (vault): refetch the app bundle and extract the exact source of the
 *     encrypted-catalog loader, so we can find the bootstrap path -> hash map
 *     that unlocks full question coverage. Anchors: the "catalog:key:v1" HMAC
 *     derivation, the Ak read path, the /qbapi/key fetch, and Dd (which loads
 *     a `.b` path map).
 *
 * HOW TO USE
 *   Signed in at qb.neetpgbot.in, YOUR OWN Chrome.
 *   F12 -> Console (allow pasting if warned). Clear input, paste, Enter.
 *   It prints the video summary + the vault loader source immediately.
 *   Then:
 *       copy(window.qbFull.videoJson())   -> video index
 *       copy(window.qbFull.vaultSrc())    -> extracted loader source
 *       window.qbFull.videoTop(5)         -> preview one course's sections
 */
(async () => {
  const log = (...a) => console.log("%c[full]", "color:#f0a;font-weight:bold", ...a);

  // ===================== PART A — VIDEO INDEX =====================
  const vr = await fetch("/qbapi/videos", { credentials: "include" });
  const vdata = await vr.json().catch(() => null);
  const courses = (vdata && vdata.courses) || [];
  log("videos:", vr.status, courses.length, "courses; built=" + (vdata && vdata.built));

  // inspect one course's shape so we know what a "section" holds
  const shapeOf = (o, d) => {
    if (o === null) return "null";
    if (Array.isArray(o)) return "Array(" + o.length + ") of " + (o.length ? shapeOf(o[0], d + 1) : "-");
    if (typeof o === "object") {
      const out = {};
      for (const k of Object.keys(o).slice(0, 15)) out[k] = shapeOf(o[k], d + 1);
      return out;
    }
    return typeof o;
  };
  const sampleCourse = courses[0] || null;
  log("sample course shape:", sampleCourse ? shapeOf(sampleCourse) : "none");

  // normalise: keep ids, titles, group, and full section trees (names + ids)
  const videoIndex = courses.map((c) => ({
    id: c.id,
    title: c.title,
    group: c.group,
    sections: (c.sections || []).map((s) => {
      if (typeof s === "string") return { title: s };
      const sec = { id: s.id, title: s.title || s.name };
      for (const k of ["lectures", "videos", "items", "episodes", "lessons"]) {
        if (Array.isArray(s[k])) {
          sec[k] = s[k].map((x) => (typeof x === "string" ? x : {
            id: x.id, title: x.title || x.name, duration: x.duration || x.len || x.seconds,
            subject: x.subject, faculty: x.faculty
          }));
        }
      }
      // keep any leftover scalar metadata
      for (const k of Object.keys(s)) {
        if (!(k in sec) && typeof s[k] !== "object") sec[k] = s[k];
      }
      return sec;
    })
  }));

  const vstats = {};
  for (const c of videoIndex) {
    const g = c.group || "(none)";
    const s = vstats[g] || (vstats[g] = { courses: 0, sections: 0, lectures: 0 });
    s.courses += 1;
    s.sections += c.sections.length;
    for (const sec of c.sections) for (const k of ["lectures", "videos", "items", "episodes", "lessons"]) if (Array.isArray(sec[k])) s.lectures += sec[k].length;
  }
  console.log("%c=== VIDEO GROUPS ===", "color:#0f0;font-size:13px");
  console.table(vstats);

  // ===================== PART B — VAULT LOADER SOURCE =====================
  let bundle = "";
  const discoverBundleUrl9 = () => {
    try { const s = document.querySelector('script[src*="index-"][src$=".js"]'); if (s && s.src) return s.src; } catch (e) {}
    try { const e = performance.getEntriesByType("resource").find((x) => /\/assets\/index-[A-Za-z0-9_-]+\.js/.test(x.name)); if (e) return e.name; } catch (e) {}
    return null;
  };
  const bundleCandidates9 = [];
  const discovered9 = discoverBundleUrl9();
  if (discovered9) bundleCandidates9.push(discovered9);
  bundleCandidates9.push("/assets/index-BIQSOdrK.js", "/index-BIQSOdrK.js", "index-BIQSOdrK.js");
  for (const p of bundleCandidates9) {
    try { const r = await fetch(p, { credentials: "include" }); if (r.ok) { bundle = await r.text(); break; } } catch (e) {}
  }
  log("bundle length:", bundle.length);
  window.__qbBundleText = bundle;

  const ctxAround = (needle, before, after) => {
    const i = bundle.indexOf(needle);
    if (i < 0) return "(anchor not found: " + needle + ")";
    return bundle.slice(Math.max(0, i - before), i + after).replace(/\s+/g, " ");
  };
  const allAround = (re, before, after, max) => {
    const out = [];
    let m, n = 0;
    re.lastIndex = 0;
    while ((m = re.exec(bundle)) && n++ < (max || 6)) out.push(bundle.slice(Math.max(0, m.index - before), m.index + after).replace(/\s+/g, " "));
    return out;
  };

  const vaultSrc = {
    hmacCatalogKey: allAround(/catalog:key:v1/g, 500, 700, 3),
    akReadPath: allAround(/no key for/g, 700, 400, 2),
    qbapiKeyFetch: allAround(/qbapi\/key/g, 300, 300, 4),
    ddLoader: allAround(/\bDd\s*=/g, 60, 900, 2),
    cDecryptFn: allAround(/\.b\[.{0,30}\]/g, 300, 200, 4),
    blobUrlShape: allAround(/\/c\//g, 120, 120, 8)
  };

  // print the most decisive one first
  console.log("%c--- HMAC catalog:key:v1 derivation ---", "color:#ff0");
  console.log(vaultSrc.hmacCatalogKey.join("\n\n"));
  console.log("%c--- Ak read path (no key for) ---", "color:#ff0");
  console.log(vaultSrc.akReadPath.join("\n\n"));
  console.log("%c--- Dd loader (.b path map) ---", "color:#ff0");
  console.log(vaultSrc.ddLoader.join("\n\n"));
  console.log("%c--- /qbapi/key fetch sites ---", "color:#ff0");
  console.log(vaultSrc.qbapiKeyFetch.join("\n\n"));

  // ===================== report =====================
  window.qbFull = {
    videoIndex, vstats,
    videoJson: () => JSON.stringify({ generatedAt: new Date().toISOString(), source: "/qbapi/videos", courseCount: videoIndex.length, groups: vstats, courses: videoIndex }, null, 2),
    videoTop: (n) => videoIndex.slice(0, n || 3),
    vaultData: vaultSrc,
    vaultSrc: () => JSON.stringify(vaultSrc, null, 2)
  };

  log("run:  copy(window.qbFull.videoJson())  for the video index");
  log("run:  copy(window.qbFull.vaultSrc())   for the extracted loader source");
})();
