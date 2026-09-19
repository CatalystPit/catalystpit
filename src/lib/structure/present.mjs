// MARKET STRUCTURE — presentation shaping and tier gating. PURE: no DB, no React, no Clerk.
//
// ── GATING HAPPENS HERE, SERVER-SIDE, BY OMISSION ───────────────────────────
//
// A free user's payload does not CONTAIN the Pro values. Not nulled, not blurred, not hidden with
// CSS — absent. The client cannot leak what it was never sent, and "view source" is not a bypass.
// That is stricter than the existing bulls/bears gate needed to be (it truncates a list) and it is
// the reason this file is pure: leak-freedom is then provable by test rather than by reading the
// component and hoping.
//
// ── THE FREE TIER IS A REAL PRODUCT, NOT A TEASER ───────────────────────────
//
// Free gets the daily structure with its reasons, the nearest actionable support and resistance as
// REAL PRICE RANGES with distance, the structural-disruption facts and where price sits relative to
// the level. That is a usable answer to "where am I". Pro adds the other two timeframes, the major
// levels, multi-timeframe confluence and the full component breakdown behind every zone.
//
// ── NOTHING IS RECOMPUTED ───────────────────────────────────────────────────
//
// Every number here is copied from canonical engine output. No rounding that changes a zone's
// meaning, no re-deriving a level, no re-labelling a timeframe. If the engine did not produce it,
// this file does not invent it — a missing major zone stays missing.

export const TIERS = Object.freeze(['free', 'pro', 'elite']);
export const isPro = (tier) => tier === 'pro' || tier === 'elite';

/** How many component reasons a free zone carries. Enough to be explainable, not the full breakdown. */
export const FREE_REASON_CAP = 3;

/**
 * The parts of the engine's zone object a client ever needs.
 *
 * `deep` adds what Pro pays for: the component levels, the named MAJOR criteria, touch history and
 * persistence. Everything in the base shape is what makes the zone actionable at all.
 */
function shapeZone(zone, { deep }) {
  if (!zone) return null;
  const base = {
    low: zone.low, high: zone.high, mid: zone.mid,
    width: zone.width, widthPct: zone.widthPct,
    distance: zone.distance, distancePct: zone.distancePct,
    distanceToMid: zone.distanceToMid, distanceToMidPct: zone.distanceToMidPct,
    side: zone.side,
    // The timeframe LABELS are not the gated weekly/monthly structure — they are what makes a level
    // worth respecting, and a free user seeing "Daily + Weekly" is being told the level is stronger,
    // not being shown the weekly trend, its swings or its own zones.
    timeframes: zone.timeframes,
    multiTimeframe: zone.multiTimeframe,
    reasons: deep ? zone.reasons : (zone.reasons || []).slice(0, FREE_REASON_CAP),
    reasonsTruncated: deep ? false : (zone.reasons || []).length > FREE_REASON_CAP,
  };
  if (!deep) return base;
  return {
    ...base,
    // MAJOR IS A PRO CLASSIFICATION, so it is absent from a free zone entirely — not the badge
    // without its reasons. Showing the label while gating the named criteria behind it would be
    // half-explaining a Pro concept, which is worse than not showing it: a free reader would see a
    // classification they cannot interrogate. The ZONE itself is unchanged for free users; only the
    // judgement about it is Pro.
    major: zone.major,
    majorCriteria: zone.majorCriteria,
    components: zone.components,
    touches: zone.touches,
    prominence: zone.prominence,
    firstSeen: zone.firstSeen,
    lastTouch: zone.lastTouch,
    persistenceDays: zone.persistenceDays,
  };
}

/** One timeframe's block. Unavailable timeframes keep their reason so the UI can say why. */
function shapeTimeframe(tf, { deep }) {
  if (!tf) return null;
  if (!tf.available) {
    return { timeframe: tf.timeframe, label: tf.label, available: false, reason: tf.reason, bars: tf.bars };
  }
  return {
    timeframe: tf.timeframe, label: tf.label, available: true,
    bars: tf.bars,
    trend: tf.trend,
    trendReasons: tf.trendReasons,
    // The research conclusion, preserved: the strict swing label stands, and the disruption facts
    // are what let a reader see why it may differ from their visual read. No transition state.
    trendAsOfPivot: tf.trendAsOfPivot,
    barsSincePivot: tf.barsSincePivot,
    priceSincePivotPct: tf.priceSincePivotPct,
    structuralDisruption: tf.structuralDisruption,
    atr: tf.atr,
    support: { nearest: shapeZone(tf.support?.nearest, { deep }) },
    resistance: { nearest: shapeZone(tf.resistance?.nearest, { deep }) },
    ...(deep ? {
      movingAverages: (tf.movingAverages || []).map((m) => ({
        label: m.label, period: m.period, available: m.available, value: m.value,
        slope: m.slope?.direction ?? null, above: m.priceVs?.above ?? null,
        distancePct: m.priceVs?.distancePct ?? null, reason: m.reason ?? null,
      })),
      maStructure: tf.maStructure,
      support: { nearest: shapeZone(tf.support?.nearest, { deep }), major: shapeZone(tf.support?.major, { deep }) },
      resistance: { nearest: shapeZone(tf.resistance?.nearest, { deep }), major: shapeZone(tf.resistance?.major, { deep }) },
    } : {}),
  };
}

