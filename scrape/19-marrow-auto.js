/* 19-marrow-auto.js — fetch ALL Marrow files + auto-download JSON chunks.
 *
 * Fully automated: fetches Marrow question bank files with rate limiting,
 * auto-downloads each chunk as a JSON file (no manual copy() needed).
 * Checkpoint/resume via localStorage. Keep-alive runs in background.
 *
 * HOW TO USE
 *   1. Run 14-links-reuse.js first (to populate window.qbLinks)
 *   2. Clear console, paste this, Enter
 *   3. It runs automatically — downloads chunks as it goes
 *   4. Leave tab open (can be minimized). Don't reload.
 *   5. If interrupted, re-run — resumes from checkpoint
 *
 * CONFIGURATION (edit before running):
 *   CHUNK_SIZE: files per download (default 50)
 *   DELAY_MS: delay between files (default 2500)
 *   AUTO_DOWNLOAD: true = auto-download chunks, false = manual copy()
 */
(async () => {
  const log = (...a) => console.log("%c[MARROW]", "color:#0f0;font-weight:bold", ...a);
  const err = (...a) => console.log("%c[MARROW]", "color:#f33;font-weight:bold", ...a);
  const warn = (...a) => console.log("%c[MARROW]", "color:#fa0;font-weight:bold", ...a);

  // ===== CONFIGURATION =====
  const CHUNK_SIZE = 50;
  const DELAY_MS = 2500;
  const AUTO_DOWNLOAD = true;

  // ===== STEP 1: Session check =====
  log("Checking session...");
  let me;
  try {
    const r = await fetch("/qbapi/me", { credentials: "include", cache: "no-store" });
    me = await r.json();
  } catch (e) { err("cannot reach /qbapi/me:", String(e)); return; }
  if (!me || me.code === undefined) { err("not logged in or session expired"); return; }
  const sessionExpiry = me.expires ? new Date(me.expires * 1000) : null;
  const codeExpiry = me.code_expires ? new Date(me.code_expires * 1000) : null;
  log("user:", me.name || me.nickname);
  log("session expires:", sessionExpiry ? sessionExpiry.toISOString() : "unknown");
  log("code expires:", codeExpiry ? codeExpiry.toISOString() : "unknown");
  if (codeExpiry && codeExpiry.getTime() < Date.now()) { err("CODE EXPIRED."); return; }
  if (sessionExpiry && sessionExpiry.getTime() < Date.now()) { err("SESSION EXPIRED."); return; }

  // ===== STEP 2: Get Marrow links =====
  if (!window.qbLinks || !window.qbLinks.data || !window.qbLinks.data.entries) {
    err("No links in memory. Run 14-links-reuse.js first, then re-run this.");
    return;
  }
  const marrowLinks = window.qbLinks.data.entries.filter((e) => e.path.startsWith("marrow_"));
  log("Marrow files total:", marrowLinks.length);

  // ===== STEP 3: Checkpoint =====
  const CKPT_KEY = "__qbMarrowCheckpoint__";
  let checkpoint = { done: [], chunkNum: 0 };
  try { checkpoint = JSON.parse(localStorage.getItem(CKPT_KEY) || '{"done":[],"chunkNum":0}'); } catch (e) {}
  const doneSet = new Set(checkpoint.done || []);
  const remaining = marrowLinks.filter((e) => !doneSet.has(e.path));
  log("checkpoint: " + doneSet.size + " done, " + remaining.length + " remaining");
  if (remaining.length === 0) {
    log("ALL MARROW FILES FETCHED. Clear checkpoint: localStorage.removeItem('__qbMarrowCheckpoint__')");
    return;
  }

  // ===== STEP 4: Keep-alive =====
  log("Starting keep-alive...");
  const kaInterval = setInterval(async () => {
    try { await fetch("/qbapi/ping", { credentials: "include", cache: "no-store" }); } catch (e) {}
  }, 30000);

  // ===== STEP 5: Auto-download helper =====
  const downloadChunk = (data, chunkNum) => {
    if (!AUTO_DOWNLOAD) return;
    try {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "marrow-chunk-" + String(chunkNum).padStart(3, "0") + ".json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      log("auto-downloaded chunk " + chunkNum + " (" + data.length + " files)");
    } catch (e) {
      warn("auto-download failed (CSP?):", String(e).slice(0, 60));
      warn("use: copy(JSON.stringify(window.__qbMarrowChunk))");
    }
  };

  // ===== STEP 6: Fetch loop =====
  let currentChunk = [];
  let chunkNum = checkpoint.chunkNum || 0;
  let fetched = 0, errors = 0, rateLimited = false;
  const t0 = Date.now();

  for (let i = 0; i < remaining.length; i++) {
    const entry = remaining[i];

    // Session check every 10 files
    if (i > 0 && i % 10 === 0) {
      try {
        const mr = await fetch("/qbapi/me", { credentials: "include", cache: "no-store" });
        const md = await mr.json();
        if (!md || md.code === undefined) { err("session died at file " + i); rateLimited = true; break; }
      } catch (e) { err("session check failed:", String(e)); rateLimited = true; break; }
    }

    try {
      // fetch key
      const kr = await fetch("/qbapi/key?u=" + entry.keyId, { credentials: "include", cache: "no-store" });
      if (kr.status === 429 || kr.status === 403) {
        const retryAfter = kr.headers.get("Retry-After");
        err("RATE LIMITED (" + kr.status + ") on " + entry.path);
        err("Retry-After: " + (retryAfter || "unknown (default 10min)"));
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

      currentChunk.push({ path: entry.path, data: data });
      doneSet.add(entry.path);
      fetched++;
      const elapsed = Math.round((Date.now() - t0) / 1000);
      const rate = (fetched / elapsed * 3600).toFixed(0);
      log("[" + (doneSet.size) + "/" + marrowLinks.length + "] " + entry.path.split("/").pop().replace(".json", "") + " (" + (data.total_questions || (data.questions && data.questions.length) || "?") + " Q) | " + rate + "/hr");

      // checkpoint + auto-download every CHUNK_SIZE
      localStorage.setItem(CKPT_KEY, JSON.stringify({ done: [...doneSet], chunkNum: chunkNum }));

      if (currentChunk.length >= CHUNK_SIZE) {
        chunkNum++;
        window.__qbMarrowChunk = currentChunk;
        downloadChunk(currentChunk, chunkNum);
        localStorage.setItem(CKPT_KEY, JSON.stringify({ done: [...doneSet], chunkNum: chunkNum }));
        currentChunk = [];
      }

    } catch (e) {
      err("error on " + entry.path + ":", String(e).slice(0, 100));
      errors++;
    }

    if (i < remaining.length - 1) await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  // ===== STEP 7: Download remaining chunk =====
  clearInterval(kaInterval);
  if (currentChunk.length > 0) {
    chunkNum++;
    window.__qbMarrowChunk = currentChunk;
    downloadChunk(currentChunk, chunkNum);
    localStorage.setItem(CKPT_KEY, JSON.stringify({ done: [...doneSet], chunkNum: chunkNum }));
  }

  // ===== STEP 8: Summary =====
  const totalElapsed = Math.round((Date.now() - t0) / 60000);
  log("=== MARROW FETCH COMPLETE ===");
  log("fetched this run:", fetched, "| errors:", errors, "| rate limited:", rateLimited);
  log("total done (all runs):", doneSet.size, "of", marrowLinks.length);
  log("time elapsed:", totalElapsed, "minutes");
  if (rateLimited) {
    err("STOPPED due to rate limiting. Wait, then re-run (resumes from checkpoint).");
  }
  if (doneSet.size < marrowLinks.length) {
    log("REMAINING:", marrowLinks.length - doneSet.size, "files. Re-run to continue.");
  } else {
    log("ALL MARROW FILES FETCHED!");
    log("Clear checkpoint: localStorage.removeItem('__qbMarrowCheckpoint__')");
  }
})();
