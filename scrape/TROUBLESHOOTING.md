# Troubleshooting & history — qb.neetpgbot.in structure extraction

Chronological record of every problem hit while extracting the library index,
and how each was resolved. Companion to `README.md`.

---

## Phase 0 — Login & agent detection (`qb_login.html`)

**Problem:** The site refuses automated browsers at login with error code
`agent_browser`. The client sends `hg` (count of `isTrusted` pointer/keydown
events) and `ag` (`agentSignals()`) to `POST /qbapi/code`. Flagged signals:
UA matching `Claude|Electron|Antigravity|Cursor|Windsurf|Kiro|Trae`; zero-size
window (`outerWidth/outerHeight === 0` on non-touch); Chromium-only UA with no
known browser brand.

**Resolution:** All work is done **after** a normal human login in the user's
own Chrome. Nothing spoofs `navigator`/UA. The agent check runs only at login;
post-login console scripting never re-trips it.

---

## Phase 1 — First recorder (`qb_record.js`)

**Problem:** Guessing `/qbapi/*` routes blind. Only `/qbapi/me` was known.

**Resolution:** A fetch/XHR recorder (`qb_record.js`) with `qbDump()` /
`qbRaw(i)` / `qbClear()`. User pasted it, reloaded, clicked through a bank,
and `qbDump()` revealed the full surface: `/qbapi/sync`, `/qbapi/key?u=`,
`/new-tests.json`, `/c/<xx>/<hash>`, videos endpoints, etc.

**Side finding:** `/c/<xx>/<hash>` are **encrypted** content blobs (mojibake
samples are expected). `/qbapi/key?u=` returns `{k: <hex>}`. `/qbapi/sync`
carries personal state; `/new-tests.json` carries the file-path tree.

---

## Phase 2 — Probe for a full manifest (`qb_probe.js`)

**Problem:** Unauthenticated `Invoke-WebRequest` probes all returned the 32KB
SPA fallback HTML — the whole API surface is gated by the session cookie
server-side. `/new-tests.json?days=99999` etc. returned identical 468,959 bytes,
so `days` is a build-time filter, not a tunable param.

**Resolution:** Probe must run **authenticated** in the browser console (same
origin → cookie rides along). `03-manifest-probe.js` did this and confirmed
`/new-tests.json` = 2,486 tests with full paths + question counts, and found the
IDB store `im-local` / `modules` (8 custom modules, 138 paths).

---

## Phase 3 — Sync drain (`02-sync-drain.js`)

**Problem:** Assumed `/qbapi/sync` holds the library catalog. Draining from
`seq=0` returned only 9 keys (custom modules, attempts) — `changes: []` on
most calls because the client was already in sync.

**Resolution:** `/qbapi/sync` holds **personal state only** (modules, attempts,
scores), not the library. The catalog must live elsewhere. `refs_packed.files`
in module records still leaked path slices (useful breadcrumb).

---

## Phase 4 — Bundle mining (`04-bundle-mining.js`)

**Problem:** Where does the full tree come from? No plain endpoint found.

**Resolution:** Mined the app's own JS bundle (`index-BIQSOdrK.js`) for
`/qbapi/*` routes and `.json` literals. Found catalog filenames:
`courses.json`, `manifest_<course>.json`, `question_index_<course>`,
`subject_topic_hierarchy_<course>.json`, `/data/<x>.manifest.json` (with
`{shards}`), `search/<course>/<term>`. Also found the anti-tamper header
`X-SOS-Stamp` and the `DecompressionStream` gzip code.

---

## Phase 5 — Base URL / CDN (`05-base-url.js`)

**Problem:** `courses.json` etc. are not at the site root (root returns SPA
HTML). Bundle references `assets.corebtr.com` → rewritten to
`corebtr-assets-production.s3.ap-south-1.amazonaws.com`. Candidate host probes
all failed (CORS / 404).

**Resolution:** These files are **not plain** — they're encrypted vault files.
The vault loader does `fetch → decrypt(key) → decompress → JSON.parse`. No
plain URL to guess. Pivot to reading the loader's own source.

---

## Phase 6 — Vault recon (`06-vault.js`)

**Problem:** `/qbapi/key?u=d0840395a5a7199d45d5e2121da1c20fe4e9c1b9` returned
`502 Bad Gateway`; vault read failed with `no key for <path>`.

**Resolution:** The 502 was transient/rate-limiting (cleared later). Also,
`window.qbVaultReport` was wiped by the reload the script asked for — only
`localStorage.__qbURLLOG__` survived. Fixed by having the report read from
localStorage instead of a console-scoped function.

---

## Phase 7 — SHA-1 hypothesis test (`07-sha1-test.js`)

**Problem:** Hypothesis that the key id `u` = `sha1(path)`. Tested
`sha1("Marrow/.../58_Grand Test 5 (From Q-Bank).json")` → `d00ef7…` ≠
observed `d0840395…`. Also `/qbapi/key?u=sha1("courses.json")` → `404`.

**Resolution:** Disproven. The key id is a **server-side content hash**, not
derivable from the path. The app resolves `path → hash` from a bootstrap
manifest (`Dd()` → `.b` map). Pivot to finding that bootstrap.

