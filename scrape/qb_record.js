/* qb.neetpgbot.in — structure recorder
   How to use:
   1) Sign in at qb.neetpgbot.in in YOUR browser (the real one, e.g. Chrome).
   2) Open DevTools (F12) > Console.  Paste this whole script, press Enter.
   3) Reload the page (F5), then tap into one bank > one folder > one test.
   4) Type:  qbDump()     and press Enter.  Copy the printed JSON back.
   Drill into any one entry in full with:  qbRaw(0)   (0 = the entry's number)
   Start over with:  qbClear()
*/
(async () => {
  const KEY = "__QB_REC__";
  if (!window[KEY]) {
    window[KEY] = { calls: [] };
    // Capture every fetch() to the API, keep the real response intact.
    const ofetch = window.fetch;
    window.fetch = async function (...args) {
      const res = await ofetch.apply(this, args);
      try {
        const url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
        if (url.includes("qbapi")) {
          const txt = await res.clone().text().catch(() => "");
          window[KEY].calls.push({ url, status: res.status, body: txt });
        }
      } catch (e) { /* don't break the page */ }
      return res;
    };
    // Capture XMLHttpRequest calls too (some apps use these).
    const oopen = XMLHttpRequest.prototype.open;
    const osend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; return oopen.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function (...a) {
      this.addEventListener("load", () => {
        try {
          const u = String(this.__u || "");
          if (u.includes("qbapi")) window[KEY].calls.push({ url: u, status: this.status, body: this.responseText || "" });
        } catch (e) { /* ignore */ }
      });
      return osend.apply(this, arguments);
    };
  }

  // A compact "shape" of a value: keys + array lengths, not the full content.
  const shape = (v, depth) => {
    depth = depth || 0;
    if (v === null) return "null";
    if (Array.isArray(v)) return "Array(" + v.length + ") of " + (v.length ? shape(v[0], depth + 1) : "-");
    if (typeof v === "object") {
      const keys = Object.keys(v);
      if (depth >= 2) return "{" + keys.slice(0, 12).join(", ") + (keys.length > 12 ? ", …" : "") + "}";
      const inner = {};
      for (const k of keys.slice(0, 20)) inner[k] = shape(v[k], depth + 1);
      return inner;
    }
    return typeof v;
  };

  // Print a structural summary of everything captured so far.
  window.qbDump = () => {
    const calls = window[KEY].calls;
    const out = calls.map((c, i) => {
      let j = null; try { j = JSON.parse(c.body); } catch (e) {}
      return { i, url: c.url, status: c.status, shape: j !== null ? shape(j) : String(c.body).slice(0, 120) };
    });
    console.log("[QB] captured " + calls.length + " qbapi call(s)");
    console.log(JSON.stringify(out, null, 2));
    return out;
  };
  // Print one captured response in full.
  window.qbRaw = (i) => {
    const c = window[KEY].calls[i];
    if (!c) return console.log("[QB] no call at index " + i);
    let j = null; try { j = JSON.parse(c.body); } catch (e) {}
    console.log(c.url, "->", c.status);
    console.log(JSON.stringify(j !== null ? j : c.body, null, 2));
    return j !== null ? j : c.body;
  };
  window.qbClear = () => { window[KEY].calls = []; console.log("[QB] cleared"); };

  console.log("%c[QB] Recorder ON (" + window[KEY].calls.length + " call(s) so far).", "color:#0a0;font-weight:bold");
  console.log("Now: reload the page (F5), tap into one bank > folder > test, then run:  qbDump()");
})();
