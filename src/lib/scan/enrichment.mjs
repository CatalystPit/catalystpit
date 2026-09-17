// CATALYST PIT INTELLIGENCE, ATTACHED TO SCANNER RESULTS.
//
// A moving stock is a question. Catalyst Pit often already holds the answer — a Pit Wire headline
// from six minutes ago, a Form 4 purchase last week, a congressional disclosure, an earnings date
// tomorrow. Surfacing that next to the move is the thing a generic scanner cannot do, and it is the
// clearest reason for Pit Scan to exist at all.
//
// AN INTERFACE, NOT A COUPLING. The engine never imports the insider module, the wire module or the
// congress module. It calls ONE function, which the server wires up to whatever sources exist. That
// keeps the scanner testable without a database, keeps a slow or failing subsystem from taking the
// scanner down with it, and means a new intelligence source is a new provider here rather than a
// change to the engine.
//
// ENRICHMENT IS NEVER A SIGNAL. It never causes a symbol to appear — price and volume do that. It
// explains a symbol that has already appeared. Letting "has news" put a stationary stock on a
// momentum scanner is how these products fill up with noise.

/** The shape every provider returns. Everything optional; absent means "we have nothing". */
export function emptyContext() {
  return { news: null, insider: null, congress: null, earnings: null };
}

/**
 * Compose several sources into one enrichment function.
 *
 * Each source is `(symbols) => Map<symbol, Partial<Context>>`, batched on purpose: a scanner cycle
 * touches hundreds of symbols, and a per-symbol query per source would be thousands of round trips
 * for one screen refresh.
 *
 * A SOURCE THAT FAILS IS SKIPPED, not fatal. Losing the congress annotation must not cost the trader
 * the scanner.
 */
export async function composeEnrichment(sources, symbols) {
  const out = new Map();
  for (const sym of symbols) out.set(sym, emptyContext());
  await Promise.all((sources || []).map(async (source) => {
    try {
      const partial = await source(symbols);
      if (!partial) return;
      for (const [sym, data] of partial) {
        if (!out.has(sym) || !data) continue;
        out.set(sym, { ...out.get(sym), ...data });
      }
    } catch {
      // One dark source, not a dark scanner.
    }
  }));
  return out;
}

const MINUTE = 60_000;

/** Age in whole minutes, or null when the timestamp is unusable. */
export const ageMinutes = (ts, now = Date.now()) =>
  (Number.isFinite(ts) ? Math.max(0, Math.round((now - ts) / MINUTE)) : null);

/**
 * How fresh a catalyst has to be to be worth showing beside a live move.
 *
 * Two hours. Beyond that it is background on the company rather than an explanation of what is
 * happening right now, and presenting it as the latter invites a false connection.
 */
export const FRESH_NEWS_MINUTES = 120;

/** A news annotation, from whatever Pit Wire hands over. */
export function newsContext({ headline, url, publishedAt, source, category }, now = Date.now()) {
  const age = ageMinutes(publishedAt, now);
  if (age == null || age > FRESH_NEWS_MINUTES) return null;
  return { headline: headline || null, url: url || null, source: source || null, category: category || null, ageMinutes: age };
}

/** An insider annotation. Only PURCHASES: a sale has many innocent explanations, a buy has few. */
export function insiderContext({ lastBuyAt, buyers, netUsd }, now = Date.now()) {
  const age = ageMinutes(lastBuyAt, now);
  if (age == null) return null;
  const days = Math.round(age / 1440);
  if (days > 90) return null;
  return { recentBuy: true, daysAgo: days, buyers: buyers ?? null, netUsd: netUsd ?? null };
}

export function congressContext({ lastTradeAt, side, member }, now = Date.now()) {
  const age = ageMinutes(lastTradeAt, now);
  if (age == null) return null;
  const days = Math.round(age / 1440);
  if (days > 90) return null;
  return { recent: true, daysAgo: days, side: side || null, member: member || null };
}

/**
 * Earnings proximity — the one annotation that matters BEFORE the event rather than after.
 *
 * Reported in days, signed: negative is behind us, positive ahead. A trader seeing a move needs to
 * know whether earnings are tomorrow, and that is a different question from whether there is news.
 */
export function earningsContext({ nextAt, lastAt, confirmed }, now = Date.now()) {
  if (Number.isFinite(nextAt)) {
    const days = Math.round((nextAt - now) / 86_400_000);
    if (days >= 0 && days <= 14) return { inDays: days, confirmed: confirmed === true };
  }
  if (Number.isFinite(lastAt)) {
    const days = Math.round((now - lastAt) / 86_400_000);
    if (days >= 0 && days <= 3) return { inDays: -days, confirmed: confirmed === true };
  }
  return null;
}

/** The short badge the table shows — the densest honest summary of what we hold. */
export function contextBadge(context) {
  if (!context) return null;
  if (context.news) return { kind: 'news', label: `NEWS ${context.news.ageMinutes}m`, detail: context.news.headline };
  if (context.earnings && context.earnings.inDays >= 0) {
    return { kind: 'earnings', label: context.earnings.inDays === 0 ? 'EARNINGS TODAY' : `ER ${context.earnings.inDays}d`, detail: null };
  }
  if (context.insider) return { kind: 'insider', label: `INSIDER ${context.insider.daysAgo}d`, detail: null };
  if (context.congress) return { kind: 'congress', label: `CONGRESS ${context.congress.daysAgo}d`, detail: null };
  return null;
}
