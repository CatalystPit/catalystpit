import { sql, and, eq, desc, inArray, gte } from 'drizzle-orm';
import { db } from './db';
import { eightkFilings } from './schema';

// 8-K Catalyst Wire — pulls SEC EDGAR's market-wide "current 8-K" stream (same free/official
// pattern as the Form 4 insider feed), resolves each filing's ticker + item codes via the
// per-company submissions API, classifies material vs routine, and stores them. Read by
// /api/eightk (News rail + Terminal panel). No paid data.

const SEC_HEADERS = { 'User-Agent': 'CatalystPit contact@catalystpit.com', 'Accept-Encoding': 'gzip, deflate' };
const PAGES = 3;                 // getcurrent pages (start 0/100/200) → ~300 recent 8-Ks scanned
const MAX_NEW = 40;              // cap detail fetches per run (submissions JSON is heavy)

// SEC 8-K item codes → short label + whether it's a material catalyst (the wire's default view).
// Reference: SEC Form 8-K General Instructions. Unknown codes fall back to "Item X.XX" / routine.
const ITEM_MAP = {
  '1.01': { label: 'Material agreement', material: true },
  '1.02': { label: 'Agreement terminated', material: true },
  '1.03': { label: 'Bankruptcy', material: true },
  '1.04': { label: 'Mine safety', material: false },
  '1.05': { label: 'Cybersecurity incident', material: true },
  '2.01': { label: 'M&A completed', material: true },
  '2.02': { label: 'Earnings', material: true },
  '2.03': { label: 'New debt obligation', material: true },
  '2.04': { label: 'Debt trigger event', material: true },
  '2.05': { label: 'Restructuring costs', material: true },
  '2.06': { label: 'Material impairment', material: true },
  '3.01': { label: 'Delisting risk', material: true },
  '3.02': { label: 'Equity dilution', material: true },
  '3.03': { label: 'Security-holder rights', material: false },
  '4.01': { label: 'Auditor change', material: true },
  '4.02': { label: 'Financial restatement', material: true },
  '5.01': { label: 'Change in control', material: true },
  '5.02': { label: 'Exec / board change', material: true },
  '5.03': { label: 'Bylaw amendment', material: false },
  '5.04': { label: 'Trading blackout', material: false },
  '5.05': { label: 'Ethics code change', material: false },
  '5.06': { label: 'Shell-status change', material: true },
  '5.07': { label: 'Shareholder vote', material: false },
  '5.08': { label: 'Director nominations', material: false },
  '6.01': { label: 'ABS disclosure', material: false },
  '6.02': { label: 'ABS servicer change', material: false },
  '6.03': { label: 'ABS credit enhancement', material: false },
  '6.04': { label: 'ABS distribution failure', material: false },
  '6.05': { label: 'ABS securities acted upon', material: false },
  '7.01': { label: 'Reg FD disclosure', material: false },
  '8.01': { label: 'Other event', material: false },
  '9.01': { label: 'Exhibits', material: false },
};

// "2.02,9.01" (or space/semicolon separated) → { codes, labels, material, primaryLabel }
export function classifyItems(itemsCsv) {
  const codes = String(itemsCsv || '').split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  const seen = new Set();
  const detail = [];
  for (const c of codes) {
    if (seen.has(c)) continue;
    seen.add(c);
    detail.push({ code: c, ...(ITEM_MAP[c] || { label: `Item ${c}`, material: false }) });
  }
  const material = detail.some((d) => d.material);
  // Prefer a material item for the headline label; drop the ubiquitous 9.01 (exhibits) from display.
  const display = detail.filter((d) => d.code !== '9.01');
  const primary = display.find((d) => d.material) || display[0] || detail[0] || null;
  return {
    codes,
    labels: (display.length ? display : detail).map((d) => d.label),
    material,
    primaryLabel: primary ? primary.label : 'Filing',
  };
}

let _ensured = false;
export async function ensureEightkTable() {
  if (_ensured) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS eightk_filings (
    id SERIAL PRIMARY KEY,
    ticker TEXT NOT NULL,
    company TEXT,
    cik TEXT NOT NULL,
    items TEXT,
    material BOOLEAN NOT NULL DEFAULT FALSE,
    primary_doc_url TEXT,
    filing_url TEXT,
    report_date DATE,
    accession TEXT NOT NULL,
    filed_at TIMESTAMPTZ NOT NULL,
    inserted_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_eightk_accession ON eightk_filings (accession)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_eightk_filed_at ON eightk_filings (filed_at)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_eightk_material_filed ON eightk_filings (material, filed_at)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_eightk_ticker ON eightk_filings (ticker)`);
  _ensured = true;
}

const pad10 = (cik) => String(cik).padStart(10, '0');

// Pull one company's submissions and extract the fields we need for a specific accession.
async function submissionDetail(cik, accession, cache) {
  if (cache.has(cik)) return cache.get(cik)?.(accession);
  let lookup = () => null;
  try {
    const r = await fetch(`https://data.sec.gov/submissions/CIK${pad10(cik)}.json`, { headers: SEC_HEADERS });
    if (r.ok) {
      const sub = await r.json();
      const ticker = (sub.tickers && sub.tickers[0]) ? String(sub.tickers[0]).toUpperCase() : null;
      const name = sub.name || null;
      const rec = sub.filings?.recent || {};
      const accs = rec.accessionNumber || [];
      lookup = (acc) => {
        const i = accs.indexOf(acc);
        if (i < 0) return { ticker, name, items: null, primaryDocument: null, reportDate: null };
        return { ticker, name, items: rec.items?.[i] || null, primaryDocument: rec.primaryDocument?.[i] || null, reportDate: rec.reportDate?.[i] || null };
      };
    }
  } catch { /* leave lookup as null-return */ }
  cache.set(cik, lookup);
  return lookup(accession);
}

