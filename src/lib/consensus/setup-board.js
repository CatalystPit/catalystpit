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
import { qualifies, labelFor, setupDirection, leanDirection, isActive, orderSetups, SETUP, SETUP_LABEL, SETUP_VERSION, freshCatalysts } from './setup.mjs';
import {
  significantByFamily, evidenceSynthesis, normalizeReaction, joinEvidenceMarket,
  researchPriority, MEANINGFUL_SIGNIFICANCE, EXCEPTIONAL_SIGNIFICANCE, JOIN,
} from './evidence-model.mjs';
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
  // ⚠️ WINDOWS MUST MATCH THE EVIDENCE ENGINE. This is the defect that hid INTC: selection counted
  // insider FILINGS over 30 days while the engine reads and displays 45, so a CEO's $10.0M
  // open-market purchase 37 days old — the first in 236 days — was invisible to the board while
  // being fully present in the evidence. Every window below is now the engine's own.
  const [ins, con, cat] = await Promise.all([
    // DOLLARS, NOT ROW COUNTS. One $10M officer purchase must outrank twenty small filings.
    db.execute(sql`
      select ticker,
             coalesce(sum(total_value) filter (where transaction_code = 'P'
               and coalesce(is_derivative,false) = false), 0)::float8 buy_usd,
             coalesce(sum(total_value), 0)::float8 any_usd
        from insider_trades
       where filing_date >= current_date - 45
         and total_value > 0 and coalesce(superseded_by,'') = ''
       group by ticker`),
    db.execute(sql`
      select ticker, count(*)::int n, count(distinct representative)::int members
        from congress_trades
       where disclosure_date >= current_date - 45 and ticker is not null
       group by ticker`),
    db.execute(sql`
      select ticker, count(*) filter (where material)::int material_n, max(filed_at) last_filed
        from eightk_filings
       where filed_at >= now() - interval '30 days'
       group by ticker`),
  ]);

  const rows = (r) => (Array.isArray(r) ? r : (r?.rows || []));

  // A SELECTION PROXY, NOT A RATING. It never reaches a user and only decides evaluation order.
  // Every term is bounded so no single family can monopolise the budget — the failure that produced
  // a board of 42 positive setups and 1 negative when insider buying led selection.
  const logw = (v, floor, ceil) => {
    const x = Number(v);
    if (!Number.isFinite(x) || x <= floor) return 0;
    return Math.min(1, (Math.log10(Math.min(x, ceil)) - Math.log10(floor))
      / (Math.log10(ceil) - Math.log10(floor)));
  };
  const score = new Map();
  const add = (t, v, fam) => {
    const k = String(t || '').toUpperCase();
    if (!k) return;
    const e = score.get(k) || { s: 0, fams: new Set() };
    e.s += v;
    if (fam) e.fams.add(fam);
    score.set(k, e);
  };

  for (const r of rows(ins)) {
    // Buying and selling both earn evaluation. Buying weighs more because it is the rarer, more
    // deliberate act, but selling still gets in so the board cannot become structurally one-sided.
    add(r.ticker, 0.55 * logw(r.buy_usd, 25000, 50000000)
                + 0.30 * logw(r.any_usd, 25000, 50000000), 'insider');
  }
  for (const r of rows(con)) {
    add(r.ticker, 0.25 + 0.15 * Math.min(1, (Number(r.members) || 1) / 3), 'congress');
  }
  for (const r of rows(cat)) {
    if (!(Number(r.material_n) || 0)) continue;
    const ageDays = r.last_filed ? (Date.now() - Date.parse(r.last_filed)) / 86400000 : 99;
    add(r.ticker, ageDays <= 7 ? 0.45 : ageDays <= 14 ? 0.25 : 0.12, 'catalyst');
  }

  // Independent families corroborating each other is itself a reason to look. Institutions are
  // deliberately absent from selection entirely: they exist for 98% of tickers.
  for (const [, e] of score) if (e.fams.size >= 2) e.s += 0.25 * (e.fams.size - 1);

  return [...score.entries()]
    .sort((x, y) => (y[1].s - x[1].s) || x[0].localeCompare(y[0]))
    .slice(0, limit)
    .map(([t]) => t);
}

// ── WHY THIS IS HERE ────────────────────────────────────────────────────────
//
// Deterministic, assembled from the same objects the card renders. No model call, no speculation,
// no verb about future price. It answers "why did Catalyst Pit put this in front of me", which is a
// question about our reasoning, not a claim about the company.

const DIR_WORD = { POSITIVE: 'positive', NEGATIVE: 'negative', MIXED: 'mixed' };

