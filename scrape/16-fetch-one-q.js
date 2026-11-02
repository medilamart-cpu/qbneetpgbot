/* 16-fetch-one-q.js — demonstrate fetching + decrypting ONE question file.
 *
 * Uses links.csv entry #1 (AMBOSS Abdominal aortic aneurysm). Pipeline:
 *   1. GET /qbapi/key?u=<keyId>  -> { k: <hex> }
 *   2. GET /c/<xx>/<hash>        -> encrypted blob (AES-GCM, first 12 bytes = IV)
 *   3. AES-GCM decrypt  (key = hex->bytes(k), IV = first 12 bytes, tag 128)
 *   4. gunzip -> JSON
 *   5. Print the structure (question count, field names) — NOT the full content.
 *
 * HOW TO USE
 *   Console healthy. Clear input, paste, Enter. Wait ~5-15s.
 *   You should see the decrypted question file's structure.
 */
(async () => {
  const log = (...a) => console.log("%c[Q]", "color:#09f;font-weight:bold", ...a);
  const err = (...a) => console.log("%c[Q]", "color:#f33;font-weight:bold", ...a);

  // Use entry #1 from links.csv
  const keyId = "e4bd887f5450472c9d016f64dd6c7abb0d22f95e";
  const blobUrl = "/c/e4/bd887f5450472c9d016f64dd6c7abb0d22f95e";
  const path = "AMBOSS/AMBOSS 1 - AMBOSS_qBANK (Abdominal to Epidural)/Abdominal aortic aneurysm.json";

  log("fetching key for", keyId);
  // 1. get the key
  let keyHex;
  try {
    const kr = await fetch("/qbapi/key?u=" + keyId, { credentials: "include", cache: "no-store" });
    if (!kr.ok) { err("key fetch failed:", kr.status); return; }
    const kd = await kr.json();
    keyHex = kd.k;
    log("got key:", keyHex.slice(0, 8) + "..." + keyHex.slice(-4), "(" + keyHex.length + " hex chars)");
  } catch (e) { err("key fetch error:", String(e)); return; }

  // 2. fetch the blob
  log("fetching blob", blobUrl);
  let buf;
  try {
    const br = await fetch(blobUrl, { credentials: "include", cache: "force-cache" });
    if (!br.ok) { err("blob fetch failed:", br.status); return; }
    buf = await br.arrayBuffer();
    log("blob bytes:", buf.byteLength);
  } catch (e) { err("blob fetch error:", String(e)); return; }

  // 3. AES-GCM decrypt: first 12 bytes = IV, rest = ciphertext+tag
  let plain;
  try {
    const raw = new Uint8Array(buf);
    const iv = raw.subarray(0, 12);
    const ct = raw.subarray(12);
    const keyBytes = new Uint8Array(keyHex.length / 2);
    for (let i = 0; i < keyBytes.length; i++) keyBytes[i] = parseInt(keyHex.substr(i * 2, 2), 16);
    const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
    const dec = await crypto.subtle.decrypt({ name: "AES-GCM", iv, tagLength: 128 }, cryptoKey, ct);
    plain = new Uint8Array(dec);
    log("decrypted bytes:", plain.length);
  } catch (e) { err("decrypt failed:", String(e)); return; }

  // 4. gunzip
  let text;
  try {
    const t = new Blob([plain]).stream().pipeThrough(new DecompressionStream("gzip"));
    text = await new Response(t).text();
    log("gunzipped chars:", text.length);
  } catch (e) { err("gunzip failed:", String(e)); return; }

  // 5. parse JSON and show structure
  let data;
  try { data = JSON.parse(text); } catch (e) { err("JSON parse failed:", String(e)); log("raw text (first 300):", text.slice(0, 300)); return; }

  log("=== DECRYPTED STRUCTURE ===");
  console.log("top-level keys:", Object.keys(data));
  if (Array.isArray(data)) {
    log("array length:", data.length);
    if (data.length > 0) {
      console.log("first item keys:", Object.keys(data[0]));
      console.log("first item (truncated):", JSON.stringify(data[0]).slice(0, 500));
    }
  } else {
    for (const k of Object.keys(data)) {
      const v = data[k];
      if (Array.isArray(v)) console.log(k + ":", "Array(" + v.length + ")", v.length > 0 ? "first keys: " + Object.keys(v[0]).join(", ") : "");
      else if (typeof v === "object" && v !== null) console.log(k + ":", "Object with keys:", Object.keys(v).slice(0, 10).join(", "));
      else console.log(k + ":", typeof v, String(v).slice(0, 80));
    }
  }
  window.__qbSample = data;
  log("full decrypted data saved to window.__qbSample");
  log("NOTE: this is ONE file. Bulk-fetching all 39,537 would take hours and likely trigger rate limits.");
})();
