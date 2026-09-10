import { and, inArray, sql } from 'drizzle-orm';
import { db } from '../../../../lib/db';
import { eightkFilings } from '../../../../lib/schema';

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

  const [news, halt] = await Promise.all([
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
  ]);

  // pit: reserved — Pit Scan is dormant until a real-time feed is wired (see lib/pitscan-feed.js).
  return Response.json({ news: [...new Set(news)], halt: [...new Set(halt)], pit: [] }, { headers: NO_STORE });
}
