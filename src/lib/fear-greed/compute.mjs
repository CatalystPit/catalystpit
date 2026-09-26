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
  optionsPcrChangeSeries,
} from './series.mjs';
import { OPTIONS_SENTIMENT_ENABLED } from './occ.mjs';

/** Which way each component runs. Declared once; model.mjs applies it. */
export const COMPONENT_DIRECTION = Object.freeze({
  momentum: DIRECTION.HIGHER_IS_GREED,
  volatility: DIRECTION.HIGHER_IS_FEAR,
  // Above its own trend = protection being bid = fear. Same inversion, different measurement.
  marketvol: DIRECTION.HIGHER_IS_FEAR,
  // Positioning becoming MORE defensive is fear. The inversion is declared here and applied once.
  options: DIRECTION.HIGHER_IS_FEAR,
  breadth: DIRECTION.HIGHER_IS_GREED,
  strength: DIRECTION.HIGHER_IS_GREED,
  credit: DIRECTION.HIGHER_IS_GREED,
});

/**
 * ⚠️ WHAT MAKES A SESSION A SESSION.
 *
 * THE DEFECT: 2026-02-16 was Presidents' Day. The market was shut, and exactly one bar exists for
 * it in our candle store — CBL at 35.05. That was enough for the panel query to emit a row, so the
 * index's own calendar gained a "session" whose breadth was computed from a single ticker and came
 * out at 0.0%, the most extreme fearful value the measure can take. It never published a reading
 * (only two components could score, below the floor of three — fail-closed did its job), but the
 * observation still sat inside the trailing window every later session ranks against.
 *
 * THE RULE, and it names no date: a session is a session when the panel that reports on it is of a
 * piece with the panel that has been reporting lately. Compared against the median eligible count
 * of the previous PANEL_REFERENCE_SESSIONS, anything under MIN_PANEL_FRACTION of it is an
 * incomplete tape rather than a market — one ticker against a thousand is 0.1%, and a real
 * reporting lag is 96%.
 *
 * ⚠️ TRAILING, LIKE EVERYTHING ELSE HERE. The reference is the sessions BEFORE this one, so a
 * session's validity is decided by information that existed on it. And a rejected session never
 * joins the reference — otherwise a run of broken days would lower the bar until they qualified.
 *
 * ⚠️ IT IS A FRACTION, NOT A FLOOR. A hard minimum count would have rejected the whole
 * pre-backfill era, when the panel legitimately held 191 names for months. The question is not
 * "are there enough tickers" but "did today's tape arrive".
 */
export const MIN_PANEL_FRACTION = 0.5;
export const PANEL_REFERENCE_SESSIONS = 21;
const PANEL_REFERENCE_MIN = 5;

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

/** The panel sessions that represent a functioning market, oldest first. */
export function validPanelSessions(panel = []) {
  const kept = [];
  const reference = [];
  for (const p of panel) {
    const n = Number(p?.eligible);
    if (!Number.isFinite(n) || n <= 0) continue;
    const ref = reference.slice(-PANEL_REFERENCE_SESSIONS);
    if (ref.length >= PANEL_REFERENCE_MIN) {
      const med = median(ref);
      if (med > 0 && n < MIN_PANEL_FRACTION * med) continue;   // not added to the reference either
    }
    reference.push(n);
    kept.push(p);
  }
  return kept;
}

/**
 * Build the seven raw series from the loaded inputs.
 *
 * @param {object} input { panel, spy, volMarket, options, credit: { risk, safe } }
 * @returns {Record<string, Array<{date,value}>>}
 */
export function rawSeries({ panel = [], spy = [], volMarket = [], options = [], credit = {} } = {}) {
  const valid = validPanelSessions(panel);
  // ⚠️ REJECTED SESSIONS LEAVE EVERY SERIES, NOT JUST THE TWO THE PANEL FEEDS. A day the market
  // did not open is not a data point for volatility or credit either, and leaving it in their
  // windows would keep the pollution this fix exists to remove.
  //
  // ⚠️ AND ONLY THE REJECTED ONES. This is a set of dates to DROP, never a calendar to intersect
  // with: the other series legitimately reach further back than the panel does, and restricting
  // them to panel dates would shorten their normalisation windows and silently change scores.
  const rejected = new Set(panel.map((p) => String(p.date)));
  for (const p of valid) rejected.delete(String(p.date));
  const drop = (s) => (rejected.size ? s.filter((p) => !rejected.has(String(p.date))) : s);

  return {
    momentum: drop(momentumSeries(spy)),
    volatility: drop(volatilitySeries(spy)),
    // ⚠️ A DIFFERENT INSTRUMENT, NOT A SECOND VIEW OF SPY. `volatility` reads SPY's own returns;
    // `marketvol` reads the volatility market. Passing `spy` here by mistake would produce a
    // perfectly plausible series that measures the same axis twice and lets it vote twice.
    marketvol: drop(volMarketSeries(volMarket)),
    breadth: valid.map((p) => ({ date: p.date, value: p.breadth })),
    strength: valid.map((p) => ({ date: p.date, value: p.strength })),
    credit: drop(relativeReturnSeries(credit.risk || [], credit.safe || [])),
    // ⚠️ THE CLEARING SOURCE PUBLISHES ON A LAG, so this series legitimately ends before the
    // others do. A session with no stored observation has no point and the component is absent
    // for it — the existing missing-component rule, not a special case.
    // ⚠️ THE KILL SWITCH LANDS HERE. Disabled means the series is EMPTY, which the existing
    // missing-component rule already handles — not a zero, not a neutral 50, just absent.
    options: OPTIONS_SENTIMENT_ENABLED ? drop(optionsPcrChangeSeries(options)) : [],
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
