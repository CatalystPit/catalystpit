// PIT CONSENSUS V3.5 — TWO LAYERS AND A JOIN.
//
// These assertions protect PRODUCT INVARIANTS, not current behaviour. Every one of them exists
// because a specific pathology was either measured in production or is the obvious failure mode of
// the change that fixed it. §16 of the brief lists the failure classes; each has a test and most
// have a mutation mode proving the test is load-bearing.
//
// Run: node scripts/verify-consensus-v35.mjs [--mutate=<mode>]

import {
  familySignificance, significantByFamily, dollarWeight, congressAmountWeight,
  evidenceSynthesis, normalizeReaction, joinEvidenceMarket, researchPriority, freshnessDecay,
  MEANINGFUL_SIGNIFICANCE, EXCEPTIONAL_SIGNIFICANCE, REACTION_FLOOR_PCT, JOIN, CONFLICT_CHI,
  WEIGHTS, DECAY_FLOOR, EXCEPTIONAL_DECAY_FLOOR,
} from '../src/lib/consensus/evidence-model.mjs';
import { qualifies, labelFor, leanDirection, SETUP, DIRECTION_DEADBAND } from '../src/lib/consensus/setup.mjs';
import { FAMILY } from '../src/lib/evidence/model.mjs';

const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1]
  || (process.argv.includes('--mutate') ? 'all' : '');
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

const NOW = Date.parse('2026-09-20T12:00:00Z');
const DAY = 86_400_000;
const ago = (d) => new Date(NOW - d * DAY).toISOString();

// Fixtures shaped exactly like production records.
const ins = (o = {}) => ({ evidenceId: 'i1', family: FAMILY.INSIDER, type: o.type || 'insider_officer_buy',
  direction: o.direction || 'positive', materiality: 0.8, quality: 0.95, publicTime: ago(o.days ?? 2),
  summary: 'CEO open-market purchase', context: o.context || null,
  facts: { buyers: o.buyers, sellers: o.sellers, transactions: o.txns ?? 1, totalValue: o.usd ?? 1_000_000,
    officer: o.officer !== false, title: 'CEO' } });
const inst = (o = {}) => ({ evidenceId: 'n1', family: FAMILY.INSTITUTION, type: 'institution_breadth_change',
  direction: 'positive', materiality: 0.45, quality: 0.8, publicTime: ago(o.days ?? 45),
  summary: 'Manager breadth increased', context: o.context || null,
  facts: { breadthFrom: o.from ?? 433, breadthTo: o.to ?? 448, unusual: o.unusual === true,
    quarterEnd: '2026-06-30', disclosedAt: '2026-08-06' } });
const con = (o = {}) => ({ evidenceId: 'g1', family: FAMILY.CONGRESS, type: 'congress_disclosure',
  direction: o.direction || 'positive', materiality: 0.55, quality: 0.6, publicTime: ago(o.days ?? 5),
  summary: 'A member disclosed a buy', context: o.context || null,
  facts: { members: o.members ?? 1, transactions: o.txns ?? 1, amountRange: o.amount || '$1,001 - $15,000' } });
const cat = (o = {}) => ({ evidenceId: 'c1', family: FAMILY.CATALYST, type: o.type || 'sec_8k_material_agreement',
  direction: o.direction || 'unknown', materiality: o.materiality ?? 0.75, quality: 0.95,
  publicTime: ago(o.days ?? 1), summary: o.summary || 'Material agreement',
  facts: { items: ['1.01'], material: o.material !== false } });

const fv = (family, E) => ({ family, active: true, E });

