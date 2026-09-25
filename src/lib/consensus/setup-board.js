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
import { loadBuildContext, chunkTickers, CHUNK } from './build-context.mjs';
import { qualifies, labelFor, marketState, MARKET_STATE_LABEL, setupDirection, leanDirection, isActive, orderSetups, SETUP, SETUP_LABEL, SETUP_VERSION, freshCatalysts } from './setup.mjs';
import {
  significantByFamily, evidenceSynthesis, normalizeReaction, joinEvidenceMarket,
  researchPriority, MEANINGFUL_SIGNIFICANCE, EXCEPTIONAL_SIGNIFICANCE, JOIN, DISCLOSURE_ONLY,
  isCurrent, evidenceConfidence, catalystDirectional,
} from './evidence-model.mjs';
import { familyFactSheet, evidenceFacts, publicAgo } from './facts.mjs';
import { marketFactsFor } from './market-facts.js';
import { FAMILY } from '../evidence/model.mjs';
import { TRADEABLE_ASSET_TYPES } from '../heatmap/heatmap-universe.mjs';
import { authorityReading, priceContext, READING, READING_LABEL, PRICE_CONTEXT_LABEL } from './authority.mjs';
import { highSignificance, SIGNIFICANCE_SOURCE } from './high-significance.mjs';

export const SETUP_BOARD_VERSION = SETUP_VERSION;

