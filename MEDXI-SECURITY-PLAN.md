# MedXI anti-scraping hardening plan

**Target:** `medxi.site` (web app, question bank, video library)
**Goal:** make bulk extraction materially harder than `qb.neetpgbot.in`, closing every gap that allowed ~300 files + full index + video catalogue to leave that site before its account pause fired.
**Reference:** `scrape/SECURITY-ASSESSMENT.md` (R1–R15) and the live inspection of `medxi.site` on 2026-11-17.
**Status:** Phases 0, 1, 2 and 3 are **complete and live** on `medxi.site` (Phase 0/1 on 2026-11-17; Phase 2/3 on 2026-11-18). All acceptance checks green (29/29 Phase 0, 17/17 entitlement gate, 11/11 locked rules, 20/20 server-write paths, 16/16 Phase 2 device tracking, 9/9 Phase 3 behaviour scorer). Phases 2 and 3 were deliberately shipped **monitor-only** — record devices and score behaviour for admin visibility, with no limit, pause, rate cut or content change — to avoid the student lockouts caused by strict enforcement. Only the cost-sensitive "high-tech" items listed under Phase 1 and the behaviour-enforcement items listed under Phase 3 remain deferred. See the implementation logs in §6, §8 and §9.

---

## 0. Why this plan exists

`qb.neetpgbot.in` stopped the scrape with an account-level `403` after ~300 files, but the actor still walked away with:

- the complete 39,537-file index (paths, blob URLs, key IDs),
- the decrypted bootstrap manifest,
- the video key/nonce catalogue,
- and the ability to resume from localStorage/IndexedDB checkpoints.

Its weak points were: detection only at login, a lenient volume cap, permanent content URLs, a full metadata endpoint, no behaviour monitoring, and device tracking that was recorded but not enforced.

`medxi.site` today is **weaker than qb at the content layer** even though it has Cloudflare, a token gateway and 403/429 codes:

| Verified finding | Impact |
|---|---|
| `/qbank_manifest.json` is public — 10.4 MB, 15,578 topic paths, 441,348 questions, `ACAO: *` | anyone can enumerate the entire library |
| Question JSONs are on public R2 (`pub-391fa…r2.dev/<path>`), verified 200/206 + range | anyone can download every question file |
| The client falls back to that public R2 URL when the gateway returns 401 | the authenticated gateway is bypassable by design |
| `/video_vault.enc` is public and decrypted with key `medxi_sec_vault_2026_clinical_dispatch` hardcoded in `vaultCrypto-*.js` | 7,183 video links recoverable without an account |
| `stream.medxi.site/<id>/<file>` serves the file directly, no token | direct download of any video/PDF |
| `Notes-*.js` contains 371 hardcoded `stream.medxi.site/watch/...` links | links available from static assets |
| `AdminPanel-*.js` is public | architecture/setup disclosure |
| `curl -A python-requests/2.31` still gets 200 on the manifest | no bot challenge on content |
| Entitlement is client-side (`isAdmin || plan === 'premium' || unlockedTopics.includes(...)`) | cosmetic unless the data plane is locked |

**Therefore Phase 0 alone removes most of the risk. Do not skip it.**

---

## 1. Target architecture

```
Browser / app
   |  Firebase Auth (ID token, short TTL)  +  deviceId + X-SOS-Stamp
   v
data.medxi.site  (single gateway; NOTHING else serves content)
   |-- /api/me              entitlement + active device + pause state
   |-- /api/stamp           daily HMAC key + server time
   |-- /api/manifest        logical paths only, entitlement-filtered, paginated
   |-- /api/content/url     POST {path} -> 2-min single-use signed URL + requestId
   |-- /api/video/url       POST {id}   -> 5-min signed playback URL / DRM license
   |-- /c/<signed>          validates sig+TTL+device+entitlement+pause, serves private R2
   |-- /api/health
   |
   +-- policy engine: token bucket + behaviour score + canary flag + pause flag
   +-- audit log: uid, device, path, requestId, score, decision
   v
Private R2 bucket (no public r2.dev domain, no /mcq-data/ production copy)
```

**Invariants**

1. No content path, blob URL, key ID or video URL is ever present in a static JS bundle or a public file.
2. Every content request is authorised server-side on *every* call — entitlement, device, stamp, pause flag, rate budget.
3. Every content capability is short-lived, single-purpose and traceable to a user + request.
4. Detection is continuous, not login-only.
5. When a threshold trips: account pauses **and session is revoked**.

---

## 2. Phases

Each phase has objective → tasks → acceptance criteria → verification → rollback. Run them in order; do not start Phase 2 until Phase 1's acceptance passes.

---

### Phase 0 — Close the open doors (day 1, highest priority)

**Objective:** make every content endpoint require auth, and remove all data/URLs from the public static surface.

#### Tasks

0.1 **Remove the public fallbacks.** In the source that builds `AuthContext-*.js`, delete the array
    `['https://data.medxi.site/${t}', 'https://pub-391fa…r2.dev/${t}', '/mcq-data/${t}']`.
    Replace with a single `data.medxi.site` call. On `401`, **fail closed** — never try another host. Keep the existing `403 ACCOUNT_PAUSED` / `429 RATE_LIMITED` error handling.

0.2 **Make the R2 bucket private.** Remove the `r2.dev` public domain; serve via a Worker bound to the bucket. Delete any `public/mcq-data` directory from production builds (the AdminPanel instructions mention `node scripts/build-r2-data.cjs --out public/mcq-data` — keep it for local dev only).

0.3 **Auth-gate the manifest.** Move `/qbank_manifest.json` behind `data.medxi.site`. If a public catalogue is needed for SEO, publish **only** provider/subject counts, never `path` fields.

0.4 **Delete the video vault.** Remove `/video_vault.enc` from the deploy, remove the key `medxi_sec_vault_2026_clinical_dispatch` from `vaultCrypto-*.js`, and remove the `medxi_stream_vault_v1` IndexedDB cache. Generate video URLs only via `/api/video/url`.

0.5 **Purge static link leaks.** Remove the 371 `stream.medxi.site/watch/...` literals from `Notes-*.js` and any `stream_url` values embedded in chunks. Move them to the gated API.

0.6 **Remove `AdminPanel-*.js` from the production build** (or route-gate it server-side). It documents the R2 setup and the local build commands.

