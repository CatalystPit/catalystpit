// FEAR & GREED — assembling the index from the loaded series.
//
// Pure with respect to the database: it takes the raw series data.mjs produced and returns the
// index for every session it can. Kept separate from data.mjs so the whole assembly — including
// point-in-time correctness — can be exercised against hand-written series in a test.

import {
  scoreComponent, composite, DIRECTION, NORM_WINDOW, COMPONENTS, COMPONENT_KEYS, METHODOLOGY,
  zoneFor,
} from './model.mjs';
import {
  momentumSeries, volatilitySeries, volMarketSeries, relativeReturnSeries, byDate, trailingWindow,
} from './series.mjs';

/** Which way each component runs. Declared once; model.mjs applies it. */
export const COMPONENT_DIRECTION = Object.freeze({
  momentum: DIRECTION.HIGHER_IS_GREED,
  volatility: DIRECTION.HIGHER_IS_FEAR,
  // Above its own trend = protection being bid = fear. Same inversion, different measurement.
  marketvol: DIRECTION.HIGHER_IS_FEAR,
  breadth: DIRECTION.HIGHER_IS_GREED,
  strength: DIRECTION.HIGHER_IS_GREED,
  credit: DIRECTION.HIGHER_IS_GREED,
});

/**
 * Build the six raw series from the loaded inputs.
 *
 * @param {object} input { panel, spy, volMarket, credit: { risk, safe } }
 * @returns {Record<string, Array<{date,value}>>}
 */
export function rawSeries({ panel = [], spy = [], volMarket = [], credit = {} } = {}) {
  return {
    momentum: momentumSeries(spy),
    volatility: volatilitySeries(spy),
    // ⚠️ A DIFFERENT INSTRUMENT, NOT A SECOND VIEW OF SPY. `volatility` reads SPY's own returns;
    // `marketvol` reads the volatility market. Passing `spy` here by mistake would produce a
    // perfectly plausible series that measures the same axis twice and lets it vote twice.
    marketvol: volMarketSeries(volMarket),
    breadth: panel.map((p) => ({ date: p.date, value: p.breadth })),
    strength: panel.map((p) => ({ date: p.date, value: p.strength })),
    credit: relativeReturnSeries(credit.risk || [], credit.safe || []),
  };
}

/**
 * The index for one session.
 *
 * ⚠️ POINT-IN-TIME BY CONSTRUCTION. Every percentile is taken against `trailingWindow(series, date,
 * NORM_WINDOW)`, which ends AT `date`. A reading published for a past session therefore ranks
 * against only the sessions that preceded it — never against the future it could not have seen.
 * There is no path in this function that reads an index greater than `date`'s.
 */
export function indexForDate(series, date, { window = NORM_WINDOW } = {}) {
  const key = String(date);
  const components = {};
  for (const k of COMPONENT_KEYS) {
    const s = series[k] || [];
    const raw = byDate(s).get(key);
    if (raw === undefined) { components[k] = null; continue; }
    components[k] = scoreComponent({
      raw,
      history: trailingWindow(s, key, window),
      direction: COMPONENT_DIRECTION[k],
    });
  }
  const c = composite(components);
  return { date: key, ...c, components };
}

/**
 * Every session for which the index can be computed, oldest first.
 *
 * A session is reportable when it exists in enough component series AND each of those has the
 * minimum history behind it. Sessions that fail are simply absent — the index never emits a row it
 * could not compute.
 */
export function indexHistory(series, { window = NORM_WINDOW, limit = null } = {}) {
  // The reporting calendar is the market series: it is the one component that defines a session.
  const calendar = (series.breadth || []).map((p) => String(p.date));
  const out = [];
  for (const d of calendar) {
    const r = indexForDate(series, d, { window });
    if (r.available) out.push(r);
  }
  return limit ? out.slice(-limit) : out;
}

/**
 * The payload the API serves and the cron materialises.
 *
 * Includes the comparison points the UI shows — previous close, a week ago, a month ago — taken
 * from the computed history rather than recomputed, so they can never disagree with the chart.
 */
export function buildPayload(series, { window = NORM_WINDOW, historyLimit = 504 } = {}) {
  const history = indexHistory(series, { window });
  const current = history.at(-1) || null;
  const at = (back) => (history.length > back ? history[history.length - 1 - back] : null);
  const strip = (r) => (r ? { date: r.date, score: r.score, zone: r.zone?.label ?? null } : null);

  return {
    version: METHODOLOGY.version,
    available: Boolean(current?.available),
    asOf: current?.date ?? null,
    score: current?.score ?? null,
    zone: current?.zone ?? null,
    reason: current?.reason ?? 'no-history',
    componentCount: current?.componentCount ?? 0,
    minComponents: current?.minComponents ?? null,
    missing: current?.missing ?? COMPONENT_KEYS,
    // ⚠️ THE LABELS AND THE NUMBERS TRAVEL TOGETHER, from one registry, so the card cannot describe
    // a component with someone else's words.
    components: COMPONENTS.map((meta) => {
      const c = current?.components?.[meta.key] || null;
      return {
        key: meta.key,
        label: meta.label,
        score: c?.score ?? null,
        zone: c && c.score !== null ? (zoneFor(c.score)?.label ?? null) : null,
        raw: c?.raw ?? null,
        samples: c?.samples ?? 0,
        available: Boolean(c),
        direction: meta.direction,
        meaning: meta.meaning,
      };
    }),
    comparisons: {
      previousClose: strip(at(1)),
      weekAgo: strip(at(5)),
      monthAgo: strip(at(21)),
    },
    history: history.slice(-historyLimit).map((r) => ({ date: r.date, score: r.score })),
    historySessions: history.length,
    normalizationWindow: window,
    calculatedAt: new Date().toISOString(),
  };
}
