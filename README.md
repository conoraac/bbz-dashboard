# BBZ Performance Dashboard

A single, **client-facing** web page showing BBZ Limousine's marketing performance —
**GA4 + Google Ads + Meta** — with date-range / comparison / channel / region / city / metric
controls, live data, and a realtime Q&A box. All keys stay on the server. Built by Astoria Advertising Company.

```
bbz-dashboard/
├── server.js          # backend: serves the page + pulls GA4/Google Ads/Meta (Windsor) + proxies the AI (Anthropic)
├── public/index.html  # the branded dashboard (filters, charts, paid sections, Q&A)
├── snapshot.json      # fallback data so it works before Windsor is wired (GA4 + Google Ads + Meta)
├── api/index.js       # Vercel entry (re-exports the Express app)
├── vercel.json        # Vercel routing/build config
├── package.json
└── .env.example
```

## How it works
- **Every page load pulls fresh data** from Windsor (GA4, Google Ads acct 889-893-9290, Meta acct 3111474999097042), cached 1 hour.
- **Resetting the date range re-renders instantly** — the page holds ~24 months and filters client-side.
- The **Channel / Region / City** filters apply to GA4. The **Google Ads** and **Meta** sections respond to **Time Frame + Comparison**.
- The **Q&A box calls the server**, which calls Claude with your key — clients never see or paste a key.
- No `WINDSOR_API_KEY` yet? The page runs on `snapshot.json` (fully interactive) and Q&A still works, so you can deploy first and turn on live data after.

## Environment variables
| Variable | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | the AI Q&A |
| `WINDSOR_API_KEY` | optional | turns on always-live data (GA4 + Google Ads + Meta) |
| `GA4_ACCOUNT` | optional | default `309061594` |
| `GADS_ACCOUNT` | optional | default `889-893-9290` |
| `META_ACCOUNT` | optional | default `3111474999097042` |
| `MODEL` | optional | default `claude-sonnet-4-6` |

## Run locally
```bash
npm install
ANTHROPIC_API_KEY=sk-ant-...  WINDSOR_API_KEY=...  npm start
# http://localhost:3000
```

## Deploy on Railway
1. Push this folder to a GitHub repo.
2. Railway → **New Project → Deploy from GitHub repo** → pick it (auto-runs `npm start`).
3. **Variables** tab → add the vars from the table above.
4. **Settings → Networking → Generate Domain** (or attach a custom domain).
5. Send the client the URL.

## Deploy on Vercel
1. Push the same folder to GitHub.
2. Vercel → **Add New → Project** → import the repo. `vercel.json` is already set up
   (all routes are handled by the Express app in `api/index.js`; `public/` and `snapshot.json` are bundled).
3. **Settings → Environment Variables** → add the same vars.
4. Deploy. Vercel gives you a `*.vercel.app` URL; add a custom domain if you like.

Same codebase runs on both — `server.js` listens on a port for Railway/local and is exported as a function handler for Vercel.

## One thing to confirm: the Windsor REST call
`server.js → windsor()` hits `https://connectors.windsor.ai/<connector>` with your `WINDSOR_API_KEY`,
the account id, a date range, and the field list. Connectors/fields/accounts match what already returned
correct numbers (GA4, `google_ads`, `facebook`). If your Windsor account expects a different param
(e.g. account implied by the key, or `select_accounts`), that one function is the only place to adjust.
After deploy, hit `/api/ga4` — it returns the live JSON (now including `gads` and `meta`) or the exact error.

## Data sources — the whole report
| Section | Source | Status |
|---|---|---|
| Website (GA4) | Windsor `googleanalytics4` (309061594) | ✅ live |
| Google Ads | Windsor `google_ads` (889-893-9290) | ✅ live |
| Meta Ads | Windsor `facebook` (3111474999097042) | ✅ live |
| Google Business Profile | Windsor `google_my_business` (locations/8839500927202128335) | ✅ live |
| Phone Calls (CallRail) | Windsor `callrail` (account 648 = BBZ) | ✅ live — total calls, answered, answer rate, first-time, by month |
| Search Console | Windsor `searchconsole` (sc-domain:bbzlimo.com) | ✅ live — clicks, impressions, CTR, avg position (Google caps history at ~16 months) |
| SEO rankings | Ahrefs API (keywords already pulled for the report) | ➕ optional add (same pattern) |

Every section renders live data when its source is flowing, and shows a clear "connect" state until then — nothing breaks, and there are no placeholder numbers.

### CallRail (live)
Working after the reconnect. Three gotchas the backend already handles:
1. **`date_filters`** must point at the calls table — `{"calls":"calls__start_time"}` — or every query 500s.
2. The connector returns **distinct field combinations, not one row per call**, so `buildCallRail()` includes the per-call id (`calls__id`) and counts rows to get real volume.
3. Booleans arrive as the strings `"True"`/`"False"`.

BBZ is account **648** (`CALLRAIL_ACCOUNT`). ⚠️ Windsor reassigns this id every time you reconnect CallRail (it was 645/647 before, now 648) — if calls stop showing, re-check the id. Because per-call rows are heavy, the backend pulls the last `CALLRAIL_MONTHS` months (default 6); a full multi-year pull times out.

### Search Console (live)
Pulled from Windsor's `searchconsole` connector for `sc-domain:bbzlimo.com` (set `GSC_ACCOUNT` to change). Google only exposes ~16 months of history, so the backend clamps the start date automatically. The trend chart plots clicks (bars) against average position (line, axis inverted so up = better).
