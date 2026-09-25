import { and, inArray, sql } from 'drizzle-orm';
import { db } from '../../../../lib/db';
import { eightkFilings } from '../../../../lib/schema';
import { classifyItems } from '../../../../lib/eightk';
import {
  fromFiling, fromWire, fromInsider, fromCongress, pickChange, WINDOW_DAYS, CHANGE,
  WIRE_MIN_IMPORTANCE,
} from '../../../../lib/terminal/watchlist-changes.mjs';

export const runtime = 'nodejs';
const NO_STORE = { 'Cache-Control': 'private, no-store' };

// Live status flags for Watchlist tickers so it's an active monitor, not a static price list:
//   NEWS = a fresh 8-K in the last 24h · HALT = currently halted (Nasdaq feed) · PIT = triggering
//   Pit Scan (reserved — populated once Pit Scan has a real-time feed). Public data; symbols in → flags.
const TICKER_RE = /^[A-Z]{1,5}$/;
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

// The conviction bands the Form 4 model already calls high-conviction. Restated in SQL so the
// promoted row can be fetched alongside the ordinary one; the display-side set it mirrors lives in
// lib/terminal/watchlist-changes.mjs and the verify suite asserts the two agree.
const NOTABLE_BANDS = '{HIGH,VERY HIGH,EXTREME}';

async function kvGet(k) {
  if (!KV_URL || !KV_TOKEN) return null;
  try { const r = await fetch(`${KV_URL}/get/${encodeURIComponent(k)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` }, cache: 'no-store' }); if (!r.ok) return null; const { result } = await r.json(); return result ? JSON.parse(result) : null; } catch { return null; }
}

