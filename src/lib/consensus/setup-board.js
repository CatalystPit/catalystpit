// THE V3 SETUP BOARD — assembly.
//
// Combines, per ticker:
//   · the canonical V2.1 consensus          (direction, confidence, coverage, market verdict)
//   · canonical evidence_v1 records          (the facts each family actually carries)
//   · price reaction anchored to publicTime  (the existing, tested reaction engine)
//   · a deterministic setup classification   (setup.mjs)
//   · a deterministic WHY THIS IS HERE       (below)
//
// Nothing here interprets evidence. It arranges canonical outputs into the object every surface —
// board, ticker page, and later Watchlist and Alerts — renders from.

import { consensusRow, BOARD_FAMILIES, CONCURRENCY } from './board.mjs';
import { classifySetup, setupDirection, isActive, orderSetups, SETUP, SETUP_LABEL, SETUP_VERSION } from './setup.mjs';
import { familyFactSheet, evidenceFacts, publicAgo } from './facts.mjs';
import { marketFactsFor } from './market-facts.js';
import { FAMILY } from '../evidence/model.mjs';

export const SETUP_BOARD_VERSION = SETUP_VERSION;

/** How many tickers are EVALUATED. How many are SHOWN is decided by qualification, not by a quota. */
export const EVALUATE_LIMIT = 150;

/**
 * Candidate selection, widened.
 *
 * ⚠️ THE DEFECT THIS FIXES. The V2.1 selector required two families from insider/congress/8-K and
 * excluded institutions entirely. ALK — whose CEO made the first officer open-market purchase in
 * our entire held history, $1.0M — was invisible, because insider was its only selecting family.
 * A board that asks "what deserves investigation" cannot miss that.
 *
 * So a ticker is EVALUATED if any of these is true; qualification then decides whether it is shown:
 *   · two or more families have records in window (the V2.1 rule, kept)
 *   · a material 8-K became public in the last 7 days
 *   · insider open-market buying occurred in window
 *   · a congressional disclosure became public in window
 */
export async function selectSetupCandidates(db, sql, { limit = EVALUATE_LIMIT } = {}) {
  const [multi, ins, con] = await Promise.all([
    db.execute(sql`
      with f as (
        select ticker, 'i' k from insider_trades
          where filing_date >= current_date - 30 and total_value > 0 and coalesce(superseded_by,'') = ''
        union all
        select ticker, 'c' k from congress_trades
          where disclosure_date >= current_date - 45 and ticker is not null
        union all
        select ticker, 'e' k from eightk_filings where filed_at >= now() - interval '30 days')
      select ticker, count(distinct k)::int fams, count(*)::int n from f
       group by ticker having count(distinct k) >= 2
       order by count(distinct k) desc, count(*) desc`),
    db.execute(sql`
      select ticker, sum(total_value)::float8 v from insider_trades
       where filing_date >= current_date - 30 and transaction_code = 'P'
         and coalesce(is_derivative,false) = false and total_value > 0
         and coalesce(superseded_by,'') = ''
       group by ticker order by sum(total_value) desc`),
    db.execute(sql`
      select ticker, count(*)::int n from congress_trades
       where disclosure_date >= current_date - 45 and ticker is not null
       group by ticker order by count(*) desc`),
  ]);

  const rows = (r) => (Array.isArray(r) ? r : (r?.rows || []));

  // ── A QUOTA, NOT A PRIORITY ORDER ─────────────────────────────────────────
  //
  // Two failed attempts are encoded here. Ordering by family count hid ALK, whose single insider
  // record — the first officer open-market purchase in our entire held history — sorted below every
  // ticker that merely had two families present. Ordering by insider buying instead filled all 150
  // slots with purchases and produced a board of 42 positive setups and 1 negative: open-market
  // BUYS are the rare, deliberate act, so selecting on them selects a direction.
  //
  // So the multi-family set — which is directionally neutral — is the base, and the high-value
  // single-family signals get a reserved allowance on top. Insider candidates are ranked by DOLLARS
  // rather than filing count, because one $1.0M purchase by a CEO is the interesting case and a
  // dozen small sales are not.
  const MULTI_QUOTA = Math.round(limit * 0.7);
  const INSIDER_QUOTA = Math.round(limit * 0.22);
  const picked = new Map();   // ticker -> selection reason, kept for diagnostics
  const take = (list, quota, reason, key = 'ticker') => {
    let n = 0;
    for (const r of list) {
      if (n >= quota) break;
      const t = String(r[key] || '').toUpperCase();
      if (!t || picked.has(t)) continue;
      picked.set(t, reason);
      n++;
    }
  };

  take(rows(multi), MULTI_QUOTA, 'multi-family');
  take(rows(ins), INSIDER_QUOTA, 'insider-buying');
  take(rows(con), limit - picked.size, 'congress');
  // Any remaining budget goes back to the neutral base rather than to a directional tier.
  take(rows(multi), limit - picked.size, 'multi-family');

  return [...picked.keys()];
}

