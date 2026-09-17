/**
 * aff-tracking-worker
 *
 * Implements:
 *   POST /api/track          -> generates a tracking_id, stores { tracking_id, li_fat_id, created_at } in KV
 *   GET  /api/health         -> simple health check
 *   POST /api/jvzoo-postback -> receives JVZoo's JVZIPN v1 notification, verifies its
 *                                signature, resolves the affiliate tracking id (caffitid)
 *                                back to the stored li_fat_id via TRACKING_KV.
 *
 * LinkedIn Conversions API calls are NOT implemented yet (a later step, once the
 * jvzoo-postback -> li_fat_id resolution above has been verified end-to-end).
 */

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(body, status, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(env),
    },
  });
}

function generateTrackingId() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `trk_${hex}`;
}

/**
 * JVZIPN v1 cipher verification.
 *
 * Per the official JVZoo docs (https://support.jvzoo.com/hc/en-us/articles/206456857):
 *   1. Take all POST fields except "cverify".
 *   2. Sort the field names alphabetically.
 *   3. Concatenate the field VALUES (in that sorted order) separated by "|".
 *   4. Append the vendor's secret key.
 *   5. SHA1 the result, uppercase the first 8 hex characters.
 *   6. Compare to the "cverify" field sent by JVZoo.
 */
async function computeJvzipnCverify(fields, secretKey) {
  const keys = Object.keys(fields)
    .filter((k) => k !== "cverify")
    .sort();
  const pop = keys.map((k) => fields[k] ?? "").join("|") + secretKey;
  const data = new TextEncoder().encode(pop);
  const digest = await crypto.subtle.digest("SHA-1", data);
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return hex.substring(0, 8).toUpperCase();
}

/**
 * POST /api/jvzoo-postback
 *
 * Receives the official JVZoo Instant Payment Notification (JVZIPN v1),
 * which JVZoo sends as application/x-www-form-urlencoded. Only this
 * officially documented format is supported; a differently-formatted
 * (e.g. JSON) request is rejected rather than guessed at.
 *
 * Flow: verify cverify signature -> extract caffitid (affiliate tracking id,
 * i.e. our own `tid`) -> look up TRACKING_KV -> resolve li_fat_id.
 * LinkedIn Conversions API is intentionally NOT called here (later step).
 */
async function handleJvzooPostback(request, env) {
  if (!env.JVZOO_SECRET_KEY) {
    console.log("jvzoo-postback: missing JVZOO_SECRET_KEY secret (server misconfiguration)");
    return jsonResponse({ error: "server_misconfigured" }, 500, env);
  }

  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    console.log("jvzoo-postback: rejected unsupported content-type");
    return jsonResponse({ error: "unsupported_content_type" }, 400, env);
  }

  let rawBody;
  try {
    rawBody = await request.text();
  } catch (err) {
    return jsonResponse({ error: "invalid_body" }, 400, env);
  }

  const params = new URLSearchParams(rawBody);
  const fields = Object.fromEntries(params.entries());

  // Fields required for verification / processing, per the official
  // JVZIPN v1 Post Parameters table.
  if (!fields.ctransaction || !fields.ctransreceipt || !fields.cverify) {
    console.log("jvzoo-postback: missing required fields");
    return jsonResponse({ error: "missing_required_fields" }, 400, env);
  }

  let expectedVerify;
  try {
    expectedVerify = await computeJvzipnCverify(fields, env.JVZOO_SECRET_KEY);
  } catch (err) {
    console.log("jvzoo-postback: cverify computation failed");
    return jsonResponse({ error: "verification_error" }, 500, env);
  }

  const verified = expectedVerify === String(fields.cverify).toUpperCase();
  console.log(`jvzoo-postback: verification=${verified ? "pass" : "fail"}`);

  if (!verified) {
    return jsonResponse({ error: "invalid_signature" }, 401, env);
  }

  const affiliateTrackingId = typeof fields.caffitid === "string" ? fields.caffitid.trim() : "";
  console.log(`jvzoo-postback: has_affiliate_tracking_id=${Boolean(affiliateTrackingId)}`);

  if (!affiliateTrackingId) {
    return jsonResponse({ error: "missing_affiliate_tracking_id" }, 400, env);
  }

  // Idempotency: JVZoo may redeliver the same notification (retries on
  // non-200, or distinct actions on the same receipt e.g. RFND then SALE).
  // We dedupe on receipt+action so a later LinkedIn CAPI step never fires
  // more than once for the same notification.
  const dedupeKey = `jvzipn_seen:${fields.ctransreceipt}:${fields.ctransaction}`;
  const alreadyProcessed = await env.TRACKING_KV.get(dedupeKey);
  if (alreadyProcessed) {
    console.log(`jvzoo-postback: duplicate=true tracking_id=${affiliateTrackingId}`);
    return jsonResponse({ status: "duplicate_ignored", tracking_id: affiliateTrackingId }, 200, env);
  }

  const recordRaw = await env.TRACKING_KV.get(affiliateTrackingId);
  console.log(`jvzoo-postback: kv_found=${Boolean(recordRaw)} tracking_id=${affiliateTrackingId}`);

  if (!recordRaw) {
    return jsonResponse({ error: "tracking_mapping_not_found" }, 404, env);
  }

  let record;
  try {
    record = JSON.parse(recordRaw);
  } catch (err) {
    console.log("jvzoo-postback: corrupt KV record");
    return jsonResponse({ error: "server_error" }, 500, env);
  }

  const dedupeTtl = 60 * 60 * 24 * 90; // 90 days: comfortably longer than JVZoo's 72h retry window.
  await env.TRACKING_KV.put(
    dedupeKey,
    JSON.stringify({
      tracking_id: affiliateTrackingId,
      transaction_type: fields.ctransaction,
      processed_at: new Date().toISOString(),
    }),
    { expirationTtl: dedupeTtl }
  );

  return jsonResponse(
    {
      status: "ok",
      tracking_id: record.tracking_id,
      li_fat_id: record.li_fat_id,
      transaction_type: fields.ctransaction,
    },
    200,
    env
  );
}

async function handleTrack(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch (err) {
    return jsonResponse({ error: "invalid_json" }, 400, env);
  }

  const liFatId = typeof payload.li_fat_id === "string" ? payload.li_fat_id.trim() : "";

  // li_fat_id is optional at this stage: a visitor might not have come from a
  // LinkedIn ad click. We still issue a tracking_id so the frontend flow is
  // consistent, but only store a record when we actually have an identifier
  // worth recovering later.
  const trackingId = generateTrackingId();

  if (liFatId) {
    const ttl = parseInt(env.TRACKING_TTL_SECONDS, 10) || 2592000; // 30 days default
    const record = {
      tracking_id: trackingId,
      li_fat_id: liFatId,
      created_at: new Date().toISOString(),
    };
    await env.TRACKING_KV.put(trackingId, JSON.stringify(record), {
      expirationTtl: ttl,
    });
  }

  return jsonResponse({ tracking_id: trackingId, stored: Boolean(liFatId) }, 200, env);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      return jsonResponse({ ok: true }, 200, env);
    }

    if (url.pathname === "/api/track" && request.method === "POST") {
      return handleTrack(request, env);
    }

    if (url.pathname === "/api/jvzoo-postback" && request.method === "POST") {
      return handleJvzooPostback(request, env);
    }

    return jsonResponse({ error: "not_found" }, 404, env);
  },
};