export async function GET(request) {
  const raw = (new URL(request.url).searchParams.get('symbols') || '').toUpperCase();
  const syms = [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => TICKER_RE.test(s)))].slice(0, 250);
  const empty = { news: [], halt: [], pit: [] };
  if (!syms.length) return Response.json(empty, { headers: NO_STORE });
  const arr = `{${syms.join(',')}}`;

  // ── ⚠️ FOUR QUERIES FOR THE WHOLE WATCHLIST, NOT FOUR PER TICKER ──────────
  //
  // A "what changed" line per row is the kind of feature that quietly becomes N requests — one per
  // symbol, times four sources, on every poll. These are one statement per source over the same
  // tables the flags already use, bounded by the same symbol list and the same recency windows the
  // display honours, so adding a family costs one statement however long the watchlist is.
  //
  // ⚠️ AND EACH ONE FETCHES BOTH TIERS OF ITS FAMILY. The display ranks a material 8-K above a
  // routine one and a high-conviction buy above an ordinary Form 4 — so `distinct on (ticker)`
  // alone would hand it the newest row and hide the very row it would have preferred. The keys
  // carry the source's own flag, which costs at most two rows per ticker instead of one.
  const [news, halt, filings, insiders, congress, wire] = await Promise.all([
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
    // Latest 8-K per ticker per materiality — so a routine filing yesterday cannot bury a material
    // one from Tuesday, which is exactly the case the precedence exists to get right.
    (async () => {
      try {
        const r = await db.execute(sql`
          select distinct on (ticker, material) ticker, items, material, filed_at, primary_doc_url, filing_url
            from eightk_filings
           where ticker = any(${arr}::text[])
             and filed_at >= now() - make_interval(days => ${WINDOW_DAYS[CHANGE.FILING]})
           order by ticker, material, filed_at desc`);
        return r.rows ?? r;
      } catch { return []; }
    })(),
    // Latest Form 4 per ticker, and separately the latest high-conviction one.
    (async () => {
      try {
        const r = await db.execute(sql`
          select distinct on (ticker, (conviction_band = any(${NOTABLE_BANDS}::text[])))
                 ticker, title, action, total_value, filing_date, filing_url, conviction_band
            from insider_trades
           where ticker = any(${arr}::text[])
             and filing_date >= now() - make_interval(days => ${WINDOW_DAYS[CHANGE.INSIDER]})
           order by ticker, (conviction_band = any(${NOTABLE_BANDS}::text[])), filing_date desc`);
        return r.rows ?? r;
      } catch { return []; }
    })(),
    // Latest congressional disclosure per ticker, dated from when it became public.
    (async () => {
      try {
        const r = await db.execute(sql`
          select distinct on (ticker) ticker, representative, type, amount_range, disclosure_date, link
            from congress_trades
           where ticker = any(${arr}::text[])
             and disclosure_date >= now() - make_interval(days => ${WINDOW_DAYS[CHANGE.CONGRESS]})
           order by ticker, disclosure_date desc`);
        return r.rows ?? r;
      } catch { return []; }
    })(),
    // ── ⚠️ THE WIRE, ATTRIBUTED BY THE EVENT AND NOT BY A SEARCH ────────────
    //
    // `tickers` is the canonical resolved attribution already on the event. An event that names no
    // ticker is matched by nothing here, which is what keeps "the market fell today" off a company
    // row. One statement for the list: a lateral per symbol against the GIN index on tickers,
    // taking the strongest story in the window and, among equals, the newest — which is the same
    // order the precedence would apply anyway.
    (async () => {
      try {
        const r = await db.execute(sql`
          select s.ticker, e.headline, e.source_name, e.importance, e.published_at, e.original_url
            from unnest(${arr}::text[]) as s(ticker)
            cross join lateral (
              select coalesce(ce.headline, ce.source_headline) as headline, ce.source_name,
                     ce.importance, ce.published_at, ce.original_url
                from canonical_events ce
               where ce.tickers @> array[s.ticker]
                 and ce.published_at >= now() - make_interval(days => ${WINDOW_DAYS[CHANGE.WIRE]})
                 and coalesce(ce.headline, ce.source_headline) is not null
                 and ce.importance >= ${WIRE_MIN_IMPORTANCE}
               order by ce.importance desc nulls last, ce.published_at desc
               limit 1
            ) e`);
        return r.rows ?? r;
      } catch { return []; }
    })(),
  ]);

  // ── ONE CHANGE PER TICKER, CHOSEN BY A STATED PRECEDENCE ──────────────────
  //
  // ⚠️ THE SELECTION IS IN A PURE MODULE, NOT HERE. What a row says and which of several events it
  // says it about are decidable from the rows alone, so they are decided somewhere they can be
  // asserted without a database — see lib/terminal/watchlist-changes.mjs.
  const changes = {};
  {
    const by = (rows, key) => {
      const m = new Map();
      for (const r of rows || []) if (r && r[key]) {
        const k = String(r[key]).toUpperCase();
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(r);
      }
      return m;
    };
    const f = by(filings, 'ticker'), i = by(insiders, 'ticker'),
      c = by(congress, 'ticker'), w = by(wire, 'ticker');
    for (const sym of syms) {
      const picked = pickChange([
        ...(f.get(sym) || []).map((fr) => fromFiling({
          // The SAME classifier the 8-K wire and the news drawer use, so one filing cannot be
          // described three ways across three surfaces.
          primaryLabel: classifyItems(fr.items)?.primaryLabel,
          items: fr.items, material: fr.material, filedAt: fr.filed_at,
          url: fr.primary_doc_url || fr.filing_url,
        })),
        ...(w.get(sym) || []).map((wr) => fromWire({
          headline: wr.headline, source: wr.source_name, importance: wr.importance,
          publishedAt: wr.published_at, url: wr.original_url,
        })),
        ...(i.get(sym) || []).map((ir) => fromInsider({
          title: ir.title, action: ir.action, totalValue: ir.total_value,
          filingDate: ir.filing_date, filingUrl: ir.filing_url, convictionBand: ir.conviction_band,
        })),
        ...(c.get(sym) || []).map((cr) => fromCongress({
          representative: cr.representative, type: cr.type,
          amountRange: cr.amount_range, disclosureDate: cr.disclosure_date, link: cr.link,
        })),
      ]);
      if (picked) changes[sym] = picked;
    }
  }

  // pit: reserved — Pit Scan is dormant until a real-time feed is wired (see lib/pitscan-feed.js).
  return Response.json({ news: [...new Set(news)], halt: [...new Set(halt)], pit: [], changes }, { headers: NO_STORE });
}