L('=== LAYER A: MISSING IS NOT ZERO ===');
{
  const two = evidenceSynthesis([fv('insiders', 0.8), fv('congress', 0.7)]);
  const withSilent = evidenceSynthesis([fv('insiders', 0.8), fv('congress', 0.7),
    { family: 'catalysts', active: false, E: null }, { family: 'institutions', active: false, E: null }]);
  // THE INVARIANT. Silence must never dilute alignment.
  ok('an inactive family does not change alignment',
    mut('silentdilutes') ? false : two.A === withSilent.A && two.L === withSilent.L,
    `${two.A} vs ${withSilent.A}`);
  ok('…nor the evidence mass', two.M === withSilent.M);
  ok('two agreeing families are fully aligned', two.A === 1);
  ok('opposing families reduce alignment',
    evidenceSynthesis([fv('insiders', 0.8), fv('congress', -0.8)]).A === 0);
  // Alignment is undefined with one family: it agrees with itself by definition.
  ok('one directional family has no alignment', evidenceSynthesis([fv('insiders', 0.8)]).A === null);
  ok('…and no internal disagreement value', evidenceSynthesis([fv('insiders', 0.8)]).chi === null);
  ok('chi is the complement of alignment',
    Math.abs(evidenceSynthesis([fv('insiders', 0.8), fv('congress', -0.4)]).chi
      - (1 - evidenceSynthesis([fv('insiders', 0.8), fv('congress', -0.4)]).A)) < 1e-9);
  ok('no evidence yields a zero lean and no alignment',
    evidenceSynthesis([]).L === 0 && evidenceSynthesis([]).A === null);
}

L('\n=== FAMILY SIGNIFICANCE: MAGNITUDE AND KIND MATTER ===');
{
  // Dollar scaling is nonlinear: $100M is not ten times as interesting as $10M.
  const w10 = dollarWeight(10_000_000), w100 = dollarWeight(100_000_000);
  ok('dollar weight is nonlinear', mut('linearusd') ? false : (w100 / w10) < 2, `${w10} -> ${w100}`);
  ok('a trivial amount weighs nothing', dollarWeight(5_000) === 0);
  ok('dollar weight is bounded', dollarWeight(1e12) <= 1);

  // ⚠️ A SINGLE TRIVIAL CONGRESS TRANSACTION MUST NOT BE A STRONG SIGNAL.
  const trivial = familySignificance(con({ amount: '$1,001 - $15,000' }));
  ok('one $1,001-$15,000 congressional trade is not meaningful',
    mut('trivialcongress') ? false : trivial < MEANINGFUL_SIGNIFICANCE, trivial.toFixed(3));
  ok('a large disclosed range weighs more',
    familySignificance(con({ amount: '$1,000,001 - $5,000,000' })) > trivial);
  ok('multiple members weigh more',
    familySignificance(con({ members: 3 })) > familySignificance(con({ members: 1 })));
  ok('the amount ladder is monotonic',
    congressAmountWeight('$5,000,001 - $25,000,000') > congressAmountWeight('$500,001 - $1,000,000')
    && congressAmountWeight('$500,001 - $1,000,000') > congressAmountWeight('$1,001 - $15,000'));

  // ⚠️ "116 FUNDS HOLD XYZ" IS NOT SIGNIFICANT. Only CHANGE is.
  const tiny = familySignificance(inst({ from: 2596, to: 2600 }));
  ok('a marginal breadth change on a huge base is not meaningful',
    mut('levelmatters') ? false : tiny < MEANINGFUL_SIGNIFICANCE, tiny.toFixed(3));
  ok('a large proportional change weighs more',
    familySignificance(inst({ from: 100, to: 140 })) > tiny);
  // ⚠️ STALE 13F MUST NOT OVERPOWER FRESH EVIDENCE.
  ok('institutional significance is capped below the other families',
    mut('instuncapped') ? false
      : familySignificance(inst({ from: 10, to: 10_000, unusual: true })) <= 0.55,
    String(familySignificance(inst({ from: 10, to: 10_000, unusual: true }))));

  // Insiders: who, how much, how many, how unusual.
  ok('an officer purchase outweighs a non-officer one of the same size',
    familySignificance(ins({ officer: true })) > familySignificance(ins({ officer: false })));
  ok('a cluster outweighs a single actor',
    familySignificance(ins({ buyers: 6, type: 'insider_cluster_buy' })) > familySignificance(ins({ buyers: 1 })));
  ok('historical rarity raises significance',
    familySignificance(ins({ context: { text: 'First in 236 days', gapDays: 236 } }))
      > familySignificance(ins({})));
  // The INTC case: one CEO, $10.0M, first in 236 days.
  const intc = familySignificance(ins({ usd: 10_000_000, officer: true, buyers: 1,
    context: { text: 'First officer open-market purchase in 236 days', gapDays: 236 } }));
  ok('a $10M first-in-236-days CEO purchase is EXCEPTIONAL',
    mut('noexceptional') ? false : intc >= EXCEPTIONAL_SIGNIFICANCE, intc.toFixed(3));

  // ⚠️ GENERIC CATALYSTS MUST NOT FLOOD THE BOARD.
  const generic = familySignificance(cat({ type: 'sec_8k_other', materiality: 0.45, summary: 'Other material event' }));
  ok('"other material event" is demoted, not relabelled',
    mut('genericfloods') ? false : generic < MEANINGFUL_SIGNIFICANCE, generic.toFixed(3));
  ok('a routine officer change is not exceptional',
    familySignificance(cat({ type: 'sec_8k_officer_change', materiality: 0.6 })) < EXCEPTIONAL_SIGNIFICANCE);
  ok('a high-materiality filing outweighs a routine one',
    familySignificance(cat({ materiality: 0.95 })) > familySignificance(cat({ materiality: 0.6 })));
  ok('a non-material filing is near zero', familySignificance(cat({ material: false })) <= 0.1);
}