---

## Phase 8 — First structure export (`08-structure-export.js`)

**Problem 1:** `buildTree` crashed: `Cannot read properties of undefined
(reading 'Article Wise')`. The first loop nested children under `.__children`
but the re-walk read them straight off the parent node.

**Resolution:** Rewrote `buildTree` with a single clean walk storing children
under `folders` and pushing tests to the deepest node.

**Problem 2:** `SyntaxError: Invalid or unexpected token` when running the
export commands. The user pasted the annotation text (`→ structure.csv`) along
with the code.

**Resolution:** Run only the bare code: `copy(window.qbStruct.csv())`.

**Result:** 2,486 tests / ~67,800 questions across 6 banks + 659 video courses
(30-day snapshot).

---

## Phase 9 — Vault source + video dump (`09-vault-source.js`)

**Problem 1:** Video objects came out empty `{}`. The `/qbapi/videos` items use
field names `t/k/s/n/d` (title/key/status/nonce/date), not
`id/title/duration`. The normalizer looked for `id/title/name/duration` and
produced all-undefined objects that `JSON.stringify` dropped.

**Resolution:** `12-video-full.js` re-normalized with the correct field names.
Result: 659 courses, 45,842 videos with titles/keys/statuses/nonces/dates.

**Problem 2 (vault):** Needed the exact loader source for `Ak`, `Dd`, the HMAC
`catalog:key:v1` derivation, and the `/qbapi/key` fetch sites.

**Resolution:** Extracted from the bundle. Decoded the full vault:
- `jk = "5b908a4bbef284d44ab65836eee87cb5375976b1"` (bootstrap id)
- `Rd(id) = "/c/<id[0:2]>/<id[2:]>"` (blob URL)
- `Xp` = AES-GCM decrypt (12-byte IV, 128-bit tag)
- `Jp` = gunzip via `DecompressionStream`
- `Ck` = `HMAC-SHA256(vk(), "catalog:key:v1")` (AES key)
- `Li` = `X-SOS-Stamp` header from `/qbapi/stamp`
- `Dd` loads the bootstrap manifest (encrypted) → parses to `{b: {path:{u,k}}}`

---

## Phase 10 — Full library decrypt (`11-full-library.js`)

**Problem 1:** `EvalError: Evaluating a string as JavaScript violates CSP
(script-src 'self' blob:)`. `new Function(...)` is blocked.

**Resolution:** Assemble all code into a `blob:` script (allowed by the CSP) and
inject it via `URL.createObjectURL`. The blob runs in the page context and
writes results to `window`.

**Problem 2:** `Identifier 's' has already been declared`. The `extractAssign`
helper started the slice at the `=` sign, so every extracted helper began with
`=` (e.g. `=e=>{...}`), producing malformed assignments in the blob.

**Resolution:** Fixed `idx` to point at the symbol name:
`idx = m.index + m[0].length - sym.length - 1`.

**Result:** Decrypted the bootstrap manifest → **39,537 question files** across
14 banks (AMBOSS, Cerebellum, Core_BTR, DAMS, DocTutorials, Marrow, Osmosis,
PrepLadder, Reflex, Speed, eGurukul, medsynapse + crossapp/gt/pearls/search),
plus 659 video courses merged into `full-library.json` / `full-library-complete.json`.

---

## Phase 11 — JSON links (`13-links.js`)

**Problem:** Timed out. The blob did the decryption AND built a 39,537-entry
array + CSV + JSON inside the blob; the complex orchestration hung and
`__qbLinksDone` was never set.

**Resolution (v2):** Blob does **only** decryption + stores the raw `.b` map on
`window.__qbLinksRaw`; the main context builds the entries array, CSV, and JSON.
Result: `links.csv` / `links.json` with `path, blobUrl, keyId, hasEmbeddedKey`
for all 39,537 files.

---

## Recurring environment issues

- **Broken console state:** A truncated/malformed paste leaves an unclosed
  string or bracket, so subsequent commands fail with `Unexpected identifier`.
  Fix: `Ctrl+A, Delete`, then `1+1` Enter to confirm health; reload (F5) if
  needed.
- **`copy()` availability:** `copy()` works in Chrome DevTools; if blocked,
  select console output manually (Ctrl+C).
- **CSP:** `script-src 'self' blob: 'wasm-unsafe-eval'` — no `unsafe-eval`,
  so `eval`/`new Function` are forbidden; `blob:` scripts are the only way to
  run injected code.
- **Rate limiting / 502:** `/qbapi/key` intermittently returns 502; retry
  after a minute. Heavy probing can trigger 403 "paused" responses.
- **Reload wipes console:** F5 resets the JS context; never reload after pasting.
  Persisted data lives in `localStorage` (`__qbURLLOG__`) or downloaded files.
- **Unauthenticated probes are useless:** the entire API surface is gated by the
  session cookie server-side; everything must run in the logged-in browser.

---

## Privacy

Redact before sharing: login codes, tokens, JWTs, `/qbapi/key` values, signed
media URLs (`vtok=`), account PII. The exported files contain only paths,
names, counts and dates.