// Ingest the market-wide current 8-K stream. Returns { scanned, inserted }.
export async function ingestEightK() {
  await ensureEightkTable();

  // 1) Scan the getcurrent 8-K stream (paginated), de-duped by accession.
  const filings = new Map();
  for (let p = 0; p < PAGES; p++) {
    let atomXml;
    try {
      const res = await fetch(
        `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&dateb=&owner=include&count=100&start=${p * 100}&output=atom`,
        { headers: SEC_HEADERS }
      );
      if (!res.ok) break;
      atomXml = await res.text();
    } catch { break; }
    const entries = [...atomXml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
    if (entries.length === 0) break;
    let added = 0;
    for (const entry of entries) {
      const link = entry.match(/<link[^>]+href="([^"]+)"/)?.[1] || '';
      const lm = link.match(/\/data\/(\d+)\/(\d+)\/([\d-]+)-index\.html?/);
      if (!lm) continue;
      const [, cik, accNoDashes, accession] = lm;
      if (filings.has(accession)) continue;
      const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '';
      const company = title.replace(/^8-K(\/A)?\s*-\s*/i, '').replace(/\s*\(\d+\)\s*\(Filer\)\s*$/i, '').trim();
      const filedAt = entry.match(/<updated>(.*?)<\/updated>/)?.[1] || null;
      filings.set(accession, { cik, accNoDashes, accession, company, filedAt, filingUrl: link.startsWith('http') ? link : `https://www.sec.gov${link}` });
      added++;
    }
    if (added === 0 && p > 0) break;
  }

  // 2) Drop accessions we already stored; cap the rest.
  let candidates = Array.from(filings.values());
  const scanned = candidates.length;
  if (candidates.length) {
    const known = await db.select({ accession: eightkFilings.accession })
      .from(eightkFilings)
      .where(inArray(eightkFilings.accession, candidates.map((f) => f.accession)));
    const knownSet = new Set(known.map((k) => k.accession));
    candidates = candidates.filter((f) => !knownSet.has(f.accession));
  }
  candidates = candidates.slice(0, MAX_NEW);

  // 3) Resolve ticker + items per new filing (submissions API), classify, collect rows.
  const cache = new Map();
  const rows = [];
  for (const f of candidates) {
    const d = await submissionDetail(f.cik, f.accession, cache);
    if (!d || !d.ticker) continue;                 // no ticker → not a tradeable name; skip
    const cls = classifyItems(d.items);
    const cikUnpadded = String(Number(f.cik));
    rows.push({
      ticker: d.ticker,
      company: d.name || f.company || null,
      cik: f.cik,
      items: d.items || null,
      material: cls.material,
      primaryDocUrl: d.primaryDocument ? `https://www.sec.gov/Archives/edgar/data/${cikUnpadded}/${f.accNoDashes}/${d.primaryDocument}` : null,
      filingUrl: f.filingUrl,
      reportDate: d.reportDate || null,
      accession: f.accession,
      filedAt: f.filedAt ? new Date(f.filedAt) : new Date(),
    });
  }

  let inserted = 0;
  if (rows.length) {
    const res = await db.insert(eightkFilings).values(rows).onConflictDoNothing({ target: eightkFilings.accession }).returning({ id: eightkFilings.id });
    inserted = res.length;
  }
  return { scanned, inserted };
}

// Read recent filings for the wire. materialOnly=true → default catalyst view.
export async function recentEightK({ materialOnly = true, limit = 40, days = 7 } = {}) {
  await ensureEightkTable();
  const since = sql`now() - make_interval(days => ${days})`;
  const where = materialOnly
    ? and(eq(eightkFilings.material, true), gte(eightkFilings.filedAt, since))
    : gte(eightkFilings.filedAt, since);
  const rows = await db.select().from(eightkFilings).where(where).orderBy(desc(eightkFilings.filedAt)).limit(limit);
  return rows.map((r) => {
    const cls = classifyItems(r.items);
    return {
      ticker: r.ticker,
      company: r.company,
      items: cls.labels,
      primaryLabel: cls.primaryLabel,
      material: r.material,
      url: r.primaryDocUrl || r.filingUrl,
      filedAt: r.filedAt,
    };
  });
}