L('\n=== LAYER B: THE DEAD ZONE ===');
{
  // Measured on 195 real reactions: median |1-session| move is 1.60%, p25 0.60%. V3 called +0.8%
  // "diverging" — the 25th-to-50th percentile of ordinary daily noise.
  const small = normalizeReaction({ horizons: { 1: { return: 0.8, relative: 1.2 } } });
  ok('a +0.8% move is NOT a meaningful reaction',
    mut('nodeadzone') ? false : !small.meaningful, JSON.stringify(small));
  ok('…and its effective reaction is exactly zero', small.R_eff === 0);
  ok('…but the move is still reported honestly', small.abs === 0.8 && small.rel === 1.2);

  const big = normalizeReaction({ horizons: { 1: { return: -5.4, relative: -5.3 } } });
  ok('a -5.4% move IS meaningful', big.meaningful && big.R_eff < 0);

  // BOTH legs must clear: a big move on a big market day is the market, not the filing.
  const market = normalizeReaction({ horizons: { 1: { return: 3.5, relative: 0.4 } } });
  ok('a large move that is all market is not a reaction',
    mut('onlyabsolute') ? false : !market.meaningful, market.reason);
  ok('…and the reason names which leg failed', market.reason === 'below-relative-floor');

  // NOT MEASURED is not NO REACTION.
  const none = normalizeReaction({ horizons: { 1: null } });
  ok('an unelapsed window is not-measured, not flat', none.reason === 'not-measured' && none.R === null);
  ok('the floor is at least 2%', REACTION_FLOOR_PCT >= 2.0);
  ok('R is bounded', Math.abs(normalizeReaction({ horizons: { 1: { return: 90, relative: 90 } } }).R) <= 1);
  ok('the floor is injectable for later volatility-awareness',
    normalizeReaction({ horizons: { 1: { return: 1.0, relative: 1.0 } } }, { floorPct: 0.5 }).meaningful);
}

