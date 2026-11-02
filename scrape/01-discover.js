/* 01-discover.js — find out which endpoints the Study OS site calls.
 *
 * ONE PASTE. A small panel appears bottom-right with a "Show report" button.
 * Pressing it opens the JSON in a textarea on the page, so you can Ctrl+A /
 * Ctrl+C it — no download, no clipboard permission, nothing the site's CSP
 * can block.
 *
 *   1. Log in to the site normally (real clicks), in Chrome.
 *   2. F12 -> Console. If Chrome refuses pasting, type:  allow pasting
 *   3. Ctrl+A then Delete in the console input, so nothing old is left there.
 *   4. Paste this whole file, press Enter.
 *   5. Click around ~60s:  bank -> folder -> test (open it, don't Start)
 *      -> back -> a second bank.
 *   6. Press "Show report", click in the textarea, Ctrl+A, Ctrl+C, paste here.
 *   7. Press "Stop" when you're done.
 *
 * It only observes requests the site already makes. It never calls the API
 * itself, and it does not touch the login or the agent checks.
 */

(() => {
  try {
    if (window.__qb && window.__qb.panel) window.qbunhook && window.qbunhook();
  } catch {
    /* ignore */
  }

  try {
    install();
  } catch (err) {
    console.error("[qb] Install failed:", err && err.message);
    console.error("[qb] Send me that message — the recorder did not start.");
  }

  function install() {
    // ---- scrub anything that looks like a credential ---------------------
    const SECRET_KEY =
      /token|secret|auth|cookie|password|passwd|otp|code|device|email|phone|jwt|session|apikey|api_key/i;
    const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

    const scrubString = (s) => String(s).replace(JWT, "<REDACTED-JWT>");
    const scrubUrl = (raw) => {
      try {
        const u = new URL(raw, location.href);
        for (const k of [...u.searchParams.keys()]) {
          if (SECRET_KEY.test(k)) u.searchParams.set(k, "<REDACTED>");
        }
        return u.origin === location.origin ? u.pathname + (u.search || "") : u.origin + u.pathname;
      } catch {
        return scrubString(raw);
      }
    };

    const scrubValue = (v, depth = 0) => {
      if (depth > 8) return "<...>";
      if (Array.isArray(v)) {
        const head = v.slice(0, 3).map((x) => scrubValue(x, depth + 1));
        return v.length > 3 ? [...head, "<... " + (v.length - 3) + " more>"] : head;
      }
      if (v && typeof v === "object") {
        const out = {};
        for (const [k, val] of Object.entries(v)) {
          if (SECRET_KEY.test(k) && (val === null || typeof val !== "object")) out[k] = "<REDACTED>";
          else out[k] = scrubValue(val, depth + 1);
        }
        return out;
      }
      if (typeof v === "string") return scrubString(v.length > 3000 ? v.slice(0, 3000) + "…" : v);
      return v;
    };

    const bodyShape = (text) => {
      if (!text) return null;
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return { type: "text", length: text.length, sample: scrubString(text.slice(0, 300)) };
      }
      return { type: "json", value: scrubValue(parsed) };
    };

    const IGNORE = /\.(png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|css|map|mp4|webm|mp3)(\?|$)/i;

    // ---- state -----------------------------------------------------------
    const state = (window.__qb = {
      startedAt: Date.now(),
      records: [],
      seen: new Map(),
      errors: [],
      panel: null,
      indexedDb: [],
      alreadyLoaded: [],
    });

    const byId = (id) => document.getElementById(id);

    const bump = () => {
      const el = byId("qb-count");
      if (!el) return;
      const n = state.records.reduce((a, r) => a + r.count, 0);
      el.textContent = n + " calls · " + state.records.length + " endpoints";
    };

    const record = (method, url, status, text, reqBody) => {
      if (IGNORE.test(url)) return;
      const key = method + " " + url;
      const short = scrubUrl(url);
      const hit = state.seen.get(key);
      if (hit) {
        hit.count++;
        bump();
        return;
      }
      const entry = {
        method,
        url: short,
        status,
        count: 1,
        request: (() => {
          if (typeof reqBody !== "string" || !reqBody) return null;
          const shape = bodyShape(reqBody);
          return shape && shape.value !== undefined ? shape.value : shape;
        })(),
        response: bodyShape(text),
      };
      state.seen.set(key, entry);
      state.records.push(entry);
      bump();
      console.log("[qb]", method, short, status);
    };

    const safe = (fn, fallback) => {
      try {
        return fn();
      } catch (e) {
        state.errors.push(String((e && e.message) || e));
        return fallback;
      }
    };

    // ---- fetch -----------------------------------------------------------
    const origFetch = window.fetch;
    window.__qbOrigFetch = origFetch;

    window.fetch = function qbFetch(input, init) {
      const promise = origFetch.apply(this, arguments);
      try {
        const isReq = typeof Request !== "undefined" && input instanceof Request;
        const url = isReq ? input.url : String(input);
        const method = String((init && init.method) || (isReq && input.method) || "GET").toUpperCase();
        const reqBody = init && typeof init.body === "string" ? init.body : null;
        if (!IGNORE.test(url)) {
          promise
            .then((res) =>
              res
                .clone()
                .text()
                .then((t) => record(method, url, res.status, t, reqBody))
                .catch(() => {})
            )
            .catch(() => {});
        }
      } catch (e) {
        state.errors.push("fetch:" + ((e && e.message) || e));
      }
      return promise;
    };

    // ---- XHR -------------------------------------------------------------
    const XHR = window.XMLHttpRequest;
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;

    XHR.prototype.open = function qbOpen(method, url) {
      this.__qbMeta = { method: String(method || "GET").toUpperCase(), url: String(url) };
      return origOpen.apply(this, arguments);
    };

    XHR.prototype.send = function qbSend(body) {
      const meta = this.__qbMeta;
      if (meta) {
        this.addEventListener("loadend", () => {
          safe(() => {
            if (IGNORE.test(meta.url)) return;
            const text =
              this.responseType === "" || this.responseType === "text" ? this.responseText : "";
            record(meta.method, meta.url, this.status, text, typeof body === "string" ? body : null);
          });
        });
      }
      return origSend.apply(this, arguments);
    };

    // ---- breadcrumbs -----------------------------------------------------
    state.alreadyLoaded = safe(
      () =>
        performance
          .getEntriesByType("resource")
          .map((e) => e.name)
          .filter((n) => /\/api|\/qbapi|\.json/i.test(n))
          .map(scrubUrl)
          .filter((v, i, a) => a.indexOf(v) === i)
          .slice(0, 80),
      []
    );

    const pageInfo = () => ({
      href: scrubUrl(location.href),
      title: document.title,
      framework: (() => {
        if (byId("__NEXT_DATA__")) return "next";
        if (window.__NUXT__) return "nuxt";
        if (document.querySelector("[data-page]")) return "inertia";
        return "unknown";
      })(),
      nextData: safe(() => {
        const el = byId("__NEXT_DATA__");
        if (!el) return null;
        const d = JSON.parse(el.textContent);
        return { route: d.page, propKeys: Object.keys(d.props || {}) };
      }, null),
    });

    if (indexedDB && indexedDB.databases) {
      indexedDB.databases()
        .then((dbs) => (state.indexedDb = (dbs || []).map((d) => d.name)))
        .catch(() => {});
    }

    // ---- report ----------------------------------------------------------
    const buildReport = () =>
      JSON.stringify(
        {
          page: pageInfo(),
          storage: {
            localStorage: safe(() => Object.keys(localStorage), []),
            sessionStorage: safe(() => Object.keys(sessionStorage), []),
          },
          indexedDb: state.indexedDb,
          alreadyLoaded: state.alreadyLoaded,
          endpointShapes: state.records.reduce((acc, r) => {
            const p = r.url.split("?")[0].replace(/\/\d+/g, "/:id");
            acc[p] = (acc[p] || 0) + 1;
            return acc;
          }, {}),
          requests: state.records,
          errors: state.errors,
        },
        null,
        2
      );

    const status = (msg) => {
      const el = byId("qb-status");
      if (el) el.textContent = msg;
      console.log("[qb]", msg);
    };

    // ---- report overlay (no download, no clipboard permission) ----------
    const openReport = () => {
      const json = buildReport();
      let ov = byId("qb-overlay");

      if (!ov) {
        ov = document.createElement("div");
        ov.id = "qb-overlay";
        Object.assign(ov.style, {
          position: "fixed",
          left: "0",
          top: "0",
          right: "0",
          bottom: "0",
          zIndex: "2147483647",
          background: "rgba(2,6,23,.88)",
          padding: "20px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        });

        const box = document.createElement("div");
        Object.assign(box.style, {
          width: "min(820px, 100%)",
          maxHeight: "88vh",
          display: "flex",
          flexDirection: "column",
          gap: "10px",
          background: "#0f172a",
          color: "#e8edf5",
          border: "1px solid #334155",
          borderRadius: "14px",
          padding: "14px 16px",
          font: "13px/1.5 system-ui,-apple-system,Segoe UI,sans-serif",
          boxShadow: "0 24px 60px rgba(0,0,0,.5)",
        });

        const title = document.createElement("div");
        title.textContent = "QB report";
        Object.assign(title.style, { fontWeight: "700", fontSize: "14px" });

        const hint = document.createElement("div");
        hint.id = "qb-hint";
        Object.assign(hint.style, { opacity: "0.7", fontSize: "12px" });

        const ta = document.createElement("textarea");
        ta.id = "qb-json";
        ta.spellcheck = false;
        Object.assign(ta.style, {
          flex: "1",
          minHeight: "44vh",
          width: "100%",
          resize: "vertical",
          padding: "10px",
          borderRadius: "10px",
          border: "1px solid #334155",
          background: "#020617",
          color: "#dbeafe",
          font: "12px/1.45 ui-monospace,Consolas,monospace",
          whiteSpace: "pre",
          overflow: "auto",
        });

        const row = document.createElement("div");
        Object.assign(row.style, { display: "flex", gap: "8px" });

        const mkBtn = (label, primary) => {
          const b = document.createElement("button");
          b.textContent = label;
          Object.assign(b.style, {
            padding: "7px 14px",
            borderRadius: "9px",
            cursor: "pointer",
            fontWeight: "600",
            border: primary ? "0" : "1px solid #475569",
            background: primary ? "#2563eb" : "transparent",
            color: "#e8edf5",
          });
          return b;
        };

        const bCopy = mkBtn("Select all", true);
        bCopy.id = "qb-selall";
        const bClose = mkBtn("Close");
        bClose.id = "qb-close";

        bCopy.addEventListener("click", () => {
          ta.focus();
          ta.select();
          try {
            ta.setSelectionRange(0, ta.value.length);
          } catch {
            /* ignore */
          }
          hint.textContent =
            "Selected " + ta.value.length + " characters — now press Ctrl+C (or Cmd+C).";
        });

        bClose.addEventListener("click", () => ov.remove());

        row.appendChild(bCopy);
        row.appendChild(bClose);
        box.appendChild(title);
        box.appendChild(hint);
        box.appendChild(ta);
        box.appendChild(row);
        ov.appendChild(box);

        // Clicking the dark backdrop closes it; clicking the card does not.
        ov.addEventListener("click", (e) => {
          if (e.target === ov) ov.remove();
        });

        document.body.appendChild(ov);
      }

      const ta = byId("qb-json");
      const hint = byId("qb-hint");
      ta.value = json;
      hint.textContent =
        ta.value.length + " characters · click \"Select all\", then Ctrl+C (Cmd+C on Mac).";
      // Put the cursor in the box and select everything, so Ctrl+C works
      // even if the button is blocked from focusing.
      setTimeout(() => {
        try {
          ta.focus();
          ta.select();
          ta.setSelectionRange(0, ta.value.length);
        } catch {
          /* user can still click it */
        }
      }, 0);
    };

    // ---- panel -----------------------------------------------------------
    const panel = document.createElement("div");
    panel.id = "qb-panel";
    Object.assign(panel.style, {
      position: "fixed",
      right: "14px",
      bottom: "14px",
      zIndex: "2147483647",
      minWidth: "215px",
      padding: "10px 12px",
      borderRadius: "12px",
      border: "1px solid #334155",
      background: "#0f172a",
      color: "#e8edf5",
      font: "12.5px/1.5 system-ui,-apple-system,Segoe UI,sans-serif",
      boxShadow: "0 12px 34px rgba(0,0,0,.4)",
    });

    const titleEl = document.createElement("div");
    titleEl.textContent = "QB recorder";
    Object.assign(titleEl.style, { fontWeight: "700", marginBottom: "4px" });

    const countEl = document.createElement("div");
    countEl.id = "qb-count";
    countEl.textContent = "0 calls · 0 endpoints";
    Object.assign(countEl.style, { opacity: "0.85" });

    const statusEl = document.createElement("div");
    statusEl.id = "qb-status";
    Object.assign(statusEl.style, { opacity: "0.6", marginTop: "2px", minHeight: "1.4em" });

    const rowEl = document.createElement("div");
    Object.assign(rowEl.style, { display: "flex", gap: "6px", marginTop: "8px" });

    const mkMini = (label, primary) => {
      const b = document.createElement("button");
      b.textContent = label;
      Object.assign(b.style, {
        padding: "6px 9px",
        borderRadius: "8px",
        cursor: "pointer",
        fontWeight: primary ? "700" : "500",
        border: primary ? "0" : "1px solid #475569",
        background: primary ? "#2563eb" : "transparent",
        color: "#e8edf5",
      });
      return b;
    };

    const bShow = mkMini("Show report", true);
    bShow.id = "qb-show";
    const bStop = mkMini("Stop");
    bStop.id = "qb-stop";

    bShow.addEventListener("click", openReport);
    bStop.addEventListener("click", () => window.qbunhook());

    rowEl.appendChild(bShow);
    rowEl.appendChild(bStop);
    panel.appendChild(titleEl);
    panel.appendChild(countEl);
    panel.appendChild(statusEl);
    panel.appendChild(rowEl);
    document.body.appendChild(panel);
    state.panel = panel;

    // ---- console fallbacks ----------------------------------------------
    window.qbreport = () => {
      openReport();
      return true;
    };

    window.qbunhook = () => {
      try {
        window.fetch = window.__qbOrigFetch || window.fetch;
        XHR.prototype.open = origOpen;
        XHR.prototype.send = origSend;
      } catch {
        /* ignore */
      }
      const p = byId("qb-panel");
      if (p) p.remove();
      const o = byId("qb-overlay");
      if (o) o.remove();
      delete window.__qb;
      console.log("[qb] Recording stopped, page restored.");
    };

    status("recording — click a bank, a folder, a test");
  }
})();
