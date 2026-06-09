// BBZ Performance Dashboard — backend
// Serves one branded page with LIVE data injected (GA4 + Google Ads + Meta),
// and proxies the AI Q&A so keys stay on the server (client-safe).
// Runs on Railway (npm start) AND Vercel (via api/index.js).
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;            // required for Q&A
const WINDSOR_KEY   = process.env.WINDSOR_API_KEY;              // optional: enables live data
const GA4_ACCOUNT   = process.env.GA4_ACCOUNT  || '309061594';        // BBZ GA4 property
const GADS_ACCOUNT  = process.env.GADS_ACCOUNT || '889-893-9290';     // BBZ Google Ads (NAC)
const META_ACCOUNT  = process.env.META_ACCOUNT || '3111474999097042'; // BBZ Meta ad account
const GBP_ACCOUNT   = process.env.GBP_ACCOUNT || 'locations/8839500927202128335'; // BBZ Business Profile
const CALLRAIL_ACCOUNT = process.env.CALLRAIL_ACCOUNT || '842-760-809'; // BBZ's CallRail account (informational; the reliable scope is the company id below, since account ids change on reconnect)
const CALLRAIL_COMPANY = process.env.CALLRAIL_COMPANY || 'COM2377c78f5f0249d4abbb51a2888b5f52'; // BBZ's CallRail company id — this is what actually filters calls. If calls vanish, pull callrail calls__company_id + calls__source and find the company whose calls include "BBZ Contact Us Page".
const CALLRAIL_MONTHS = +(process.env.CALLRAIL_MONTHS || 6); // CallRail returns per-call rows; pulling many months is slow, so default to the last 6. Raise if your call volume is low.
const GSC_ACCOUNT   = process.env.GSC_ACCOUNT || 'bbzlimo.com'; // BBZ Search Console property as it appears in the account_id field (the sc-domain property; the url-prefix one is "https://www.bbzlimo.com/")
const MODEL         = process.env.MODEL || 'claude-sonnet-4-6';
const DASH_PASSWORD = process.env.DASH_PASSWORD || ''; // set this on Railway to require a password before the report can be viewed; leave unset to keep it open

const TEMPLATE = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const SNAPSHOT = JSON.parse(fs.readFileSync(path.join(__dirname, 'snapshot.json'), 'utf8'));

