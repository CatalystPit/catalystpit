// WHY IS THIS MOVING? — bounded catalyst resolution for major unmatched movers.
//
// ── ⚠️ WHAT THIS IS NOT ─────────────────────────────────────────────────────
//
// Not a second scanner, not a second evidence engine, and not a news search. It queries ONE store:
// primary_events, the canonical wire Catalyst Pit already ingests. No new vendor, no scraping, no
// per-viewer request. If the wire does not have it, the answer is that we did not identify one.
//
// ── WHY IT EXISTS ───────────────────────────────────────────────────────────
//
// Moving Now finds real movers with no canonical evidence — APUS +155%, SRZN +95%, PMAX +88% on
// the day this was written. Traced individually, none had a catalyst anywhere in our sources, and
// EDGAR confirmed no filing that day either. But "we hold no evidence record" and "we looked and
// found nothing" are different statements, and only the second one is worth showing a trader.
//
// The gap this closes is narrower and real: a press release CAN exist in the wire while its ticker
// tag failed to resolve, in which case the evidence engine never sees it. Searching the wire by
// COMPANY NAME finds exactly that case.
//
// ── ⚠️ THE MATCH MUST MEET THE EXISTING TICKER STANDARD ─────────────────────
//
// A headline is not attached because it contains the company's name. It is attached only when the
// canonical resolver — the same resolveCompanies the wire itself uses — independently resolves that
// headline to this ticker. One resolver, one standard. A name that merely appears in the text
// (a partner, an acquirer, a list) resolves to nothing and is refused, which is the whole reason
// that resolver has a vocabulary of ambiguous words in the first place.

import { kvGetJson, kvSetJson, kvConfigured } from '../consensus/materialization.mjs';
import { classifyCompanyEvent, relevanceDays, isEvidenceSource } from '../evidence/company-events.mjs';

/** Only a genuinely large move is worth resolving; everything else keeps the cheap answer. */
export const MAJOR_MOVE_PCT = 25;

/** How many movers may be resolved in one pass. Bounds the query, not the board. */
export const MAX_RESOLVE = 12;

/** How far back a catalyst may be and still plausibly relate to today's session. */
export const LOOKBACK_HOURS = 48;

/**
 * How far back a CLASSIFIED event may be and still be useful context.
 *
 * The query bound only; each hit is then held to its own event type window via relevanceDays.
 */
export const CLASSIFIED_LOOKBACK_HOURS = 30 * 24;

export const CACHE_KEY = 'scan:mover-catalyst:v1';
/** One resolution per TTL for everybody — a hundred viewers cost what one costs. */
export const CACHE_TTL_SEC = 300;

/**
 * Resolve catalysts for a bounded set of tickers from the canonical wire.
 *
 * @returns {Promise<Record<string, {headline,source,url,publicTime}|null>>}
 *   ticker -> catalyst, or null meaning "checked, nothing identified". A ticker absent from the
 *   map was never checked, which is a third state and deliberately distinguishable from null.
 */
export async function resolveMoverCatalysts(db, sql, tickers = []) {
  const want = [...new Set(tickers.map((t) => String(t || '').toUpperCase()).filter(Boolean))].slice(0, MAX_RESOLVE);
  if (!want.length) return {};

  const key = `${CACHE_KEY}:${want.slice().sort().join(',')}`;
  if (kvConfigured()) {
    const hit = await kvGetJson(key);
    if (hit && typeof hit === 'object') return hit;
  }

  const out = {};
  try {
    // The names we will search for, from the security master rather than invented.
    const names = (await db.execute(sql`
      select s.ticker, coalesce(s.company, i.name) as name
        from screener_stocks s
        left join security_identity i on i.ticker = s.ticker
       where s.ticker = any(${`{${want.join(',')}}`}::text[])`)).rows;

    const { resolveCompanies, tokens } = await import('../company-symbols.mjs');
    // The wire's own index, cached there for six hours — not a second copy.
    const { symbolIndex } = await import('../primary-events.js');
    const index = await symbolIndex();

    for (const row of names) {
      const ticker = String(row.ticker).toUpperCase();
      out[ticker] = null;                       // checked, nothing yet
      const name = String(row.name || '').trim();
      // A name we cannot tokenise cannot be searched for without matching everything.
      const toks = name ? tokens(name) : [];
      if (!toks.length || !index) continue;

      // The distinctive head of the name, which is what a headline would lead with.
      const head = toks[0];
      if (!head || head.length < 4) continue;

      const hits = (await db.execute(sql`
        select coalesce(source_headline, headline) h, source, canonical_url, original_url,
               published_at, tickers
          from primary_events
         where published_at > now() - (${CLASSIFIED_LOOKBACK_HOURS} || ' hours')::interval
           and coalesce(source_headline, headline) ilike ${'%' + head + '%'}
         order by published_at desc limit 40`)).rows;

      for (const e of hits) {
        const headline = String(e.h || '');
        // ⚠️ THE CANONICAL RESOLVER DECIDES, NOT THE ilike. The ilike is only a cheap prefilter;
        // attaching on it would tag every headline containing a common word.
        const resolved = resolveCompanies(headline, index) || [];
        const tagged = Array.isArray(e.tickers) ? e.tickers : [];
        if (!resolved.includes(ticker) && !tagged.includes(ticker)) continue;
        // ⚠️ THE LONGER WINDOW IS EARNED, NOT GIVEN. Past 48 hours the item must classify as a real
        // event under the canonical taxonomy, and then only for as long as its own type is relevant.
        // An unrecognised headline stays stale at 48 hours, so months-old unrelated news cannot be
        // dragged onto a card to explain today's move.
        const ageH = e.published_at ? (Date.now() - new Date(e.published_at).getTime()) / 3600e3 : Infinity;
        const spec = classifyCompanyEvent(headline);
        if (ageH > LOOKBACK_HOURS) {
          // ⚠️ AND THE SOURCE MUST BE ONE EVIDENCE WOULD ACCEPT. Inside 48 hours a wire item is
          // shown as an unclassified "fresh catalyst" and the reader can see what it is. Past that
          // we are asserting a month-old item explains today, and an aggregator column is not
          // good enough to carry that claim — the same standard pressReleaseEvidence applies.
          if (!spec || !isEvidenceSource(e.source)) continue;
          if (ageH > relevanceDays(spec.type) * 24) continue;
        }
        out[ticker] = {
          eventType: spec?.type || null,
          // FRESH CATALYST vs RECENT RELEVANT CATALYST — the card says which, and neither says caused.
          fresh: ageH <= LOOKBACK_HOURS,
          headline: headline.split('\n')[0].slice(0, 160),
          source: e.source || null,
          url: e.canonical_url || e.original_url || null,
          publicTime: e.published_at ? new Date(e.published_at).toISOString() : null,
        };
        break;
      }
    }
  } catch {
    // A resolution failure must never empty the board; the rows keep their unresolved state.
    return out;
  }

  if (kvConfigured() && Object.keys(out).length) await kvSetJson(key, out, CACHE_TTL_SEC);
  return out;
}
