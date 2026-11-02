/* 18-priority-fetch.js — fetch Marrow → Core_BTR → PrepLadder with rate limiting.
 *
 * Priority order: Marrow first, then Core_BTR, then PrepLadder.
 * Rate limited: 3s delay between files, session checks every 10 files.
 * Checkpoint/resume via localStorage. Keep-alive pings every 30s.
 *
 * PREREQUISITE: Run 14-links-reuse.js first to populate window.qbLinks.
 *   (Or the script will try to extract links from the manifest itself.)
 *
 * HOW TO USE
 *   1. Edit CONFIG below (BATCH_SIZE, DELAY_MS)
 *   2. Paste into console, Enter
 *   3. Wait. It fetches the batch, saves to window.__qbFetched
 *   4. Save: copy(JSON.stringify(window.__qbFetched))
 *   5. Re-run to continue from checkpoint
 *
 * CONFIGURATION:
 *   BATCH_SIZE: files per run (default 50)
 *   DELAY_MS: delay between files (default 3000)
 *   BANKS: priority order (default Marrow, Core_BTR, PrepLadder)
 */
(async () => {
  const log = (...a) => console.log("%c[PF]", "color:#0f0;font-weight:bold", ...a);
  const err = (...a) => console.log("%c[PF]", "color:#f33;font-weight:bold", ...a);

  // ===== CONFIGURATION =====
  const BATCH_SIZE = 50;
  const DELAY_MS = 3000;
  const BANKS = ["Marrow", "Core_BTR", "PrepLadder"];

  // ===== STEP 1: Check session =====
  log("Checking session...");
  let me;
  try {
    const r = await fetch("/qbapi/me", { credentials: "include", cache: "no-store" });
    me = await r.json();
  } catch (e) { err("cannot reach /qbapi/me:", String(e)); return; }
  if (!me || me.code === undefined) { err("not logged in or session expired"); return; }
  const now = Date.now();
  const sessionExpiry = me.expires ? new Date(me.expires * 1000) : null;
  const codeExpiry = me.code_expires ? new Date(me.code_expires * 1000) : null;
  log("user:", me.name || me.nickname);
  log("session expires:", sessionExpiry ? sessionExpiry.toISOString() : "unknown");
  log("code expires:", codeExpiry ? codeExpiry.toISOString() : "unknown");
  if (codeExpiry && codeExpiry.getTime() < now) { err("CODE EXPIRED. Cannot fetch."); return; }
  if (sessionExpiry && sessionExpiry.getTime() < now) { err("SESSION EXPIRED. Re-login required."); return; }

  // ===== STEP 2: Get links =====
  let links = [];
  if (window.qbLinks && window.qbLinks.data && window.qbLinks.data.entries) {
    links = window.qbLinks.data.entries;
    log("using in-memory links:", links.length);
  } else {
    err("No links in memory. Run 14-links-reuse.js first, then re-run this.");
    return;
  }

  // Filter to priority banks and sort by bank order
  const bankOrder = {};
  BANKS.forEach((b, i) => { bankOrder[b] = i; });
  const priorityLinks = links
    .filter((e) => {
      const bank = e.path.split("/")[0];
      return BANKS.includes(bank);
    })
    .sort((a, b) => {
      const ba = a.path.split("/")[0];
      const bb = b.path.split("/")[0];
      if (bankOrder[ba] !== bankOrder[bb]) return bankOrder[ba] - bankOrder[bb];
      return a.path < b.path ? -1 : 1;
    });

  log("priority banks:", BANKS.join(" → "));
  const bankCounts = {};
  for (const e of priorityLinks) { const b = e.path.split("/")[0]; bankCounts[b] = (bankCounts[b] || 0) + 1; }
  console.table(bankCounts);
  log("total priority files:", priorityLinks.length);

  // ===== STEP 3: Checkpoint =====
  const CKPT_KEY = "__qbPriorityCheckpoint__";
  let checkpoint = { done: [], lastIdx: 0 };
  try { checkpoint = JSON.parse(localStorage.getItem(CKPT_KEY) || '{"done":[],"lastIdx":0}'); } catch (e) {}
  const doneSet = new Set(checkpoint.done || []);
  const remaining = priorityLinks.filter((e) => !doneSet.has(e.path));
  log("checkpoint: " + doneSet.size + " done, " + remaining.length + " remaining");

  if (remaining.length === 0) {
    log("ALL PRIORITY FILES FETCHED. Clear checkpoint: localStorage.removeItem('__qbPriorityCheckpoint__')");
    return;
  }

  // ===== STEP 4: Keep-alive =====
  log("Starting keep-alive...");
  const kaInterval = setInterval(async () => {
    try { await fetch("/qbapi/me", { credentials: "include", cache: "no-store" }); } catch (e) {}
  }, 30000);
  const syncInterval = setInterval(async () => {
    try { await fetch("/qbapi/sync", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ seq: 0 }) }); } catch (e) {}
  }, 60000);

  // ===== STEP 5: Batch fetch =====
  const batch = remaining.slice(0, BATCH_SIZE);
  log("Fetching batch of " + batch.length + " files (" + DELAY_MS + "ms delay)...");
  const results = [];
  let fetched = 0, errors = 0, rateLimited = false;

  for (let i = 0; i < batch.length; i++) {
    const entry = batch[i];

    // Session check every 10 files
    if (i > 0 && i % 10 === 0) {
      try {
        const mr = await fetch("/qbapi/me", { credentials: "include", cache: "no-store" });
        const md = await mr.json();
        if (!md || md.code === undefined) { err("session died mid-batch at file " + i); rateLimited = true; break; }
      } catch (e) { err("session check failed:", String(e)); rateLimited = true; break; }
    }

    try {
      // fetch key
      const kr = await fetch("/qbapi/key?u=" + entry.keyId, { credentials: "include", cache: "no-store" });
      if (kr.status === 429 || kr.status === 403) {
        const retryAfter = kr.headers.get("Retry-After");
        err("RATE LIMITED (" + kr.status + ") on " + entry.path + ". Retry-After: " + (retryAfter || "unknown"));
        rateLimited = true;
        break;
      }
      if (!kr.ok) { err("key fetch " + kr.status + " for " + entry.path); errors++; continue; }
      const kd = await kr.json();

      // fetch blob
      const br = await fetch(entry.blobUrl, { credentials: "include", cache: "force-cache" });
      if (br.status === 429 || br.status === 403) {
        err("RATE LIMITED (" + br.status + ") on blob " + entry.path);
        rateLimited = true;
        break;
      }
      if (!br.ok) { err("blob fetch " + br.status + " for " + entry.path); errors++; continue; }
      const buf = await br.arrayBuffer();

      // decrypt
      const raw = new Uint8Array(buf);
      const iv = raw.subarray(0, 12);
      const ct = raw.subarray(12);
      const keyBytes = new Uint8Array(kd.k.length / 2);
      for (let j = 0; j < keyBytes.length; j++) keyBytes[j] = parseInt(kd.k.substr(j * 2, 2), 16);
      const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
      const dec = await crypto.subtle.decrypt({ name: "AES-GCM", iv, tagLength: 128 }, cryptoKey, ct);
      const plain = new Uint8Array(dec);

      // gunzip
      const text = await new Response(new Blob([plain]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
      const data = JSON.parse(text);

      results.push({ path: entry.path, data: data });
      doneSet.add(entry.path);
      fetched++;
      const bank = entry.path.split("/")[0];
      log("[" + (i + 1) + "/" + batch.length + "] " + bank + ": " + entry.path.split("/").pop().replace(".json", "") + " (" + (data.total_questions || (data.questions && data.questions.length) || "?") + " Q)");

      localStorage.setItem(CKPT_KEY, JSON.stringify({ done: [...doneSet], lastIdx: i + 1 }));

    } catch (e) {
      err("error on " + entry.path + ":", String(e).slice(0, 100));
      errors++;
    }

    if (i < batch.length - 1) await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  // ===== STEP 6: Summary =====
  clearInterval(kaInterval);
  clearInterval(syncInterval);

  log("=== BATCH COMPLETE ===");
  log("fetched:", fetched, "| errors:", errors, "| rate limited:", rateLimited);
  log("total done (all sessions):", doneSet.size, "of", priorityLinks.length);

  if (rateLimited) {
    err("STOPPED due to rate limiting. Wait for Retry-After, then re-run (resumes from checkpoint).");
  }

  window.__qbFetched = results;
  log("fetched data saved to window.__qbFetched (" + results.length + " files)");
  log("To save: copy(JSON.stringify(window.__qbFetched))");
  log("Checkpoint saved. Re-run to continue.");
  log("To reset checkpoint: localStorage.removeItem('__qbPriorityCheckpoint__')");
})();
