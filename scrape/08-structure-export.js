/* 08-structure-export.js — build the banks -> folders -> tests index from the
 * two plain, authenticated endpoints that actually work:
 *     GET /new-tests.json   -> {days, tests:[{file,name,questions,at,kind}]}
 *     GET /qbapi/videos     -> {courses:[{id,title,group,sections:[...]}]}
 *
 * The `file` field is the FULL logical path:
 *     BANK / edition / section / ... / subject / Test.json
 * so we can rebuild the whole hierarchy without touching the encrypted vault.
 *
 * Output: a nested tree (structure.json) and a flat table (structure.csv).
 * No question text, options, answers or explanations — names, paths, counts.
 *
 * HOW TO USE
 *   Signed in at qb.neetpgbot.in, YOUR OWN Chrome.
 *   F12 -> Console (allow pasting if warned). Clear input, paste, Enter.
 *   It prints a summary, then run the export lines it suggests:
 *       copy(window.qbStruct.csv())      -> paste into a .csv file
 *       copy(window.qbStruct.json())     -> paste into a .json file
 *       window.qbStruct.tree()           -> expand the tree in the console
 *       window.qbStruct.stats()          -> per-bank counts
 */
(async () => {
  const log = (...a) => console.log("%c[struct]", "color:#0c6;font-weight:bold", ...a);

  // ---------- fetch the two sources ----------
  const getJson = async (u, opts) => {
    const r = await fetch(u, Object.assign({ credentials: "include" }, opts || {}));
    const t = await r.text();
    try { return { ok: r.ok, status: r.status, data: JSON.parse(t) }; }
    catch (e) { return { ok: false, status: r.status, data: null, raw: t.slice(0, 120) }; }
  };

  const nt = await getJson("/new-tests.json");
  log("new-tests.json:", nt.status, nt.data && Array.isArray(nt.data.tests) ? nt.data.tests.length + " tests" : "NO DATA");

  const vid = await getJson("/qbapi/videos");
  log("qbapi/videos:", vid.status, vid.data && Array.isArray(vid.data.courses) ? vid.data.courses.length + " video courses" : "NO DATA");

  const tests = (nt.data && nt.data.tests) || [];
  const vcourses = (vid.data && vid.data.courses) || [];

  // ---------- turn each test path into a row ----------
  // path = BANK / level2 / level3 / ... / Test.json
  const rows = tests.map((t) => {
    const file = String(t.file || "");
    const parts = file.split("/").filter(Boolean);
    const testFile = parts.pop() || "";
    return {
      bank: parts[0] || "",
      // everything between bank and filename is the folder chain
      folders: parts.slice(1),
      test: (t.name || testFile.replace(/\.json$/i, "")),
      questions: t.questions || 0,
      kind: t.kind || "",
      at: t.at || 0,
      file
    };
  }).sort((a, b) => a.file.localeCompare(b.file));

  // ---------- per-bank stats ----------
  const stats = {};
  for (const r of rows) {
    const s = stats[r.bank] || (stats[r.bank] = { tests: 0, questions: 0, folders: new Set(), editions: new Set() });
    s.tests += 1;
    s.questions += r.questions || 0;
    if (r.folders[0]) s.editions.add(r.folders[0]);
    for (const f of r.folders) s.folders.add(f);
  }
  const statsOut = {};
  for (const [k, v] of Object.entries(stats)) {
    statsOut[k] = { tests: v.tests, questions: v.questions, editions: v.editions.size, distinctFolders: v.folders.size };
  }

  // ---------- nested tree ----------
  const buildTree = () => {
    const mk = () => ({ folders: {}, tests: [] });
    const root = mk();
    for (const r of rows) {
      let node = root;
      for (const seg of [r.bank, ...r.folders]) {
        if (!node.folders[seg]) node.folders[seg] = mk();
        node = node.folders[seg];
      }
      node.tests.push({ test: r.test, questions: r.questions, kind: r.kind, file: r.file });
    }
    const clean = (node) => {
      const out = {};
      if (node.tests.length) out.tests = node.tests;
      const fk = Object.keys(node.folders);
      if (fk.length) {
        out.folders = {};
        for (const k of fk) out.folders[k] = clean(node.folders[k]);
      }
      return out;
    };
    const tree = {};
    for (const [k, v] of Object.entries(root.folders)) tree[k] = clean(v);
    return tree;
  };
  const tree = buildTree();

  // ---------- CSV ----------
  const esc = (s) => {
    s = String(s == null ? "" : s);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csvLines = ["bank,edition,folder_chain,test,questions,kind,file"];
  for (const r of rows) {
    csvLines.push([
      esc(r.bank),
      esc(r.folders[0] || ""),
      esc(r.folders.slice(1).join(" > ")),
      esc(r.test),
      esc(r.questions),
      esc(r.kind),
      esc(r.file)
    ].join(","));
  }
  const csv = csvLines.join("\n");

  // ---------- video library (separate, plain structure) ----------
  const videoOut = vcourses.map((c) => ({
    id: c.id, title: c.title, group: c.group,
    sections: (c.sections || []).map((s) => (typeof s === "string" ? s : (s.name || s.title || JSON.stringify(s).slice(0, 60))))
  }));

  // ---------- export helpers ----------
  window.qbStruct = {
    rows, tree, statsOut, csv, videoOut,
    json: () => JSON.stringify({
      generatedAt: new Date().toISOString(),
      source: "/new-tests.json (days=" + (nt.data && nt.data.days) + ") + /qbapi/videos",
      testCount: rows.length,
      banks: statsOut,
      tree,
      videoCourses: videoOut
    }, null, 2),
    csv: () => csv,
    treeFn: () => tree,
    stats: () => statsOut,
    top: (n) => rows.slice(0, n || 20)
  };

  // ---------- print summary ----------
  console.log("%c=== PER-BANK STATS ===", "color:#0f0;font-size:13px");
  console.table(statsOut);
  log("total tests indexed:", rows.length);
  log("video courses:", videoOut.length);
  log("");
  log("EXPORT — run these and paste the output into files:");
  log("  copy(window.qbStruct.csv())    -> structure.csv");
  log("  copy(window.qbStruct.json())   -> structure.json");
  log("  window.qbStruct.stats()        -> per-bank counts");
  log("  window.qbStruct.top(30)        -> first 30 rows preview");
})();
