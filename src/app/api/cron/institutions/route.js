import { db } from '../../../../lib/db';
import { fundHoldings, fundFilings } from '../../../../lib/schema';
import { INSTITUTIONS } from '../../../../lib/institutions.mjs';
import { and, eq, sql, inArray } from 'drizzle-orm';
import { auth, clerkClient } from '@clerk/nextjs/server';

export const runtime = 'nodejs';
export const maxDuration = 300;

// Institutions ingestion (13F-HR). Per fund: resolve+verify CIK → pull latest 2 quarters of
// 13F-HR from EDGAR → parse the info table → store holdings + a per-quarter summary. Then a
// bounded pass resolves top CUSIPs→tickers via OpenFIGI (cached). Idempotent: a (cik,quarter)
// already in fund_filings is skipped, so multiple runs progressively fill the slate.
const KV_TOKEN    = process.env.KV_REST_API_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;
const OPENFIGI_KEY = process.env.OPENFIGI_API_KEY;   // optional — higher OpenFIGI rate/batch
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;         // enables the in-app admin import trigger

// True when the signed-in user is the configured admin (for manual imports without the cron secret).
async function isAdmin() {
  try {
    const { userId } = await auth();
    if (!userId || !ADMIN_EMAIL) return false;
    const u = await (await clerkClient()).users.getUser(userId);
    const email = u.emailAddresses.find((e) => e.id === u.primaryEmailAddressId)?.emailAddress || u.emailAddresses[0]?.emailAddress;
    return !!email && email.toLowerCase() === ADMIN_EMAIL.toLowerCase();
  } catch { return false; }
}
const KV_BASE     = 'https://powerful-grouper-86116.upstash.io';
const SEC_HEADERS = { 'User-Agent': 'CatalystPit contact@catalystpit.com', 'Accept-Encoding': 'gzip, deflate' };

const TIME_BUDGET_MS = 250000;   // stop starting new funds past this (leaves room to finish + tickers)
const TICKER_BUDGET  = 400;      // max CUSIP→ticker lookups per run
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad10 = (c) => String(c).replace(/\D/g, '').padStart(10, '0');
const unpad = (c) => String(Number(String(c).replace(/\D/g, '')));

