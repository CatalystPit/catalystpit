import { auth } from '@clerk/nextjs/server';
import { resolveUserTier } from '../../../lib/entitlements';
import { getQuotes } from '../../../lib/market-data';

export const runtime = 'nodejs';
export const maxDuration = 15;

// Batch quotes for a set of tickers, ENTITLEMENT-AWARE: Pro/Elite get real-time (when the configured
// provider supports it), Free gets delayed. Provider-agnostic (Polygon now, Twelve Data next) — this
// route never touches a vendor directly, it goes through lib/market-data.getQuotes().
const TICKER_RE = /^[A-Z0-9.\-]{1,10}$/;

export async function GET(request) {
  const raw = (new URL(request.url).searchParams.get('symbols') || '').toUpperCase();
  const syms = [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => TICKER_RE.test(s)))].slice(0, 100);
  if (!syms.length) return Response.json({}, { headers: { 'Cache-Control': 'private, no-store' } });

  let realtime = false;
  try { const { userId } = await auth(); if (userId) { const tier = await resolveUserTier(); realtime = tier === 'pro' || tier === 'elite'; } } catch { /* signed-out → delayed */ }

  try {
    const quotes = await getQuotes(syms, { realtime });
    return Response.json(quotes, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (e) {
    return Response.json({}, { status: 200, headers: { 'Cache-Control': 'private, no-store' } });
  }
}
