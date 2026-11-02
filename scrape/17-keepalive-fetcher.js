/* 17-keepalive-fetcher.js — keep session alive + background batch fetcher.
 *
 * Does two things:
 *   1. KEEP-ALIVE: pings /qbapi/me every 30s + /qbapi/sync every 60s to
 *      prevent inactivity-based session expiry (mimics normal app behavior).
 *   2. BATCH FETCHER: fetches question files from a configurable list with
 *      rate limiting + checkpoint/resume via localStorage.
 *
 * IMPORTANT LIMITATIONS:
 *   - Cannot extend server-side session expiry (code_expires / expires)
 *   - If code expires and server checks code validity per-request, session dies
 *   - 403 "account paused" = stop immediately (account-level flag)
 *   - Run in a background tab; don't close the browser
 *
 * HOW TO USE
 *   1. First check session: run the "status" block below
 *   2. If session is alive, run the full script
 *   3. Monitor console for progress and errors
 *
 * CONFIGURATION (edit before running):
 *   BATCH_SIZE: how many files to fetch per run (default 50)
 *   DELAY_MS: delay between files in ms (default 3000)
 *   FOLDER_FILTER: only fetch files whose path starts with this (default "" = all)
 */
(async () => {
  const log = (...a) => console.log("%c[KA]", "color:#0af;font-weight:bold", ...a);
  const err = (...a) => console.log("%c[KA]", "color:#f33;font-weight:bold", ...a);

  // ===== CONFIGURATION =====
  const BATCH_SIZE = 50;
  const DELAY_MS = 3000;
  const FOLDER_FILTER = ""; // e.g. "Marrow/marrow_NEET PG/Cardiology" or "" for all

  // ===== STEP 1: Check session status =====
  log("Checking session status...");
  let me;
  try {
    const r = await fetch("/qbapi/me", { credentials: "include", cache: "no-store" });
    me = await r.json();
  } catch (e) { err("cannot reach /qbapi/me:", String(e)); return; }
  if (!me || me.code === undefined) { err("not logged in or session expired"); return; }

  const now = Date.now();
  const sessionExpiry = me.expires ? new Date(me.expires * 1000) : null;
  const codeExpiry = me.code_expires ? new Date(me.code_expires * 1000) : null;
  log("user:", me.name || me.nickname, "| uid:", me.uid);
  log("session expires:", sessionExpiry ? sessionExpiry.toISOString() : "unknown");
  log("code expires:", codeExpiry ? codeExpiry.toISOString() : "unknown");
  log("live_sync:", me.live_sync, "| ai:", me.ai, "| owner:", me.owner);

  if (codeExpiry && codeExpiry.getTime() < now) {
    err("CODE ALREADY EXPIRED. Cannot fetch new content. Session may still work for already-cached data.");
    return;
  }
  if (sessionExpiry && sessionExpiry.getTime() < now) {
    err("SESSION EXPIRED. Re-login required.");
    return;
  }
  if (sessionExpiry && codeExpiry) {
    const sessionOutlivesCode = sessionExpiry.getTime() > codeExpiry.getTime();
    log("session outlives code:", sessionOutlivesCode);
    if (sessionOutlivesCode) {
      const extra = Math.round((sessionExpiry.getTime() - codeExpiry.getTime()) / 3600000);
      log(">>> You have ~" + extra + " extra hours after code expiry. Keep-alive may help.");
    } else {
      log(">>> Session and code expire together. Keep-alive won't extend past code expiry.");
    }
  }

  // ===== STEP 2: Load links index =====
  // Try to load from a previously saved links.csv/json, or fetch links.json
  let links = [];
  try {
    // Check if qbLinks is already in memory
    if (window.qbLinks && window.qbLinks.data && window.qbLinks.data.entries) {
      links = window.qbLinks.data.entries;
      log("using in-memory links:", links.length);
    }
  } catch (e) {}
  if (links.length === 0) {
    err("No links index in memory. Run 14-links-reuse.js first to populate window.qbLinks, then re-run this script.");
    return;
  }

  // Apply folder filter
  if (FOLDER_FILTER) {
    links = links.filter((e) => e.path.startsWith(FOLDER_FILTER));
    log("after filter '" + FOLDER_FILTER + "':", links.length, "files");
  }

  // ===== STEP 3: Load checkpoint =====
  const CKPT_KEY = "__qbFetchCheckpoint__";
  let checkpoint = { done: [], lastIdx: 0 };
  try { checkpoint = JSON.parse(localStorage.getItem(CKPT_KEY) || '{"done":[],"lastIdx":0}'); } catch (e) {}
  const doneSet = new Set(checkpoint.done || []);
  const remaining = links.filter((e) => !doneSet.has(e.path));
  log("checkpoint: " + doneSet.size + " done, " + remaining.length + " remaining");

  if (remaining.length === 0) {
    log("ALL FILES IN THIS BATCH ALREADY FETCHED. Clear checkpoint with: localStorage.removeItem('__qbFetchCheckpoint__')");
    return;
  }

  // ===== STEP 4: Start keep-alive =====
  log("Starting keep-alive (ping every 30s, sync every 60s)...");
  const keepAliveInterval = setInterval(async () => {
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
    // Check session before each file
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
        err("RATE LIMITED (" + kr.status + ") on " + entry.path + ". Retry-After: " + (retryAfter || "unknown (default 10min)"));
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

      // save to results (in memory — user can download later)
      results.push({ path: entry.path, data: data });
      doneSet.add(entry.path);
      fetched++;
      log("[" + (i + 1) + "/" + batch.length + "] fetched: " + entry.path + " (" + (data.total_questions || data.questions?.length || "?") + " questions)");

      // save checkpoint
      localStorage.setItem(CKPT_KEY, JSON.stringify({ done: [...doneSet], lastIdx: i + 1 }));

    } catch (e) {
      err("error on " + entry.path + ":", String(e).slice(0, 100));
      errors++;
    }

    // delay between files
    if (i < batch.length - 1) await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  // ===== STEP 6: Summary =====
  clearInterval(keepAliveInterval);
  clearInterval(syncInterval);

  log("=== BATCH COMPLETE ===");
  log("fetched:", fetched, "| errors:", errors, "| rate limited:", rateLimited);
  log("total done (all sessions):", doneSet.size, "of", links.length);

  if (rateLimited) {
    err("STOPPED due to rate limiting. Wait for Retry-After duration, then re-run (it resumes from checkpoint).");
  }

  // Save results to window for download
  window.__qbFetched = results;
  log("fetched data saved to window.__qbFetched (" + results.length + " files)");
  log("To save: copy(JSON.stringify(window.__qbFetched))");
  log("Checkpoint saved — re-run to continue from where you left off.");
  log("To reset checkpoint: localStorage.removeItem('__qbFetchCheckpoint__')");
})();
