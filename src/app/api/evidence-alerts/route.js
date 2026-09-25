import { auth } from '@clerk/nextjs/server';
import { resolveUserAccess } from '../../../lib/entitlements';
import { listSubscriptions, setSubscription, normalizeTicker } from '../../../lib/alerts/evidence-alert-store';

export const runtime = 'nodejs';
const NO_STORE = { 'Cache-Control': 'private, no-store' };

// Evidence Alert SUBSCRIPTIONS.
//
//   GET  → { pro, tickers: [...] }   every ticker this person monitors, in one request
//   POST { ticker, enabled }         turn one on or off
//
// ⚠️ ENTITLEMENT IS RESOLVED HERE, NOT IN THE BUTTON. Hiding a control is a layout decision; it is
// not access control, and a POST from a browser console would sail past it. A non-Pro caller is
// refused by this route whatever the page rendered.
const PRO_TIERS = new Set(['pro', 'elite']);

async function requirePro() {
  const { userId } = await auth();
  if (!userId) return { error: 'unauthorized', status: 401 };
  let tier = 'free';
  try { ({ tier } = await resolveUserAccess()); } catch { tier = 'free'; }
  // ⚠️ FAIL CLOSED ON AN ENTITLEMENT LOOKUP FAILURE. A Clerk outage must not hand out a Pro
  // feature; it degrades to "not entitled", which is recoverable, rather than to "entitled",
  // which is not.
  if (!PRO_TIERS.has(tier)) return { error: 'pro_required', status: 403, userId };
  return { userId };
}

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) return Response.json({ pro: false, tickers: [] }, { headers: NO_STORE });
    let tier = 'free';
    try { ({ tier } = await resolveUserAccess()); } catch { tier = 'free'; }
    const pro = PRO_TIERS.has(tier);
    // A lapsed subscriber still SEES what they had monitored; they simply cannot add more. Hiding
    // the rows would look like data loss.
    return Response.json({ pro, tickers: await listSubscriptions(userId) }, { headers: NO_STORE });
  } catch (e) {
    return Response.json({ pro: false, tickers: [], error: e.message }, { headers: NO_STORE });
  }
}

export async function POST(request) {
  const gate = await requirePro();
  if (gate.error) return Response.json({ error: gate.error }, { status: gate.status, headers: NO_STORE });
  try {
    const b = await request.json().catch(() => ({}));
    const ticker = normalizeTicker(b?.ticker);
    if (!ticker) return Response.json({ error: 'invalid ticker' }, { status: 400, headers: NO_STORE });
    // `enabled` omitted means toggle, which is what every surface's single button wants.
    const current = await listSubscriptions(gate.userId);
    const next = typeof b?.enabled === 'boolean' ? b.enabled : !current.includes(ticker);
    await setSubscription(gate.userId, ticker, next);
    return Response.json({ ticker, enabled: next, tickers: await listSubscriptions(gate.userId) }, { headers: NO_STORE });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 400, headers: NO_STORE });
  }
}