// Branded password screen shown when DASH_PASSWORD is set and the visitor isn't authenticated yet.
const LOGIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BBZ Limousine — Performance Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Hanken+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0d0d0f;font-family:'Hanken Grotesk',Arial,sans-serif;color:#fff;padding:24px}
.box{width:100%;max-width:360px;text-align:center}
.mark{margin-bottom:34px;line-height:1}
.mark .w{font-family:'Fraunces',Georgia,serif;font-weight:600;font-size:46px;letter-spacing:.06em}
.mark .rule{height:1px;background:#c0a35e;margin:7px auto 6px;width:140px}
.mark .sub{font-size:8.5px;letter-spacing:.26em;color:#cfd2d6}
h1{font-family:'Fraunces',Georgia,serif;font-weight:500;font-size:19px;margin-bottom:6px}
p.sub2{font-size:12px;color:#8a8d92;letter-spacing:.03em;margin-bottom:24px}
input{width:100%;font-family:inherit;font-size:14px;color:#fff;background:#161719;border:1px solid #2a2b2f;border-radius:8px;padding:12px 14px;text-align:center;letter-spacing:.04em}
input:focus{outline:none;border-color:#c0a35e}
button{width:100%;margin-top:12px;font-family:inherit;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#1a1208;background:#c0a35e;border:0;border-radius:8px;padding:12px;cursor:pointer}
button:hover{background:#cdb068}button:disabled{opacity:.6;cursor:default}
.err{min-height:18px;margin-top:12px;font-size:12px;color:#cf6b5f}
.foot{margin-top:30px;font-size:8px;letter-spacing:.28em;color:#54565b;text-transform:uppercase}
</style></head>
<body><div class="box">
<div class="mark"><div class="w">BBZ</div><div class="rule"></div><div class="sub">LIMOUSINE &amp; LIVERY SERVICE</div></div>
<h1>Performance Dashboard</h1><p class="sub2">Enter the password to view this report.</p>
<input id="pw" type="password" placeholder="Password" autofocus autocomplete="current-password">
<button id="go">View Report</button>
<div class="err" id="err"></div>
<div class="foot">Astoria Advertising Company</div>
</div>
<script>
var pw=document.getElementById('pw'),go=document.getElementById('go'),err=document.getElementById('err');
function submit(){err.textContent='';go.disabled=true;go.textContent='Checking...';
 fetch('/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:pw.value})})
 .then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j};});})
 .then(function(x){if(x.ok&&x.j&&x.j.ok){location.href='/';}else{err.textContent=(x.j&&x.j.error)||'Incorrect password.';go.disabled=false;go.textContent='View Report';pw.value='';pw.focus();}})
 .catch(function(){err.textContent='Something went wrong. Please try again.';go.disabled=false;go.textContent='View Report';});}
go.addEventListener('click',submit);
pw.addEventListener('keydown',function(e){if(e.key==='Enter')submit();});
</script></body></html>`;

// ----------------------------------------------------------------------------
// Windsor.ai REST pull. IMPORTANT: Windsor's API returns EVERY connected account
// by default (account selection in the UI does NOT scope the API). So we must
// scope every pull to BBZ explicitly. We do it two ways for safety:
//   1) server-side via the documented `filter` param: filter=[["account_id","eq",ID]]
//   2) client-side: drop any row whose account field != BBZ's id
// This guarantees another client's data can never bleed into BBZ's dashboard.
// ----------------------------------------------------------------------------
async function windsor(connector, account, fields, from, to, opts = {}) {
  const acctField = opts.acctField || 'account_id';
  const useServerFilter = opts.serverFilter !== false;   // some connectors (Search Console) ignore the filter and return nothing; those filter in code only
  const flds = (account && !fields.includes(acctField)) ? [acctField, ...fields] : fields;
  const params = new URLSearchParams();
  params.set('api_key', WINDSOR_KEY);
  params.set('date_from', from);
  params.set('date_to', to);
  params.set('fields', flds.join(','));
  params.set('_renderer', 'json');
  if (account && useServerFilter) params.set('filter', JSON.stringify([[acctField, 'eq', account]]));
  if (opts.date_filters) params.set('date_filters', JSON.stringify(opts.date_filters));
  const url = `https://connectors.windsor.ai/${connector}?` + params.toString();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000); // never let one source hang the refresh
  let r;
  try { r = await fetch(url, { signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
  if (!r.ok) throw new Error(connector + ' ' + r.status + ': ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  let rows = j.data || j;
  if (Array.isArray(rows) && account) rows = rows.filter(x => String(x[acctField]) === String(account));
  return rows;
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
// trailing-N-months start date (1st of the month N-1 months ago)
function trailingFrom(n) { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - (n - 1)); return d.toISOString().slice(0, 10); }

// Google Ads drill-down: campaign > ad group > keyword, per month. detail[ym][campaign][adGroup][keyword] = [clicks,impr,cost,conv].
// Pulled for the trailing 13 months so the keyword grain stays well under Windsor's response cap.
async function buildGadsDetail() {
  let rows;
  try {
    rows = await windsor('google_ads', GADS_ACCOUNT,
      ['year_month','campaign','ad_group_name','keyword_text','clicks','impressions','cost','conversions','search_impression_share'],
      trailingFrom(13), TO());
  } catch { return {}; }
  if (!Array.isArray(rows)) return {};
  const out = {};
  for (const r of rows) {
    const ym = normYM(r.year_month), c = r.campaign; if (!ym || !c) continue;
    const g = r.ad_group_name || '(no ad group)', k = r.keyword_text || '(no keyword)';
    const M = out[ym] || (out[ym] = {});
    const C = M[c] || (M[c] = {});
    const G = C[g] || (C[g] = {});
    const v = G[k] || (G[k] = [0,0,0,0,0,0]);
    const impr = +r.impressions||0, is = +r.search_impression_share||0; // is is a 0..1 ratio
    v[0]+=+r.clicks||0; v[1]+=impr; v[2]+=+r.cost||0; v[3]+=+r.conversions||0;
    if (is > 0) { v[4]+=impr/is; v[5]+=impr; } // v[4]=eligible impressions, v[5]=impressions that carried an IS value
  }
  return out;
}

// Meta drill-down: campaign > ad set > ad (with creative thumbnail), per month.
// detail[ym][campaign][adSet][ad] = [spend,leads,clicks,impr,thumbnailUrl].
async function buildMetaDetail() {
  let rows;
  try {
    rows = await windsor('facebook', META_ACCOUNT,
      ['year_month','campaign','adset_name','ad_name','thumbnail_url','spend','actions_lead','clicks','impressions'],
      trailingFrom(13), TO());
  } catch { return {}; }
  if (!Array.isArray(rows)) return {};
  const out = {};
  for (const r of rows) {
    const ym = normYM(r.year_month), c = r.campaign; if (!ym || !c) continue;
    const s = r.adset_name || '(no ad set)', a = r.ad_name || '(no ad)';
    const M = out[ym] || (out[ym] = {});
    const C = M[c] || (M[c] = {});
    const S = C[s] || (C[s] = {});
    const v = S[a] || (S[a] = [0,0,0,0,'']);
    v[0]+=+r.spend||0; v[1]+=+r.actions_lead||0; v[2]+=+r.clicks||0; v[3]+=+r.impressions||0;
    if (r.thumbnail_url) v[4] = r.thumbnail_url;
  }
  return out;
}

// Meta placement breakdown: clicks/impressions/spend by publisher platform, per month.
// placements[ym][platform] = [clicks, impressions, spend].
async function buildMetaPlacements() {
  let rows;
  try {
    rows = await windsor('facebook', META_ACCOUNT,
      ['year_month','publisher_platform','clicks','impressions','spend'],
      trailingFrom(13), TO());
  } catch { return {}; }
  if (!Array.isArray(rows)) return {};
  const out = {};
  for (const r of rows) {
    const ym = normYM(r.year_month), p = r.publisher_platform || 'unknown'; if (!ym) continue;
    const M = out[ym] || (out[ym] = {});
    const v = M[p] || (M[p] = [0,0,0]);
    v[0]+=+r.clicks||0; v[1]+=+r.impressions||0; v[2]+=+r.spend||0;
  }
  return out;
}

async function buildGads() {
  const base = buildPaid(
    await windsor('google_ads', GADS_ACCOUNT, ['year_month','campaign','clicks','impressions','cost','conversions'], FROM, TO()),
    ['clicks','impressions','cost','conversions']);
  base.detail = await buildGadsDetail();
  return base;
}
async function buildMeta() {
  const base = buildPaid(
    await windsor('facebook', META_ACCOUNT, ['year_month','campaign','clicks','impressions','spend','actions_lead','reach'], FROM, TO()),
    ['clicks','impressions','spend','actions_lead','reach']);
  base.detail = await buildMetaDetail();
  base.placements = await buildMetaPlacements();
  return base;
}

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
  if (!CALLRAIL_COMPANY) return { months: [], data: {}, empty: true };
  const d = new Date(); d.setMonth(d.getMonth() - (CALLRAIL_MONTHS - 1)); d.setDate(1);
  const from = d.toISOString().slice(0, 10);
  let rows;
  try {
    rows = await windsor('callrail', CALLRAIL_COMPANY,
      ['year_month','date','calls__id','calls__answered','calls__first_call','calls__source','calls__lead_status','calls__duration'],
      from, TO(), { acctField: 'calls__company_id', date_filters: { calls: 'calls__start_time' } });
  } catch { return { months: [], data: {}, empty: true }; }
  if (!Array.isArray(rows) || !rows.length) return { months: [], data: {}, empty: true };
  const isTrue = v => v === 'True' || v === true;
  const data = {}, sources = {}, daily = {}, months = new Set();
  for (const r of rows) {
    const ym = normYM(r.year_month); if (!ym) continue; months.add(ym);
    const ans = isTrue(r.calls__answered), fst = isTrue(r.calls__first_call);
    const cur = (data[ym] = data[ym] || [0,0,0,0,0]);
    cur[0] += 1; if (ans) cur[1] += 1; if (fst) cur[2] += 1;
    if (r.calls__lead_status === 'good_lead') cur[3] += 1;   // good_lead is CallRail's "qualified lead" flag
    cur[4] += +r.calls__duration || 0;                       // running total of call seconds, for the Avg Duration KPI
    const day = (r.date || '').slice(0, 10);
    if (day) { const dd = (daily[day] = daily[day] || [0,0,0]); dd[0] += 1; if (ans) dd[1] += 1; if (fst) dd[2] += 1; }
    const s = r.calls__source || 'Unknown';
    (sources[ym] = sources[ym] || {})[s] = (sources[ym][s] || 0) + 1;
  }
  const out = { months: [...months].sort(), data, sources, daily };
  out.log = await buildCallRailLog();
  return out;
}

// Recent call log (trailing 30 days) with per-call detail. Kept short so the response stays well under cap.
async function buildCallRailLog() {
  const d = new Date(); d.setDate(d.getDate() - 30);
  const from = d.toISOString().slice(0, 10);
  let rows;
  try {
    rows = await windsor('callrail', CALLRAIL_COMPANY,
      ['calls__start_time','calls__source','calls__duration','calls__answered','calls__first_call','calls__customer_city','calls__customer_state','calls__direction','calls__customer_name','calls__customer_phone_number','calls__keywords','calls__lead_status'],
      from, TO(), { acctField: 'calls__company_id', date_filters: { calls: 'calls__start_time' } });
  } catch { return []; }
  if (!Array.isArray(rows)) return [];
  const isTrue = v => v === 'True' || v === true;
  const log = rows.map(r => ({
    t: r.calls__start_time || '',
    s: r.calls__source || 'Unknown',
    d: +r.calls__duration || 0,
    a: isTrue(r.calls__answered),
    f: isTrue(r.calls__first_call),
    c: [r.calls__customer_city, r.calls__customer_state].filter(Boolean).join(', '),
    dir: r.calls__direction || '',
    n: r.calls__customer_name || '',
    p: r.calls__customer_phone_number || '',
    kw: r.calls__keywords || '',
    ls: r.calls__lead_status || ''
  })).filter(x => x.t).sort((a, b) => (a.t < b.t ? 1 : -1));
  return log.slice(0, 300);
}

// Search Console — Windsor `searchconsole` connector. Monthly [clicks, impressions, avg position].
// Google caps history at ~16 months, so clamp the start date.
async function buildGSC() {
  const d = new Date(); d.setMonth(d.getMonth() - 15);
  const from = d.toISOString().slice(0, 10);
  const data = {}, months = new Set();
  try {
    const rows = await windsor('searchconsole', GSC_ACCOUNT, ['year_month','clicks','impressions','position'], from, TO(), { serverFilter: false });
    if (Array.isArray(rows)) for (const r of rows) {
      const ym = normYM(r.year_month); if (!ym) continue;
      months.add(ym);
      data[ym] = [+r.clicks || 0, +r.impressions || 0, +r.position || 0];
    }
  } catch (e) { console.error('GSC totals:', e.message); }
  const out = { months: [...months].sort(), data };
  try { out.queries = await buildGSCQueries(); } catch (e) { console.error('GSC queries:', e.message); out.queries = {}; }
  if (!out.months.length && !Object.keys(out.queries).length) out.empty = true;
  return out;
}

// Search Console query-level, per month. queries[ym][queryText] = [clicks, impressions, position].
// account_id is NOT filterable server-side for Search Console, so we pull one month at a time (each
// month's all-property response is small) and code-filter to bbzlimo.com inside windsor(). Pulled in
// small batches so we don't trip Windsor's concurrency/rate limits (which would empty the whole section).
async function buildGSCQueries() {
  const N = 12, BATCH = 4, now = new Date(), out = {};
  const specs = [];
  for (let i = 0; i < N; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    specs.push({
      from: d.toISOString().slice(0, 10),
      end: new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10),
      ym: ('' + d.getFullYear()) + String(d.getMonth() + 1).padStart(2, '0'),
    });
  }
  for (let i = 0; i < specs.length; i += BATCH) {
    const slice = specs.slice(i, i + BATCH);
    const res = await Promise.all(slice.map(s =>
      windsor('searchconsole', GSC_ACCOUNT, ['account_id','query','clicks','impressions','position'], s.from, s.end, { serverFilter: false })
        .then(rows => ({ ym: s.ym, rows })).catch(() => ({ ym: s.ym, rows: [] }))
    ));
    for (const { ym, rows } of res) {
      if (!Array.isArray(rows) || !rows.length) continue;
      const Q = {};
      for (const r of rows) {
        const q = r.query; if (!q) continue;
        const v = Q[q] || (Q[q] = [0, 0, 0]);
        v[0] += +r.clicks || 0; v[1] += +r.impressions || 0; v[2] = +r.position || v[2];
      }
      out[ym] = Q;
    }
  }
  return out;
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

// ---------------------------------------------------------------------------
// Optional password gate. Set DASH_PASSWORD on the server to require a password
// before the report (and its data endpoints) can be viewed. Leave it unset to
// keep the report open. The plaintext password is never stored in the cookie;
// we store a one-way hash of it and re-derive + compare on every request.
// ---------------------------------------------------------------------------
const AUTH_TOKEN = DASH_PASSWORD ? crypto.createHash('sha256').update('bbz::' + DASH_PASSWORD).digest('hex') : '';
function parseCookies(h) { const o = {}; (h || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = p.slice(i + 1).trim(); }); return o; }
function isAuthed(req) { if (!DASH_PASSWORD) return true; return parseCookies(req.headers.cookie).bbz_auth === AUTH_TOKEN; }

// Public: accept the password and set the auth cookie. (Registered BEFORE the gate, so it stays reachable.)
app.post('/login', (req, res) => {
  if (!DASH_PASSWORD) return res.json({ ok: true });
  const pw = (req.body && req.body.password) || '';
  if (pw === DASH_PASSWORD) {
    res.set('Set-Cookie', `bbz_auth=${AUTH_TOKEN}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax; Secure`);
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: 'Incorrect password.' });
});

// Gate everything below: serve the login screen for page views, 401 for API calls.
app.use((req, res, next) => {
  if (isAuthed(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Authentication required.' });
  res.set('Cache-Control', 'no-store').type('html').send(LOGIN_PAGE);
});

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


// ---- AI marketing analysis: all six section notes + summary in ONE cached call ----
const analysisCache = new Map();
app.post('/api/analyze', async (req, res) => {
  if (!ANTHROPIC_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set on the server.' });
  const { context } = req.body || {};
  if (!context) return res.status(400).json({ error: 'Missing context.' });
  if (analysisCache.has(context)) return res.json(analysisCache.get(context));
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 1500, messages: [{ role: 'user', content:
        `You are a senior marketing analyst at Astoria Advertising Company reviewing BBZ Limousine's live performance `
        + `data for the current reporting window. Using ONLY the data below, write a brief marketing read for each `
        + `channel: what the numbers indicate and the single most useful next action. Be specific with figures, plain `
        + `spoken, no jargon, no markdown, 2 to 3 sentences each. Do not use em dashes.\n\n${context}\n\n`
        + `Respond with ONLY a JSON object (no preamble, no code fences) with exactly these keys: `
        + `"ga4", "gads", "meta", "gbp", "callrail", "searchconsole" (each a 2 to 3 sentence string), `
        + `"summary" (a 2 to 3 sentence executive takeaway string across all channels), and `
        + `"actions" (an array of 4 to 6 short, specific, prioritized action item strings drawn from across all `
        + `channels, each starting with a verb and referencing concrete figures or names where useful, most important first). `
        + `If a channel shows no data, give a one sentence note that it is not yet reporting.` }] })
    });
    const j = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: j });
    let txt = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    txt = txt.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
    let out; try { out = JSON.parse(txt); } catch { out = { summary: txt }; }
    analysisCache.set(context, out);
    if (analysisCache.size > 50) analysisCache.delete(analysisCache.keys().next().value);
    res.json(out);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});


// Railway / local: listen.  Vercel: the app is exported and invoked per-request.
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log('BBZ dashboard on http://localhost:' + PORT));
  warm(); // pre-pull live data at startup so the first visit is already live
}
export default app;
