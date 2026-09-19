// Live probe: run the Evidence Engine against real Catalyst Pit data and find tickers that
// demonstrate each evidence pattern. Read-only.
//
// Run: node --env-file=.env.local --import ./scripts/real-db-register.mjs scripts/probe-evidence-live.mjs

import { neon } from '@neondatabase/serverless';
import { tickerEvidence, coverageBoundaries } from '../src/lib/evidence/resolve.js';

const sql = neon(process.env.DATABASE_URL);
const NOW = Date.now();
const DAY = 86400e3;

const line = (s = '') => console.log(s);
const head = (s) => { line(); line('='.repeat(72)); line(s); line('='.repeat(72)); };

head('COVERAGE BOUNDARIES (what our rarity claims are measured against)');
const cov = await coverageBoundaries({ now: NOW });
for (const [k, v] of Object.entries(cov)) {
  line(`  ${k.padEnd(14)} ${v ? new Date(v).toISOString().slice(0, 10) : '(unknown — no rarity claims)'}`
    + (v ? `   ~${Math.floor((NOW - v) / DAY / 365 * 10) / 10} years` : ''));
}

// ── find real candidates for each pattern ────────────────────────────────────
head('CANDIDATE TICKERS BY PATTERN (from live tables)');

const q = async (label, text) => {
  try {
    const r = await sql.query(text);
    line(`\n${label}`);
    if (!r.length) { line('  (none)'); return []; }
    for (const row of r.slice(0, 6)) line('  ' + JSON.stringify(row));
    return r;
  } catch (e) { line(`\n${label}\n  ERROR ${e.message}`); return []; }
};

const insiderCands = await q('A. Officer open-market purchases (code P, non-derivative), last 45d', `
  select ticker, count(*) n, count(distinct executive) execs, max(filing_date) last
    from insider_trades
   where transaction_code = 'P' and coalesce(is_derivative,false) = false
     and filing_date >= current_date - 45 and total_value > 0
   group by ticker order by execs desc, n desc limit 8`);

const catalystCands = await q('B. Material 8-K filings, last 20d', `
  select ticker, count(*) n, max(filed_at) last, string_agg(distinct items, ' | ') items
    from eightk_filings
   where material = true and filed_at >= now() - interval '20 days'
   group by ticker order by n desc limit 8`);

const congressCands = await q('C. Congressional disclosures, last 45d', `
  select ticker, count(*) n, count(distinct member_slug) members, max(disclosure_date) last
    from congress_trades
   where disclosure_date >= current_date - 45 and ticker is not null
   group by ticker order by members desc, n desc limit 8`);

const instCands = await q('D. Largest recent 13F breadth swings', `
  with q as (select max(quarter) q0 from fund_holdings),
  cur as (select ticker, count(distinct cik) b from fund_holdings, q
          where quarter = q.q0 and put_call = '' and ticker is not null group by ticker),
  prv as (select h.ticker, count(distinct h.cik) b from fund_holdings h
          where h.quarter = (select max(quarter) from fund_holdings where quarter < (select q0 from q))
            and h.put_call = '' and h.ticker is not null group by h.ticker)
  select cur.ticker, prv.b as prev_breadth, cur.b as breadth, (cur.b - prv.b) as delta
    from cur join prv on prv.ticker = cur.ticker
   where prv.b >= 20 order by abs(cur.b - prv.b) desc limit 8`);

// E: multiple families at once
const multi = await q('E. Tickers with MULTIPLE evidence families active in the last 45d', `
  with i as (select distinct ticker from insider_trades
              where transaction_code='P' and filing_date >= current_date - 45 and total_value > 0),
       k as (select distinct ticker from eightk_filings
              where material and filed_at >= now() - interval '45 days'),
       c as (select distinct ticker from congress_trades
              where disclosure_date >= current_date - 45 and ticker is not null)
  select coalesce(i.ticker,k.ticker,c.ticker) ticker,
         (i.ticker is not null)::int insider, (k.ticker is not null)::int catalyst, (c.ticker is not null)::int congress
    from i full join k on k.ticker=i.ticker full join c on c.ticker=coalesce(i.ticker,k.ticker)
   where (i.ticker is not null)::int + (k.ticker is not null)::int + (c.ticker is not null)::int >= 2
   limit 10`);

// ── run the engine on the picks ──────────────────────────────────────────────
const picks = [...new Set([
  ...multi.map((r) => r.ticker),
  ...insiderCands.map((r) => r.ticker),
  ...catalystCands.map((r) => r.ticker),
  ...congressCands.map((r) => r.ticker),
  ...instCands.map((r) => r.ticker),
].filter(Boolean))].slice(0, 12);

head(`EVIDENCE ENGINE OUTPUT — ${picks.length} real tickers`);
for (const t of picks) {
  const t0 = Date.now();
  let res;
  try { res = await tickerEvidence(t, { now: NOW }); }
  catch (e) { line(`\n### ${t}  ENGINE ERROR: ${e.message}`); continue; }
  const ms = Date.now() - t0;
  line(`\n### ${t}   (${res.evidence.length} items, ${ms}ms)`
    + (res.failedFamilies.length ? `  FAILED: ${JSON.stringify(res.failedFamilies)}` : '')
    + (res.quarantined.length ? `  QUARANTINED: ${JSON.stringify(res.quarantined)}` : ''));
  for (const e of res.evidence) {
    const age = Math.floor((NOW - new Date(e.publicTime).getTime()) / DAY);
    line(`  [${e.family.toUpperCase().padEnd(11)}] ${e.summary}`);
    line(`      type=${e.type}  public=${String(e.publicTime).slice(0, 10)} (${age}d)`
      + (e.eventTime ? `  event=${String(e.eventTime).slice(0, 10)}` : '')
      + (e.referencePeriod ? `  period=${e.referencePeriod}` : ''));
    if (e.context?.text) line(`      CONTEXT: ${e.context.text}`);
    if (e.url) line(`      ${e.url.slice(0, 100)}`);
  }
}

line('\ndone');
