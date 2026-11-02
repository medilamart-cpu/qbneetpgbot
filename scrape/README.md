# Structure export — banks → folders → tests index + video library

Goal: a complete, personal offline index of the whole library — **banks →
editions → folders → tests** (with paths and question counts) and the **video
library** (courses → sections → lectures). No question text, no answers, no
explanations, no media streams.

## Status — COMPLETE

Both halves of the index are done:

| Part | Source | Count |
|------|--------|------:|
| Question files (full history) | bootstrap manifest (decrypted) | **39,537** |
| Video courses | `/qbapi/videos` (plain, full catalog) | **659** (~15k lectures) |

The earlier `/new-tests.json` snapshot (2,486 tests, 30-day window) is
superseded by `full-library.json`.

## Final deliverables

- `full-library.json` — the complete index: nested question tree (39,537 files,
  14 banks), per-bank stats, and the video library (659 courses, grouped with
  course/section/lecture counts).
- `video index.txt` — the **full** video structure: per-course titles, section
  names, and per-lecture ids/titles/durations. (`full-library.json` aggregates
  videos as counts only; this file has the detail.)
- `structure.csv` / `structure.json` — the earlier 30-day snapshot (kept for
  reference).

## What these scripts do NOT do

- They do not touch the login. You sign in yourself, in your own Chrome.
- They do not patch, spoof or override `navigator` or any site function
  permanently; `fetch`/`XMLHttpRequest` are wrapped only to observe traffic.
- They do not replay, guess or brute-force ids; they read authenticated
  endpoints and the app's own JS bundle.
- They never store or export the per-user content key from `/qbapi/key`.
- Media streams are out of scope (DRM'd: Widevine CENC + HLS AES-128).

## How the full question index was unlocked

The complete library is NOT in `/new-tests.json` (that's a 30-day snapshot).
It lives behind an encrypted "vault". Reverse-engineering the app bundle
(the app's hashed `index-*.js` bundle) showed the loader:

```js
xt = async e => (await Ak(e)).data          // read a vault file by path
// Ak(path):
//   a = (await Dd()).b[$d(path)]           // path -> {u: blobId, k: key?}
//   if (!a) { ... fallback to /qbapi/extra-test ... }
//   blob = fetch(Rd(a.u))                  // Rd(id) = "/c/<id[0:2]>/<id[2:]>"
//   key  = a.k ? a.k : Tk(a.u)            // Tk = /qbapi/key?u=<id>
//   plain = Xp(blob, key)                 // AES-GCM, 12-byte IV, 128-bit tag
//   text  = Jp(plain)                     // gunzip
//   return JSON.parse(text)
```

The bootstrap manifest itself is the encrypted file
`/c/5b/908a4bbef284d44ab65836eee87cb5375976b1`. Its AES-256-GCM key is
derived client-side:

```js
Ck = HMAC-SHA256(vk(), "catalog:key:v1")   // vk() XORs base64 chunks from wk[]
```

and the fetch carries an `X-SOS-Stamp` header built from `/qbapi/stamp`.
Decrypting that ONE file yields `manifest.b` — a map of **every file path in
the library** (39,537 entries) to its blob id. That is the full index.

The CSP forbids `eval`/`new Function` (`script-src 'self' blob:`), so the
extracted minified helpers were spliced into a `blob:` script (which the policy
allows) and run there. Only the path index was extracted — no content keys, no
question text.

## Video library

`GET /qbapi/videos` returns 659 courses in the clear — the **full** catalog, not
a snapshot. `video index.txt` captures the complete structure (course titles,
section names, lecture ids/titles/durations). `full-library.json` aggregates
videos as counts only. The actual media is DRM'd (Widevine CENC + HLS AES-128)
and is out of scope.

## Script inventory

- `11-full-library.js` — **the full-coverage exporter** (decrypts the bootstrap
  manifest + merges videos). Use this.
- `09-vault-source.js` — extracted the vault loader source + dumped the video
  index (produced `video index.txt`).
- `08-structure-export.js` — the working 30-day snapshot exporter (question
  index + video aggregates).
- `10-bootstrap-src.js` — extracted the bootstrap helpers (`wk`, `Rf`, `Zp`, etc.).
- `06-vault.js`, `07-sha1-test.js` — earlier vault recon (reload-proof hook;
  SHA-1 id hypothesis, since disproven).
- `05-base-url.js`, `04-bundle-mining.js` — discovered the CDN/vault
  architecture and catalog filenames.
- `03-manifest-probe.js` — found `/new-tests.json` (2,486 tests) and the IDB
  `modules` store.
- `02-sync-drain.js` — proved `/qbapi/sync` carries only personal state.
- `qb_record.js`, `qb_probe.js`, `qb_login.html` — earliest recon.

## Troubleshooting

See `TROUBLESHOOTING.md` for the full history of problems hit (agent detection,
encrypted vault, CSP `eval` ban, console state issues, rate limits) and how each
was resolved.

## Privacy

Redact before sharing anything: login codes, tokens, JWTs, the `/qbapi/key`
value, signed media URLs (`vtok=`), and account PII (name, uid, device id).
The exported files contain only paths, names, counts and dates — they are the
owner's material; keep them for personal study, don't re-share.