async function kvGet(key) {
  try {
    const r = await fetch(`${KV_BASE}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
    if (!r.ok) return null;
    return (await r.json())?.result ?? null;
  } catch { return null; }
}
async function kvSet(key, value, ttl) {
  try {
    await fetch(`${KV_BASE}/set/${encodeURIComponent(key)}${ttl ? `?ex=${ttl}` : ''}`, {
      method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'text/plain' }, body: String(value),
    });
  } catch { /* non-fatal */ }
}

async function secJson(url) { try { const r = await fetch(url, { headers: SEC_HEADERS }); return r.ok ? await r.json() : null; } catch { return null; } }
async function secText(url) { try { const r = await fetch(url, { headers: SEC_HEADERS }); return r.ok ? await r.text() : null; } catch { return null; } }

const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Resolve + verify a fund's CIK. Prefers the seeded cik; else EDGAR company search by secName.
// Verified against submissions (must file 13F-HR). Returns { cik, entityName } or null (logged).
async function resolveCik(fund) {
  const cached = await kvGet(`catalystpit:inst:cik:${fund.slug}`);
  let cik = fund.cik ? unpad(fund.cik) : (cached || null);

  if (!cik) {
    // EDGAR company search matches on a "starts-with" of the entity name, so search WITHOUT the
    // trailing legal suffix (LLC / L.P. / LTD / Inc …) — those often differ from what EDGAR stores.
    const q = String(fund.secName || '').replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim()
      .replace(/\s+(l\s*p|llc|llp|inc|ltd|corp|co|lllp)\s*$/i, '').trim();
    for (const name of [q, fund.secName]) {
      const atom = await secText(`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=${encodeURIComponent(name)}&type=13F-HR&dateb=&owner=include&count=10&output=atom`);
      const m = atom && (atom.match(/<cik>(\d+)<\/cik>/i) || atom.match(/CIK=(\d{4,10})/i));
      if (m) { cik = unpad(m[1]); break; }
      await sleep(120);
    }
  }
  if (!cik) return null;

  const sub = await secJson(`https://data.sec.gov/submissions/CIK${pad10(cik)}.json`);
  if (!sub) return null;
  const forms = sub.filings?.recent?.form || [];
  if (!forms.some((f) => String(f).startsWith('13F-HR'))) {
    console.log(`[institutions] ${fund.slug}: CIK ${cik} (${sub.name}) files no 13F-HR — skipped`);
    return null;
  }
  // Soft name check — log if the entity looks unrelated (helps catch a wrong seeded CIK).
  if (normName(sub.name).slice(0, 6) && !normName(sub.name).includes(normName(fund.label).slice(0, 5)) &&
      !normName(fund.secName).includes(normName(sub.name).slice(0, 5))) {
    console.log(`[institutions] ${fund.slug}: NAME CHECK — cik ${cik} resolves to "${sub.name}" (expected ~"${fund.secName}")`);
  }
  await kvSet(`catalystpit:inst:cik:${fund.slug}`, cik, 30 * 24 * 3600);
  return { cik, entityName: sub.name, sub };
}

// Latest N distinct-quarter 13F-HR filings from a submissions payload.
function latest13F(sub, n = 2) {
  const R = sub.filings?.recent || {};
  const out = [];
  const seen = new Set();
  for (let i = 0; i < (R.form || []).length; i++) {
    if (!String(R.form[i]).startsWith('13F-HR')) continue;   // includes 13F-HR and 13F-HR/A
    const quarter = R.reportDate?.[i];
    if (!quarter || seen.has(quarter)) continue;
    seen.add(quarter);
    out.push({ accession: R.accessionNumber[i], quarter, filedDate: R.filingDate[i] });
    if (out.length >= n) break;
  }
  return out;
}

// Parse a 13F info table into positions. Namespace-tolerant regex (tags may be prefixed).
function parseInfoTable(xml, wholeDollars) {
  const tag = (block, name) => {
    const m = block.match(new RegExp(`<(?:\\w+:)?${name}>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'i'));
    return m ? m[1].trim() : '';
  };
  const rows = [];
  const blocks = xml.match(/<(?:\w+:)?infoTable>[\s\S]*?<\/(?:\w+:)?infoTable>/gi) || [];
  for (const b of blocks) {
    const cusip = tag(b, 'cusip').toUpperCase();
    if (!cusip) continue;
    const rawValue = parseFloat(tag(b, 'value').replace(/,/g, '')) || 0;
    const shares = parseFloat(tag(b, 'sshPrnamt').replace(/,/g, '')) || 0;
    rows.push({
      issuer:  tag(b, 'nameOfIssuer'),
      cls:     tag(b, 'titleOfClass') || '',
      cusip,
      value:   wholeDollars ? rawValue : rawValue * 1000,   // pre-2023 filings reported $thousands
      shares,
      putCall: tag(b, 'putCall') || '',
    });
  }
  return rows;
}

// Fetch + parse one 13F filing's info table.
async function fetchHoldings(cik, accession, filedDate) {
  const accNoDash = accession.replace(/-/g, '');
  const idx = await secJson(`https://www.sec.gov/Archives/edgar/data/${unpad(cik)}/${accNoDash}/index.json`);
  const items = idx?.directory?.item || [];
  const xmls = items.filter((it) => /\.xml$/i.test(it.name) && !/primary_doc\.xml$/i.test(it.name));
  const wholeDollars = String(filedDate) >= '2023-01-01';
  for (const it of xmls) {
    await sleep(120);
    const xml = await secText(`https://www.sec.gov/Archives/edgar/data/${unpad(cik)}/${accNoDash}/${it.name}`);
    if (xml && /<(?:\w+:)?infoTable>/i.test(xml)) return parseInfoTable(xml, wholeDollars);
  }
  return [];
}

async function storeFiling(cik, quarter, filedDate, accession, rows) {
  // Chunked insert (giants have thousands of rows). Dedup via the unique index.
  const values = rows.map((r) => ({
    cik, quarter, cusip: r.cusip, ticker: null, issuer: r.issuer, cls: r.cls,
    shares: r.shares, value: r.value, putCall: r.putCall, filedDate,
  }));
  for (let i = 0; i < values.length; i += 500) {
    await db.insert(fundHoldings).values(values.slice(i, i + 500)).onConflictDoNothing();
  }
  const totalValue = rows.reduce((s, r) => s + (r.value || 0), 0);
  await db.insert(fundFilings)
    .values({ cik, quarter, filedDate, accession, totalValue, holdingsCount: rows.length })
    .onConflictDoNothing();
}

// OpenFIGI CUSIP→ticker, batched + KV-cached. Returns Map(cusip→ticker|'').
const US_EXCH = new Set(['US', 'UN', 'UW', 'UQ', 'UA', 'UR', 'UP', 'UV', 'UF', 'UD']);
async function resolveTickers(cusips) {
  const out = new Map();
  const need = [];
  for (const c of cusips) {
    const hit = await kvGet(`catalystpit:cusip:${c}`);
    if (hit != null) out.set(c, hit); else need.push(c);
  }
  const batchSize = OPENFIGI_KEY ? 100 : 10;
  for (let i = 0; i < need.length; i += batchSize) {
    const batch = need.slice(i, i + batchSize);
    try {
      const r = await fetch('https://api.openfigi.com/v3/mapping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(OPENFIGI_KEY ? { 'X-OPENFIGI-APIKEY': OPENFIGI_KEY } : {}) },
        body: JSON.stringify(batch.map((c) => ({ idType: 'ID_CUSIP', idValue: c }))),
      });
      if (r.ok) {
        const arr = await r.json();
        arr.forEach((res, j) => {
          const c = batch[j];
          const pick = (res.data || []).find((d) => US_EXCH.has(d.exchCode)) || (res.data || [])[0];
          const t = pick?.ticker ? String(pick.ticker).toUpperCase() : '';
          out.set(c, t);
          if (t) kvSet(`catalystpit:cusip:${c}`, t, 90 * 24 * 3600);   // cache positives 90d
        });
      }
    } catch { /* skip batch */ }
    await sleep(OPENFIGI_KEY ? 300 : 2600);   // respect rate limits (250/min keyed, ~25/min anon)
  }
  return out;
}

// Self-bootstrap the tables so the feature works without a separate manual migration.
// All IF NOT EXISTS → safe to run every time; no data loss.
async function ensureTables() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS fund_holdings (
    id serial PRIMARY KEY, cik text NOT NULL, quarter date NOT NULL, cusip text NOT NULL,
    ticker text, issuer text, class text NOT NULL DEFAULT '', shares double precision,
    value double precision, put_call text NOT NULL DEFAULT '', filed_date date,
    inserted_at timestamptz NOT NULL DEFAULT now())`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_fund_holding ON fund_holdings (cik, quarter, cusip, class, put_call)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_fund_holdings_cik_quarter ON fund_holdings (cik, quarter)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_fund_holdings_ticker ON fund_holdings (ticker)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_fund_holdings_cusip ON fund_holdings (cusip)`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS fund_filings (
    cik text NOT NULL, quarter date NOT NULL, filed_date date, accession text,
    total_value double precision, holdings_count integer,
    inserted_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (cik, quarter))`);
}

export async function GET(request) {
  const onlySlug = new URL(request.url).searchParams.get('fund');   // ?fund=slug imports one fund
  const isVercelCron = request.headers.get('x-vercel-cron') === '1';
  let authorized = isVercelCron || request.headers.get('authorization') === `Bearer ${CRON_SECRET}`;
  // Manual trigger (single or full-slate) allowed for the configured admin only — imports are heavy
  // and sign-ups are public, so this must not be open to any signed-in user.
  if (!authorized) authorized = await isAdmin();
  if (!authorized) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  try { await ensureTables(); } catch (e) { console.log(`[institutions] ensureTables failed: ${e.message}`); return Response.json({ ok: false, error: `ensureTables: ${e.message}` }, { status: 500 }); }

  const startedAt = Date.now();
  const tickerBudget = onlySlug ? 150 : TICKER_BUDGET;   // resolve tickers on manual runs too (single funds are small)
  const funds = onlySlug ? INSTITUTIONS.filter((f) => f.slug === onlySlug) : INSTITUTIONS;

  const done = [], skipped = [];
  for (const fund of funds) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) { skipped.push(`${fund.slug}(time)`); continue; }
    try {
      const resolved = await resolveCik(fund);
      if (!resolved) { skipped.push(`${fund.slug}(no-cik)`); continue; }
      const { cik, sub } = resolved;
      const filings = latest13F(sub, 2);
      let ingested = 0;
      for (const f of filings) {
        const existing = await db.select({ cik: fundFilings.cik }).from(fundFilings)
          .where(and(eq(fundFilings.cik, cik), eq(fundFilings.quarter, f.quarter))).limit(1);
        if (existing.length) continue;   // idempotent
        const rows = await fetchHoldings(cik, f.accession, f.filedDate);
        if (rows.length) { await storeFiling(cik, f.quarter, f.filedDate, f.accession, rows); ingested += rows.length; }
        await sleep(150);
      }
      done.push(`${fund.slug}:${resolved.entityName}(${ingested})`);
    } catch (e) {
      skipped.push(`${fund.slug}(err:${e.message.slice(0, 120)})`);
    }
  }

  // Bounded ticker resolution: highest-value unresolved CUSIPs first. (Skipped on manual runs.)
  let tickersResolved = 0;
  try {
    const rows = await db.select({ cusip: fundHoldings.cusip, v: sql`max(${fundHoldings.value})`.mapWith(Number) })
      .from(fundHoldings).where(sql`${fundHoldings.ticker} is null`)
      .groupBy(fundHoldings.cusip).orderBy(sql`max(${fundHoldings.value}) desc`).limit(tickerBudget);
    if (rows.length) {
      const map = await resolveTickers(rows.map((r) => r.cusip));
      for (const [cusip, ticker] of map) {
        if (!ticker) continue;
        await db.update(fundHoldings).set({ ticker })
          .where(and(eq(fundHoldings.cusip, cusip), sql`${fundHoldings.ticker} is null`));
        tickersResolved++;
      }
    }
  } catch (e) { console.log(`[institutions] ticker pass error: ${e.message}`); }

  const summary = { ok: true, funds: funds.length, done: done.length, skipped, tickersResolved, ms: Date.now() - startedAt };
  console.log(`[institutions] ${JSON.stringify(summary)}`);
  return Response.json(summary);
}