export function whyThisIsHere({ setup, synthesis, significantFamilies = [], sheet, market, reaction, join }) {
  const parts = [];
  const NAME = { insider: 'Insiders', institution: 'Institutions', congress: 'Congress', catalyst: 'Catalysts' };
  const join2 = (n) => (n.length <= 1 ? (n[0] || '') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`);

  // ⚠️ ONE FAMILY UNIVERSE. Earlier this sentence was assembled from V2.1's drivers and opposition
  // while the rest of the card used the V3.5 significance layer, so cards named families that did
  // not appear in their own evidence list. Both sides now come from the same place.
  const meaningful = significantFamilies.filter((f) => f.significance >= MEANINGFUL_SIGNIFICANCE);
  const dirOf = (f) => f.evidence?.direction;
  const pos = meaningful.filter((f) => dirOf(f) === 'positive').map((f) => NAME[f.family] || f.family);
  const neg = meaningful.filter((f) => dirOf(f) === 'negative').map((f) => NAME[f.family] || f.family);

  // 1. THE TRIGGER.
  const cat = sheet?.[FAMILY.CATALYST]?.[0];
  if (setup?.setup?.startsWith('FRESH_CATALYST') && cat) {
    parts.push(`${cat.headline || 'A material company filing'} became public ${cat.publicAgo || 'recently'}`);
  } else if (setup?.setup === SETUP.UNUSUAL_INSIDER_ACTIVITY) {
    const ins = meaningful.find((f) => f.family === FAMILY.INSIDER);
    parts.push(ins?.evidence?.context?.text || sheet?.[FAMILY.INSIDER]?.[0]?.headline
      || 'Historically unusual insider activity');
  }

  // 2. WHAT THE EVIDENCE SAYS.
  if (pos.length && neg.length) parts.push(`${join2(pos)} point positive, while ${join2(neg)} point negative`);
  else if (pos.length) parts.push(`${join2(pos)} point positive`);
  else if (neg.length) parts.push(`${join2(neg)} point negative`);

  // 3. WHAT PRICE IS DOING ABOUT IT — never confirming or diverging inside the dead zone.
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

  // ── THE V3.5 PIPELINE, in order ──────────────────────────────────────
  // significance -> qualification -> synthesis -> reaction -> join -> priority -> label
  const significantFamilies = significantByFamily(evidence, { now });
  const synthesis = evidenceSynthesis(row?.families || []);
  const fresh = freshCatalysts(evidence, { now });
  const sheet = familyFactSheet(evidence, { now });

  // THE DRIVING RECORD — what the market reaction is measured from. The freshest material catalyst
  // when there is one, else the highest-ranked record overall (the engine already ranked them).
  const driver = evidence.find((e) => e.family === FAMILY.CATALYST && e.facts?.material === true)
    || evidence[0] || null;

  // Only a setup actually triggered by a filing may describe price relative to "the filing".
  // Everything else is confirming or contradicting the DISCLOSURE evidence, whatever the reaction
  // happens to be anchored to.
  const catalystDriven = fresh.length > 0;
  // LAYER B: normalise the reaction, with the dead zone applied.
  const reaction = normalizeReaction(driver?.reaction || null);

  // LAYER C: the join. Never confirming or diverging inside the dead zone.
  const join = joinEvidenceMarket({ synthesis, reaction, significantFamilies });

  const q = qualifies({ significantFamilies, freshCatalyst: fresh.length > 0, reaction, synthesis });
  const label = labelFor({
    join, significantFamilies, freshCatalyst: fresh.length > 0,
    freshCatalystEvidence: fresh[0] || null, synthesis,
  });

  const market = await marketFactsFor(sym, {
    driver, reaction, join,
    verdict: canonical?.market?.confirmation || 'UNAVAILABLE',
    driverLabel: catalystDriven && driver?.family === FAMILY.CATALYST
      ? 'the filing' : 'the disclosure evidence',
  });

  // When independent sources genuinely disagree, the honest summary direction is MIXED — asserting
  // a lean alongside "these sources contradict each other" would undercut the card's own reading.
  const direction = join.state === JOIN.SOURCES_CONFLICT ? 'MIXED' : leanDirection(synthesis);
  const unusualCount = Object.values(sheet).flat().filter((f) => f?.unusual).length;

  return {
    ticker: sym,
    version: SETUP_VERSION,
    calculatedAt: new Date(now).toISOString(),

    setup: {
      setup: label.setup,
      label: SETUP_LABEL[label.setup],
      secondary: label.secondary,
      reasons: label.reasons,
      direction,
      // ⚠️ QUALIFICATION IS INDEPENDENT OF THE LABEL. A ticker is active because material
      // evidence exists, not because an archetype happened to fire.
      active: q.ok && isActive(label.setup),
      qualifiedBy: q.why,
      unusualCount,
      // How old the triggering event is — the ordering term for "why now".
      whyNowAgeMs: driver?.publicTime ? now - Date.parse(driver.publicTime) : null,
      whyNowAgo: driver?.publicTime ? publicAgo(driver.publicTime, now) : null,
    },

    // LAYER A / B / C kept structurally separate in the payload, so no consumer can conflate
    // public evidence with what price did about it.
    evidence_layer: {
      ...synthesis,
      significantFamilies: significantFamilies.map((f) => ({
        family: f.family, significance: Math.round(f.significance * 1000) / 1000, tier: f.tier,
        meaningful: f.significance >= MEANINGFUL_SIGNIFICANCE,
        exceptional: f.significance >= EXCEPTIONAL_SIGNIFICANCE,
      })),
    },
    _significant: significantFamilies,
    reaction_layer: reaction,
    join_layer: join,
    // INTERNAL SORT KEY ONLY — never rendered. See evidence-model.mjs.
    priority: researchPriority({
      join, synthesis, significantFamilies, confidence: canonical?.confidence,
      freshCatalyst: fresh.length > 0,
      youngestEvidenceAgeMs: evidence.length
        ? Math.min(...evidence.map((e) => now - Date.parse(e.publicTime)).filter(Number.isFinite))
        : null,
      stillDeveloping: fresh.length > 0,
    }),

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
        s.why = whyThisIsHere({
          setup: s.setup, synthesis: s.evidence_layer,
          significantFamilies: s._significant, sheet: s.families,
          market: s.market, reaction: s.reaction_layer, join: s.join_layer,
        });
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
