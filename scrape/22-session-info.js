/* 22-session-info.js — capture your session info + cookies for later use.
 *
 * Extracts everything useful about your current session:
 *   - /qbapi/me response (name, uid, code, expires, code_expires, device, etc.)
 *   - Cookies (session token, etc.)
 *   - localStorage keys (app state)
 *   - Useful headers
 *
 * Does NOT capture the content decryption key (/qbapi/key) — that's per-file
 * and sensitive. Does NOT capture question content.
 *
 * HOW TO USE
 *   Signed in at qb.neetpgbot.in. Console healthy. Clear input, paste, Enter.
 *   Then:  copy(window.qbSession.json())   -> session-info.json
 */
(async () => {
  const log = (...a) => console.log("%c[SESS]", "color:#f90;font-weight:bold", ...a);

  // 1. /qbapi/me
  let me = null;
  try {
    const r = await fetch("/qbapi/me", { credentials: "include", cache: "no-store" });
    me = await r.json();
  } catch (e) { log("me fetch failed:", String(e)); }

  // 2. Cookies
  const cookies = document.cookie.split(";").map((c) => {
    const [name, ...rest] = c.trim().split("=");
    return { name: name.trim(), value: rest.join("=").trim() };
  }).filter((c) => c.name);

  // 3. localStorage keys (values truncated for safety)
  const lsKeys = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const val = localStorage.getItem(key);
      lsKeys.push({ key, length: val ? val.length : 0, preview: val ? val.slice(0, 80) : null });
    }
  } catch (e) { log("localStorage read failed:", String(e)); }

  // 4. /qbapi/stamp (session stamp key)
  let stamp = null;
  try {
    const r = await fetch("/qbapi/stamp", { credentials: "include", cache: "no-store" });
    stamp = await r.json();
  } catch (e) { log("stamp fetch failed:", String(e)); }

  // 5. Device info from navigator
  const device = {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory,
    maxTouchPoints: navigator.maxTouchPoints,
    cookieEnabled: navigator.cookieEnabled,
    onLine: navigator.onLine
  };

  // 6. Session expiry info
  const now = Date.now();
  const sessionInfo = me ? {
    name: me.name,
    nickname: me.nickname,
    uid: me.uid,
    code: me.code,
    owner: me.owner,
    expires: me.expires,
    expiresDate: me.expires ? new Date(me.expires * 1000).toISOString() : null,
    code_expires: me.code_expires,
    codeExpiresDate: me.code_expires ? new Date(me.code_expires * 1000).toISOString() : null,
    sessionRemainingHours: me.expires ? Math.round((me.expires * 1000 - now) / 3600000) : null,
    codeRemainingHours: me.code_expires ? Math.round((me.code_expires * 1000 - now) / 3600000) : null,
    sessionOutlivesCode: me.expires && me.code_expires ? me.expires > me.code_expires : null,
    live_sync: me.live_sync,
    ai: me.ai,
    is_active_device: me.is_active_device,
    active_device: me.active_device,
    active_device_name: me.active_device_name
  } : null;

  const sessionData = {
    capturedAt: new Date().toISOString(),
    url: location.href,
    origin: location.origin,
    session: sessionInfo,
    cookies: cookies,
    localStorage: lsKeys,
    stamp: stamp ? { k: stamp.k ? stamp.k.slice(0, 8) + "..." : null, day: stamp.day, now: stamp.now } : null,
    device: device
  };

  window.qbSession = {
    data: sessionData,
    json: () => JSON.stringify(sessionData, null, 2)
  };

  console.log("%c=== SESSION INFO ===", "color:#0f0;font-size:13px");
  if (sessionInfo) {
    console.log("name:", sessionInfo.name);
    console.log("uid:", sessionInfo.uid);
    console.log("code:", sessionInfo.code);
    console.log("session expires:", sessionInfo.expiresDate, "(" + sessionInfo.sessionRemainingHours + " hours left)");
    console.log("code expires:", sessionInfo.codeExpiresDate, "(" + sessionInfo.codeRemainingHours + " hours left)");
    console.log("session outlives code:", sessionInfo.sessionOutlivesCode);
    console.log("active device:", sessionInfo.active_device_name, "(" + sessionInfo.is_active_device + ")");
  }
  console.log("cookies:", cookies.length);
  console.log("localStorage keys:", lsKeys.length);
  log("run:  copy(window.qbSession.json())   -> session-info.json");
})();
