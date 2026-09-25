import { and, inArray, sql } from 'drizzle-orm';
import { db } from '../../../../lib/db';
import { eightkFilings, insiderTrades, congressTrades } from '../../../../lib/schema';
import { classifyItems } from '../../../../lib/eightk';
import {
  fromFiling, fromInsider, fromCongress, pickChange, WINDOW_DAYS, CHANGE,
} from '../../../../lib/terminal/watchlist-changes.mjs';

export const runtime = 'nodejs';
const NO_STORE = { 'Cache-Control': 'private, no-store' };

// Live status flags for Watchlist tickers so it's an active monitor, not a static price list:
//   NEWS = a fresh 8-K in the last 24h · HALT = currently halted (Nasdaq feed) · PIT = triggering
//   Pit Scan (reserved — populated once Pit Scan has a real-time feed). Public data; symbols in → flags.
const TICKER_RE = /^[A-Z]{1,5}$/;
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvGet(k) {
  if (!KV_URL || !KV_TOKEN) return null;
  try { const r = await fetch(`${KV_URL}/get/${encodeURIComponent(k)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` }, cache: 'no-store' }); if (!r.ok) return null; const { result } = await r.json(); return result ? JSON.parse(result) : null; } catch { return null; }
}

export async function GET(request) {
  const raw = (new URL(request.url).searchParams.get('symbols') || '').toUpperCase();
  const syms = [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => TICKER_RE.test(s)))].slice(0, 250);
  const empty = { news: [], halt: [], pit: [] };
  if (!syms.length) return Response.json(empty, { headers: NO_STORE });

  // ── ⚠️ THREE QUERIES FOR THE WHOLE WATCHLIST, NOT THREE PER TICKER ────────
  //
  // A "what changed" line per row is the kind of feature that quietly becomes N requests — one per
  // symbol, times four sources, on every poll. These are DISTINCT ON (ticker) over the same tables
  // the flags already use, bounded by the same symbol list and the same recency windows the display
  // honours, so adding the feature costs three statements however long the watchlist is.
  const [news, halt, filings, insiders, congress] = await Promise.all([
    // Fresh 8-K in the last 24h → NEWS
    (async () => {
      try {
        const rows = await db.select({ t: eightkFilings.ticker }).from(eightkFilings)
          .where(and(inArray(eightkFilings.ticker, syms), sql`${eightkFilings.filedAt} >= now() - interval '24 hours'`))
          .groupBy(eightkFilings.ticker);
        return rows.map((r) => r.t);
      } catch { return []; }
    })(),
    // Currently halted (not yet resumed) from the cached Nasdaq halt feed → HALT
    (async () => {
      try {
        const set = new Set(syms);
        const cache = await kvGet('halts:v1');
        return (cache?.halts || []).filter((h) => h.symbol && set.has(h.symbol) && !h.resumed).map((h) => h.symbol);
      } catch { return []; }
    })(),
    // Latest material 8-K per ticker, within the filing window.
    (async () => {
      try {
        const r = await db.execute(sql`
          select distinct on (ticker) ticker, items, material, filed_at, primary_doc_url, filing_url
            from eightk_filings
           where ticker = any(${`{${syms.join(',')}}`}::text[])
             and filed_at >= now() - make_interval(days => ${WINDOW_DAYS[CHANGE.FILING]})
           order by ticker, filed_at desc`);
        return r.rows ?? r;
      } catch { return []; }
    })(),
    // Latest Form 4 per ticker.
    (async () => {
      try {
        const r = await db.execute(sql`
          select distinct on (ticker) ticker, title, action, total_value, filing_date, filing_url
            from insider_trades
           where ticker = any(${`{${syms.join(',')}}`}::text[])
             and filing_date >= now() - make_interval(days => ${WINDOW_DAYS[CHANGE.INSIDER]})
           order by ticker, filing_date desc`);
        return r.rows ?? r;
      } catch { return []; }
    })(),
    // Latest congressional disclosure per ticker, dated from when it became public.
    (async () => {
      try {
        const r = await db.execute(sql`
          select distinct on (ticker) ticker, representative, type, amount_range, disclosure_date, link
            from congress_trades
           where ticker = any(${`{${syms.join(',')}}`}::text[])
             and disclosure_date >= now() - make_interval(days => ${WINDOW_DAYS[CHANGE.CONGRESS]})
           order by ticker, disclosure_date desc`);
        return r.rows ?? r;
      } catch { return []; }
    })(),
  ]);

  // ── ONE CHANGE PER TICKER, CHOSEN BY RECENCY ──────────────────────────────
  //
  // ⚠️ THE SELECTION IS IN A PURE MODULE, NOT HERE. What a row says and which of several events it
  // says it about are decidable from the rows alone, so they are decided somewhere they can be
  // asserted without a database — see lib/terminal/watchlist-changes.mjs.
  const changes = {};
  {
    const by = (rows, key) => {
      const m = new Map();
      for (const r of rows || []) if (r && r[key]) m.set(String(r[key]).toUpperCase(), r);
      return m;
    };
    const f = by(filings, 'ticker'), i = by(insiders, 'ticker'), c = by(congress, 'ticker');
    for (const sym of syms) {
      const fr = f.get(sym), ir = i.get(sym), cr = c.get(sym);
      const picked = pickChange([
        fr ? fromFiling({
          // The SAME classifier the 8-K wire and the news drawer use, so one filing cannot be
          // described three ways across three surfaces.
          primaryLabel: classifyItems(fr.items)?.primaryLabel,
          items: fr.items, material: fr.material, filedAt: fr.filed_at,
          url: fr.primary_doc_url || fr.filing_url,
        }) : null,
        ir ? fromInsider({ title: ir.title, action: ir.action, totalValue: ir.total_value,
          filingDate: ir.filing_date, filingUrl: ir.filing_url }) : null,
        cr ? fromCongress({ representative: cr.representative, type: cr.type,
          amountRange: cr.amount_range, disclosureDate: cr.disclosure_date, link: cr.link }) : null,
      ]);
      if (picked) changes[sym] = picked;
    }
  }

  // pit: reserved — Pit Scan is dormant until a real-time feed is wired (see lib/pitscan-feed.js).
  return Response.json({ news: [...new Set(news)], halt: [...new Set(halt)], pit: [], changes }, { headers: NO_STORE });
}