/** How many tickers are EVALUATED. How many are SHOWN is decided by qualification, not by a quota. */
// ⚠️ RAISED FROM 200, WHICH WAS LOOKING AT 6% OF OUR OWN CANDIDATE POOL.
//
// 3,267 tickers currently carry evidence inside the engine's windows — 2,646 with insider activity,
// 734 with open-market buys, 966 with a material 8-K, 315 with a congressional disclosure. At 200
// the board evaluated 6.1% of them and published 29 rows.
//
// The 200 was budgeted against a cost that is no longer real. The code assumed ~1s per ticker;
// measured now it is 86ms, and concurrency is not the constraint (86ms at 4 parallel, 95ms at 16 —
// it is round-trip latency, not contention). Measured end-to-end board builds:
//
//     200 ->  29 rows          600 ->  50 rows  (50s)
//    1500 ->  93 rows (87s)   3267 ->  99 rows (180s, full coverage)
//
// ⚠️ RAISED AGAIN, THIS TIME TO STOP BINDING AT ALL. 1500 still truncated a 3,267-candidate pool,
// so 1,767 companies with real in-window evidence were never evaluated — a stock could be absent
// from Consensus purely because it sorted below an arbitrary cut, which is the one failure mode
// full-market coverage has to rule out. 6000 is above any candidate count the evidence windows can
// currently produce, so the LIMIT no longer decides anything; the evidence windows do.
//
// It is a ceiling, not a target: the pool is whatever has evidence, measured at 3,267 today.
// Full coverage costs ~180s against the cron's 300s maxDuration, and a build that overruns is
// killed before publishing, so the previous board survives rather than a partial one shipping.
export const EVALUATE_LIMIT = 6000;

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
    // Amount matters here for the same reason dollars matter for insiders: a $500,001-$1,000,000
    // disclosure and a $1,001-$15,000 one are not the same signal, and counting rows treated them
    // identically — which is why BE, carrying a large disclosed purchase and the first
    // congressional disclosure for that ticker in 403 days, never reached evaluation.
    db.execute(sql`
      select ticker, count(*)::int n, count(distinct representative)::int members,
             coalesce(max(amount_mid), 0)::float8 amt
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
    add(r.ticker, 0.25 + 0.15 * Math.min(1, (Number(r.members) || 1) / 3)
                + 0.15 * logw(r.amt, 15_000, 5_000_000), 'congress');
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

export function whyThisIsHere({ setup, synthesis, significantFamilies = [], consensusFamilies = [], sheet, market, reaction, join }) {
  const parts = [];
  const join2 = (n) => (n.length <= 1 ? (n[0] || '') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`);

  // ⚠️ THE SENTENCE IS BUILT FROM THE FACT BLOCKS THE CARD ACTUALLY RENDERS, and from their own
  // directions. Two shipped bugs came from reading anything else:
  //
  //   GOLD  said "Insiders point positive" while the Insiders block read "5 insiders sold $7.0M
  //         outside a 10b5-1 plan" — because the sentence used the consensus signed value
  //         (insiders = +0.010, a near-zero aggregate) instead of the record on the card.
  //   GMRS  named Institutions with no Institutions block anywhere, because a family can carry a
  //         signed value without a displayable record.
  //
  // Reading the blocks makes both impossible by construction: a family can only be named if the
  // reader can see it, and it can only be described the way its own record describes it.
  // The chip labels are upper-case for the card's family headers; prose needs the sentence form.
  const PROSE = { catalyst: 'Catalysts', insider: 'Insiders', institution: 'Institutions', congress: 'Congress' };
  const blocks = Object.entries(sheet || {}).flatMap(([fam, items]) =>
    (items || []).filter(Boolean).map((f) => ({ ...f, prose: PROSE[fam] || f.familyLabel })));
  const pos = blocks.filter((f) => f.direction === 'positive').map((f) => f.prose);
  const neg = blocks.filter((f) => f.direction === 'negative').map((f) => f.prose);

  // 1. THE TRIGGER.
  const cat = sheet?.[FAMILY.CATALYST]?.[0];
  if (setup?.setup?.startsWith('FRESH_CATALYST') && cat) {
    parts.push(`${cat.headline || 'A material company filing'} became public ${cat.publicAgo || 'recently'}`);
  } else if (setup?.setup === SETUP.UNUSUAL_INSIDER_ACTIVITY) {
    const ins = sheet?.[FAMILY.INSIDER]?.[0];
    parts.push(ins?.context || ins?.headline || 'Historically unusual insider activity');
  }

  // 2. WHAT THE VISIBLE EVIDENCE SAYS.
  if (pos.length && neg.length) {
    const aligned = setup?.setup === SETUP.CROSS_SOURCE_ALIGNMENT;
    const lean = synthesis?.L ?? 0;
    parts.push(aligned
      ? `${join2(lean >= 0 ? pos : neg)} point ${lean >= 0 ? 'positive' : 'negative'}, with minor contrary evidence from ${join2(lean >= 0 ? neg : pos)}`
      : `${join2(pos)} point positive, while ${join2(neg)} point negative`);
  } else if (pos.length) parts.push(`${join2(pos)} point positive`);
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
export async function buildSetup(ticker, { now = Date.now(), resolve, resolveConsensus, ctx = null } = {}) {
  const sym = String(ticker).toUpperCase();

  // ⚠️ ctx IS PASSED, NEVER CONSULTED HERE. It travels to the query sites inside the two engines and
  // the reaction attach, each of which reads the rows its own query would have produced. Nothing on
  // this path changes what is computed — see consensus/build-context.mjs.
  const [row, resolved] = await Promise.all([
    consensusRow(sym, { now, resolve: resolveConsensus, ctx }),
    (async () => {
      const tickerEvidence = resolve || (await import('../evidence/resolve.js')).tickerEvidence;
      return tickerEvidence(sym, { now, ctx });
    })(),
  ]);

  const canonical = row?.canonical || null;
  let evidence = resolved?.evidence || [];

  // AN ENGINE FAILURE IS NOT AN ABSENCE OF EVIDENCE. Reported, never silently shortened.
  const degraded = (resolved?.failedFamilies || []).length > 0;

  // Reactions anchored to publicTime. One candle fetch per ticker; SPY amortised process-wide.
  try {
    const { attachReactions } = await import('../evidence/reaction-data.js');
    evidence = await attachReactions(sym, evidence, { now, ctx });
  } catch { /* reaction is enrichment; its absence must not remove the evidence */ }

  // ── THE V3.5 PIPELINE, in order ──────────────────────────────────────
  // significance -> qualification -> synthesis -> reaction -> join -> priority -> label
  const significantFamilies = significantByFamily(evidence, { now });
  // §7: mask the catalyst family's direction when no canonical catalyst record is classifiable.
  // Facts and freshness still count; only the DIRECTION is withheld, because guessing it would
  // be fabrication and it is what made unclassified filings argue with real evidence.
  const catalystHasDirection = evidence.some((e) => e.family === FAMILY.CATALYST && catalystDirectional(e));
  const synthFamilies = (row?.families || []).map((f) => (f.family === 'catalysts' && !catalystHasDirection
    ? { ...f, E: 0 } : f));
  const synthesis = evidenceSynthesis(synthFamilies);
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

  const freshCatalystAgeMs = fresh.length
    ? Math.min(...fresh.map((e) => now - Date.parse(e.publicTime)).filter(Number.isFinite))
    : null;
  const currency = isCurrent({ significantFamilies, freshCatalystAgeMs, now });
  const confidence = evidenceConfidence({ significantFamilies, synthesis, newestAgeMs: currency.newestAgeMs });

  const q = qualifies({ significantFamilies, freshCatalyst: fresh.length > 0, reaction, synthesis });
  let label = labelFor({
    join, significantFamilies, freshCatalyst: fresh.length > 0,
    freshCatalystEvidence: fresh[0] || null, synthesis,
  });

  const market = await marketFactsFor(sym, {
    driver, reaction, join, ctx,
    verdict: canonical?.market?.confirmation || 'UNAVAILABLE',
    driverLabel: catalystDriven && driver?.family === FAMILY.CATALYST
      ? 'the filing' : 'the disclosure evidence',
  });

  // ⚠️ GATED ON THE SETUP, NOT THE JOIN. TELA and INM shipped headed "Positive" above
  // "Cross-source conflict" with a NEGATIVE delisting notice on the card, because the conflict was
  // established by the meaningful-opposition branch while the join still read EVIDENCE_BUILDING.
  // Whatever route produced the conflict, a card that says these sources contradict each other
  // cannot also assert a lean.
  // ⚠️ THE READING IS THE HEADLINE NOW, AND IT IS NOT A VOTE OF THE FAMILIES.
  //
  // The old direction was MIXED whenever any family dissented, which on the live board made
  // "Cross-source conflict" 13 of 29 rows — including TELA, where a -0.028 stale catalyst was
  // cancelling a +0.282 fresh insider cluster and the row's own synthesis said chi=0.085.
  // authorityReading() asks instead which families are CURRENT AND SUBSTANTIAL enough to name a
  // direction at all; background 13F breadth and price may agree but never veto. See authority.mjs.
  // `row.families` is the signed per-family output of the v1 engine (D/S/F/Q/E/state) — the same
  // array _consensusFamilies exposes. NOT `synthFamilies`, which has already had catalyst direction
  // neutralised for display, and not `sheet`, which is the rendered fact blocks.
  const engineFamilies = row?.families || [];
  const reading = authorityReading(engineFamilies);
  const price = priceContext(reading.direction, engineFamilies.find((f) => f?.family === 'structure'), reaction);

  // ⚠️ A CARD CANNOT SAY "Positive" AND "Cross-source conflict" AT ONCE. The conflict archetype
  // was assigned by the old any-family-dissents rule; once background 13F and a stale catalyst can
  // no longer veto, the sources genuinely do not conflict and the label is simply wrong. It is
  // corrected to what the reading found — alignment when two or more sources agree, a single-source
  // finding when only one does. The conflict archetype survives for rows the reading also calls
  // contested, which is the case it was always meant to describe.
  const named = reading.reading === READING.POSITIVE || reading.reading === READING.NEGATIVE;
  if (named && label.setup === SETUP.CROSS_SOURCE_CONFLICT) {
    label = {
      ...label,
      setup: reading.agreement.total >= 2 ? SETUP.CROSS_SOURCE_ALIGNMENT : SETUP.SINGLE_SOURCE_SIGNIFICANCE,
      reasons: [reading.why, ...(label.reasons || []).filter((r) => !/disagree|both directions|comparable weight/i.test(r))],
    };
  }

  const conflicted = label.setup === SETUP.CROSS_SOURCE_CONFLICT || join.state === JOIN.SOURCES_CONFLICT;
  // The reading decides the direction when it can name one; the old lean remains the fallback so
  // nothing downstream that expects POSITIVE/NEGATIVE/MIXED sees a shape it has not seen before.
  const direction = reading.reading === READING.POSITIVE ? 'POSITIVE'
    : reading.reading === READING.NEGATIVE ? 'NEGATIVE'
      : conflicted ? 'MIXED' : leanDirection(synthesis);
  const unusualCount = Object.values(sheet).flat().filter((f) => f?.unusual).length;

  return {
    ticker: sym,
    version: SETUP_VERSION,
    calculatedAt: new Date(now).toISOString(),

    // ⚠️ AN ATTENTION TAG, NOT A DIRECTION. Computed from the same canonical evidence records the
    // cards render, so a reason can always be checked against the filing shown beneath it. It does
    // not feed direction, confidence or qualification — a row can be high significance and Negative.
    highSignificance: (() => {
      const h = highSignificance(evidence);
      return {
        high: h.high,
        reasons: h.reasons.slice(0, 3),
        count: h.reasons.length,
        // ⚠️ COMPUTED FROM THE FULL LIST, BEFORE THE SLICE. The reasons are trimmed to three for
        // the wire, so testing the trimmed array would drop a qualifying insider reason on a row
        // that happened to carry more than three. No new rule — this is the SAME qualification
        // highSignificance() already performed, asked a narrower question.
        insider: h.reasons.some((r) => r.source === SIGNIFICANCE_SOURCE.INSIDER),
      };
    })(),

    // ⚠️ THE PLAIN-LANGUAGE ANSWER, derived in authority.mjs and carried whole so no surface
    // recomputes it and no two can disagree.
    reading: {
      reading: reading.reading,
      label: READING_LABEL[reading.reading],
      tier: reading.tier ?? null,
      tierLabel: reading.tierLabel ?? '',
      direction: reading.direction,
      leading: reading.leading,
      corroborating: reading.corroborating,
      against: reading.against,
      belowFloor: reading.belowFloor || [],
      agreement: reading.agreement,
      why: reading.why,
      price: price.context,
      priceLabel: price.label,
      priceWhy: price.why,
    },

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
      // SECONDARY. Price is context on the card, never the identity.
      marketState: marketState({ join, reaction, direction, setup: label.setup }),
      marketStateLabel: MARKET_STATE_LABEL[marketState({ join, reaction, direction, setup: label.setup })],
      // §1: on the DEFAULT board or only in the lookback view, and why.
      current: currency.current,
      currentWhy: currency.why,
      newestEvidenceAgeMs: currency.newestAgeMs,
      // §6: confidence from significance, quality, independence and FRESHNESS — not family count.
      confidence,
      unusualCount,
      // How old the triggering event is — the ordering term for "why now".
      whyNowAgeMs: driver?.publicTime ? now - Date.parse(driver.publicTime) : null,
      whyNowAgo: driver?.publicTime ? publicAgo(driver.publicTime, now) : null,
    },

    // LAYER A / B / C kept structurally separate in the payload, so no consumer can conflate
    // public evidence with what price did about it.
    evidence_layer: {
      ...synthesis,
      // §9: how many families are DIRECTIONALLY ACTIVE, which is what 'single-source' means.
      // The card previously printed 'Single-source' beside '3 of 4 active families' because one
      // counted direction and the other counted presence. Both numbers are now published so the
      // UI can state presence and direction separately instead of conflating them.
      directionalFamilies: synthesis.n,
      meaningfulFamilies: significantFamilies.filter((f) => f.significance >= MEANINGFUL_SIGNIFICANCE).length,
      confidence,
      significantFamilies: significantFamilies.map((f) => ({
        family: f.family, significance: Math.round(f.significance * 1000) / 1000, tier: f.tier,
        meaningful: f.significance >= MEANINGFUL_SIGNIFICANCE,
        exceptional: f.significance >= EXCEPTIONAL_SIGNIFICANCE,
      })),
    },
    _significant: significantFamilies,
    _consensusFamilies: row?.families || [],
    reaction_layer: reaction,
    join_layer: join,
    // INTERNAL SORT KEY ONLY — never rendered. See evidence-model.mjs.
    priority: researchPriority({
      join, synthesis, significantFamilies, confidence,
      freshCatalyst: fresh.length > 0,
      // Age is measured on the newest MEANINGFUL evidence, not on the newest record of any kind:
      // a stale case does not become current because an insignificant filing arrived.
      youngestEvidenceAgeMs: currency.newestAgeMs,
      stillDeveloping: currency.why === 'fresh-catalyst',
    }),

    // V2.1 PRESERVED IN FULL, as secondary metadata. Existing consumers keep working and the two
    // layers cannot disagree, because V3 reads this object rather than recomputing it.
    canonical,
    // The legacy consensus_v1 object, carried verbatim for Pit Scan's divergence gate — which
    // requires version/activeCount/confidence/directionValue and correctly REFUSES the v2 synthesis
    // object. Passthrough only: nothing here recomputes or reshapes it.
    consensusV1: row ? {
      version: row.version, activeCount: row.activeCount, confidence: row.confidence,
      directionValue: row.directionValue, direction: row.direction, alignment: row.alignment,
    } : null,

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
/**
 * ⚠️ HOW LONG THE BUILD MAY RUN BEFORE IT STOPS TAKING NEW WORK.
 *
 * maxDuration is 300s and is the plan ceiling. A build that reaches it is KILLED — not rejected,
 * killed — which means no heartbeat, no log line, no lock release, and a board that simply stops
 * moving. That is precisely how this failed: every invocation for six hours started, ran 300s and
 * vanished, leaving a frozen clock as the only symptom.
 *
 * Stopping ourselves first turns an invisible kill into a recorded outcome.
 *
 * ⚠️ SET AS CLOSE TO THE CEILING AS IS SAFE, so it fires only when something is genuinely wrong.
 * This is not the fix for a slow build — the fix was the missing (ticker, quarter) index on
 * fund_holdings and CONCURRENCY — it is the thing that makes the next slow build visible instead of
 * silent. Everything after the build is validation, one KV write and one heartbeat, measured at
 * 1-3s, so 30s of headroom under the 300s platform ceiling is generous.
 *
 * The first value here was 240s, chosen before the build had been measured end to end. Production
 * then reported `deadline after 243s at 2477/3309 candidates` — the deadline working exactly as
 * intended, and the number that showed 240 was below what the build needed rather than above it.
 */
export const BUILD_DEADLINE_MS = 270_000;

export async function buildSetupBoard(db, sql, {
  now = Date.now(), limit = EVALUATE_LIMIT, resolve, resolveConsensus,
  deadlineAt = Date.now() + BUILD_DEADLINE_MS,
} = {}) {
  const candidates = await selectSetupCandidates(db, sql, { limit });
  // ⚠️ THE SCOPE LINE NEEDS A DENOMINATOR, AND IT MUST BE THE CANONICAL ONE. Reusing the screener's
  // own asset-type taxonomy rather than inventing a second definition of "a US stock" — a reader
  // seeing "99 setups from N companies" has to be able to trust N. One extra count per BUILD, never
  // per view.
  let universe = null;
  try {
    const u = await db.execute(sql`select count(*)::int n from screener_stocks s
      left join screener_meta m on m.ticker = s.ticker
      where coalesce(m.asset_type,'') = any(${`{${TRADEABLE_ASSET_TYPES.join(',')}}`}::text[])
        and coalesce(s.market_cap, m.market_cap) > 0`);
    universe = Number((Array.isArray(u) ? u : u?.rows || [])[0]?.n) || null;
  } catch { universe = null; }
  if (!candidates.length) {
    return { rows: [], candidates: 0, evaluated: 0, failed: 0, universe, builtAt: new Date(now).toISOString() };
  }

  // ── ⚠️ BULK LOAD PER CHUNK, THEN BUILD FROM MEMORY ────────────────────────
  //
  // This loop used to issue 16 database round trips PER CANDIDATE — 52,944 for a full pass, which
  // is why the build could not finish inside the platform's 300s ceiling. Each chunk now loads the
  // same rows for ~400 tickers in one wave of queries and every setup in that chunk is computed
  // without touching the database again.
  //
  // The chunk is also the memory bound: twelve years of candles for the whole candidate universe is
  // ~2.2M bars, which does not belong in one map inside a 3009MB function.
  const built = [];
  let failed = 0, aborted = false;
  const chunks = chunkTickers(candidates, CHUNK);
  const loadMs = [];
  outer:
  for (const chunk of chunks) {
    if (Date.now() >= deadlineAt) { aborted = true; break; }
    let ctx = null;
    const loadStart = Date.now();
    try {
      ctx = await loadBuildContext(db, sql, chunk, { now });
    } catch (e) {
      // ⚠️ A FAILED BULK LOAD MUST NOT SKIP THE CHUNK. ctx stays null and every resolver falls back
      // to its own query, exactly as before this existed — slower, and correct.
      console.warn(`[setup-board] bulk load failed for a chunk of ${chunk.length}: ${e.message}`);
      ctx = null;
    }
    loadMs.push(Date.now() - loadStart);

    let i = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunk.length) }, async () => {
      while (i < chunk.length) {
        // ⚠️ CHECKED BEFORE TAKING WORK, NOT AFTER DOING IT. A worker that has started a ticker
        // finishes it; no new one is picked up past the deadline. The partial result is NOT
        // published — rebuildBoard refuses it — so last-known-good survives untouched.
        if (Date.now() >= deadlineAt) { aborted = true; break; }
        const t = chunk[i++];
        try {
          const s = await buildSetup(t, { now, resolve, resolveConsensus, ctx });
          s.why = whyThisIsHere({
            setup: s.setup, synthesis: s.evidence_layer,
            significantFamilies: s._significant, consensusFamilies: s._consensusFamilies,
            sheet: s.families,
            market: s.market, reaction: s.reaction_layer, join: s.join_layer,
          });
          built.push(s);
        } catch {
          failed++;
        }
      }
    }));
    if (aborted) break outer;
  }

  // ⚠️ QUALIFICATION, NOT A QUOTA. Everything without an active setup is dropped, however much data
  // it has. A board of 9 is a correct answer when only 9 companies have something worth looking at.
  // ⚠️ THE DEFAULT BOARD IS CURRENT SITUATIONS ONLY. Everything else remains in the evidence
  // record, on the ticker page and available to a lookback view — it is simply not a reason to
  // look at a company today, and leaving it here pushed live situations down the page.
  const qualified = built.filter((s) => s.setup.active);
  const active = qualified.filter((s) => s.setup.current);

  return {
    // ⚠️ THE CALLER MUST BE ABLE TO TELL A COMPLETE BUILD FROM A TRUNCATED ONE. Without this the
    // abort would publish a board missing however many candidates it never reached, which reads
    // to every consumer as "those companies have no evidence".
    aborted,
    // Bulk-load cost, so the split between fetching and computing stays visible in production.
    bulkLoadMs: loadMs.reduce((a, b) => a + b, 0),
    chunks: chunks.length,
    rows: orderSetups(active),
    candidates: candidates.length,
    evaluated: built.length,
    dropped: built.length - active.length,
    // Split so the two reasons are distinguishable in operations: nothing material to say, versus
    // material but no longer current.
    droppedNoEvidence: built.length - qualified.length,
    droppedStale: qualified.length - active.length,
    universe,
    failed,
    builtAt: new Date(now).toISOString(),
  };
}