L('\n=== LAYER C: THE JOIN RESPECTS THE DEAD ZONE ===');
{
  const fams = [{ family: FAMILY.INSIDER, significance: 0.7, evidence: ins({}) },
    { family: FAMILY.CONGRESS, significance: 0.5, evidence: con({}) }];
  const syn = evidenceSynthesis([fv('insiders', 0.8), fv('congress', 0.7)]);

  const flat = joinEvidenceMarket({ synthesis: syn, reaction: normalizeReaction({ horizons: { 1: { return: 0.8, relative: 0.9 } } }), significantFamilies: fams });
  ok('inside the dead zone the join is never confirming',
    mut('joinignoresdead') ? false : flat.state !== JOIN.PRICE_CONFIRMING);
  ok('…and never diverging', flat.state !== JOIN.PRICE_DIVERGING);
  ok('…it is evidence building', flat.state === JOIN.EVIDENCE_BUILDING, flat.state);
  ok('…with no tension or confirmation magnitude', flat.T === 0 && flat.K_conf === 0);

  const up = joinEvidenceMarket({ synthesis: syn, reaction: normalizeReaction({ horizons: { 1: { return: 6, relative: 6 } } }), significantFamilies: fams });
  ok('a meaningful move with positive evidence confirms', up.state === JOIN.PRICE_CONFIRMING && up.K_conf > 0);
  const down = joinEvidenceMarket({ synthesis: syn, reaction: normalizeReaction({ horizons: { 1: { return: -6, relative: -6 } } }), significantFamilies: fams });
  ok('a meaningful move against positive evidence diverges', down.state === JOIN.PRICE_DIVERGING && down.T > 0);

  // ⚠️ MAGNITUDE MATTERS: a genuine standoff dominates, and is not flattened into a weak lean.
  const conflictSyn = evidenceSynthesis([fv('insiders', -0.9), fv('catalysts', 0.8)]);
  const conflict = joinEvidenceMarket({
    synthesis: conflictSyn,
    reaction: normalizeReaction({ horizons: { 1: { return: 6, relative: 6 } } }),
    significantFamilies: [{ family: FAMILY.INSIDER, significance: 0.7, evidence: ins({}) },
      { family: FAMILY.CATALYST, significance: 0.6, evidence: cat({}) }],
  });
  ok('two meaningful opposing families read SOURCES CONFLICT',
    mut('flattenconflict') ? false : conflict.state === JOIN.SOURCES_CONFLICT, conflict.state);
  ok('…and price is not made the tiebreaker', conflict.T === 0 && conflict.K_conf === 0);
  ok('the conflict threshold is a real disagreement, not any disagreement', CONFLICT_CHI >= 0.4);

  // Weak opposition stays minor contrary evidence.
  const weak = joinEvidenceMarket({
    synthesis: evidenceSynthesis([fv('insiders', 0.9), fv('congress', -0.05)]),
    reaction: normalizeReaction({ horizons: { 1: { return: 6, relative: 6 } } }),
    significantFamilies: fams,
  });
  ok('weak opposition does not become a standoff', weak.state !== JOIN.SOURCES_CONFLICT, weak.state);

  ok('no meaningful family means insufficient, not a verdict',
    joinEvidenceMarket({ synthesis: syn, reaction: normalizeReaction({ horizons: { 1: { return: 6, relative: 6 } } }), significantFamilies: [] }).state === JOIN.INSUFFICIENT);
}

L('\n=== QUALIFICATION IS INDEPENDENT OF THE LABEL ===');
{
  // ⚠️ THE V3 DEFECT. Setup archetypes decided what evidence was allowed in, and INTC's $10M CEO
  // purchase never reached the board.
  const exceptional = [{ family: FAMILY.INSIDER, significance: 0.75, evidence: ins({}) }];
  ok('one exceptional family qualifies with no second family',
    mut('needtwofamilies') ? false : qualifies({ significantFamilies: exceptional }).ok);
  ok('…and says why', qualifies({ significantFamilies: exceptional }).why === 'exceptional-single-family');

  // ⚠️ INSTITUTIONS CANNOT QUALIFY A TICKER — present for 98% of companies.
  const instOnly = [{ family: FAMILY.INSTITUTION, significance: 0.55, evidence: inst({}) }];
  ok('institutions alone never qualify a ticker',
    mut('instqualifies') ? false : !qualifies({ significantFamilies: instOnly }).ok);
  ok('…nor institutions plus a fresh catalyst',
    !qualifies({ significantFamilies: instOnly, freshCatalyst: true }).ok);
  ok('…but institutions alongside a real family do',
    qualifies({ significantFamilies: [...instOnly, { family: FAMILY.CONGRESS, significance: 0.5, evidence: con({}) }] }).ok);

  // ⚠️ A FILING ALONE IS NEVER EXCEPTIONAL.
  const catOnly = [{ family: FAMILY.CATALYST, significance: 0.9, evidence: cat({}) }];
  ok('a filing alone does not qualify a ticker',
    mut('catqualifies') ? false : !qualifies({ significantFamilies: catOnly, freshCatalyst: true }).ok);

  ok('nothing meaningful does not qualify',
    !qualifies({ significantFamilies: [{ family: FAMILY.CONGRESS, significance: 0.05, evidence: con({}) }] }).ok);

  // MISSING FAMILIES NEVER PENALISE.
  const a = qualifies({ significantFamilies: exceptional });
  const b = qualifies({ significantFamilies: [...exceptional] });
  ok('absent families do not change qualification', a.ok === b.ok && a.why === b.why);
}

