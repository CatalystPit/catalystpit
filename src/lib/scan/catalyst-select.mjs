// WHICH ONE EVENT DOES THE ROW SHOW?
//
// A ticker can carry an 8-K, three Form 4s, a congressional disclosure and a quarter of 13F change
// on the same day. A scan row shows exactly ONE, because a row showing five catalysts is a row a
// trader has to read rather than scan — and the ticker page already exposes everything.
//
// Deterministic and explainable: same inputs, same choice, and the choice can be justified by
// pointing at the two candidates' fields. No weights fitted to anything.
//
// ── THE ORDERING PRINCIPLE ───────────────────────────────────────────────────
//
// A fresh material company event outranks background positioning. An offering filed eight minutes
// ago outranks 13F activity from three months ago, not because of a hard-coded pair but because
// materiality and freshness are what the comparison is made of.
//
// ⚠️ 13F IS NOT A CATALYST AND CAN NEVER BE SELECTED. It describes a quarter that ended months ago.
// It is background evidence for Consensus and context on the ticker page; as a "catalyst" it would
// put every mega-cap on the board every quarter.

// Materiality by event type, in [0,1]. These say how much a trader should CARE that this happened,
// not what it predicts.
export const CATALYST_TYPES = Object.freeze({
  // ── SEC 8-K, by item code. The SEC's own taxonomy, not a publisher's opinion. ──
  'sec_8k_non_reliance':      { label: '8-K · NON-RELIANCE',        materiality: 1.00, family: 'catalysts', quality: 0.95 },
  'sec_8k_delisting':         { label: '8-K · DELISTING NOTICE',    materiality: 0.95, family: 'catalysts', quality: 0.95 },
  'sec_8k_auditor_change':    { label: '8-K · AUDITOR CHANGE',      materiality: 0.85, family: 'catalysts', quality: 0.95 },
  'sec_8k_obligation':        { label: '8-K · FINANCIAL OBLIGATION', materiality: 0.80, family: 'catalysts', quality: 0.95 },
  'sec_8k_material_agreement':{ label: '8-K · MATERIAL AGREEMENT',  materiality: 0.75, family: 'catalysts', quality: 0.95 },
  'sec_8k_agreement_ended':   { label: '8-K · AGREEMENT TERMINATED', materiality: 0.75, family: 'catalysts', quality: 0.95 },
  'sec_8k_results':           { label: '8-K · RESULTS',             materiality: 0.70, family: 'catalysts', quality: 0.95 },
  'sec_8k_officer_change':    { label: '8-K · OFFICER CHANGE',      materiality: 0.60, family: 'catalysts', quality: 0.95 },
  'sec_8k_other':             { label: '8-K · OTHER EVENT',         materiality: 0.45, family: 'catalysts', quality: 0.80 },

  // ── Form 4. Purchases carry information; routine plan sales mostly do not. ──
  'insider_cluster_buy':      { label: 'FORM 4 · CLUSTER BUY',      materiality: 0.85, family: 'insiders', quality: 0.95 },
  'insider_officer_buy':      { label: 'FORM 4 · OFFICER BUY',      materiality: 0.80, family: 'insiders', quality: 0.95 },
  'insider_buy':              { label: 'FORM 4 · INSIDER BUY',      materiality: 0.65, family: 'insiders', quality: 0.90 },
  'insider_discretionary_sell': { label: 'FORM 4 · DISCRETIONARY SELL', materiality: 0.55, family: 'insiders', quality: 0.90 },
  // Below the Catalysts Now materiality floor on purpose: a pre-scheduled plan sale was decided
  // months ago and is not news. It stays defined so it can appear as CONTEXT without ever
  // qualifying a row.
  'insider_routine_sell':     { label: 'FORM 4 · 10b5-1 SALE',      materiality: 0.20, family: 'insiders', quality: 0.90 },

  // ── Congress. Freshness is measured from DISCLOSURE, never the trade date. ──
  'congress_disclosure':      { label: 'CONGRESS · DISCLOSED',      materiality: 0.55, family: 'congress', quality: 0.60 },
  'congress_multi':           { label: 'CONGRESS · MULTIPLE MEMBERS', materiality: 0.65, family: 'congress', quality: 0.60 },

  // ── Pit Wire, only where the event is already classified as material. ──
  'wire_material':            { label: 'WIRE · MATERIAL',           materiality: 0.60, family: 'catalysts', quality: 0.70 },
});

