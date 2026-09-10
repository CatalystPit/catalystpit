import 'server-only';
import { scoreTicker } from './pitscan';

// ─────────────────────────────────────────────────────────────────────────────
//  PIT SCAN pipeline (server-only). Orchestrates: real-time feed → engine →
//  ranked, STRIPPED public rows. The scoring internals never leave here.
//
//  DATA FEED: Pit Scan needs real-time intraday minute data + 20-session
//  time-of-day baselines. Polygon Stocks Starter is 15-min DELAYED with no
//  stream, so the live feed is a PLACEHOLDER until a real-time source is wired
//  (Polygon Advanced websocket, or similar). `getIntradaySnapshots()` returns []
//  until `PITSCAN_REALTIME_URL` is configured → the API reports {configured:false}
//  and the Terminal shows an honest "awaiting real-time feed" state. No delayed
//  data is ever presented as live.
// ─────────────────────────────────────────────────────────────────────────────

const TOP_N = 40;
const REALTIME_URL = process.env.PITSCAN_REALTIME_URL || null;

export function pitScanConfigured() {
  return !!REALTIME_URL;
}

// Pull per-ticker intraday snapshots + private baselines from the real-time feed.
// Returns [] until a feed is configured. When wired, this builds each ticker's
// { price, dayHigh/Low, cumVolToday, bars[], baselines{}, pressureHistory[], catalyst }
// from the stream + the intraday baseline store — the exact input scoreTicker() expects.
export async function getIntradaySnapshots() {
  if (!REALTIME_URL) return [];
  // TODO(realtime): fetch the live snapshot universe + hydrate baselines/pressure history here.
  return [];
}

// Strip a scored row to ONLY the approved public output fields. Everything the
// formula depends on (_rankScore, _sub, baselines) is dropped here.
function toPublicRow(s) {
  return {
    ticker: s.ticker,
    price: round(s.price, 4),
    changePct: round(s.changePct, 2),
    rvol: round(s.rvol, 2),
    volume: s.volume,
    marketCap: s.marketCap,
    float: s.float,
    catalyst: s.catalyst,
    signal: s.signal,          // WATCHING | HEATING | IGNITION | EXTREME
    direction: s.direction,    // bull | bear
    pitPressure: s.pitPressure,
    pitIgnition: s.pitIgnition,
    triggeredAt: s.triggeredAt,
  };
}
const round = (v, d) => (v == null || isNaN(v) ? null : Number(v.toFixed(d)));

// Run one Pit Scan cycle for a direction and return public rows only.
export async function runPitScan({ direction = 'bull' } = {}) {
  if (!pitScanConfigured()) return { configured: false, live: false, rows: [], asOf: null };
  const snapshots = await getIntradaySnapshots();
  const scored = [];
  for (const snap of snapshots) {
    let s = null;
    try { s = scoreTicker(snap); } catch { s = null; }
    if (s && s.direction === direction) scored.push(s);
  }
  scored.sort((a, b) => b._rankScore - a._rankScore);
  const rows = scored.slice(0, TOP_N).map(toPublicRow);
  return { configured: true, live: true, rows, asOf: Date.now() };
}