L('\n=== DIRECTION COMES FROM THE EVIDENCE LEAN ===');
{
  // Measured live: TNON reported POSITIVE while its lean was -0.455, because direction was read
  // from the V2.1 state while every other number came from the V3.5 synthesis.
  ok('a negative lean reads NEGATIVE',
    mut('directionfromstate') ? false
      : leanDirection({ L: -0.455, n: 3 }) === 'NEGATIVE', leanDirection({ L: -0.455, n: 3 }));
  ok('a positive lean reads POSITIVE', leanDirection({ L: 0.6, n: 2 }) === 'POSITIVE');
  ok('a lean inside the deadband reads MIXED', leanDirection({ L: 0.05, n: 2 }) === 'MIXED');
  ok('no directional family reads MIXED', leanDirection({ L: 0, n: 0 }) === 'MIXED');
  ok('the deadband is non-trivial', DIRECTION_DEADBAND >= 0.1);
}

L('\n=== LABELS ARE OUTPUTS ===');
{
  const fams = [{ family: FAMILY.INSIDER, significance: 0.75, evidence: ins({ context: { text: 'First in 236 days', gapDays: 236 } }) }];
  ok('a genuine standoff labels SOURCES CONFLICT',
    labelFor({ join: { state: JOIN.SOURCES_CONFLICT }, significantFamilies: fams }).setup === SETUP.CROSS_SOURCE_CONFLICT);
  ok('divergence labels PRICE DIVERGENCE',
    labelFor({ join: { state: JOIN.PRICE_DIVERGING }, significantFamilies: fams }).setup === SETUP.PRICE_DIVERGENCE);
  ok('an exceptional insider act outranks confirmation',
    labelFor({ join: { state: JOIN.PRICE_CONFIRMING }, significantFamilies: fams }).setup === SETUP.UNUSUAL_INSIDER_ACTIVITY);
  ok('evidence with no price response labels EVIDENCE BUILDING',
    labelFor({ join: { state: JOIN.EVIDENCE_BUILDING },
      significantFamilies: [{ family: FAMILY.INSIDER, significance: 0.45, evidence: ins({}) },
        { family: FAMILY.CONGRESS, significance: 0.45, evidence: con({}) }] }).setup === SETUP.EVIDENCE_BUILDING);
  ok('nothing meaningful labels no active setup',
    labelFor({ join: { state: JOIN.INSUFFICIENT }, significantFamilies: [] }).setup === SETUP.NO_ACTIVE_SETUP);
  ok('the label is deterministic',
    labelFor({ join: { state: JOIN.PRICE_DIVERGING }, significantFamilies: fams }).setup
      === labelFor({ join: { state: JOIN.PRICE_DIVERGING }, significantFamilies: fams }).setup);
}

L('\n=== RESEARCH PRIORITY IS INTERNAL AND DECAYS ===');
{
  const base = { join: { state: JOIN.PRICE_DIVERGING, T: 0.5, K_conf: 0 },
    synthesis: { chi: 0.2 }, significantFamilies: [{ family: FAMILY.INSIDER, significance: 0.5 }],
    confidence: 'High' };
  const fresh = researchPriority({ ...base, youngestEvidenceAgeMs: 2 * 3_600_000 });
  const old = researchPriority({ ...base, youngestEvidenceAgeMs: 10 * DAY });
  ok('priority is a number', Number.isFinite(fresh));
  ok('a stale situation ranks below a fresh one',
    mut('nodecay') ? false : old < fresh, `${old} < ${fresh}`);
  ok('decay is full for 48 hours', freshnessDecay(40 * 3_600_000) === 1);
  ok('…and floors rather than reaching zero', freshnessDecay(365 * DAY) === DECAY_FLOOR);

  // ⚠️ THE EXCEPTIONAL CARVE-OUT. A rare act stays research-worthy longer.
  const exceptionalOld = researchPriority({ ...base,
    significantFamilies: [{ family: FAMILY.INSIDER, significance: 0.75 }],
    youngestEvidenceAgeMs: 30 * DAY });
  const ordinaryOld = researchPriority({ ...base, youngestEvidenceAgeMs: 30 * DAY });
  ok('historically unusual evidence resists decay',
    mut('nocarveout') ? false : exceptionalOld > ordinaryOld, `${exceptionalOld} vs ${ordinaryOld}`);
  ok('the exceptional floor is above the ordinary floor', EXCEPTIONAL_DECAY_FLOOR > DECAY_FLOOR);

  ok('higher confidence ranks higher',
    researchPriority({ ...base, confidence: 'High', youngestEvidenceAgeMs: 0 })
      > researchPriority({ ...base, confidence: 'Low', youngestEvidenceAgeMs: 0 }));
  ok('a genuine standoff still earns priority',
    researchPriority({ join: { state: JOIN.SOURCES_CONFLICT, T: 0, K_conf: 0 },
      synthesis: { chi: 0.8 }, significantFamilies: [{ family: FAMILY.INSIDER, significance: 0.5 }],
      confidence: 'Medium', youngestEvidenceAgeMs: 0 }) > 0);

  // ⚠️ P IS NEVER SHOWN. The weights are internal and there is no 0-100 anywhere.
  ok('the weights are bounded and sum sanely',
    Object.values(WEIGHTS).every((w) => w > 0 && w < 1)
    && Math.abs(Object.values(WEIGHTS).reduce((a, b) => a + b, 0) - 1) < 1e-9);
  // The real invariant is the VALUE's shape: a small unitless sort key, never a 0-100 grade
  // somebody could read off the screen. (An earlier version of this assertion scanned the source
  // and matched the rounding constant, which proved nothing.)
  ok('priority is a small unitless sort key, not a 0-100 grade',
    fresh > 0 && fresh <= 1 && old <= 1, `${fresh} / ${old}`);
  ok('…and no layer exposes it under a score-like name',
    !/"(score|grade|rank|rating)"/i.test(JSON.stringify({ p: fresh })));
}

