/* 07-sha1-test.js — test whether the vault key id is SHA-1 of the file path.
 *
 * Observed after reload:
 *   GET /qbapi/key?u=d0840395a5a7199d45d5e2121da1c20fe4e9c1b9  -> 502
 *   [vault] could not read "Marrow/marrow_NEET PG/tests_grand/Year_2020-21/
 *           58_Grand Test 5 (From Q-Bank).json": no key for <same path>
 *
 * If u === sha1(path), then for ANY file we can derive its key id ourselves,
 * and we never need to "discover" catalog URLs — we compute them. That turns
 * the whole catalog into: for each known path, key = sha1(path); blob = /c/..
 *
 * This script (no reload needed, run it in the current console):
 *   1. Recovers whatever the persistent hook logged into localStorage.
 *   2. Tests sha1(path) === the observed hash, for the known path pair.
 *   3. Computes key ids for the known catalog filenames (courses.json, ...).
 *   4. Probes /qbapi/key for one of them to see if the 502 has cleared.
 *
 * HOW TO USE
 *   F12 -> Console, paste, Enter. Then:  copy(window.qbShaReport())
 */
(async () => {
  const log = (...a) => console.log("%c[sha1]", "color:#0ff;font-weight:bold", ...a);

  const sha1hex = async (s) => {
    const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  };

  // ---------- 1) recover the persistent hook log ----------
  let urlLog = [];
  try { urlLog = JSON.parse(localStorage.getItem("__qbURLLOG__") || "[]"); } catch (e) {}
  log("hook log entries recovered:", urlLog.length);
  const catalogish = urlLog.filter((e) => /courses\.json|manifest_|question_index|subject_topic|\/data\/|\/c\/|qbapi\/key|search\//.test(e.u || ""));
  console.table(catalogish.slice(-40));

  // ---------- 2) test the sha1 hypothesis on the known pair ----------
  const knownPath = "Marrow/marrow_NEET PG/tests_grand/Year_2020-21/58_Grand Test 5 (From Q-Bank).json";
  const observed  = "d0840395a5a7199d45d5e2121da1c20fe4e9c1b9";
  const computed  = await sha1hex(knownPath);
  const match = computed === observed;
  log("sha1(knownPath) =", computed);
  log("observed  u     =", observed);
  log(match ? ">>> MATCH — key id IS sha1(path)!" : ">>> NO MATCH — key id is something else");

  // also try sha1 of the path with a leading slash, and of just the basename,
  // in case the id is normalised differently
  const variants = {};
  for (const [label, s] of [
    ["path", knownPath],
    ["/path", "/" + knownPath],
    ["basename", knownPath.split("/").pop()],
    ["lower", knownPath.toLowerCase()],
    ["path_no_ext", knownPath.replace(/\.json$/, "")]
  ]) {
    variants[label] = await sha1hex(s);
  }
  log("variants:", variants);

  // ---------- 3) derive key ids for the known catalog filenames ----------
  const catalogNames = [
    "courses.json",
    "manifest_neetpg.json",
    "manifest_fmge.json",
    "question_index_neetpg",
    "question_index_fmge",
    "subject_topic_hierarchy_NEETPG.json",
    "subject_topic_hierarchy_NEETPG.json",
    "subject_topic_hierarchy_fmge.json"
  ];
  const derived = [];
  for (const n of catalogNames) derived.push({ name: n, u: await sha1hex(n) });
  console.table(derived);

  // ---------- 4) probe /qbapi/key for courses.json, to see if 502 cleared ----------
  const probeU = await sha1hex("courses.json");
  let keyProbe = null;
  try {
    const r = await fetch("/qbapi/key?u=" + probeU, { credentials: "include" });
    const t = await r.text();
    keyProbe = { status: r.status, len: t.length, body: t.slice(0, 200) };
  } catch (e) { keyProbe = { status: "ERR", body: String(e) }; }
  log("key probe for courses.json (u=" + probeU + "):", keyProbe);

  // try a couple of alternate blob URL shapes for courses.json, no-cors to see reachability
  const blobProbes = [];
  for (const u of [probeU]) {
    for (const shape of [
      "/c/" + u.slice(0, 2) + "/" + u,
      "/c/" + u,
      "/data/courses.json",
      "/courses.json"
    ]) {
      try {
        const r = await fetch(shape, { credentials: "include" });
        const t = await r.text();
        blobProbes.push({ url: shape, status: r.status, len: t.length, head: t.trim().slice(0, 60) });
      } catch (e) { blobProbes.push({ url: shape, status: "ERR", head: String(e).slice(0, 50) }); }
      await new Promise((r) => setTimeout(r, 60));
    }
  }
  console.table(blobProbes);

  // ---------- report ----------
  window.qbShaReport = () => JSON.stringify({
    hookLogRecovered: urlLog.length,
    catalogishRequests: catalogish.slice(-60),
    sha1Test: { knownPath, observed, computed, match, variants },
    derivedCatalogIds: derived,
    keyProbeForCoursesJson: keyProbe,
    blobProbes
  }, null, 2);

  log("DONE. run:  copy(window.qbShaReport())");
})();
