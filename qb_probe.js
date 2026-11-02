/* qb_probe.js — paste ONCE into qb.neetpgbot.in console (while logged in).
   Probes for a full manifest of all question files (not just recent ones). */
(function () {
  const j = (o) => JSON.stringify(o);
  const short = (t, n) => String(t).slice(0, n === undefined ? 200 : n);

  // ---- 1) GET candidate static manifests at the root (session cookie auto-sent)
  const roots = [
    "new-tests.json", "all-tests.json", "tests.json", "index.json", "tree.json",
    "catalog.json", "manifest.json", "files.json", "banks.json", "courses.json",
    "videos.json", "list.json", "qb.json", "new-videos.json", "new-tests.json?days=100000",
    "new-tests.json?days=3650", "new-tests.json?all=1"
  ];
  // ---- 2) GET candidate API listing endpoints
  const apis = [
    "/qbapi/me", "/qbapi/live", "/qbapi/prep-live", "/qbapi/extra-tests",
    "/qbapi/videos", "/qbapi/videos/new", "/qbapi/files", "/qbapi/tree",
    "/qbapi/index", "/qbapi/list", "/qbapi/sync", "/qbapi/library",
    "/qbapi/tests", "/qbapi/banks", "/qbapi/manifest", "/qbapi/catalog"
  ];

  const out = [];
  const rec = (tag, url, r, txt) => {
    const isJson = /^[{[]/.test(String(txt).trim());
    const looksHtml = /^<!doctype|^<html/i.test(String(txt).trim());
    out.push({
      tag, url, status: r.status, len: (txt || "").length,
      json: isJson, html: looksHtml,
      head: short(txt, 160)
    });
  };

  const grab = (u) => fetch(u, { credentials: "include" })
    .then(r => r.text().then(t => { rec("GET", u, r, t); return t; }))
    .catch(e => { out.push({ tag: "GET", url: u, status: "ERR", len: 0, head: String(e) }); });

  // 3) POST /qbapi/sync with several plausible body shapes
  const syncBodies = [
    {},
    { full: true },
    { since: 0 },
    { since: 0, full: true },
    { device: "probe", full: 1 }
  ];
  const postSync = (body) => fetch("/qbapi/sync", {
    method: "POST", credentials: "include",
    headers: { "content-type": "application/json" },
    body: j(body)
  }).then(r => r.text().then(t => { rec("POST", "/qbapi/sync " + j(body), r, t); return t; }))
    .catch(e => { out.push({ tag: "POST", url: "/qbapi/sync", status: "ERR", len: 0, head: String(e) }); });

  (async () => {
    for (const u of roots) await grab(u);
    for (const u of apis) await grab(u);
    for (const b of syncBodies) await postSync(b);

    // Summarize: only show interesting hits (json, or non-HTML)
    const interesting = out.filter(o => o.json || (!o.html && o.status === 200));
    const html = out.filter(o => o.html);
    const errs = out.filter(o => o.status === "ERR" || o.status >= 400);

    console.log("%c=== PROBE SUMMARY ===", "color:#0f0;font-size:14px");
    console.log("%cINTERESTING (JSON / real data):", "color:#0ff;font-weight:bold");
    console.table(interesting.map(o => ({ status: o.status, len: o.len, url: o.url, head: o.head })));
    console.log("%cHTML fallback (not a real file): " + html.length + " urls", "color:#888");
    console.log("%cERRORS / 404:", "color:#f80;font-weight:bold");
    console.table(errs.map(o => ({ status: o.status, url: o.url, head: o.head })));

    // Keep raw bodies for the biggest JSON hits so we can inspect them
    window.__qbProbe = out;
    window.__qbOut = "=== INTERESTING ===\n" +
      interesting.map(o => `${o.status} len=${o.len} ${o.url}\n  ${o.head}`).join("\n") +
      "\n\n=== ERRORS ===\n" + errs.map(o => `${o.status} ${o.url} :: ${o.head}`).join("\n");
    console.log("%c>>> Run qbOut() and paste me the result.", "color:#ff0;font-weight:bold");
  })();
})();
