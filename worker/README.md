# Affiliate Tracking Worker — Step 1

Cloudflare Worker + KV scaffold for LinkedIn Ads → JVZoo → LinkedIn Conversions API
server-side tracking. This step only implements `POST /api/track`, which stores a
`tracking_id -> li_fat_id` record in KV. JVZoo postback handling and LinkedIn CAPI
calls are added in later steps.

## Prerequisites

- Node.js and npm installed
- A Cloudflare account with the domain (e.g. `appscouthub.com`) added

## 1. Install Wrangler (Cloudflare's CLI)

Install it locally as a dev dependency (avoids the `EACCES` permission error you
get with `npm install -g` on Linux when npm's global prefix is root-owned):

```bash
npm install
```

Then log in (opens a browser for Cloudflare OAuth):

```bash
npx wrangler login
```

From here on, run every `wrangler` command via `npx wrangler ...` (or the npm
scripts already defined in `package.json`: `npm run dev`, `npm run deploy`,
`npm run kv:create`).

## 2. Create the KV namespace

```bash
npx wrangler kv namespace create TRACKING_KV
```

This prints an `id`. Copy it into `wrangler.toml` under `[[kv_namespaces]] id = "..."`.

For local development, also create a preview namespace (optional):

```bash
npx wrangler kv namespace create TRACKING_KV --preview
```

Copy the printed `preview_id` into `wrangler.toml` as `preview_id = "..."` on the
same `[[kv_namespaces]]` block if you want `wrangler dev` to use a separate store.

## 3. Bind the KV namespace to the Worker

Already declared in `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "TRACKING_KV"
id = "REPLACE_WITH_KV_NAMESPACE_ID"
```

Make sure the `id` matches what `wrangler kv namespace create` returned.

## 4. Run locally

```bash
npx wrangler dev
```

## 5. Deploy

```bash
npx wrangler deploy
```

Wrangler will print the `*.workers.dev` URL. To attach it to your domain instead,
uncomment the `[[routes]]` block in `wrangler.toml`, set `zone_name` to your domain,
then redeploy.

## Testing Step 1

Health check:

```bash
curl https://<your-worker>.workers.dev/api/health
# {"ok":true}
```

Simulate a LinkedIn-ad visitor click (with a fake li_fat_id):

```bash
curl -X POST https://<your-worker>.workers.dev/api/track \
  -H "Content-Type: application/json" \
  -d '{"li_fat_id":"test-li-fat-id-123"}'
# {"tracking_id":"trk_xxxxxxxxxxxx","stored":true}
```

Verify the record landed in KV:

```bash
npx wrangler kv key get --namespace-id=<KV_NAMESPACE_ID> "trk_xxxxxxxxxxxx"
```

Expected value:

```json
{"tracking_id":"trk_xxxxxxxxxxxx","li_fat_id":"test-li-fat-id-123","created_at":"..."}
```

Simulate a visitor with no LinkedIn identifier (e.g. direct traffic):

```bash
curl -X POST https://<your-worker>.workers.dev/api/track \
  -H "Content-Type: application/json" \
  -d '{}'
# {"tracking_id":"trk_yyyyyyyyyyyy","stored":false}
```

No KV record should be created for this one (`stored:false`).

## Next steps (not implemented yet)

- `js/tracking.js` on the landing page: parse `li_fat_id` from the URL, call
  `/api/track`, append `tracking_id` to the JVZoo affiliate link.
- `/api/jvzoo-postback`: verify JVZoo's IPN `cverify` signature, deduplicate by
  transaction/receipt ID, look up the `tracking_id` in KV, and send the event to
  LinkedIn's Conversions API.
- Worker secrets for the LinkedIn OAuth token, LinkedIn Conversion Rule URN, and
  the JVZoo IPN secret key (added via `npx wrangler secret put`, never in this repo).