/**
 * Shape engine output for a tier.
 *
 * `structure` is exactly what marketStructure() returned. An unavailable structure passes its own
 * reason straight through — insufficient history and a suppressed price series are product states,
 * not errors, and the UI says which.
 */
export function shapeForTier(structure, tier) {
  const pro = isPro(tier);
  if (!structure || structure.available === false) {
    return {
      tier: pro ? 'pro' : 'free',
      available: false,
      reason: structure?.reason || 'no structure available',
      methodology: structure?.methodology ?? null,
    };
  }

  const mtf = structure.multiTimeframe || {};
  const head = {
    tier: pro ? 'pro' : 'free',
    available: true,
    methodology: structure.methodology,
    asOf: structure.asOf,
    currentPrice: structure.currentPrice,
    priceDate: structure.priceDate,
    dailyAtr: structure.dailyAtr,
    daily: shapeTimeframe(structure.daily, { deep: pro }),
  };

  if (!pro) {
    // FREE. Weekly, monthly, major levels and confluence are ABSENT — no key, no null, nothing to
    // read off the wire. `locked` describes what exists without carrying any of its values.
    return {
      ...head,
      nearestSupport: shapeZone(mtf.support?.nearest, { deep: false }),
      nearestResistance: shapeZone(mtf.resistance?.nearest, { deep: false }),
      supportRelationship: relationshipOf(mtf.support?.relationship),
      resistanceRelationship: relationshipOf(mtf.resistance?.relationship),
      locked: lockedSummary(structure),
    };
  }

  return {
    ...head,
    weekly: shapeTimeframe(structure.weekly, { deep: true }),
    monthly: shapeTimeframe(structure.monthly, { deep: true }),
    alignment: mtf.alignment,
    conflicts: mtf.conflicts || [],
    nearestSupport: shapeZone(mtf.support?.nearest, { deep: true }),
    majorSupport: shapeZone(mtf.support?.major, { deep: true }),
    majorSupportIsNearest: !!mtf.support?.majorIsNearest,
    nearestResistance: shapeZone(mtf.resistance?.nearest, { deep: true }),
    majorResistance: shapeZone(mtf.resistance?.major, { deep: true }),
    majorResistanceIsNearest: !!mtf.resistance?.majorIsNearest,
    supportRelationship: relationshipOf(mtf.support?.relationship),
    resistanceRelationship: relationshipOf(mtf.resistance?.relationship),
    confluenceSupport: (mtf.support?.confluence || []).map((z) => shapeZone(z, { deep: true })),
    confluenceResistance: (mtf.resistance?.confluence || []).map((z) => shapeZone(z, { deep: true })),
  };
}

const relationshipOf = (r) => (r ? { state: r.state, detail: r.detail } : null);

/**
 * What a free user is told EXISTS, with none of its values.
 *
 * Counts and booleans only. "2 multi-timeframe confluence zones" is an honest description of what
 * Pro adds; the prices behind it are not in this object and never reach the client.
 */
function lockedSummary(structure) {
  const mtf = structure.multiTimeframe || {};
  const avail = (tf) => !!tf?.available;
  return {
    weekly: avail(structure.weekly),
    monthly: avail(structure.monthly),
    // A major zone that does not exist is reported as absent rather than as a locked one — selling
    // access to a level the engine never found would be selling nothing.
    majorSupport: !!mtf.support?.major,
    majorResistance: !!mtf.resistance?.major,
    confluenceSupportCount: (mtf.support?.confluence || []).length,
    confluenceResistanceCount: (mtf.resistance?.confluence || []).length,
    alignment: !!mtf.alignment?.state,
  };
}

/**
 * Does this payload contain any gated value?
 *
 * Used by the test suite as an independent check on the gate: it walks the SHAPE rather than
 * trusting the shaping code, so a future field added to the Pro branch and forgotten in the free
 * branch is caught rather than shipped.
 */
export const PRO_ONLY_KEYS = Object.freeze([
  'weekly', 'monthly', 'alignment', 'conflicts',
  'majorSupport', 'majorResistance', 'confluenceSupport', 'confluenceResistance',
  'majorSupportIsNearest', 'majorResistanceIsNearest',
]);

export function proLeakage(payload) {
  if (!payload || payload.tier !== 'free') return [];
  const found = PRO_ONLY_KEYS.filter((k) => k in payload);
  // The deep half of a zone must not ride along inside a free zone either.
  for (const z of [payload.nearestSupport, payload.nearestResistance]) {
    if (!z) continue;
    for (const k of ['major', 'majorCriteria', 'components', 'touches', 'persistenceDays', 'prominence']) {
      if (k in z) found.push(`zone.${k}`);
    }
  }
  return found;
}