// ── WHY THIS IS HERE ────────────────────────────────────────────────────────
//
// Deterministic, assembled from the same objects the card renders. No model call, no speculation,
// no verb about future price. It answers "why did Catalyst Pit put this in front of me", which is a
// question about our reasoning, not a claim about the company.

const DIR_WORD = { POSITIVE: 'positive', NEGATIVE: 'negative', MIXED: 'mixed' };

export function whyThisIsHere({ setup, canonical, sheet, market }) {
  const parts = [];
  // Drivers and opposition come from the CANONICAL object, not from which families happen to have a
  // fact sheet. Deriving the two sides from the sheet listed institutions as both supporting and
  // opposing on the same card, because the sheet only knows presence, not which way a family points.
  const names = (list) => (list || []).map((f) => f.label || f.family);
  const join = (n) => (n.length <= 1 ? (n[0] || '') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`);

  // 1. THE TRIGGER — what makes this now rather than last month.
  const cat = sheet?.[FAMILY.CATALYST]?.[0];
  if (setup?.setup?.startsWith('FRESH_CATALYST') && cat) {
    parts.push(`${cat.headline || 'A material company filing'} became public ${cat.publicAgo || 'recently'}`);
  } else if (setup?.setup === SETUP.UNUSUAL_INSIDER_ACTIVITY) {
    const ins = sheet?.[FAMILY.INSIDER]?.[0];
    parts.push(ins?.context || ins?.headline || 'Historically unusual insider activity');
  }

  // 2. WHAT THE DISCLOSURE EVIDENCE SAYS.
  const drivers = names(canonical?.drivers);
  const opposition = names(canonical?.opposition);
  const dir = DIR_WORD[setupDirection(canonical)];
  if (drivers.length && opposition.length) {
    parts.push(`${join(drivers)} point ${dir === 'mixed' ? 'one way' : dir}, while ${join(opposition)} point the other`);
  } else if (drivers.length && dir !== 'mixed') {
    parts.push(`${join(drivers)} point ${dir}`);
  } else if (drivers.length) {
    parts.push(`${join(drivers)} carry evidence without a clear direction`);
  }

  // 3. WHAT PRICE IS DOING ABOUT IT.
  if (market?.explain) parts.push(market.explain);

  const sentence = (t) => (t ? `${t.charAt(0).toUpperCase()}${t.slice(1)}` : t);
  const text = parts.filter(Boolean).map(sentence).join('. ');
  return text ? `${text}.` : null;
}

// ── ONE TICKER ──────────────────────────────────────────────────────────────

/**
 * The canonical V3 setup object for one ticker.
 *
 * Reusable by the board, the ticker page, and later Watchlist and Alerts — which is why it carries
 * evidence IDs, publicTimes and a methodology version rather than being shaped for one card.
 */
export async function buildSetup(ticker, { now = Date.now(), resolve, resolveConsensus } = {}) {
  const sym = String(ticker).toUpperCase();

  const [row, resolved] = await Promise.all([
    consensusRow(sym, { now, resolve: resolveConsensus }),
    (async () => {
      const tickerEvidence = resolve || (await import('../evidence/resolve.js')).tickerEvidence;
      return tickerEvidence(sym, { now });
    })(),
  ]);

  const canonical = row?.canonical || null;
  let evidence = resolved?.evidence || [];

  // AN ENGINE FAILURE IS NOT AN ABSENCE OF EVIDENCE. Reported, never silently shortened.
  const degraded = (resolved?.failedFamilies || []).length > 0;

  // Reactions anchored to publicTime. One candle fetch per ticker; SPY amortised process-wide.
  try {
    const { attachReactions } = await import('../evidence/reaction-data.js');
    evidence = await attachReactions(sym, evidence, { now });
  } catch { /* reaction is enrichment; its absence must not remove the evidence */ }

  const setup = classifySetup({ canonical, evidence, now });
  const sheet = familyFactSheet(evidence, { now });

  // THE DRIVING RECORD — what the market reaction is measured from. The freshest material catalyst
  // when there is one, else the highest-ranked record overall (the engine already ranked them).
  const driver = evidence.find((e) => e.family === FAMILY.CATALYST && e.facts?.material === true)
    || evidence[0] || null;

  const market = await marketFactsFor(sym, {
    driver,
    verdict: canonical?.market?.confirmation || 'UNAVAILABLE',
    driverLabel: driver?.family === FAMILY.CATALYST ? 'the filing' : 'the disclosure evidence',
  });

  const direction = setupDirection(canonical);
  const unusualCount = Object.values(sheet).flat().filter((f) => f?.unusual).length;

  return {
    ticker: sym,
    version: SETUP_VERSION,
    calculatedAt: new Date(now).toISOString(),

    setup: {
      setup: setup.setup,
      label: SETUP_LABEL[setup.setup],
      secondary: setup.secondary,
      reasons: setup.reasons,
      direction,
      active: isActive(setup.setup),
      unusualCount,
      // How old the triggering event is — the ordering term for "why now".
      whyNowAgeMs: driver?.publicTime ? now - Date.parse(driver.publicTime) : null,
      whyNowAgo: driver?.publicTime ? publicAgo(driver.publicTime, now) : null,
    },

    // V2.1 PRESERVED IN FULL, as secondary metadata. Existing consumers keep working and the two
    // layers cannot disagree, because V3 reads this object rather than recomputing it.
    canonical,

    families: sheet,
    market,
    driver: driver ? evidenceFacts(driver, { now }) : null,
    why: null,        // filled below, after market facts exist
    degraded,
    failedFamilies: (resolved?.failedFamilies || []).map((f) => f.family),
    evidenceCount: evidence.length,
  };
}

/** Assemble the board: evaluate candidates, keep only what qualifies, order by research relevance. */
export async function buildSetupBoard(db, sql, { now = Date.now(), limit = EVALUATE_LIMIT, resolve, resolveConsensus } = {}) {
  const candidates = await selectSetupCandidates(db, sql, { limit });
  if (!candidates.length) {
    return { rows: [], candidates: 0, evaluated: 0, failed: 0, builtAt: new Date(now).toISOString() };
  }

  const built = [];
  let i = 0, failed = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, async () => {
    while (i < candidates.length) {
      const t = candidates[i++];
      try {
        const s = await buildSetup(t, { now, resolve, resolveConsensus });
        s.why = whyThisIsHere({ setup: s.setup, canonical: s.canonical, sheet: s.families, market: s.market });
        built.push(s);
      } catch {
        failed++;
      }
    }
  }));

  // ⚠️ QUALIFICATION, NOT A QUOTA. Everything without an active setup is dropped, however much data
  // it has. A board of 9 is a correct answer when only 9 companies have something worth looking at.
  const active = built.filter((s) => s.setup.active);

  return {
    rows: orderSetups(active),
    candidates: candidates.length,
    evaluated: built.length,
    dropped: built.length - active.length,
    failed,
    builtAt: new Date(now).toISOString(),
  };
}