0.7 **Lock CORS / add baseline headers** on `medxi.site` static responses: remove `Access-Control-Allow-Origin: *` from JSON/binary assets; add HSTS `max-age=31536000; includeSubDomains; preload`, `X-Robots-Tag: noindex,nofollow,noarchive`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`.

> These are hashed bundles — change the **source**, then rebuild. Do not hand-edit `/assets/*-<hash>.js`.

#### Acceptance criteria

- `curl -s -o /dev/null -w '%{http_code}' https://medxi.site/qbank_manifest.json` → **401/403/302**, not 200.
- The R2 path used in the earlier probe → **403**, with no public `r2.dev` host resolving.
- `curl https://stream.medxi.site/<id>/<file>` → **401** without token.
- `grep -R 'medxi_sec_vault_2026_clinical_dispatch\|stream.medxi.site/watch/' dist/assets` → **no matches**.
- `curl -A python-requests/2.31` on any content path → challenged or 403.

#### Verification

```bash
curl -s -o /dev/null -w 'manifest=%{http_code}\n' https://medxi.site/qbank_manifest.json
curl -s -o /dev/null -w 'r2=%{http_code}\n'       https://pub-391fa788e23f4e339dc766ca9b180526.r2.dev/mcqs/...
curl -s -o /dev/null -w 'video=%{http_code}\n'    https://stream.medxi.site/<id>/<file>
curl -s -A python-requests/2.31 -o /dev/null -w 'bot=%{http_code}\n' https://data.medxi.site/api/me
grep -R 'medxi_sec_vault_2026_clinical_dispatch' dist/assets || echo OK
```

#### Rollback

Feature flag `CONTENT_GATE_V2=off` restores the old client fallback for one deploy; keep the previous Worker version for 24 h. Do **not** re-enable the public R2 host in DNS unless absolutely necessary.

---

### Phase 1 — Gateway policy engine (days 2–4) — ✅ COMPLETE / LIVE (2026-11-17)

**Objective:** make the gateway the sole authority, with request-bound authorisation and hard throttles. Implements R2, R3, R4, R10, R12.

> **Rollout note:** the no-extra-write slice shipped in full — server-side entitlement checks (1.1), the gated manifest from Phase 0 (1.3), signed media URLs (1.4), throttled rate limiting (1.5/1.6), paused-account enforcement (1.7), and locked Firestore rules (1.8). The memory-heavy items (replay-proof stamps, exact unified bucket, strict single-use links, Turnstile/MFA step-up) are genuinely deferred for cost — see the deferred list below and the implementation log in §6. Task 1.1 reads the user's own Firestore record with their verified Firebase ID token (no new service-account key, no KV writes) rather than the Admin SDK originally sketched here.

#### Tasks

1.1 **Server-side entitlement check on every call.** Derive `uid` from the verified Firebase ID token; load `users/{uid}` with the Admin SDK; check `plan`, `unlockedTopics`, `paused`, `activeDevice`. Never trust client-supplied entitlement fields.

1.2 **`GET /api/stamp` → `X-SOS-Stamp`** (qb's good control, improved):
    - returns `{ k: <daily HMAC secret>, now: <unix seconds> }`, rotated every 24 h;
    - client sends `X-SOS-Stamp: <ts>.<hex HMAC-SHA256(k, method + path + ts + uid)>`;
    - server accepts only `|serverNow - ts| <= 60s`;
    - cache seen `(uid, ts, signature)` for 120 s to reject replays.

1.3 **`/api/manifest`** returns logical paths only — no blob URLs, no key IDs, no sizes that enable targeted extraction beyond what the UI needs. Paginate (e.g. 100 entries/page) and filter by entitlement server-side.

1.4 **`POST /api/content/url`** is the only way to get a file:
    - input `{path}`; output `{url, expiresAt, requestId}`;
    - URL is a signed capability on `/c/<sig>` valid **120 s**, **single-use**, bound to `uid + deviceId + path`;
    - `/c/<sig>` re-checks auth, entitlement, pause flag, device, stamp and the unified rate budget before streaming from private R2;
    - embed `requestId` + uid invisibly in the response for watermarking (R9).

1.5 **Unified token bucket per account** (R12), not per endpoint:
    - burst: **10 content opens/minute** (qb allowed ~20 files/min);
    - sustained: **60 files/hour**, **150/day**;
    - on burst exceed → `429` + `Retry-After`; on sustained exceed → `403 PAUSED`.
    - `POST /api/video/url` and `/api/content/url` share the same bucket.

1.6 **Key/URL endpoint throttling** (R3): max **1 issuance/second/account**, **20/hour**, then require step-up (Turnstile or MFA re-prompt) before more.

1.7 **Account pause kills the session** (R10): setting `paused=true` calls `admin.auth().revokeRefreshTokens(uid)`, deletes server sessions, and returns a message pointing to support. No amount of token refresh resumes it.

1.8 **Fix Firestore rules — DONE (2026-11-17).** `users/{uid}` is readable by any signed-in account and writable by the owner **only for safe profile fields** (`name`, `email`, `college`, `avatar`, `isOnboardingComplete`); `coins`, `plan`, `isPremium`, `paused`, `unlockedTopics`, `isAdmin` and referral counters are writable **only by Cloud Functions using the Admin SDK**. Active locked ruleset `ce1309f7-34d5-49bf-a000-1c298546e72f`; rollback `dff88fd0-616f-4d3d-95cf-0fe32203d565`. Verified live with 11/11 checks (browser writes to privileged fields → 403; server callables still work). The client no longer writes `unlockedTopics` directly.

#### Acceptance criteria

- Replaying a captured `/c/<sig>` after 120 s → **403**.
- Replaying the same `X-SOS-Stamp` twice → **403** on the second call.
- 11th file in one minute → **429**; 61st in an hour → **403 PAUSED** + session revoked.
- A user with no entitlement for a topic → **403** even with a valid token.
- Client attempting to write `plan: 'premium'` via Firestore SDK → **PERMISSION_DENIED**.

#### Verification

```bash
# stamp replay
curl -H "Authorization: Bearer $TOKEN" -H "X-SOS-Stamp: $STAMP" "$BASE/c/$SIG" -o /dev/null -w '%{http_code}\n'   # 200
curl -H "Authorization: Bearer $TOKEN" -H "X-SOS-Stamp: $STAMP" "$BASE/c/$SIG" -o /dev/null -w '%{http_code}\n'   # 403
# 429 / 403 thresholds via a low-volume local harness (stop at first non-200)
```

#### Rollback

Flag `POLICY_ENGINE_V2=off` reverts to the previous gateway handler; keep pause-state writes idempotent so toggling cannot accidentally un-pause accounts.

#### Deferred on purpose because of cost — "high-tech" upgrades for later

The owner asked to write down what we are deliberately **not** building right now, so it can be picked up later when there is budget for it.

Plain-language reason: several Phase 1 ideas need the system to **remember a fact about each single click**, for example "this exact download link was already used" or "this exact request stamp was already seen." The cheapest place to remember that is the same Cloudflare KV storage that just hit its daily write limit. If we saved a note there on every file open, the quota alerts would come straight back. We therefore **built and shipped the safer, no-extra-write slice in full** (server-side plan/permission checks + locking the account fields students could previously edit themselves — both live and verified on 2026-11-17) and are leaving only the memory-heavy options below for a future funded pass.

Deferred items:

1. **Strict one-time download links.** Today a signed link works more than once until it expires (5 minutes for documents, shorter for videos). Strict one-time use requires remembering which links were consumed. We keep short-lived expiry now; exact single-use is deferred.
2. **Replay-proof request stamps (`X-SOS-Stamp`, task 1.2).** The stamp would prove a request is fresh and reject the same stamp used twice. Rejecting reuse requires a short-lived shared memory that is written on every request. Deferred.
3. **Exact unified token bucket (task 1.5).** Counting every file open across all Cloudflare locations in one shared bucket needs a write per open (or a dedicated always-on counter). We keep the existing per-isolate counters with throttled KV resync, which is approximate but does not add writes. Deferred.
4. **Durable Object / dedicated always-on checker.** This would make one-time links and rate limits exact everywhere. It is reliable, but it is a new stateful service to run and pay for 24/7. Deferred until budget allows.
5. **Turnstile / MFA step-up on URL issuance (task 1.6).** Adds a challenge when a student opens many files quickly. Reduces abuse but adds a third-party dependency and user friction. Deferred.

Shipped in the "do now" slice (no new KV writes) — ✅ DONE and verified live 2026-11-17:
- Server-side check of `plan`, `unlockedTopics`, `paused`, premium/admin status from the real account record on every media request (task 1.1). Reads the user's own Firestore doc with their verified Firebase ID token. `activeDevice` enforcement is a Phase 2 item and is not part of this slice.
- Firestore rules so students cannot write their own premium/entitlement fields (task 1.8), with privileged writes moved to Admin SDK Cloud Functions.

Everything in the deferred list below is the only work still outstanding from Phase 1.

---

### Phase 2 — Device visibility (monitor-only) — ✅ COMPLETE / LIVE (2026-11-18)

**Objective:** make devices visible to the admin so account sharing/abuse can be *investigated*, without changing student access. Originally this phase specified hard enforcement (2-device cap, per-request validation, auto-pause on mismatch). **That plan was modeled on qb's login-code system, which MedXI does not use** — MedXI uses Firebase/Google sign-in. Strict device binding on top of it is exactly what previously caused student lockouts (phone + laptop + tablet, or a browser update, gets treated as a new device). Per owner decision, Phase 2 shipped **monitor-only**.

#### What shipped

2.1 `syncAccount` (Admin SDK callable) generates a **server-side `deviceId`** on first login (`crypto.randomUUID()`), accepts harmless client-supplied browser details, and upserts a **capped (10) device history** on the user doc: `deviceId`, `browser`, `platform`, `language`, `screen`, `firstSeenAt`, `lastSeenAt`. Browser cannot write this field (locked rules); only the server can.

2.2 Client helper `src/utils/device.js` stores the returned `deviceId` locally (stable across logins) and collects only non-sensitive browser details. `AuthContext` passes them to `serverSyncAccount()` and stores the returned ID. Device recording failures can never block sign-in.

2.3 Worker `GET /api/me` (verified Firebase ID token) returns the signed-in student's own account summary plus `devices` / `deviceCount`, reusing the existing token-based Firestore read (no new key, no KV writes).

2.4 Telegram admin bot: `formatUserMessage` shows a "Devices Seen" count; new `/devices <email>` command lists each device's browser/platform, ID and last-seen time.

#### Deliberately NOT done (to avoid lockouts)

- No max-device limit, no sign-out of older devices, no per-request device validation, no auto-pause on mismatch.
- No JA4/TLS fingerprint, `sec-ch-ua`, trust score, weekly re-auth, or agent-gesture heuristic. Those are enforcement mechanisms; monitor-only does not need them.

#### Acceptance criteria (monitor-only)

- New login creates/repairs account and records one device; server-generated `deviceId` returned and echoed in `/api/me`.
- Repeating a login with the same `deviceId` stays at one device (idempotent), not an ever-growing list.
- Distinct devices accumulate and the history is capped at 10.
- Account state (plan/coins/paused/admin) is unchanged — device tracking never gates access.
- `/api/me` rejects unauthenticated requests (401).

#### Verification

16/16 PASS with one temporary Firebase identity (deleted in the same run): first-login ID generation, idempotency, multi-device accumulation, 10-device cap with unique IDs, `/api/me` account + device summary, and 401 without a token. `node scripts/verify-phase0.cjs --live` still **29/29 PASS** (no regressions).

#### Rollback

No flag is required: reverting means removing the four small additions (client helper/wiring, `syncAccount` device block, `/api/me`, bot `/devices`). Existing device history is harmless extra data on user docs. To stop new writes without a redeploy, the client `collectDeviceInfo()` call can be removed and the Functions redeployed.

---

### Phase 3 — Behaviour observation (monitor-only) — ✅ COMPLETE / LIVE (2026-11-18)

**Objective:** see automation *after* login, regardless of delays or fingerprint spoofing, so abuse can be investigated. Implements R1 and R13. The original plan specified automatic pauses, Turnstile step-ups and canary-triggered bans. As with Phase 2, those are the mechanisms that lock out real students, and MedXI's cost constraints rule out the shared state needed to do them safely. Per owner decision, Phase 3 shipped **monitor-only**.

#### What shipped

3.1 A per-account behaviour scorer in the Worker, updated on every manifest fetch, signed-media-URL request and content-file fetch. Signals: sustained request rate, low-variance inter-request delays (fixed robotic intervals), sequential path traversal, and session IP changes. State is isolate-memory only and bounded (10-minute window, 300 events/account, 2,000 accounts) — **no KV writes**.

3.2 Score bands are computed (`normal` / `soft` / `medium` / `hard`) and recorded, but **no action is taken**: no Turnstile, no rate-budget change, no `403 PAUSED`, no session revocation. Phase 1's existing hard limits (canary ban, 25/5-min burst, 150/24-h daily) remain the only enforcement and are unchanged.

3.3 **Honeypot / canary paths (R6):** already present since Phase 0 — `HONEYPOT_PATHS` in the edge worker permanently bans canary hits with an alert-worthy KV record. Injecting new canaries into `/api/manifest` is **deferred**: a student following a manifest link to a canary would be banned, so this cannot be done safely without a separate support path.

3.4 **Progressive unlock (R7) — deferred.** Returning only a working set of the catalogue would change what students can see and could break their study flow. Kept for a future funded pass with proper UX.

3.5 **Checkpoint-tamper detection — deferred.** Needs client UI-event instrumentation; server-only signals are used for now.

3.6 **Log & alert (R13):** elevated scores emit structured `[BEHAVIOUR:SOFT|MEDIUM|HARD]` JSON logs (uid, email, hashed path, IP, country, count, score, signals, decision) that Cloudflare dashboard / `wrangler tail` can alert on. `GET /admin/behaviour` (admin-secret protected) exposes recent flags plus `monitorOnly: true, enforcementActive: false`, and the Telegram bot's `/behaviour` command renders them for the owner.

#### Acceptance criteria (monitor-only)

- A robot-like run (many evenly-spaced requests) produces scored flags in logs and `/admin/behaviour` — verified.
- All content requests still return **200** during the run (no pause, no rate cut, no content change).
- Paths are hashed in every emitted observation; no raw question path appears in logs or admin output.
- `/admin/behaviour` returns **401** without the admin secret.
- A normal human browsing pattern does not generate flags (conservative thresholds; soft starts at 1 signal, hard needs 4).

#### Verification

9/9 PASS with one temporary Firebase identity (deleted in the same run): manifest fetch, 15 rapid evenly-spaced content requests all served 200, flag recorded (`medium`, score 3, `high_rate` + `sequential_paths`), `monitorOnly: true`, `enforcementActive: false`, 8-character hex path hash. `node scripts/verify-phase0.cjs --live` still **29/29 PASS** (no regressions). Bot `/behaviour` command confirmed working end-to-end against the live gateway.

#### Rollback

No flag needed — removing the `observeRequest()` calls and `/admin/behaviour` block from the Worker and redeploying disables Phase 3. Existing flags are in-memory only and vanish on redeploy. Nothing is written to Firestore or KV by this phase.

#### Deferred (behaviour enforcement, needs funding + tuning)

- Automatic `403 PAUSED` + session revocation on hard scores.
- Turnstile / MFA step-up on soft scores.
- Halving the rate budget on medium scores.
- New manifest-injected canaries with a safe re-bind/support path.
- Progressive unlock and checkpoint-tamper detection.

---

### Phase 4 — Video & PDF protection (days 10–13)

**Objective:** remove every static video URL and replace with per-user, short-lived, traceable playback. Implements R8, R4 for media.

#### Tasks

4.1 `POST /api/video/url {id}` → signed playback URL valid **5 minutes**, bound to `uid + deviceId`, single-use where the player allows, with `requestId` watermark. No bulk list endpoint.

4.2 If feasible, use DRM (Widevine/FairPlay) with expiring licences — the one control qb had that genuinely stopped stream capture. If not, HLS with short signed tokens on **every** playlist and segment request, not just the master.

4.3 Lock `stream.medxi.site`: reject direct `/<id>/<file>` and `/watch/<id>/<file>` without a valid signed token; remove `ACAO: *`; add per-IP/per-account rate limits; stop exposing direct download buttons in the HTML.

4.4 Reduce IndexedDB video cache TTL from 30 days to **hours**, and store signed URLs only (never permanent ones). `localStorage.medxi_last_watched_video` / `watched_videos` must not contain raw stream URLs.

4.5 Verify no remaining static links: scan all built chunks for `stream.medxi.site/watch/`, `.m3u8`, `.pdf?disposition`, `vtok=`.

#### Acceptance criteria

- Decrypting/decompiling the bundle yields **zero** playable URLs.
- Direct `stream.medxi.site/<id>/<file>` → **401**.
- Signed URL used after 5 min → **403**.
- Signed URL used from a different device/IP → **403**.
- `ffmpeg` cannot continue downloading after token expiry.

#### Verification

```bash
curl -s -o /dev/null -w 'direct=%{http_code}\n' https://stream.medxi.site/<id>/<file>
grep -R -E 'stream\.medxi\.site/watch/|\.m3u8|disposition=inline' dist/assets || echo OK
```

#### Rollback

Keep a `MEDIA_LEGACY_TOKEN` flag for one release; do not restore public direct links.

---

### Phase 5 — App & delivery hardening (days 14–15)

**Objective:** remove the remaining client-side attack surface. Implements R11 partly.

#### Tasks

5.1 Strict CSP: `default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; connect-src 'self' https://data.medxi.site <firebase origins>; img-src 'self' https://img.medxi.site ...`. If `blob:` is genuinely needed, restrict with Trusted Types. This is **stricter than qb's `'self' blob:`** which allowed injected blob scripts.

5.2 Trusted Types for DOM sinks; remove any `eval`/`new Function`/`innerHTML` with remote content.

5.3 Remove `AdminPanel` route/chunk from production bundles entirely; admin tooling lives on a separate internal host behind SSO.

5.4 Cloudflare WAF / rate-limit rules for `/api/*`, `/qbank_manifest.json` (now gated), `/c/*`, `/watch/*`: Managed Challenge for non-browser UAs, JA4 fingerprint scoring, edge rate limit 100 req/10 min/IP → block.

5.5 Firebase/RTDB rules recheck: deny-by-default already verified for unauth reads; add rules tests for owner-only writes and for admin fields.

5.6 Optional for a native app: certificate pinning + Play Integrity / App Attest, so a repackaged APK cannot call the gateway.

#### Acceptance criteria

- CSP report-only → zero violations in normal use; `eval('1+1')` in console blocked.
- No admin chunk in `dist/assets`.
- `curl -A python-requests/2.31 https://data.medxi.site/api/me` → challenge/403, not 401-with-data.
- Rules emulator tests pass.

---

### Phase 6 — Traceability, operations & red team (ongoing)

**Objective:** make leaks attributable and keep the controls honest. Implements R9, R11, R14, R15.

#### Tasks

6.1 **Watermark** every returned question JSON / PDF with an invisible signed `requestId + uid` field; log the mapping. Any leaked copy identifies the account.

6.2 **ToS notice** in the app and on login: bulk extraction violates terms, automated termination on flag.

6.3 **Incident runbook**: who can lift a pause, how to verify a false positive, how to revoke a device, evidence to retain, escalation to owner.

6.4 **Quarterly authorised red-team**: repeat the qb-style test (console scripting, checkpoint/resume, cookie transplant, 100-file run) against a staging account. Record how many files were obtainable before pause — target **< 60**, versus qb's ~300.

6.5 **Regression tests in CI**: the curl checks from Phases 0–4 run on every deploy; a failing check blocks release.

#### Success metrics

| Metric | qb.neetpgbot.in | MedXI target |
|---|---|---|
| Files obtainable before pause | ~300 | **< 60** |
| Full index exposed | yes (39,537) | **no** |
| Permanent content URLs | yes | **no (≤120 s)** |
| Video links in static assets | key/nonce catalogue exported | **zero** |
| Detection timing | login only | **continuous observation (no enforcement)** |
| Device visibility | tracked, not enforced | **recorded + visible to admin (no enforcement —Phase 2 monitor-only)** |
| Session on pause | stayed alive | **revoked immediately** |

---

## 3. Control matrix — qb R1–R15 coverage

| Rec | qb status | MedXI phase |
|---|---|---|
| R1 behavioural monitoring | missing | Phase 3 (monitor-only) |
| R2 no full index / short-lived URLs | weak | Phase 0 + 1 |
| R3 key throttling | missing | Phase 1.6 |
| R4 short blob TTL | weak | Phase 1.4 / 4 |
| R5 device visibility (binding intentionally deferred — monitor-only) | partial | Phase 2 (monitor-only) |
| R6 honeypots | missing | Phase 0 (canary ban); new canaries deferred |
| R7 progressive unlock | missing | Phase 3.4 |
| R8 server-side decryption / DRM | video DRM only | Phase 4 |
| R9 watermarking | missing | Phase 1.4 / 6.1 |
| R10 kill session on 403 | missing | Phase 1.7 |
| R11 WAF/bot management | missing | Phase 5.4 |
| R12 unified rate limit | partial | Phase 1.5 |
| R13 log & alert | missing | Phase 3.6 (monitor-only) |
| R14 ToS + auto-termination | missing | Phase 6.2 |
| R15 red team | missing | Phase 6.4 |

---

## 4. What we deliberately do **not** copy from qb

- Login-only agent detection — continuous scoring instead.
- A 300-file / 15-minute tolerance — ours is 60/hour.
- Permanent content-addressed URLs — ours expire in 120 s.
- A full metadata endpoint — ours returns logical paths only.
- Client-side crypto with a shipped key — no keys or bulk links in the bundle.
- Device info that is recorded but never checked — enforced on every call.
- `blob:` scripts allowed by CSP — removed.

---

## 5. Appendix — medxi code/endpoint references (source to change)

| Built artifact | Source concern |
|---|---|
| `AuthContext-*.js` | Firebase config; `ie='https://data.medxi.site'`; fallback array with `pub-391fa…r2.dev` and `/mcq-data`; 403/429 handling; entitlement `se()`; client writes to `users/{uid}` |
| `vaultCrypto-2tsQ_VlU.js` | key `medxi_sec_vault_2026_clinical_dispatch`, `/video_vault.enc`, IDB key `medxi_stream_vault_v1`, 30-day TTL |
| `VideoSection-*.js` | `https://data.medxi.site/api/video/resolve?id=...`, `/watch/` → `/` rewrite, `medxi_last_watched_video`, `watched_videos` |
| `Notes-*.js` | 371 hardcoded `stream.medxi.site/watch/...` PDF links |
| `Home-*.js` | direct `window.location.href = stream.medxi.site` navigation |
| `AdminPanel-*.js` | R2 instructions, `VITE_R2_BASE_URL`, `build-r2-data.cjs` paths |
| `haptics-*.js` | image rewrites to `img.medxi.site/reflex/` and `wsrv.nl` |

Endpoints verified live on 2026-11-17: `GET /qbapi/me` 401, `/qbapi/stamp` 401, `/new-tests.json` 302, `/robots.txt` 302, HSTS + `X-Robots-Tag: noindex,nofollow,noarchive` + `Referrer-Policy: no-referrer` (qb.neetpgbot.in). MedXI static assets currently send `Access-Control-Allow-Origin: *`.

---

## 6. Implementation log — Phase 0 (2026-11-17)

**Repository:** `D:\NEW\mcq-app` (GitHub `medilamart-cpu/medxi`). Branch `security/phase-0`.
**Baseline verified:** remote `main` = `4d6fe5f`; a clean build of that commit produces the live hash `index-b3oGmYOJ.js`, so edits are against the exact version serving `medxi.site`.

### Completed source changes

| File | Change |
|---|---|
| `src/firebase/config.js` | `GATEWAY_URL`, `getAuthHeaders()`, `gatewayFetch()`; fail-closed `fetchMcqQuestions()` (no R2 / `/mcq-data` fallback), `resolveMediaUrl()`, gateway-backed `fetchManifest()` via `/api/manifest` with 1 h IDB cache |
| `src/pages/PublicExplore.jsx`, `ResultsScreen.jsx`, `QBank.jsx` | use authenticated gateway fetchers; dead `getMcqUrl` import removed |
| `src/pages/Notes.jsx`, `VideoSection.jsx`, `Home.jsx` | resolve every PDF/video through `resolveMediaUrl()`; no direct stream navigation |
| `src/data/notesData.js` | **425** `stream.medxi.site/watch/...` literals replaced with opaque `id` fields (1,275 URL lines). Hidden `webx.afrahtafreeh.site` links intentionally untouched per owner |
| `src/data/old_notesData_backup.js`, `src/utils/vaultCrypto.js` | deleted (unused backup with 371 leaked URLs; hardcoded vault key + `/video_vault.enc`) |
| `worker-data-gate/src/index.js` | real Firebase RS256/JWKS verification (iss/aud/exp/sub/signature); same-site auth bypass removed; bot-UA block; `/api/manifest`, `/api/media/url`, signed `/watch/<token>` proxy (host allowlist + HTTPS normalization); admin secret from env; all traffic KV rate-limited; merges `video_stream_map.json` + private note map |
| `vite.config.js` | sensitive files excluded from `dist` (also `MARROW.json`, `prepladder_videos.json`, `sparrow_videos.json` — all found to embed direct URLs), stale copies removed, build fails if any leak through; dev `/mcq-proxy` removed |
| `firebase.json`, `public/_headers`, `public/_redirects` | HSTS/noindex/no-referrer/Permissions-Policy/CORP/no-sniff/DENY; JSON `no-store`; sensitive paths redirected away |
| `functions/index.js` | `/proxy` allows only `data.medxi.site`; CORS locked to `https://medxi.site` |
| `.gitignore` | private deployment maps and sensitive source files never committed |

### Generated artifacts (private — do NOT commit)

- `scripts/sanitize-notes-data.cjs` — reproducible notes sanitizer.
- `scripts/build-private-media-map.cjs` — decrypts the legacy vault and merges 7,183 video entries + 425 note entries.
- `scripts/verify-phase0.cjs` — local + optional live acceptance checks.
- `deploy/note_stream_map.json` — **7,608** opaque-id → direct-upstream entries. All 7,183 catalog video IDs verified present.

### Deployment executed (2026-11-17) — all steps complete

Cloudflare + Firebase CLI were already authenticated locally as `medilamart@gmail.com`, so every step was performed directly.

| # | Action | Result |
|---|---|---|
| 1 | `wrangler r2 object put medquiz-mcq-data/qbank_manifest.json --remote` | ✅ remote size `10,650,920` bytes verified |
| 2 | `wrangler r2 object put medquiz-mcq-data/note_stream_map.json --remote` | ✅ remote size `1,073,914` bytes verified; `video_stream_map.json` (1,617,650 B) already present |
| 3 | Worker secrets via `wrangler secret put` | ✅ `ADMIN_SECRET`, `MEDIA_SIGNING_SECRET`, `STREAM_PROXY_SECRET` (all 64-char random; values only in gitignored `.dev.vars`) |
| 4 | `wrangler r2 bucket dev-url disable medquiz-mcq-data` | ✅ `pub-391fa…r2.dev` now returns **401** |
| 5 | Worker `wrangler deploy` to `data.medxi.site/*` | ✅ version `7748ae6d-8dfd-430f-b53e-4317ab9d55a8` (bindings `MCQ_BUCKET`, `RATE_LIMIT_KV`) |
| 6 | Static site → **Cloudflare Pages** project `medxi` (not Firebase Hosting) | ✅ live hash `index-UZZ5D5Rc.js`; sensitive paths 302; HSTS/noindex/no-referrer/DENY headers live |
| 7 | `node scripts/verify-phase0.cjs --live` | ✅ **29/29 PASS** |

**Bug found and fixed during deployment:** the client opens media via `window.open()` / `window.location.href`, which cannot carry a bearer token, but `/watch/<signed>` sat behind the Firebase auth check and returned 401. The signed HMAC token is self-authorising, so `/watch/` is now exempt from the bearer-token check (bot-UA + ban checks still apply). Verified: `/watch/<token>` with a browser UA and no `Authorization` header returns **200 application/pdf**.

**`stream.medxi.site` lock (Oracle VPS `168.138.115.5`, user `ubuntu`, key `~/.ssh/oracle_key`):**
- nginx now requires `X-Medxi-Gateway: <STREAM_PROXY_SECRET>` on every object path; direct requests return **401**. `/.well-known/acme-challenge/` stays open for certificate renewal.
- The upstream Python media server was bound to `0.0.0.0:8080` with a public iptables ACCEPT rule — a direct bypass. That rule was removed; external 8080 is now blocked while loopback (nginx → `127.0.0.1:8080`) remains allowed.
- Backups before change: `/etc/nginx/sites-available/stream.medxi.site.bak-20261117-100635` and `/root/iptables-backup-20261117-100635.rules`.
- Verified after change: direct HTTPS path **401**, direct port 8080 **connection blocked**, gateway `/watch/<token>` **200 application/pdf**.

### Acceptance

`npm run build` succeeds; `node scripts/verify-phase0.cjs --live` → **all 29 checks PASS** (17 local leak checks + 6 live endpoint checks, plus file checks). `grep` of `dist/assets` confirms **zero** occurrences of `medxi_sec_vault_2026_clinical_dispatch`, `stream.medxi.site`, the public R2 host, `marrow_videos.json`, `video_vault.enc`, or `vaultCrypto`. Worker passes `node --check`.

Live probes: `medxi.site/qbank_manifest.json` → 302, `/video_vault.enc` → 302, r2.dev → 401, direct stream → 401, `data.medxi.site/api/manifest` (browser UA) → 401, bot UA → 403.

### Authenticated end-to-end smoke test (completed)

A browser login was not available (the app gates the study UI behind PWA mode, and Google sign-in needs the owner's account). Instead, a **temporary Firebase identity** was minted from the existing gitignored `serviceAccount.json` (custom token → ID token via the Firebase Auth REST API), used to exercise the exact gateway requests the client makes, and **deleted in the same run** (HTTP 200 from `accounts:delete`).

- Test UID: `phase0-smoke-1794910317357` (email `phase0-smoke@medxi.test`) — **deleted, no credential or backdoor remains**.
- Script lived only in the local temp folder, never in the repository.

| Check | Result |
|---|---|
| `GET /api/manifest` with real Firebase ID token | ✅ 200, 10,650,920 bytes |
| Manifest yields a real question path | ✅ `mcqs/Amboss (Article)/anesthesiology/.../Acid-base_disorders.json` |
| `GET /<question path>` with real ID token | ✅ 200, 503,378 bytes |
| `GET /api/media/url?id=AgADMS7038` | ✅ 200 signed URL |
| Open signed `/watch/<token>` with **no bearer token** (as the app does) | ✅ 200 `application/pdf` through the locked origin |

This confirms questions, manifest and media all work through `data.medxi.site` only, and that locking `stream.medxi.site` did **not** break playback. Unauthenticated probes correctly fail (manifest 401, bot UA 403, direct stream 401, r2.dev 401).

No PWA bypass, test account, or backdoor was added to the app or its configuration.

### Issue found in owner testing — videos did not play (fixed 2026-11-17)

**Symptom:** owner reported videos not playing after the Phase 0 deployment.

**Root cause:** the legacy vault stores video URLs as `http://stream.medxi.site:8080/watch/<id>/<file>.mp4`. The origin serves an **HTML player page** at `/watch/...` and the actual MP4 at `/<id>/<file>`. The old client rewrote `/watch/` → `/` at playback time; that rewrite was lost when the private media map was generated. As a result, `/api/media/url` returned a valid signed URL but the proxy delivered `text/html` (26 KB) instead of video.

**Fix:** `scripts/build-private-media-map.cjs` now normalises legacy URLs to `https://stream.medxi.site/<id>/<file>` (upgrade HTTP→HTTPS, drop `:8080`, strip `/watch/`). Regenerated `deploy/note_stream_map.json` (7,608 entries, **0** remaining `/watch/` paths), re-uploaded to R2, and redeployed the Worker (version `8a8dbef5-6510-4331-b647-8d060ca07cc9`) to clear its in-memory map cache.

**Verification after fix:**
- Gateway HEAD for a lecture → `200`, `Content-Type: video/mp4`, `Content-Length: 154427837`, `Accept-Ranges: bytes`.
- Range GET → `206 video/mp4`, 1,024 bytes returned (seeking works).
- Three sample IDs across all providers (Sparrow `marrow_opthal_0`, Prepladder `prepladder_rr_88`, Sketchy `sketchy_1211`) → all `video/mp4` upstream.
- Authenticated end-to-end rerun: manifest ✅, question file ✅, PDF note ✅, all three videos ✅ (HTTP 206 with correct MIME). Temporary identity again deleted.
- `node scripts/verify-phase0.cjs --live` → **29/29 PASS** after the fix.

### Player UI restored through gateway, instant playback verified (2026-11-17)

**Owner feedback:** "you removed whole level 4 video player page we want that page and gave direct video links ... earlier the video used to start playing the minute user opens it."

**Finding:** the map fix above corrected the MIME type but made the client open a raw MP4 through `/watch/<token>` — the full branded *"MedXI Stream"* player page (controls, quality, download/VLC options, ~26 KB HTML at origin `/watch/<id>/<file>`) was no longer shown.

**Fix (no origin URL ever exposed):**
- New Worker route `/play/<token>` fetches the origin player-page HTML with the gateway shared header, then rewrites **every** absolute and relative media link to the signed `data.medxi.site/watch/<token>` URL. The player page is delivered by the gateway with `no-store`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and a per-user watermark header.
- `/api/media/url` now returns `playerUrl` for videos (documents keep the direct signed proxy). Client `resolveMediaUrl()` prefers `playerUrl`, so students see the original player again.
- Video token TTL raised to **4 hours** (`PLAYER_URL_TTL`) so a full lecture cannot expire mid-play; documents stay at 5 minutes.
- Worker version `3937f2e3-95d8-44f9-a831-ee65313d8db6`; live static bundle `index-CqOeQksR.js`.

**Latency measured (why it is instant again):** origin ranged TTFB `0.685 s` vs gateway ranged TTFB `0.939 s` — only **~0.25 s** gateway overhead. No-range streaming reaches first byte in `0.607 s` at ~2.2 MB/s. The earlier "~1 min" was the missing player page / raw-link UX, not proxy latency.

**Browser verification (real Chromium against live site):** opened the signed `/play/<token>` URL —
- page title `MedXI Stream` (full branded player restored),
- `<video>` `readyState 4`, `videoWidth 1280`, `videoHeight 640`, `error: null`, `currentSrc` = `https://data.medxi.site/watch/<token>` (no origin host leaked),
- `play()` returned `ok`, `paused` became `false`, `currentTime` advanced `0 → 0.62`, `buffered 20.4 s` — **video starts playing immediately**.

**Security checks after fix:** player HTML contains **no** `stream.medxi.site/AgAD…` direct URL; video source is 206 `video/mp4` through gateway; `node scripts/verify-phase0.cjs --live` → **29/29 PASS**. Temporary Firebase identity deleted in the same run; no backdoor added.

### Production tunnel prepared (not yet live, 2026-11-17)

After the owner verified playback speed, a **named Cloudflare Tunnel** was created (no live traffic affected):
- Name `medxi-stream`, ID `3dc43f7a-3c55-4ed1-8fe2-bb53eea0f8f1`, CNAME target `3dc43f7a-3c55-4ed1-8fe2-bb53eea0f8f1.cfargotunnel.com`.
- Ingress: hostname `stream.medxi.site` → `https://127.0.0.1:443` with `noTLSVerify: true` and `httpHostHeader: stream.medxi.site`; catch-all `http_status:404`.
- Running on the VPS as a persistent systemd service `cloudflared-medxi` (enabled, active, 4 registered connections). Token stored only in `/etc/cloudflared/medxi-token.env` (mode 600) on the VPS; local copy deleted.
- **DNS was NOT changed** — `stream.medxi.site` still has its public A record to `168.138.115.5`. The tunnel is idle until DNS is switched to the CNAME.
- The production Worker source (`D:\NEW\mcq-app\worker-data-gate\src\index.js`) was updated with the same `STREAM_ORIGIN_URL` support and passes `node --check`, but was **not deployed**. Owner chose to hold the Pages deploy; only the Worker is to be deployed after DNS is confirmed.

The Wrangler OAuth token has `connectivity:admin` (tunnels) but **no DNS write scope**, so the DNS switch must be done by the owner in the Cloudflare dashboard (or with a separate API token).

### Production cutover executed (2026-11-17, after owner verification)

Owner confirmed fast playback and performed the DNS change in the Cloudflare dashboard. Steps completed:

1. **DNS cutover verified:** `stream.medxi.site` now resolves only to Cloudflare IPs (`172.67.130.25`, `104.21.7.100`); headers show `Server: cloudflare`. Video `GET /…mp4` with Range returns **206 video/mp4**, and the origin player page (`/watch/...`) returns title `MedXI Stream` with `rawStreamUrl` on `stream.medxi.site` — all served through the tunnel.
2. **Production Worker deployed:** `medxi-data-gate`, version `4d05c8e9-1d30-4734-9cc3-e33ab47ac501`, route `data.medxi.site/*` unchanged. Bindings: RATE_LIMIT_KV, MCQ_BUCKET, `STREAM_ORIGIN_URL=https://stream.medxi.site`. Secrets confirmed present: `ADMIN_SECRET`, `MEDIA_SIGNING_SECRET`, `STREAM_PROXY_SECRET`.
3. **Live Worker API verified** with one temporary Firebase identity (`prod-verify-…`, deleted after the test): both URL formats `marrow_biochem_1` (keeps `.mp4`) and `marrow_opthal_0` (strips `.mp4`) returned `api=200 page=200 title=MedXI Stream video=206 type=video/mp4 leak=false glued=false`.
4. **Browser playback verified twice** on `https://data.medxi.site/play/<token>` (both lecture formats): `readyState 4`, 1280×640, `error: null`, `play()` advanced `currentTime`, source `https://data.medxi.site/watch/<token>` — confirmed again **after** the firewall lock (buffered 24.7 s, smooth).
5. **VPS firewall locked:** backup saved to `/home/ubuntu/iptables-backup-before-tunnel-lock.rules`; inbound ACCEPT rules for TCP 443 and 8080 removed and persisted with `netfilter-persistent save`. Kept: SSH 22, port 80 (certbot renewal), loopback, established/related, ICMP. Direct `http://168.138.115.5:8080/` and `https://168.138.115.5/` now time out (`status=000`); SSH `ssh-ok`; video through tunnel still 206. Origin IP is no longer publicly reachable.

**Pages deploy held** per owner decision — live static bundle remains `index-b3oGmYOJ.js`. The current live client redirects straight to `stream.medxi.site/watch/...`, so video keeps working via the origin player (now hidden behind the tunnel). Full Worker-enforced playback activates only when the Pages deploy is later approved.

`verify-phase0.cjs --live` shows 4 expected failures in this staged state (`public manifest/video vault/legacy R2 host/direct stream are reachable — HTTP 200`) because the Pages-side file removals and full origin lock are deliberately deferred. Curl on `/play` and `/watch` returns `{"error":"Automated clients are not permitted.","code":"BOT_BLOCKED"}` — this is the intended automated-client block; real browsers pass, as verified above.

Rollback references: DNS A record `168.138.115.5`, firewall backup `/home/ubuntu/iptables-backup-before-tunnel-lock.rules`, Worker version `7f5d2a46-4eb3-4ac4-ac39-e2a042a0f772`.

### Pages deploy, cleanup & commit (2026-11-17, final)

Owner approved full rollout after verifying playback speed. Completed:
- **Pages production deploy:** the current dist was copied to a clean temp dir (to avoid Wrangler compiling the repo's Firebase `functions/` folder, which failed with an `EventTarget` esbuild error) and deployed with `wrangler pages deploy dist --project-name medxi --branch main` → deployment `3427c179-809c-454d-9bb6-396b6eda1b7a`, aliased to `https://medxi.site` and `https://www.medxi.site`. Live bundle `index-C-f8xt9p.js`; `AuthContext-646x5eqN.js` confirmed to contain `data.medxi.site`, `api/media/url`, `playerUrl`. Client now resolves every video/note/PDF through the signed gateway instead of direct origin URLs. `videos_catalog.json`/`videos_database.json` in dist contain metadata only (no stream URLs).
- **Acceptance:** initially `verify-phase0.cjs --live` → 27/29, with the two deferred residuals (`legacy R2 host`, `direct stream`). Both were later closed in the owner-approved hardening step below → **29/29 ALL CHECKS PASSED**.
- **Cleanup:** stopped local `wrangler dev` on 8787; stopped the staging Quick Tunnel on the VPS (kept the user's `cleanstream` tunnel and the production named `medxi-stream` tunnel active); deleted staging Worker `medxi-data-gate-staging`; removed `worker-data-gate-staging/` and all temp helper scripts. Production Worker `4d05c8e9…` and tunnel service verified healthy after cleanup.
- **Commit & push:** committed `cab8161dc5828f280521b6bf27c3997bb44d3930` on `security/phase-0` (26 files) and pushed to `origin/security/phase-0`. Production branch is `main`, so the push created only a preview deploy `d5e7915c…` (no aliases) — `medxi.site` production stayed on `3427c179`. No secrets/private media maps/vault files were staged (all gitignored).

### PWA "JavaScript MIME type" error after deploy (fixed 2026-11-17)

Owner reported the installed PWA would not open on their phone: "text/html is not a valid JavaScript MIME type". Diagnosis: the service worker was still `medxi-cache-v8` and had never been version-bumped across the security deploys, so the phone kept a stale cached `index.html` referencing removed bundle hashes. Those requests hit the SPA catch-all (`/* → /index.html 200`) and returned HTML where JS was expected. A fresh browser load was fine (all assets 200 with correct types) — proving it was cache-only.

Fix (commit `714f826`, deployed production `c10277c7`):
- Bumped SW cache `v8 → v9`; the new SW deletes all old caches and auto-reloads open app windows.
- Service worker now detects HTML responses on asset requests, never caches/serves them as JS, and returns a clean 404 internally.
- Added `/assets/* → /asset-404.js 200` rewrite so even a stale HTML requesting a removed bundle gets valid empty JavaScript at the edge (real assets and SPA routes unaffected).
- Verified live: missing asset → `application/javascript`, real asset → JS, SPA route → HTML, `sw.js` → `medxi-cache-v9`.

Note for the owner: the phone needs one reload/close-reopen of the PWA to pick up the new service worker; after that it self-heals.

**Follow-up (commit `6771290`, production `5ab6f290`):** owner then reported "Importing a module script failed". Root cause was the same stale SW, and the empty-JS `/assets/*` rewrite made it worse (a stale page importing a removed chunk got empty JS → failed import). Final fix removes the rewrite **and all service-worker caching**: the SW now only purges legacy caches on activate and has no `fetch` handler, so every request goes to the network/CDN. Cloudflare's `Cache-Control: immutable` on hashed `/assets/*` already caches assets safely, so nothing is lost. Verified fresh load: no console errors, app renders, correct title, SW controlled. This permanently removes the whole class of stale-PWA MIME/import errors.

### Authenticated PWA reproduction attempt (2026-11-17) — no error reproduces

Owner reported the old `text/html is not a valid JavaScript MIME type` error again and asked for the temp-credential/PWA-style check. Performed with evidence-first approach; **no live changes made**.

Evidence gathered:
- Recursive chunk audit of the deployed build (`index-C-f8xt9p.js`): 47 reachable chunks audited against `dist/assets` (48 files) — **0 bad content types, 0 referenced-but-missing chunks**.
- Edge check: `https://medxi.site/` serves current `index-C-f8xt9p.js` with `Cache-Control: public, max-age=0, must-revalidate`; `/sw.js` is `no-cache, no-store` with no `fetch` handler. So the server/edge is not serving stale HTML.
- Created a temporary Firebase Auth user via Admin SDK, exchanged a custom token for an ID token, injected the exact Firebase v12 auth record into browser IndexedDB (`firebaseLocalStorageDb` / store `firebaseLocalStorage` / keyPath `fbase_key` / value wrapper), seeded a minimal Firestore `users/<uid>` doc, and forced PWA mode with `?pwa=true` (`src/utils/pwaAccess.js`). Auth confirmed via `identitytoolkit accounts:lookup` + Firestore listen channels.
- Navigated every authenticated app route in PWA mode — `/`, `/video`, `/notes`, `/qbank`, `/search`, `/saved`, `/profile`, `/quiz-config`, `/quiz`, `/results`, `/admin`, `/lobby/TEST123`, `/explore`, `/news`, `/about`, `/privacy`, `/terms`, `/contact`, 404 route — each rendered real app content (Video Explorer, QBank Explorer, Notes, etc.). **Zero console errors** on every route.
- Exercised the full media flow with the temp token: `/api/media/url` returned 200 with a branded `/play/<token>` URL; opened the player — title `MedXI Stream`, `<video>` present, `readyState 4`, **zero console errors**.
- Checked the older domain seen in browser tabs: `qb.neetpgbot.in` redirects to a different app (`/login.html?reason=signed_out`, title "Sign in — Study OS"); its `/login.js` is valid `text/javascript`. Not the source of the MIME error.

**Conclusion:** the current production build has no missing/mis-typed module anywhere in the authenticated PWA flow. The phone error is local to that device — either a still-active legacy service worker/cache that never updated, or the installed shortcut points at a different origin than `https://medxi.site`. No speculative live changes were made.

**Temp identity cleanup:** Firestore `users/lxojYX7OpucNrTICLuxyXgdRVrZ2` and Firebase Auth user `lxojYX7OpucNrTICLuxyXgdRVrZ2` deleted and verified (`auth/user-not-found`). All diagnostic scripts removed.

**If the phone still errors:** need the exact URL the home-screen icon opens (long-press → App info / shortcut URL), plus browser + Android/iOS version. Device-side reset (only after confirming origin is `medxi.site`): close PWA fully → browser Settings → Site settings → `medxi.site` → Storage → Clear data → reopen once.

### Multiple installed PWAs on the owner's device (2026-11-17)

Owner confirmed they have several PWAs installed; the **old PWA shows the MIME error while the new site opens fine**. This confirms the issue is not in the current build.

Diagnosis of old origins:
- Named aliases already serve the fixed build: `medxi.pages.dev`, `security-phase-0.medxi.pages.dev`, and current production `medxi.site` all serve `index-C-f8xt9p.js` with the no-cache SW.
- Old immutable Pages deployments still serve frozen stale builds. Example: `0079991d.medxi.pages.dev` serves `index-b3oGmYOJ.js` with SW `medxi-cache-v8` — exactly the setup that produces the MIME error. A home-screen PWA installed from such a hash URL can never be repaired by editing `medxi.site`; it is a different origin with its own service worker and cache.
- Fix for these is device-side: uninstall the old PWA and reinstall only from `https://medxi.site`. Deleting old Pages deployments prevents future stale installs but is a separate, opt-in cleanup (not done).

### Localhost test of the staging Worker (2026-11-17)

A fully-local mode of the staging Worker is running at `http://localhost:8787` (started with `npx wrangler dev --config wrangler.json --port 8787` from `D:\NEW\mcq-app\worker-data-gate-staging`). It uses a local `.dev.vars` signing secret and a locally seeded `note_stream_map.json` in R2 (`wrangler r2 object put medquiz-mcq-data/note_stream_map.json --file D:\NEW\mcq-app\deploy\note_stream_map.json --local`). All generated `/play` and `/watch` URLs point to `localhost`, so the browser sees one origin and the `Cross-Origin-Resource-Policy: same-origin` header is satisfied.

To make the dev server reachable from the owner's own browser, it was restarted with `--ip 0.0.0.0` and is available on the LAN IP `http://172.20.10.11:8787` (machine Wi-Fi adapter). The helper defaults to that base and allows override with `MEDXI_LOCAL_BASE`. Windows Firewall inbound rules could not be read without admin; if the LAN IP is blocked, an inbound allow rule for TCP 8787 is needed.

Helper script: `C:\Users\DHRUV\AppData\Local\Temp\opencode\local-player.cjs`. Usage: `node local-player.cjs <mediaId>` (defaults to `prepladder_biochem_0`). It mints a temporary Firebase identity, prints a localhost player link, and **deletes the identity immediately** in a `finally` block. Example IDs: `marrow_opthal_0`, `marrow_opthal_1`, `prepladder_biochem_0/1/2`, `sketchy_10/11/12`.

Verified with `prepladder_biochem_0`: title `MedXI Stream`, `<video src>` = `http://localhost:8787/watch/<token>`, `readyState 4`, 1280×720, `error: null`, `play()` advanced `currentTime` 0 → 2.44 s in 2.5 s with ~4.7 s buffered.

Note: an earlier `wrangler dev --remote` attempt produced remote workers.dev URLs inside the player HTML, which the browser blocked as cross-origin (`ERR_BLOCKED_BY_RESPONSE.NotSameOrigin`). Full local mode avoids this.

### Isolated Worker + Cloudflare Tunnel staging test (2026-11-17)

Goal: prove Worker + Tunnel works **without touching live traffic**. Nothing on `medxi.site`, `data.medxi.site`, or `stream.medxi.site` was changed.

**Setup (all isolated):**
- On the VPS, started `cloudflared tunnel --no-tls-verify --url https://127.0.0.1:443`. This is an outbound-only **Quick Tunnel**, so no Cloudflare DNS record, named tunnel, or account config was created. It produced `https://pike-markets-fda-beings.trycloudflare.com`, which resolves only to Cloudflare IPs (`104.16.230.132`, `104.16.231.132`) — the VPS IP is not exposed.
- Created a separate Worker `medxi-data-gate-staging` at `https://medxi-data-gate-staging.medilamart.workers.dev`. It has **no route** (workers.dev only), **no KV binding** (rate-limit counters are isolated/no-op), R2 bucket bound read-only for the media map, a **separate `MEDIA_SIGNING_SECRET`**, and `STREAM_ORIGIN_URL` set to the tunnel URL so it never fetches `stream.medxi.site`.
- Added isolated `STREAM_ORIGIN_URL` support only to the staging copy at `D:\NEW\mcq-app\worker-data-gate-staging\src\index.js`. The production Worker source is untouched.
- Minted one temporary Firebase identity (`phase0-staging-…`), used it to obtain tokens, then **deleted and verified removal**.

**Results:**
- `/api/media/url` → 200 with `playerUrl`; token TTL 4 h for video.
- `/play/<token>` → 200, `MedXI Stream` title, source points only to the staging `/watch/<token>` URL; no `stream.medxi.site`, `trycloudflare.com`, VPS IP, or `nginx` string in the HTML.
- Both origin URL variants pass: `marrow_biochem_1` (keeps `.mp4`) and `marrow_opthal_0` (strips `.mp4`) → no token/extension gluing, no origin leak, 206 video/mp4 with correct Content-Range. The locally-fixed `.mp4` rewrite is confirmed working through the tunnel.
- Browser playback: `readyState 4`, 1280×640, `error: null`, `play()` advanced `currentTime` 6.1 → 8.6 s over 3 s with ~46 s buffered — smooth, not a black screen.
- `/watch` response headers expose only Cloudflare (`server: cloudflare`, `cf-ray`), no origin host or redirect.

**Latency (warm, 5 runs, first 256 KB):**
| Path | Avg TTFB |
|---|---|
| Direct origin (`stream.medxi.site`) | ~300 ms |
| Quick Tunnel alone | ~970 ms |
| Staging Worker + Tunnel | ~1,170 ms |

So Worker + Tunnel adds roughly **+0.6–0.9 s to first byte** versus the current direct origin. First-frame playback still started in well under a second after the page loaded, and buffering caught up quickly. This is the concrete speed trade-off for hiding the VPS; no 1-minute stall.

**Still pending:** owner verification of the staging player URL. Cleanup (stopping the tunnel and deleting the staging Worker) was **not** done yet — ask before removing, since the URL is useful for verification. No production deploy, commit, or push.

### Player black-screen bug found in owner testing (fixed locally, not deployed)

Owner reported that some `/play/<token>` pages were a **black screen** while others played fine. Root cause: the origin player page is inconsistent — some lectures keep `.mp4` in their `<source>` / `rawStreamUrl` links (e.g. `marrow_biochem_1`), others strip it (e.g. `marrow_opthal_0`). The rewrite used `noExt` (path with extension stripped), so for the `.mp4` lectures it produced `https://data.medxi.site/watch/<TOKEN>.mp4?...` — the token had `.mp4` glued on, failed validation, and the video never loaded.

**Fix (local only, Worker not redeployed):** read the real media path from the page's own `const rawStreamUrl = "..."`, then rewrite every variant (with and without extension, longest first) so no extension can be left attached to the token. Verified locally against both lecture types → both produce clean `.../watch/TOKEN?disposition=inline` URLs, no origin URL leak. Worker passes `node --check`.

### Live deployment reverted to original (2026-11-17, owner request)

Owner reported the security changes were frustrating students in production and asked that live be restored to the pre-security state while all security work is finished and verified locally **before any push**.

Revert executed and verified:
- **Static site:** rebuilt from pristine `main` (`index-b3oGmYOJ.js`) and redeployed to Cloudflare Pages `medxi` → `https://0079991d.medxi.pages.dev`. Live `medxi.site` confirmed serving `index-b3oGmYOJ.js`.
- **Worker:** original `main` code redeployed to `data.medxi.site/*` → version `7f5d2a46-4eb3-4ac4-ac39-e2a042a0f772`.
- **R2:** `wrangler r2 bucket dev-url enable medquiz-mcq-data` → public r2.dev host returns **200** again.
- **Origin `stream.medxi.site`:** original nginx config restored from `stream.medxi.site.bak-20261117-100635`, nginx reload OK; iptables restored from `iptables-backup-20261117-100635.rules` (public 8080 ACCEPT back). Direct HTTPS video path returns **200 video/mp4** with no gateway header; direct `/watch/...` returns **200 text/html**.
- **Browser verification:** original "MedXI Stream" player page opened from live origin; `<video>` `readyState 4`, 1280×640, `error: null`, `play()` OK, `currentTime 0 → 0.59` — original instant playback restored.

All security changes remain **uncommitted on `security/phase-0`** (saved via git stash and restored intact after the revert). Nothing was pushed. Do **not** redeploy security changes to production until the owner has verified them.

### Known deviations / follow-ups

- `AdminPanel-*.js` is still in the bundle behind a client-side `isAdmin` guard; removing it from the public build is deferred so production content management keeps working. Address in Phase 1/5 with a server-gated admin surface.
- Question images still rely on same-origin image requests (`Sec-Fetch-Site`) because `<img>` cannot send a bearer token; move to signed image URLs in Phase 4.
- Hidden `webx.afrahtafreeh.site` links remain in `notesData.js` by owner instruction; they are scheduled for removal from the site.
- The earlier rollback is **superseded**: Phase 0 is live again (Pages `5ab6f290`, Worker `a66e650b-…`) and the branch `security/phase-0` is pushed to `f2bd4b6`. Old frozen Pages deployments are preserved, not deleted. `package.json` / `package-lock.json` contain pre-existing `puppeteer-core` changes that were left untouched.

### Cloudflare free-tier capacity (Worker cost / limits)

Confirmed from Cloudflare's current pricing/limits docs (2026-10/11): Workers Free = **$0**, **100,000 requests/day**, **10 ms CPU/request**, **100,000 KV reads/day**, **1,000 KV writes/day**, 50 subrequests/request. **No charge for data transfer/egress or bandwidth** — proxying video bytes through the Worker costs nothing per GB. Workers Paid = **$5/month per account**, 10M requests + 30M CPU-ms included, then $0.30/M requests and $0.02/M CPU-ms.

Practical capacity per video view (each lecture may issue many ranged `/watch/<token>` requests, one per video chunk):
- Roughly **20–80 Worker requests per full lecture** (page + API + ranged chunks), each also a KV read.
- At 100,000 requests/day → on the order of **~1,200–5,000 lecture-views/day** depending on lecture length/seeking, shared across all users.
- KV writes are the tighter free-tier limit (**1,000/day**). The original rate limiter wrote a counter on **every** burst-check request, which is what drove the dashboard to ~90% and triggered the daily-limit alert. The throttled fix below cuts those writes by ~10x.
- A single user watching a handful of lectures/day is nowhere near the cap. For a student body with heavy daily use, the $5/month Paid plan removes the daily request cap and is inexpensive.
- Note: R2 egress is also free; the origin VPS (Oracle) bandwidth is unchanged — the Worker validates/streams but Cloudflare adds no data charge.

KV write pressure became real only after the full Worker-enforced rollout; the `once per 5-min window` estimate above was too optimistic.
- Firebase Hosting deploy also succeeded at `https://medquiz-c05e9.web.app` but that is not the live custom domain; `medxi.site` is the Cloudflare Pages project `medxi`.

### KV write-quota fix deployed (2026-11-17)

Owner reported `RATE_LIMIT_KV` had reached ~90% of the free-plan daily write allowance. Diagnosis: `vidrate:*` and `burst:*` counters were written with `ctx.waitUntil(safeKvPut(...))` on **every** `/api/media/url` and MCQ fetch; with 1,000 writes/day that alert is inevitable. `safeKvPut` already prevented user-visible outages, but the counters became unreliable once quota was exhausted.

Fix in `D:\NEW\mcq-app\worker-data-gate\src\index.js`:
- Added `nextRateCount(env, ctx, key, ttlSeconds)` with per-isolate `localRateCounters` and `KV_WRITE_EVERY = 10`: KV is written on the first hit for a key and then only every 10th hit. A 30-second `KV_RESYNC_MS` adopts the highest count seen by other isolates, so the ban threshold remains effective across isolates. Reads stay cheap (100k/day allowance); permanent-ban writes are unchanged.
- Both call sites (`vidrate:*` for video URL resolution and `burst:*` for MCQ fetches) now use the throttled counter. Threshold checks were preserved as `> LIMIT` so the ban still fires on the 21st video / 26th MCQ request in a 5-minute window.

Checks and rollout:
- `node --check` and `npx wrangler deploy --dry-run` passed. Deployed `medxi-data-gate` to `data.medxi.site/*` → version `a66e650b-d817-4efe-9717-00680369de63`; bindings unchanged (`RATE_LIMIT_KV`, `MCQ_BUCKET`, `STREAM_ORIGIN_URL=https://stream.medxi.site`).
- Authenticated live test with one temporary Firebase identity (deleted and verified `auth/user-not-found` in the same run): unauthenticated `/api/manifest` → 401; authenticated manifest → 200; `/api/media/url` → 200 with only `https://data.medxi.site/watch/<token>` and `/play/<token>` (no `stream.medxi.site` or raw `.mp4`); `/play/<token>` → 200 branded page with no origin host/path leak; `/watch/<token>` with Range → 206 `video/mp4`, 1,024 bytes, no redirect to the origin.
- Throttle evidence: 12 rapid `/api/media/url` calls all returned 200, but the remote KV counter read back `10` — i.e. roughly 2 writes instead of 12. The temporary `vidrate:*` key was deleted afterwards.
- Committed `f2bd4b6` (`perf(worker): throttle KV burst-counter writes to stop daily quota alerts`) and pushed to `origin/security/phase-0`.

No deployments or old PWAs were deleted.

### Friendly migration notice for old installed PWAs (2026-11-17)

Owner confirmed the old PWA's home-screen icon opens `https://medxi.site` (so it is an origin we control), and asked for a message instead of deleting deployments. The stale cached HTML still requests removed bundles — specifically `/assets/index-b3oGmYOJ.js` (entry) and `/assets/AuthContext-BsNT2zbs.js` (modulepreload chunk). Cloudflare's edge still serves the old `index-b3oGmYOJ.js` from its 1-year `immutable` cache, so a Pages `_redirects` rewrite alone could not win without a zone cache purge (the Wrangler OAuth token only has `zone (read)`).

Implemented a two-layer, non-destructive fallback:
- `public/legacy-app-notice.js` renders a branded "Time to update MedXI" card with `https://medxi.site` and Android/iOS reinstall steps. Exact `_redirects` rules map the two dead bundle paths to it with status 200 for browsers that reach the origin.
- `public/sw.js` now has a **narrow** fetch handler for those two exact paths only. It fetches `/legacy-app-notice.js` with `cache: 'no-store'` and falls back to an inline notice if that fails. This is not app caching — every other request still has no fetch handler and goes straight to the network/CDN, preserving the decision to remove service-worker caching.

Verified live:
- New Pages deployment `b22af707` is aliased to `medxi.site` / `www.medxi.site`; `/sw.js` is `no-cache, no-store, must-revalidate` and contains the exact legacy-path handler.
- Browser simulation: with the new SW controlling `https://medxi.site`, injecting a module script for `/assets/index-b3oGmYOJ.js` returned 200, rendered the notice (`title = "MedXI — App update required"`, link to `https://medxi.site`), and produced **zero console errors**.
- Fresh load of the current app still uses `index-C-f8xt9p.js` with the new SW controlling and **zero console errors** — no regression.
- Committed `5b94fb9` (`fix(pwa): show migration notice for cached legacy bundles`) and pushed to `origin/security/phase-0`.

Old frozen `*.medxi.pages.dev` hash deployments were left intact. If any old PWA turns out to point at one of those instead of `medxi.site`, a notice is not technically possible without changing that origin; device-side uninstall/reinstall remains the only option.

### Final two residuals closed — full acceptance 29/29 (2026-11-17)

Owner approved finishing the two accepted residuals and moving on.

1. **Legacy R2 host:** `npx wrangler r2 bucket dev-url disable medquiz-mcq-data --force`. The public `pub-391fa788e23f4e339dc766ca9b180526.r2.dev` host now returns **401** for `qbank_manifest.json` (was 200).
2. **Direct stream access:** hardened at two layers because Cloudflare's CDN was serving cached stream files before the origin could reject them:
   - **Origin:** nginx now includes `/etc/nginx/snippets/medxi-gateway.conf`, which returns 403 unless `X-Medxi-Gateway` equals the shared secret. ACME challenge paths are exempt. Live config copied to `deploy/nginx/stream.medxi.site.conf`; backup `/etc/nginx/stream.medxi.site.bak-gateway-lock`; `nginx -t` passed and nginx reloaded.
   - **Edge:** new Worker `medxi-stream-guard` on route `stream.medxi.site/*` (version `c06c0caa-a450-42f2-baab-91f02440540c`) returns 403 for header-less requests before cache lookup, and passes gateway subrequests through. This was necessary because the old public stream URL was a Cloudflare cache HIT with `max-age=31536000` and the Wrangler OAuth token has no zone/cache-purge scope.
   - A fresh secret was generated locally (value never printed or committed) and set on both `medxi-data-gate` (new version `36432580-43c5-4577-8109-dc9118a5128a`) and `medxi-stream-guard`.

Verification:
- Direct `https://stream.medxi.site/AgADMS7038/Anatomy%20Marrow%20Ed8.pdf` → **403**; same URL with the gateway header + Range → **206**.
- Authenticated playback re-tested with one temporary Firebase identity (deleted and verified): `/play/<token>` → 200 branded player with no origin leak; video `/watch/<token>` → 206 `video/mp4`, 1,024 bytes; PDF `/watch/<token>` → 206 `application/pdf`, 1,024 bytes. No raw origin/R2 URLs anywhere. (An initial stale map id `6798` returned 404 from origin and was replaced with `marrow_ortho_29`; not a regression.)
- `node scripts/verify-phase0.cjs --live` → **29/29 PASS / ALL CHECKS PASSED**.
- Existing legitimate KV ban records were left untouched.
- Committed `ef38ad7` (`feat(security): block direct stream access at edge and origin`) and pushed to `origin/security/phase-0`.

Note: the KV daily write allowance was already nearly exhausted during this hardening, so `safeKvPut` fail-safes kept requests working while counter writes may be skipped until the quota resets at UTC midnight. The 10x write throttle remains deployed for subsequent days.

### Reported UI issues after hardening — diagnosed and fixed (2026-11-17)

Owner reported: old PWA showed an error while the new one worked; video pages opened but videos did not load in the old PWA; and "Open Note" did not work in either. Two separate root causes, both evidence-backed:

1. **"Open Note" in the current app — popup blocker.** `openLinkDirect()` awaited `resolveMediaUrl()` and only then called `window.open(url)`. Calling `window.open` after an `await` loses the browser's user-activation gesture, so popup blockers (especially Safari / installed PWAs) silently dropped the new tab. Verified the backend was fine first: a temporary identity resolved the real note IDs used by the UI (`AgADMS7038`, `AgADRi7057`) → HTTP 200 with `/watch/<signed>` URLs, no origin leak; identity deleted. Fix: `openResolvedUrlInNewTab()` opens a blank tab **synchronously** inside the click handler and navigates it after the gateway responds, with a same-tab fallback if the popup is blocked. Applied to both `openLinkDirect` and the "don't show notice again" path of `triggerDownload`.
2. **Old PWA video/notes — blocked by design.** The frozen old bundles (`Home-BXcf92of.js`, `Notes-3c6h5Zkk.js`) contain hard-coded `stream.medxi.site/watch/...` links. These are exactly the direct links the edge guard now blocks, so they cannot work without undoing the security rollout. Rather than leave a bare 403, `medxi-stream-guard` now redirects header-less **browser navigations** (`Sec-Fetch-Mode: navigate` / `Sec-Fetch-Dest: document`) to a new standalone page, `public/app-update.html`, with the site URL and reinstall steps. Subresource/media requests and gateway traffic still use the normal 403/pass-through logic, so gating is unchanged.

Verification after the fixes:
- `https://stream.medxi.site/...` with no headers → **403**; with navigation headers → **302** to `https://medxi.site/app-update.html` → **200** with the update notice.
- `node scripts/verify-phase0.cjs --live` → **29/29 ALL CHECKS PASSED**.
- Authenticated playback with a temporary identity (deleted and verified): video `/watch` → 206 `video/mp4`, PDF `/watch` → 206 `application/pdf`, no raw URLs.
- Production Pages deployment `6a181507`, live bundle `index-BJb27ilc.js`; stream guard version `aa957087-512e-479e-8c3c-e9b75a38a37d`.
- Committed `8891bc3` (`fix(ui): open notes reliably and guide stale PWAs to update`) and pushed to `origin/security/phase-0`.

No old deployments were deleted. Old PWA users are shown the update/reinstall message rather than an error.

### Note viewer page restored through the gateway (2026-11-17)

Owner clarified that the old flow had a **page on `stream.medxi.site` showing the note with a Download PDF button** (the document equivalent of the level-4 video player page), and that opening the raw PDF directly skipped that step. The origin still serves this page at `/watch/<id>/<file>`; it was only unreachable because direct origin access is now blocked.

Implemented in `medxi-data-gate` (version `c4f63c31-69ac-452b-b3bd-599bb464eb02`):
- `/api/media/url` now returns `playerUrl` for **all** media: `/play/<signed>` for videos and `/note/<signed>` for documents. `url` remains the direct signed `/watch/<signed>` proxy for in-app downloads.
- `/note/<signed>` reuses the branded-page handler: it validates the HMAC token, fetches the origin's "MedXI Notes" page with the gateway secret, and rewrites every origin URL (download button, "open inline" link and `rawStreamUrl`) to the signed gateway URL. No raw `stream.medxi.site` URL reaches the browser.
- `/note/` was added to the self-authorising playback paths so a plain browser navigation works without a bearer header.

Client change: none needed — `resolveMediaUrl()` already preferred `playerUrl`, so clicking **Open Note** now lands on the branded note page (title + Download PDF button) instead of the raw PDF.

Verification with a temporary identity (deleted and verified): `/note/<signed>` → 200 with "MedXI Notes", "Download PDF File" and only signed gateway URLs; the signed PDF → 206 `application/pdf`; video `/play/<signed>` still → 200 with signed video → 206 `video/mp4`. Committed `ffce846`; pushed to `origin/security/phase-0`.

---

## 7. Implementation log — Phase 1 (2026-11-17)

**Repository:** `D:\NEW\mcq-app` (GitHub `medilamart-cpu/medxi`), branch `security/phase-0`.
**Decision:** privileged account writes go through Firebase Cloud Functions with the Admin SDK. No new Worker service-account key, no new KV writes. Entitlement state that the Worker needs is read with the **student's own verified Firebase ID token** against the Firestore REST API (probe confirmed an authorized read returns the doc or a 404 for "no doc yet"), so no secret is added to the Worker.

### What was built and shipped

| Piece | Detail |
|---|---|
| `functions/account.js` (new) | Five callable functions: `syncAccount` (idempotent create/repair, applies admin-bot `pre_authorized_users` grants once, signup invite linking, legacy owner/friend referral credit), `adminSetUser` (admin-only field grant), `unlockContent` (validates coin threshold, writes `unlockedTopics`), `qualifyReferral` (awards referrer once on first quiz), `redeemReferral` (existing-account invite redemption). Exported from `functions/index.js`; `proxy` kept. Deployed to `us-central1`. |
| Entitlement semantics preserved | Coins are **not spent** — holding 10 credits unlocks Notes, holding 200 unlocks Edition 8; `isAdmin` / `plan==='premium'` / `isPremium` / explicit `unlockedTopics` also qualify. No immediate signup referrer credit — the referrer is credited only when the referee qualifies. All verified by test. |
| Client migration | `AuthContext` now calls `serverSyncAccount()` instead of browser-writing `plan`/`coins`/`unlockedTopics`/`isAdmin`; profile edits are whitelisted to safe fields. `referralManager` wrappers call the server functions (`serverAccount.js`). Admin Panel grants call `serverAdminSetUser`. `getFunctions()` added to `src/firebase/config.js`. |
| Worker entitlement gate (`medxi-data-gate`) | On every `/api/media/url`, reads `users/{uid}` with the verified ID token (30 s isolate-memory cache; no KV writes), blocks `paused` accounts (403 `ACCOUNT_PAUSED`), and checks entitlement before issuing any signed link. Notes require `medxi_notes_library`; Edition 8 videos are identified via `entitlement_map.json` (298 `marrow_*` IDs, all confirmed present in the 7,183-key `video_stream_map.json`). Free videos need no entitlement. |
| `entitlement_map.json` | Stored in the existing private bucket `medquiz-mcq-data` (no new storage, no KV). |
| Locked Firestore rules | Browser may read profiles and edit only its own safe profile fields; it cannot create user docs, write privileged fields, or touch the `referrals` collection. Server functions bypass rules via Admin SDK. Old ruleset retained for instant rollback. |

### Deployment IDs / rollback

- Cloud Functions deployed: `syncAccount`, `adminSetUser`, `unlockContent`, `qualifyReferral`, `redeemReferral`, `proxy` (`us-central1`, project `medquiz-c05e9`).
- Active locked Firestore ruleset: **`ce1309f7-34d5-49bf-a000-1c298546e72f`**.
- Rollback Firestore ruleset (previous, permissive): **`dff88fd0-616f-4d3d-95cf-0fe32203d565`**.
- Worker `medxi-data-gate` entitlement version: **`c2605e11-8635-46d5-8092-c3a39e5b4e37`**.
- Pages deployment: **`7b20c191`** (aliases `medxi.site` / `www.medxi.site`), live bundle `index-J4Sl0Zrs.js`.
- Edge guard `medxi-stream-guard`: `aa957087-512e-479e-8c3c-e9b75a38a37d` (unchanged).

### Verification results (all temporary identities deleted after every run)

- Server-write paths: **20/20 PASS** — account create/repair, admin grants, note/Ed8 unlock thresholds, coins not spent, referral redeem + qualification, idempotency, permission denial; re-run **after** rules lock with identical results.
- Legacy-account repair / admin-bot grant: **8/8 PASS** — plan upgraded, bonus coins applied once, unlock applied, streak preserved, referral code repaired.
- Live entitlement gate: **17/17 PASS** — free user (free video allowed, notes/Ed8 blocked), 10-credit (notes allowed, Ed8 blocked), explicit unlock, 200-credit (Ed8 allowed), premium, admin, paused (all media blocked), plus branded note page + signed PDF 206 and video player + signed video. Re-run after rules lock: identical.
- Locked rules: **11/11 PASS** — profile edit allowed; browser writes to `plan`, `coins`, `unlockedTopics`, `isAdmin`, `paused` and privileged creates all → 403; server callables still work.
- `node scripts/verify-phase0.cjs --live`: **29/29 PASS / ALL CHECKS PASSED**.

No backdoor or test account remains; no new KV writes were added.

### Known caveat — signed video-token revocation lag

Playback links are self-authorising HMAC tokens with a **4-hour TTL** (a full lecture must not expire mid-play). The Worker also caches entitlements for 30 s in isolate memory. Consequence: if an account is paused or an entitlement is removed **after** a video link has been issued, the already-issued `/watch` token keeps working until it expires (up to 4 hours), and other isolates can take up to ~30 s to reflect a change. Making revocation instant would require the deferred one-time-link / shared-state work (strict single-use links, Durable Object) — it is intentionally not built now to avoid new KV writes. Note links expire in 5 minutes, so they re-check far sooner. Newly issued links always reflect current entitlements.

---

## 8. Implementation log — Phase 2 (monitor-only device visibility, 2026-11-18)

**Repository:** `D:\NEW\mcq-app` (GitHub `medilamart-cpu/medxi`), branch `security/phase-0`.
**Decision:** owner chose **monitor-only** device binding after being shown that the plan's strict options (2-device cap, per-request validation, auto-pause) are the exact ones that previously locked out students. MedXI uses Firebase/Google sign-in, not qb's login-code system, so hard device binding adds friction without a matching benefit. No device limit, no enforcement, no access change.

### What changed

| File | Change |
|---|---|
| `src/utils/device.js` (new) | `getStoredDeviceId()` / `storeDeviceId()` (stable `medxi_device_id` in localStorage) and `collectDeviceInfo()` returning the stored ID plus harmless browser details (UA, platform, language, screen). No fingerprinting. |
| `src/utils/serverAccount.js` | `serverSyncAccount(refCode, device)` now sends `{ refCode, device }` to `syncAccount`. |
| `src/context/AuthContext.jsx` | On auth, collects device info, passes it to `serverSyncAccount`, and stores the returned `deviceId`. Failure to record a device can never block sign-in. |
| `functions/account.js` | `syncAccount` generates a server-side `deviceId` (`crypto.randomUUID()`) when absent, sanitises browser details, upserts a capped 10-entry `devices` history on the user doc (Admin SDK writes only), and returns `deviceId`. |
| `worker-data-gate/src/index.js` | New `GET /api/me` returns the signed-in account summary + `devices` / `deviceCount` using the existing verified-ID-token Firestore read. |
| `telegram-bot/bot.cjs` (gitignored, VPS only) | Fail-closed `isAuthorized()` (from the earlier fix) plus device visibility: "Devices Seen" count in profiles and a `/devices <email>` detail command. |
| `firestore.rules` | Unchanged — already blocks browser writes to `devices` (profile whitelist) and reads remain allowed. |

### Bug found and fixed during verification

Initial deploy used `FieldValue.serverTimestamp()` for `firstSeenAt` / `lastSeenAt` inside the `devices` array. Firestore rejects sentinels inside arrays: `FieldValue.serverTimestamp() cannot be used inside of an array`. Fixed by using plain `Date` objects, redeployed Functions, and re-ran verification.

### Deployment IDs / rollback

- Cloud Functions redeployed (`syncAccount` + 5 others), `us-central1`, project `medquiz-c05e9`.
- Worker `medxi-data-gate` version: **`a3e2a15f-f21a-40af-b702-6db7fd233926`** (route `data.medxi.site/*`).
- Pages deployment: live bundle **`index-L3904iSx.js`** (`AuthContext-ChJMX9X5.js`), aliases `medxi.site` / `www.medxi.site`.
- Bot: `/home/ubuntu/medxi-bot/bot.cjs` on VPS `168.138.115.5` (service `medxi-bot` active); backup `bot.cjs.bak-before-phase2`.
- Firestore rules unchanged: active `ce1309f7-34d5-49bf-a000-1c298546e72f`, rollback `dff88fd0-616f-4d3d-95cf-0fe32203d565`.

### Verification results

- Phase 2 device flow: **16/16 PASS** — server-generated ID, one device on first login, Edge detected, idempotent repeat, multi-device accumulation, 10-device cap with unique IDs, `/api/me` reflects account + 10 devices, 401 without token.
- `node scripts/verify-phase0.cjs --live`: **29/29 PASS / ALL CHECKS PASSED** (no regressions).
- Live bundle confirmed `index-L3904iSx.js`; legacy notice `legacy-app-notice.js` still served 200.
- All temporary Firebase identities deleted and verified: full user list scanned (1,468 users), **0** `phase2verify-*` identities remaining. Temporary scripts removed.

---

## 9. Implementation log — Phase 3 (monitor-only behaviour observation, 2026-11-18)

**Repository:** `D:\NEW\mcq-app` (GitHub `medilamart-cpu/medxi`), branch `security/phase-0`.
**Decision:** owner asked to proceed with the next phase after Phase 2. Phase 3's original design (auto-pause, Turnstile step-up, rate cuts, canary bans) carries the same lockout risk that drove the Phase 2 monitor-only decision, and needs shared state that the cost constraints rule out. Shipped the observation/logging slice only; no student-facing behaviour changed.

### What changed

| File | Change |
|---|---|
| `worker-data-gate/src/index.js` | `observeRequest()` scorer in isolate memory (10-min window, 300 events/account, 2,000-account cap, FNV-1a hashed paths); hooked into `/api/manifest`, `/api/media/url`, and content-file fetches. `GET /admin/behaviour` (admin-secret protected) returns flags + `monitorOnly`/`enforcementActive`. Structured `[BEHAVIOUR:*]` console logs for Cloudflare alerting. No KV/Firestore writes. |
| `telegram-bot/bot.cjs` (gitignored, VPS only) | `/behaviour` (and `/behavior`) command reads `/admin/behaviour` using `MEDXI_ADMIN_SECRET` from the bot's `.env`; formats score, decision, signals, hashed path, IP/country. Added to `/help`. |

### Deployment IDs / rollback

- Worker `medxi-data-gate` version: **`924eb772-758c-4ebd-9edf-7e252acf18e0`** (route `data.medxi.site/*` unchanged).
- Bot: `/home/ubuntu/medxi-bot/bot.cjs` on VPS `168.138.115.5`; service `medxi-bot` active. Backups `bot.cjs.bak-before-phase3` and `.env.bak-before-phase3`.
- `MEDXI_ADMIN_SECRET` added to the bot's `.env` (reuses the Worker's existing `ADMIN_SECRET`; no new credential). Confirmed exactly one key.
- No Pages or Functions redeploy needed (no client/server-function changes this phase).
- Rollback: remove the three `observeRequest()` calls and the `/admin/behaviour` block, redeploy Worker. All state is in-memory and disappears on redeploy.

### Verification results

- Phase 3 scorer: **9/9 PASS** — manifest 200, 15 evenly-spaced content requests all 200 (no pause), flag recorded (`medium`, score 3, `high_rate` + `sequential_paths`), `monitorOnly: true`, `enforcementActive: false`, 8-hex-char path hash, `/admin/behaviour` 401 without secret.
- Bot `/behaviour` command confirmed working end-to-end against the live gateway (rendered the monitor-only summary).
- `node scripts/verify-phase0.cjs --live`: **29/29 PASS / ALL CHECKS PASSED** (no regressions).
- All temporary identities deleted: full user list scanned (1,469 users), **0** `phase3verify-*` / `phase3probe-*` identities remaining. Temporary verification script removed.

### Caveat — per-isolate state

Behaviour flags live in each Worker isolate's memory, so the admin view is a partial sample and flags fade on redeploy or isolate recycle. Making it exact would need shared state (Durable Object / Firestore writes), which is deferred for cost. Structured logs remain the primary alert channel.

---

## 10. Implementation log — Phase 4 (shared-state enforcement, 2026-11-18)

**Repository:** `D:\NEW\mcq-app` (GitHub `medilamart-cpu/medxi`), branch `security/phase-0`.
**Decision:** the owner asked for all six deferred enforcement items, using a free alternative to Cloudflare's paid state products. Selected **Upstash Redis free tier** (500K commands/month, 250 MB, HTTPS REST callable from a Worker, no card). Firestore was the runner-up (20K writes/day). Every shared-state read/write **fails open**: if Redis is unavailable or its quota is exhausted, enforcement is skipped and students keep access. No new Firebase service-account key, no gateway KV writes.

### Master switches (deliberately conservative)

- `mode = shadow` by default — decisions are logged, nothing is enforced.
- Feature switches: `autoPause=true`, `turnstile=true`, `rateCuts=true`, `canaries=true`, `checkpointTamper=true`, **`progressiveUnlock=false`** (it hides 80% of the catalogue on day one; enable only with owner approval).
- Turnstile code is present but **dormant** until Cloudflare dashboard widget keys exist. No lockout without keys.
- Flip with `/admin/enforcement` (master) or `/admin/feature` (one automation), from the admin bot or Worker.

### What changed

| File | Change |
|---|---|
| `worker-data-gate/src/index.js` | Shared enforcement state in free Redis: atomic `EVAL` guard (pause + refresh-token revocation + score + challenge state in one command), auto-pause, session revocation, score-based rate cuts, manifest canaries (`syncIndex`), progressive unlock (2 providers per 40 trusted interactions), trusted UI-event endpoint, authoritative checkpoint endpoint with >25-index jump detection (suppressed when trusted UI events exist), `TURNSTILE_REQUIRED` step-up + `/api/challenge`, and admin endpoints `/admin/enforcement`, `/admin/feature`, `/admin/state`, `/admin/paused`, `/admin/unpause`, `/admin/unlock`. Fail-open everywhere; mode cached 60s to protect the free quota. |
| `functions/enforce.js` (new) | `adminEnforce` internal hook: mirrors pause into Firestore (`paused`, `pauseReason`, `pausedAt`) and calls `auth.revokeRefreshTokens(uid)`. Protected by the existing `ADMIN_SECRET` (as `MEDXI_ADMIN_SECRET`); no new credential. Also handles `unpause` and `alert`. |
| `functions/index.js` | Exports `adminEnforce`. |
| `src/firebase/config.js` | `reportUiEvent()` (only genuine `isTrusted` interactions, throttled), `getCheckpoint()` / `reportCheckpoint()`, and `gatewayFetch()` handling of `TURNSTILE_REQUIRED` (dynamically loads the Turnstile script, shows a widget, POSTs `/api/challenge`, retries once). |
| `src/pages/QBank.jsx` | Reports trusted provider/collection/subject/sort interactions. |
| `src/pages/QuizScreen.jsx` | Reports trusted answer selections and checkpoint position per question. |
| `telegram-bot/bot.cjs` (gitignored, VPS only) | `/enforcement`, `/enforce active|shadow`, `/feature <name> on|off`, `/paused`, `/unpause <uid>`, `/enfstate <uid>`; all added to `/help`. |
| `scripts/verify-phase4.cjs` (kept as regression suite) | 20 checks covering canary injection, progressive unlock, trusted-event unlock, checkpoint tamper, canary-triggered auto-pause, admin unpause, Turnstile dormancy and shared-state inspection. Restores `shadow` + `progressiveUnlock=off` and deletes its temp identity in `finally`. |

### Live leak found and fixed during rollout

`node scripts/verify-phase0.cjs --live` initially failed two checks: `https://medxi.site/qbank_manifest.json` and `/video_vault.enc` returned **HTTP 200 with real content** on the old production Pages deployment (confirmed by Content-Type `application/json` / `application/octet-stream`, not the SPA HTML fallback). The freshly built `dist/` excludes both files and ships `_redirects` rules; a new production Pages deployment now returns **302** for both. Old deployments were not deleted, so legacy PWAs keep their reinstall/update notice.

### Deployment IDs / rollback

- Worker `medxi-data-gate` version: **`1b884c94-09b2-4cd5-bfc7-57ec8ec979c9`** (route `data.medxi.site/*` unchanged). Earlier Phase 4 versions `63c7148d-…`, `856cecc3-…`, `46059fc2-…` were superseded. The final change shortened the mode cache from 60s to 15s so an emergency flip back to `shadow` propagates quickly.
- Cloud Function `adminEnforce` (us-central1): `https://us-central1-medquiz-c05e9.cloudfunctions.net/adminEnforce`.
- Worker secrets: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `ENFORCE_FUNCTION_URL`; Functions `.env`: `MEDXI_ADMIN_SECRET` (gitignored, never printed).
- Pages production deployment: **`251e8b2c`** (branch `main`), preview `e4abece7` (branch `security-phase-0`); live bundle **`index-DbQsXylW.js`**, shared chunk **`AuthContext-Dr3d9uM9.js`**. Old deployments retained.
- Bot: `/home/ubuntu/medxi-bot/bot.cjs` on VPS `168.138.115.5`; service `medxi-bot` active. Backup `bot.cjs.bak-before-phase4`.
- Rollback: set `/admin/enforcement` to `shadow` (instant, no deploy needed), or `/admin/feature <name> off` for one automation. Full rollback: redeploy the previous Worker version and remove the `adminEnforce` export. Redis state can be cleared with `admin/unpause` + `admin/unlock`.

### Verification results

- Phase 4 suite: **20/20 PASS** — canary injected into manifest, unlock batch 1 → 2 after 40 trusted events, checkpoint jump raised shared score, canary hit returned `ACCOUNT_PAUSED` and appeared in `/admin/paused`, further access blocked with 403, `/admin/unpause` restored access, Turnstile dormant, shared-state inspection correct. Mode restored to `shadow` and `progressiveUnlock=off` after the run.
- `node scripts/verify-phase0.cjs --live`: **ALL CHECKS PASSED** — including the two previously failing public-file checks (now 302) and all bundle-leak checks.
- Production bundle `index-DbQsXylW.js` live; shared chunk contains `TURNSTILE_REQUIRED` / `/api/ui-event` / `/api/checkpoint` / `/api/challenge`.
- Full Firebase Auth scan: 1,604 users, **0** `phase4verify-*` / `manifestprobe-*` identities remaining.
- Client `npm run build` clean; Worker, Functions, bot all `node --check` clean.

### Outstanding owner actions (no lockouts if delayed)

1. ~~**Claim the free Upstash DB before 2026-11-21:** https://upstash.com/start-redis/console/3d986754-7eb0-41b8-bdd6-298965f4ad1f — free, no card. Unclaimed databases are deleted; fail-open keeps students studying, but enforcement state would stop.~~ **Superseded by Section 11:** Supabase is now the live shared state, so no claim is needed.
2. **Turnstile step-up:** create a Cloudflare Turnstile widget, set Worker secrets `TURNSTILE_SECRET_KEY` and `TURNSTILE_SITE_KEY`, and client `VITE_TURNSTILE_SITE_KEY`. Until then the challenge path never triggers.
3. **Activation (owner approval required):** `/enforce active`, then optionally `/feature progressiveUnlock on`. Keep `shadow` until the owner is comfortable watching `/paused` and `/behaviour`.

### Known caveat

The existing 4-hour signed video/notes tokens keep working after a pause because they are self-authorising HMAC tokens. Pause enforcement on the gateway uses the Redis revocation timestamp compared with the token's `auth_time`, plus Firebase refresh-token revocation via `adminEnforce`. This closes new token minting and gateway access; an already-issued short-lived playback token may survive until its own expiry.

---

**Definition of done:** Phases 0–5 accepted, all regression checks green in CI, and a red-team run against staging banks fewer than 60 files before an automatic, session-killing pause with an alert fired. **Phases 2 and 3 were intentionally delivered monitor-only**, so the "device enforced every request", "automatic pause", and "session revocation" metrics were **not** claimed met at those stages. **Phase 4 implements the enforcement machinery (shadow by default, `progressiveUnlock` off, Turnstile wired and configured but unreachable until the master mode is `active`)** — the full "done" criteria apply only after the owner activates and validates in `active` mode.

## 11. Phase 4b - Supabase shared-state migration (2026-11-18)

**Reason:** Upstash free (500K commands/month) showed 1,630 commands in 49 minutes during verification, mostly from test traffic. Supabase Free lists 50,000 MAU, 500 MB DB, 5 GB egress and unlimited API requests at $0/month, which is far above this app's 1,604 registered users and ~1-2 MB of state. Owner chose migration over write-tuning Upstash. This also removes the Upstash `2026-11-21` claim deadline.

**Status:** **LIVE.** Owner created the Free Supabase project and ran the schema. The first deploy exposed a corrupted live `SUPABASE_URL` secret (Worker log showed `Invalid URL: \u0016/rest/v1/...`); both secrets were refreshed from the local `.dev.vars` (values never printed) and the Worker redeployed. Worker version at the end of the Supabase migration: **`f211dd2f-18dc-4b6e-92fc-d4dead71c449`** on route `data.medxi.site/*`. A follow-up safety guard activates Turnstile only when **both** `TURNSTILE_SECRET_KEY` and `TURNSTILE_SITE_KEY` exist, so a half-configured secret cannot demand a challenge the page cannot render. Upstash secrets remain locally as a rollback option but are no longer referenced by the Worker source. The current live Worker is **`ede2599d-4ff8-488b-8fe0-6829443e25f7`** (see §12–13).

### What changed

| File | Change |
|---|---|
| `worker-data-gate/src/index.js` | Replaced the Upstash `redisCmd`/`EVAL`/`SCAN` adapter with Supabase REST against one table `enf_state`. One row per user (`user:<uid>`) plus one `global` row; one GET returns the whole guard state. Global mode/features/providerCount are read fresh on every use (no stale cache), so admin toggles reach every isolate immediately. All reads/writes fail open. Score writes are state-change only (zero-score normal requests write nothing). Env values are trimmed/quote-stripped to avoid secret paste artifacts. |
| `worker-data-gate/supabase-schema.sql` (new) | Table DDL, GIN index, RLS enabled with no client policies (service-role only), plus documented JSON shapes. |
| `worker-data-gate/.dev.vars` | Holds `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` locally (gitignored, never printed). Live Worker secrets are set via `wrangler secret put`. |
| `scripts/verify-phase4.cjs` | CRLF-safe `.dev.vars` parsing, plus a check that `/admin/enforcement` reports `sharedState: true` under the new adapter. 22 checks total; disables Turnstile only for the deterministic run, then restores `shadow` + `progressiveUnlock=off` + `turnstile=on` and deletes its temp identity. |

### Verification results

- `node scripts/verify-phase4.cjs`: **24/24 PASS** - canaries injected only for scripted clients and hidden from browser-like clients, unlock batch 1 -> 2 after 40 trusted events, checkpoint jump raised shared score, canary hit returned `ACCOUNT_PAUSED` and appeared in `/admin/paused`, further access blocked with 403, `/admin/unpause` restored access, Turnstile configured with the live widget keys, shared-state inspection correct. Mode restored to `shadow`, `progressiveUnlock=off`, `turnstile=on` after the run.
- Live `/admin/enforcement` after final integration: **`mode=shadow`**, `active=false`, `sharedState=true`, `turnstileConfigured=true`, `progressiveUnlock=false`, all six enforcement features `on`.
- Supabase table cleaned after testing: all temporary `user:*` test rows and the `probe:test` row were deleted; real user rows were left intact.
- Firebase Auth sweep: **1,617 users, 0** `phase4verify-*` / `manifestprobe-*` identities remaining; the temporary `turnstileverify-*` identity was deleted.
- Worker `node --check` and `wrangler deploy --dry-run` clean.

### Outstanding owner actions (revised)

1. **Turnstile step-up:** completed — the existing widget is wired end-to-end (see §12). No owner setup remains.
2. **Activation (owner approval required):** `/enforce active`, then optionally `/feature progressiveUnlock on`. Keep `shadow` until the owner is comfortable watching `/paused` and `/behaviour`.
3. **Optional cleanup:** the old Upstash secrets can now be removed and the 2026-11-21 claim task closed; Supabase is the live shared state and fail-open still protects students if it is ever unavailable.

---

## 12. Phase 4c - Turnstile step-up wired to the existing widget (2026-11-18)

**Status:** **LIVE, dormant behind `mode=shadow`.** The owner already created the widget; it was retrieved and wired using Cloudflare's "existing widget" flow. Nothing challenges a student until the master mode is `active`.

### Widget

| Property | Value |
|---|---|
| Site key (public) | `0x4AAAAAAGGxSAsXKgHZHbMk` |
| Name | `medxi.site (Spin)` |
| Type / clearance | Managed / `no_clearance` (normally invisible) |
| Allowed domains | `medxi.site`, `localhost`, `127.0.0.1` (no `www` variant) |
| Secret key | Retrieved with canonical Wrangler `4.164.0` from the pinned account `87e42b045dc2182ef8f54bd33ea8ee30`, validated with a dummy-token `siteverify` probe (`invalid-input-response`, no `invalid-input-secret`), then stored only as Worker secret `TURNSTILE_SECRET_KEY` and in the gitignored local `.dev.vars`. Never printed. |
| Public key binding | Worker secret `TURNSTILE_SITE_KEY` |

### Integration

| File | Change |
|---|---|
| `worker-data-gate/src/index.js` | Canonical `siteverify` at `https://challenges.cloudflare.com/turnstile/v0/siteverify`. Requires `data.success === true`, `data.action === 'medxi_step_up'`, and `data.hostname` in `TURNSTILE_HOSTNAMES`. Missing/invalid token, wrong action, wrong hostname, non-OK response, timeout or network error all return `CHALLENGE_FAILED` (fail-closed once keys exist). `POST /api/challenge` marks the challenge on success. |
| `worker-data-gate/wrangler.json` | `TURNSTILE_HOSTNAMES=medxi.site` production var. Local `.dev.vars` allows `localhost,127.0.0.1,medxi.site`. |
| `src/firebase/config.js` | Widget renders with `action: 'medxi_step_up'`; `gatewayFetch()` handles `TURNSTILE_REQUIRED`, posts the token to `/api/challenge`, then retries once. No separate `VITE_TURNSTILE_SITE_KEY` needed — the Worker returns the site key in the challenge response. |
| `scripts/verify-phase4.cjs` | Disables `turnstile` only for the deterministic canary test, then restores it to `on`. 24 checks. |

**Deployments:** Worker **`ede2599d-4ff8-488b-8fe0-6829443e25f7`** on `data.medxi.site/*`; Pages **`361938cb`** (`https://361938cb.medxi.pages.dev`), bundles `index-Byb_HuhV.js` and `AuthContext-Dd3b8Qf4.js`.

**Trigger conditions:** master mode `active` AND feature `turnstile=on` AND both keys present AND shared score `>= 2` AND no prior completed challenge. Because mode is still `shadow`, real traffic never sees the widget.

### Validation

- `node scripts/verify-phase4.cjs`: **24 passed, 0 failed** after the stricter thresholds in §13.
- Real-token end-to-end from `https://medxi.site/app-update.html` (static page on the production hostname): fresh Turnstile token with `action=medxi_step_up` → `POST /api/challenge` returned **200 `{"success":true,"message":"Verification complete."}`**; replaying the same token returned **403 `CHALLENGE_FAILED`**. Siteverify reported `hostname=medxi.site`.
- Dummy-token probe confirmed the stored secret is valid; no secret value was ever printed or committed.
- Temporary Firebase identity and its Supabase state row were deleted after validation; no temp scripts remain.

**Fail-open invariant unchanged:** any Supabase error, missing secret, timeout or quota edge returns `null`; `checkGuard` then reports no pause/revocation/score/challenge and the student keeps access. Master mode remains `shadow`, so nothing is enforced on real traffic during migration.

---

## 13. Phase 4d - enforcement tuning and local inspection (2026-11-18)

**Owner decision after reviewing the risk of student lockouts:** first add safety rails, then tighten the specific deterrence thresholds. Both steps are deployed; **`mode` stays `shadow`** until the owner explicitly approves activation.

### Safety rails kept

| Rail | Behaviour |
|---|---|
| Hidden canaries | `syncIndex` trap paths are only returned to requests without browser same-site metadata, or to accounts that already carry a review signal. A normal student's browser never sees a clickable canary. |
| Behaviour auto-pause | Requires score `>= 5` **and** at least two independent signals. One strong signal alone cannot pause an account. |
| Score-read race | Checkpoint score is awaited before the checkpoint row is written, so the two Supabase read-modify-writes cannot lose each other's data. |
| `admin/state` | Reports `canaryHits`, and `admin/unpause` clears it, so an admin can see and reset review state. |
| Progressive unlock | Still `off` by default. |

### Stricter thresholds the owner chose

| Setting | Before | Now |
|---|---|---|
| Canary hit consequence | First hit review-only, pause on repeat | **First hit pauses** (`ENF_CANARY_PAUSE_AFTER=1`) |
| Turnstile step-up | shared score `>= 2` | **shared score `>= 1`** (both the media and MCQ paths) |
| Checkpoint-tamper jump | `> 50`, weight `+1` | **`> 25`, weight `+2`** |

**Honest limitation:** these are detection + friction, not a wall. A scraper with a real account and browser-like timing can stay under them. The actual deterrence is the layered design — auth-gated manifest, no raw media/PDF links, signed short-lived URLs, hidden origin, bot-UA block, permanent classic-honeypot ban, and (once active) account pause + refresh-token revocation. Soft thresholds alone do not keep a determined scraper away.

### Local inspection

Started for owner review:
- Vite dev server: `http://127.0.0.1:5173/`
- Wrangler dev Worker: `http://127.0.0.1:8787/`

### Verification

- `node scripts/verify-phase4.cjs`: **24 passed, 0 failed** - canaries hidden from browser-like clients, immediate canary pause, checkpoint score `>= 2`, unpause restores access.
- Live `/admin/enforcement`: `mode=shadow`, `sharedState=true`, `turnstileConfigured=true`, `progressiveUnlock=false`, all six features on.
- Temp Firebase identity and Supabase row deleted after the run.
- Current Worker: **`ede2599d-4ff8-488b-8fe0-6829443e25f7`**.

**Activation still requires owner approval.** No real traffic is enforced while `mode=shadow`.

---

## 14. Production incident - stale frontend bundle broke videos and notes (2026-11-19)

**Report:** `Diagnosis: Page Not Found` on every video and note, while QBank worked.

**Root cause:** the Cloudflare Pages Git integration auto-deploys `main`. All security/gateway frontend work lived on `security/phase-0`, so production `medxi.site` was still serving an old `main` bundle (`index-HrcbjG3d.js` / `AuthContext-BsNT2zbs.js`) that redirected straight to `stream.medxi.site/watch/...`. Commit `ef38ad7` later blocked direct stream access at the edge and origin, so those direct links began returning empty `403`. QBank kept working because it already fetched through `data.medxi.site`. The "Page Not Found" screen came from the SPA catch-all on navigation failures, not from the gateway player pages.

**Fix:**
- Verified the committed gateway path end-to-end: note `AgADMS7038` -> `200` `MedXI Notes` player page; video `marrow_biochem_1` -> `200` `MedXI Stream` player page; no `Diagnosis: Page Not Found`.
- Merged `security/phase-0` into `main` in a clean temporary worktree and pushed (`7d75673`) so future automated main deploys keep the gateway code.
- Deployed a clean build of that merge to production: **`4f42de9a`**. No old deployments were deleted.
- Live `medxi.site` now serves `index-7kkd402c.js` + `AuthContext-Dd3b8Qf4.js`; the deployed bundle contains `api/media/url` and `playerUrl`.

**Untouched:** the owner's in-progress, uncommitted DAMS catalog changes in `D:\NEW\mcq-app` (`public/videos_catalog.json`, `src/pages/VideoSection.jsx`, `worker-data-gate/*`, `scratch/`, `deploy/video_stream_map.json`) and all uncommitted scrape files in this repository. They were not built or deployed.

**Final state:** `/admin/enforcement` still reports `mode=shadow`, `progressiveUnlock=false`, `turnstileConfigured=true`. Enforcement activation still requires explicit owner approval.