/** 8-K item code → catalyst type. Unmapped codes deliberately produce nothing. */
export const ITEM_TO_TYPE = Object.freeze({
  '4.02': 'sec_8k_non_reliance',
  '3.01': 'sec_8k_delisting',
  '4.01': 'sec_8k_auditor_change',
  '2.04': 'sec_8k_obligation',
  '1.01': 'sec_8k_material_agreement',
  '1.02': 'sec_8k_agreement_ended',
  '2.02': 'sec_8k_results',
  '5.02': 'sec_8k_officer_change',
  '8.01': 'sec_8k_other',
});

const finite = (n) => typeof n === 'number' && Number.isFinite(n);

/**
 * Normalise one raw event into a catalyst candidate, or null.
 *
 * `publicAt` is when the information became PUBLICLY AVAILABLE — the SEC filing timestamp, the
 * congressional disclosure date. Never a transaction date: using one would date evidence to a day
 * nobody outside the company or Congress could have known it.
 */
export function toCandidate({ type, publicAt, ref = null, detail = null, symbol = null } = {}) {
  const spec = CATALYST_TYPES[type];
  if (!spec || !publicAt) return null;
  const ts = new Date(publicAt).getTime();
  if (!finite(ts)) return null;
  return {
    type, symbol,
    label: detail ? `${spec.label} · ${detail}` : spec.label,
    family: spec.family,
    materiality: spec.materiality,
    quality: spec.quality,
    publicAt: new Date(ts).toISOString(),
    ref,
  };
}

/**
 * Pick the one catalyst a row shows.
 *
 * Ranked on materiality decayed by age, so "fresh and material" beats both "stale and material" and
 * "fresh and trivial" without either being special-cased. The half-life is short because this board
 * answers "right now": a day-old 8-K is history, and the ordering should say so.
 *
 * Ties break on materiality, then on recency, then on type name — so the choice is deterministic
 * even for two identical events, and a test can assert it.
 */
export const CATALYST_HALF_LIFE_HOURS = 12;

export function selectPrimaryCatalyst(candidates, { now = Date.now() } = {}) {
  const usable = (Array.isArray(candidates) ? candidates : [])
    .filter(Boolean)
    // 13F can never be a catalyst, wherever it came from.
    .filter((c) => c.family !== 'institutions')
    .map((c) => {
      const ageH = (now - new Date(c.publicAt).getTime()) / 3600000;
      // Future-dated evidence is a data error and must not win by being "freshest".
      if (!finite(ageH) || ageH < 0) return null;
      const decay = Math.pow(0.5, ageH / CATALYST_HALF_LIFE_HOURS);
      return { ...c, ageHours: ageH, rank: (c.materiality ?? 0) * decay };
    })
    .filter(Boolean);

  if (!usable.length) return null;
  usable.sort((a, b) =>
    (b.rank - a.rank)
    || ((b.materiality ?? 0) - (a.materiality ?? 0))
    || (a.ageHours - b.ageHours)
    || String(a.type).localeCompare(String(b.type)));
  return usable[0];
}

/**
 * The compact insider context string — evidence, not a score.
 *
 * Returns null rather than "NONE" when there is nothing meaningful: an empty cell reads as absence,
 * whereas the word NONE reads as a finding.
 */
export function insiderContext({ buyers = 0, officerBuy = false, cluster = false, discretionarySellers = 0, routineSells = 0 } = {}) {
  if (cluster && buyers >= 3) return 'CLUSTER';
  if (officerBuy) return 'CEO/CFO BUY';
  if (buyers >= 2) return `${buyers} BUYS`;
  if (buyers === 1) return '1 BUY';
  if (discretionarySellers >= 2) return `${discretionarySellers} SELLS`;
  // Routine 10b5-1 selling is deliberately NOT surfaced as insider "evidence" — it is the noise the
  // column exists to filter out.
  if (routineSells > 0 && discretionarySellers === 0) return null;
  return null;
}
