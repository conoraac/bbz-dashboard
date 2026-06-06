// BBZ Performance Dashboard — backend
// Serves one branded page with LIVE data injected (GA4 + Google Ads + Meta),
// and proxies the AI Q&A so keys stay on the server (client-safe).
// Runs on Railway (npm start) AND Vercel (via api/index.js).
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;            // required for Q&A
const WINDSOR_KEY   = process.env.WINDSOR_API_KEY;              // optional: enables live data
const GA4_ACCOUNT   = process.env.GA4_ACCOUNT  || '309061594';        // BBZ GA4 property
const GADS_ACCOUNT  = process.env.GADS_ACCOUNT || '889-893-9290';     // BBZ Google Ads (NAC)
const META_ACCOUNT  = process.env.META_ACCOUNT || '3111474999097042'; // BBZ Meta ad account
const GBP_ACCOUNT   = process.env.GBP_ACCOUNT || 'locations/8839500927202128335'; // BBZ Business Profile
const CALLRAIL_ACCOUNT = process.env.CALLRAIL_ACCOUNT || '648'; // BBZ's CallRail account in Windsor. NOTE: this id changes each time CallRail is reconnected in Windsor (was 645/647, now 648) — re-verify if calls stop appearing.
const CALLRAIL_MONTHS = +(process.env.CALLRAIL_MONTHS || 6); // CallRail returns per-call rows; pulling many months is slow, so default to the last 6. Raise if your call volume is low.
const GSC_ACCOUNT   = process.env.GSC_ACCOUNT || 'sc-domain:bbzlimo.com'; // BBZ Search Console property
const MODEL         = process.env.MODEL || 'claude-sonnet-4-6';

const TEMPLATE = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const SNAPSHOT = JSON.parse(fs.readFileSync(path.join(__dirname, 'snapshot.json'), 'utf8'));