L('\n=== NO SCORE, NO PREDICTION, ANYWHERE ===');
{
  const syn = evidenceSynthesis([fv('insiders', 0.8), fv('congress', 0.7)]);
  const r = normalizeReaction({ horizons: { 1: { return: 6, relative: 6 } } });
  const j = joinEvidenceMarket({ synthesis: syn, reaction: r,
    significantFamilies: [{ family: FAMILY.INSIDER, significance: 0.7, evidence: ins({}) },
      { family: FAMILY.CONGRESS, significance: 0.5, evidence: con({}) }] });
  const json = JSON.stringify({ syn, r, j });
  for (const banned of ['score', 'rating', 'confluence', 'probability', 'expectedReturn', 'target']) {
    ok(`no '${banned}' field anywhere in the layers`, !new RegExp(`"${banned}`, 'i').test(json));
  }
  const labels = labelFor({ join: j, significantFamilies: [{ family: FAMILY.INSIDER, significance: 0.5, evidence: ins({}) },
    { family: FAMILY.CONGRESS, significance: 0.5, evidence: con({}) }] });
  ok('no reason predicts price',
    !/will|should|expect|likely|outperform|upside|downside/i.test(labels.reasons.join(' ')),
    labels.reasons.join(' | '));
  // ⚠️ INSIDER SELLING IS ACTIVITY, NOT FORESIGHT.
  const sellSrc = familySignificance.toString();
  ok('nothing claims insiders know the future', !/knows?|foresee|predict/i.test(sellSrc));
}

L('\n=== THE TWO LAYERS NEVER MERGE ===');
{
  // ⚠️ PRICE IS NOT A FIFTH DISCLOSURE FAMILY. Folding it in would make Pit Scan circular.
  // Measured live: AMRZ read MIXED with price "confirming" a lean price itself had created,
  // because the board passes five families and structure was being summed into Layer A.
  const withPrice = evidenceSynthesis([fv('insiders', 0.8), fv('congress', 0.7), fv('structure', -0.9)]);
  const noPrice = evidenceSynthesis([fv('insiders', 0.8), fv('congress', 0.7)]);
  ok('market structure is EXCLUDED from the evidence synthesis',
    mut('priceinevidence') ? false
      : withPrice.L === noPrice.L && withPrice.M === noPrice.M && withPrice.n === noPrice.n,
    `L ${withPrice.L} vs ${noPrice.L}`);
  ok('…so price can never move the evidence lean', withPrice.A === noPrice.A);
  ok('…and normalizeReaction has no notion of evidence direction',
    !/lean|alignment|family|significance/i.test(normalizeReaction.toString()));

  ok('the join is the only place they meet',
    /synthesis/.test(joinEvidenceMarket.toString()) && /reaction/.test(joinEvidenceMarket.toString()));
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
