/* 02-sync-drain.js — bootstrap /qbapi/sync at seq=0 and drain the FULL state.
 *
 * Why: the recorder showed sync is incremental (changes[] + more flag). Most
 * calls returned Array(0) because the client had already synced. Replaying from
 * seq=0 should make the server resend every record, including refs_packed.files
 * (the question file path lists) and anything else that builds the tree.
 *
 * This script ONLY reads responses. It captures request bodies too so we can
 * learn the exact sync protocol the app uses. Nothing is spoofed or patched.
 *
 * HOW TO USE
 * 1. Sign in at qb.neetpgbot.in in YOUR OWN Chrome (real clicks).
 * 2. F12 -> Console. If Chrome warns, type:  allow pasting
 * 3. Clear the input (Ctrl+A, Delete), paste all of this, Enter.
 *      You should see:  [sync] ready
 * 4. Let it run (it self-drives, ~5-20s). Then copy the report:
 *
 *        copy(window.qbSyncReport())
 *
 * 5. Paste that text back. If it says "foundNoRefs", also run:
 *
 *        copy(window.qbSyncKeys())
 */
(async () => {
  const TAG = "%c[sync]";
  const log = (c, ...a) => console.log(TAG, "color:#0cf;font-weight:bold", ...a);

  // ---- capture REQUEST bodies for qbapi so we learn the protocol ----
  if (!window.__qbReqCap) {
    window.__qbReqCap = [];
    const of = window.fetch;
    window.fetch = async function (...args) {
      try {
        const u = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
        if (u.includes("qbapi")) {
          const init = args[1] || {};
          let reqBody = init.body;
          if (reqBody && typeof reqBody !== "string") { try { reqBody = JSON.stringify(reqBody); } catch (e) { reqBody = "[unreadable]"; } }
          window.__qbReqCap.push({ url: u, method: init.method || "GET", body: reqBody === undefined ? null : String(reqBody).slice(0, 2000) });
        }
      } catch (e) { /* ignore */ }
      return of.apply(this, args);
    };
  }

  const post = async (body) => {
    const r = await fetch("/qbapi/sync", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch (e) {}
    return { status: r.status, len: t.length, j, raw: t };
  };

  // ---- 1) what does the app itself send to /qbapi/sync? ----
  const seenReq = (window.__qbReqCap || []).filter((r) => r.url.includes("/qbapi/sync"));
  log("captured sync REQUEST bodies from the app:", seenReq.length, seenReq.slice(0, 8));

  // ---- 2) try bootstrap shapes at seq=0 until one returns changes ----
  const boots = [
    { seq: 0 },
    { seq: 0, epoch: 0 },
    { since: 0 },
    { from: 0 },
    { seq: 0, full: true },
    { seq: 0, since: 0 },
    { last_seq: 0 },
    { cursor: 0 },
    { seq: 0, limit: 10000 },
    {}
  ];
  let best = null;
  const bootLog = [];
  for (const b of boots) {
    const res = await post(b);
    const nCh = res.j && Array.isArray(res.j.changes) ? res.j.changes.length : -1;
    bootLog.push({ body: JSON.stringify(b), status: res.status, len: res.len, changes: nCh, more: res.j && res.j.more, seq: res.j && res.j.seq, epoch: res.j && res.j.epoch });
    if (nCh > 0 && (!best || nCh > best.nCh)) best = { body: b, nCh, j: res.j };
    await new Promise((r) => setTimeout(r, 120));
  }
  log("bootstrap probe:", bootLog);
  console.table(bootLog);

  if (!best) {
    log("No bootstrap shape returned changes. Showing what the app sends:");
    console.table(seenReq);
    window.qbSyncReport = () => JSON.stringify({ note: "no bootstrap worked", reqSeen: seenReq, bootLog }, null, 2);
    window.qbSyncKeys = () => "(nothing to show)";
    console.log("%c>>> run copy(window.qbSyncReport())", "color:#ff0");
    return;
  }

  // ---- 3) drain all pages ----
  log("best bootstrap:", JSON.stringify(best.body), "-> changes:", best.nCh, "more:", best.j.more);
  const seenKeys = new Map();   // key -> value (deduped)
  const pathSet = new Set();
  let cur = best.j;
  let pages = 0;
  const MAXP = 400;

  const scanForPaths = (v, depth) => {
    if (depth > 8 || v === null || v === undefined) return;
    if (typeof v === "string") {
      if (v.length > 4 && v.length < 400 && /\.(json)$/i.test(v) && v.includes("/")) pathSet.add(v);
      return;
    }
    if (Array.isArray(v)) { for (const x of v) scanForPaths(x, depth + 1); return; }
    if (typeof v === "object") { for (const k in v) scanForPaths(v[k], depth + 1); }
  };

  const absorb = (j) => {
    if (!j || !Array.isArray(j.changes)) return;
    for (const ch of j.changes) {
      if (ch && ch.key !== undefined) seenKeys.set(ch.key, ch.value);
      scanForPaths(ch, 0);
    }
  };
  absorb(cur);

  while (cur && cur.more && pages < MAXP) {
    pages++;
    const nextBody = { ...best.body, seq: cur.seq };
    if (cur.epoch !== undefined) nextBody.epoch = cur.epoch;
    const res = await post(nextBody);
    if (!res.j) { log("page", pages, "non-JSON, stopping"); break; }
    absorb(res.j);
    cur = res.j;
    if (pages % 10 === 0) log("drained", pages, "pages; keys:", seenKeys.size, "paths:", pathSet.size);
    await new Promise((r) => setTimeout(r, 80));
  }

  log("DONE. pages:", pages, "distinct keys:", seenKeys.size, "distinct .json paths:", pathSet.size);

  // ---- 4) find the refs / files records specifically ----
  const refKeys = [];
  for (const [k, v] of seenKeys) {
    const s = JSON.stringify(v);
    if (s && (s.includes("refs_packed") || s.includes('"files"') || (Array.isArray(v) && v.length > 20))) {
      refKeys.push({ key: k, type: Array.isArray(v) ? "array(" + v.length + ")" : typeof v, preview: String(s).slice(0, 180) });
    }
  }
  log("candidate ref/file records:", refKeys.length);
  console.table(refKeys.slice(0, 40));

  // ---- 5) build the report ----
  const paths = [...pathSet].sort();
  const libs = {};
  for (const p of paths) {
    const lib = p.split("/")[0];
    libs[lib] = (libs[lib] || 0) + 1;
  }
  window.__qbSync = { seenKeys, paths, refKeys, bootLog, seenReq };
  window.qbSyncKeys = () => JSON.stringify([...seenKeys.keys()].slice(0, 500), null, 2);
  window.qbSyncReport = () => JSON.stringify({
    pages, distinctKeys: seenKeys.size, distinctJsonPaths: paths.length,
    libraries: libs,
    samplePaths: paths.slice(0, 40),
    refKeyCandidates: refKeys.slice(0, 60),
    appSyncRequest: seenReq.slice(0, 5)
  }, null, 2);

  if (paths.length) {
    log("%cFOUND PATHS — run: copy(window.qbSyncReport())", "color:#0f0;font-weight:bold");
  } else {
    log("no .json paths yet — run both: copy(window.qbSyncReport())  then  copy(window.qbSyncKeys())");
  }
})();