// ----------------------------------------------------------------------------
// Windsor.ai REST pull.  NOTE: confirm the exact endpoint + params against your
// Windsor dashboard (Onboarding > API). These mirror the connector calls that
// already returned correct numbers (GA4 309061594, Google Ads 889-893-9290,
// Meta 3111474999097042). If your account is keyed differently (e.g. account is
// implied by the key, or the param is select_accounts), this is the ONLY
// function to adjust.
// ----------------------------------------------------------------------------
async function windsor(connector, account, fields, from, to, extra) {
  let url = `https://connectors.windsor.ai/${connector}`
    + `?api_key=${encodeURIComponent(WINDSOR_KEY)}`
    + (account ? `&account_id=${encodeURIComponent(account)}` : '')
    + `&date_from=${from}&date_to=${to}`
    + `&fields=${fields.join(',')}&_renderer=json`;
  if (extra) for (const [k, v] of Object.entries(extra)) url += `&${k}=${encodeURIComponent(v)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000); // never let one source hang the refresh
  let r;
  try { r = await fetch(url, { signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
  if (!r.ok) throw new Error(connector + ' ' + r.status + ': ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  return j.data || j;
}

const FROM = '2024-06-01';
const TO   = () => new Date().toISOString().slice(0, 10);
const normYM = s => String(s).includes('|')
  ? String(s).split('|')[0] + String(s).split('|')[1].padStart(2, '0')
  : String(s);

const BOT_REG  = new Set(['Gansu','Vojvodina','Central Visayas','Punjab','Iowa','England','Washington','Wyoming']);
const BOT_CITY = new Set(['Lanzhou','Singapore','Santa Clara','Moses Lake','Mission Viejo','Ashburn','Dallas','North Haledon']);

function geo(rows, key, bots, topn) {
  const tot = {};
  for (const r of rows) { const n = r[key], s = +r.sessions; if (!n || bots.has(n) || !s) continue; tot[n] = (tot[n]||0)+s; }
  const top = Object.entries(tot).sort((a,b)=>b[1]-a[1]).slice(0, topn).map(x=>x[0]);
  const map = {};
  for (const r of rows) {
    const n = r[key], s = +r.sessions, k = +r.conversions || 0; if (!n || bots.has(n) || !s) continue;
    const kk = top.includes(n) ? n : 'Other', ym = normYM(r.year_month);
    const d = (map[ym] = map[ym] || {}), cur = (d[kk] = d[kk] || [0,0]); cur[0]+=s; cur[1]+=k;
  }
  return { names: [...top, 'Other'], map };
}

async function buildGA4() {
  const to = TO();
  const [ch, reg, city, ke] = await Promise.all([
    windsor('googleanalytics4', GA4_ACCOUNT, ['year_month','session_default_channel_group','sessions','totalusers','screen_page_views','event_count','conversions'], FROM, to),
    windsor('googleanalytics4', GA4_ACCOUNT, ['year_month','region','sessions','conversions'], FROM, to),
    windsor('googleanalytics4', GA4_ACCOUNT, ['year_month','city','sessions','conversions'], FROM, to),
    windsor('googleanalytics4', GA4_ACCOUNT, ['year_month','conversions_inbound_call','conversions_lead_form','conversions_liverycoach_booked','conversions_request_a_quote'], FROM, to),
  ]);
  const chm = {}, chans = new Set(), months = new Set();
  for (const r of ch) {
    const ym = normYM(r.year_month), c = r.session_default_channel_group;
    if (!ym || !c || +r.sessions < 30) continue;
    chans.add(c); months.add(ym);
    (chm[ym] = chm[ym] || {})[c] = [+r.sessions, +r.totalusers, +r.screen_page_views, +r.event_count, +r.conversions];
  }
  const keo = {};
  for (const r of ke) {
    const ym = normYM(r.year_month); if (!ym) continue;
    keo[ym] = [+r.conversions_inbound_call||0, +r.conversions_lead_form||0, +r.conversions_liverycoach_booked||0, +r.conversions_request_a_quote||0];
  }
  const R = geo(reg, 'region', BOT_REG, 8), Y = geo(city, 'city', BOT_CITY, 9);
  const monthsArr = [...months].sort();
  const nowYM = new Date().toISOString().slice(0,7).replace('-','');
  const complete = monthsArr.filter(m => m < nowYM);
  const current = complete.length ? complete[complete.length-1] : monthsArr[monthsArr.length-1];
  return { channels: [...chans].sort(), months: monthsArr, chm, ke: keo,
           regNames: R.names, reg: R.map, cityNames: Y.names, city: Y.map, current };
}

// generic monthly campaign aggregator for paid platforms
function buildPaid(rows, valFields) {
  const data = {}, camps = [], months = new Set();
  for (const r of rows) {
    const ym = normYM(r.year_month), camp = r.campaign; if (!ym || !camp) continue;
    months.add(ym); if (!camps.includes(camp)) camps.push(camp);
    const vals = valFields.map(f => +r[f] || 0);
    (data[ym] = data[ym] || {})[camp] = vals;
  }
  return { months: [...months].sort(), campaigns: camps, data };
}
const buildGads = async () => buildPaid(
  await windsor('google_ads', GADS_ACCOUNT, ['year_month','campaign','clicks','impressions','cost','conversions'], FROM, TO()),
  ['clicks','impressions','cost','conversions']);
const buildMeta = async () => buildPaid(
  await windsor('facebook', META_ACCOUNT, ['year_month','campaign','clicks','impressions','spend','actions_lead','reach'], FROM, TO()),
  ['clicks','impressions','spend','actions_lead','reach']);

// Google Business Profile — daily rows aggregated to monthly [impressions, calls, website, directions]
async function buildGBP() {
  const rows = await windsor('google_my_business', GBP_ACCOUNT,
    ['year_month','impressions','call_clicks','website_clicks','direction_requests','review_total_count','review_average_rating_total'], FROM, TO());
  const data = {}, months = new Set(); let reviews = 0, rating = 0;
  for (const r of rows) {
    const ym = normYM(r.year_month); if (!ym) continue;
    if (r.impressions != null || r.call_clicks != null) {
      months.add(ym);
      const d = (data[ym] = data[ym] || [0,0,0,0]);
      d[0]+=+r.impressions||0; d[1]+=+r.call_clicks||0; d[2]+=+r.website_clicks||0; d[3]+=+r.direction_requests||0;
    }
    if (r.review_total_count != null) reviews = Math.max(reviews, +r.review_total_count || 0);
    if (r.review_average_rating_total != null) rating = +r.review_average_rating_total || rating;
  }
  return { months: [...months].sort(), data, reviews, rating };
}

// CallRail — call-level rows aggregated to monthly [total, answered, first-time]. Returns empty until BBZ's
// CallRail account is connected in Windsor (then it populates automatically).
// CallRail — per-call rows counted into monthly [total, answered, first-time] + source tally.
// Needs date_filters on the calls table, and a per-call id to count (the connector otherwise
// returns distinct field combinations, not one row per call). Booleans come back as "True"/"False".
async function buildCallRail() {
  if (!CALLRAIL_ACCOUNT) return { months: [], data: {}, empty: true };
  const d = new Date(); d.setMonth(d.getMonth() - (CALLRAIL_MONTHS - 1)); d.setDate(1);
  const from = d.toISOString().slice(0, 10);
  let rows;
  try {
    rows = await windsor('callrail', CALLRAIL_ACCOUNT,
      ['year_month','calls__id','calls__answered','calls__first_call','calls__source'],
      from, TO(), { date_filters: JSON.stringify({ calls: 'calls__start_time' }) });
  } catch { return { months: [], data: {}, empty: true }; }
  if (!Array.isArray(rows) || !rows.length) return { months: [], data: {}, empty: true };
  const data = {}, sources = {}, months = new Set();
  for (const r of rows) {
    const ym = normYM(r.year_month); if (!ym) continue; months.add(ym);
    const cur = (data[ym] = data[ym] || [0,0,0]);
    cur[0] += 1;                                              // total calls
    if (r.calls__answered === 'True' || r.calls__answered === true) cur[1] += 1;
    if (r.calls__first_call === 'True' || r.calls__first_call === true) cur[2] += 1;
    const s = r.calls__source || 'Unknown';
    (sources[ym] = sources[ym] || {})[s] = (sources[ym][s] || 0) + 1;
  }
  return { months: [...months].sort(), data, sources };
}

// Search Console — Windsor `searchconsole` connector. Monthly [clicks, impressions, avg position].
// Google caps history at ~16 months, so clamp the start date.
async function buildGSC() {
  const d = new Date(); d.setMonth(d.getMonth() - 15);
  const from = d.toISOString().slice(0, 10);
  const rows = await windsor('searchconsole', GSC_ACCOUNT, ['year_month','clicks','impressions','position'], from, TO());
  const data = {}, months = new Set();
  for (const r of rows) {
    const ym = normYM(r.year_month); if (!ym) continue;
    months.add(ym);
    data[ym] = [+r.clicks || 0, +r.impressions || 0, +r.position || 0];
  }
  return { months: [...months].sort(), data };
}

let cache = { t: 0, data: null };
let inflight = null;
const isFresh = () => cache.data && Date.now() - cache.t < 3600e3;

async function refresh() {
  const [ga4, gads, meta, gbp, callrail, searchconsole] = await Promise.all([
    buildGA4().catch(e => { console.error('GA4:', e.message); return null; }),
    buildGads().catch(e => { console.error('GAds:', e.message); return { months: [], data: {}, empty: true }; }),
    buildMeta().catch(e => { console.error('Meta:', e.message); return { months: [], data: {}, empty: true }; }),
    buildGBP().catch(e => { console.error('GBP:', e.message); return { months: [], data: {}, empty: true }; }),
    buildCallRail().catch(e => { console.error('CallRail:', e.message); return { months: [], data: {}, empty: true }; }),
    buildGSC().catch(e => { console.error('GSC:', e.message); return null; }),
  ]);
  const base = ga4 || SNAPSHOT;                 // if GA4 itself fails, fall back to snapshot shape
  const data = { ...base, gads, meta, gbp, callrail, searchconsole };
  cache = { t: Date.now(), data };
  return data;
}

// Returns immediately if fresh; otherwise shares a single in-flight pull.
async function getData() {
  if (!WINDSOR_KEY) return SNAPSHOT;
  if (isFresh()) return cache.data;
  if (!inflight) inflight = refresh().finally(() => { inflight = null; });
  return inflight;
}

// Fire-and-forget: kick a refresh in the background without blocking anyone.
function warm() {
  if (!WINDSOR_KEY || isFresh() || inflight) return;
  inflight = refresh().catch(e => console.error('warm failed:', e.message)).finally(() => { inflight = null; });
}

// ---- the page: render INSTANTLY from cache (or snapshot), refresh in background ----
app.get('/', (req, res) => {
  const live = isFresh();
  const data = live ? cache.data : (cache.data || SNAPSHOT);
  if (!live) warm();                                  // start a background pull; don't wait for it
  const stale = !live && !!WINDSOR_KEY;               // we served snapshot but real data is on the way
  const inject = 'const DATA=' + JSON.stringify(data) + ';window.__STALE__=' + (stale ? 'true' : 'false') + ';';
  res.set('Cache-Control', 'no-store');               // always serve the latest page, never a cached copy
  res.type('html').send(TEMPLATE.replace('/*__DATA__*/', inject));
});

// ---- lightweight readiness check the page polls after a cold start (non-blocking) ----
app.get('/api/ready', (req, res) => res.json({ ready: isFresh() }));

// ---- live data as JSON (handy for testing the Windsor wiring) ----
app.get('/api/ga4', async (req, res) => {
  try { res.json(await getData()); } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ---- AI Q&A proxy (key stays here, never in the browser) ----
app.post('/api/ask', async (req, res) => {
  if (!ANTHROPIC_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set on the server.' });
  const { question, context } = req.body || {};
  if (!question) return res.status(400).json({ error: 'Missing question.' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 1000, messages: [{ role: 'user', content:
        `You are a senior analyst at Astoria Advertising Company reviewing BBZ Limousine's live marketing data `
        + `(GA4 + Google Ads + Meta). Answer using ONLY the snapshot below, which reflects the user's current `
        + `filter selections. Be specific with numbers, concise (max ~140 words), and practical.\n\n${context || ''}\n\nQUESTION: ${question}` }] })
    });
    const j = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: j });
    res.json({ text: (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim() });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});


// Railway / local: listen.  Vercel: the app is exported and invoked per-request.
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log('BBZ dashboard on http://localhost:' + PORT));
  warm(); // pre-pull live data at startup so the first visit is already live
}
export default app;
