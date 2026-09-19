// EVIDENCE TIMELINE — the same engine, at a different granularity.
//
// What Changed asks "what should I know about this company right now", and answers with a DIGEST:
// eleven Form 4s filed over three weeks collapse into "11 insiders bought $2.6M". That is the right
// shape for a list a trader reads top-down.
//
// A chart asks a different question — "when did evidence enter the market, against this price" —
// and a digest cannot answer it, because the eleven filings happened on different days and a single
// marker would have to pick one. So this module emits evidence at each distinct PUBLIC MOMENT.
//
// ⚠️ THIS IS A GRANULARITY, NOT A SECOND OPINION. Every classification rule is imported from
// resolve.js: what counts as an open-market purchase, which 8-K item codes are material and how
// material, which PIT column is the public clock. If those rules were restated here, the timeline
// and What Changed would drift apart the first time either was edited, and the same filing would
// mean two different things on the same page.
//
// ── CONTEXT IS COMPUTED AS OF THE EVENT, NOT AS OF NOW ──────────────────────
//
// "First officer open-market purchase in 842 days" is a claim about the moment it happened. For a
// marker eight months back, the honest version measures the gap from the purchases BEFORE IT, with
// `now` set to that filing's own date. Computing it from today would describe the chart's past
// using the present's knowledge, which is the same class of error as placing a congressional trade
// on its transaction date.

import { sql } from 'drizzle-orm';
import { db } from '../db';
import { FAMILY, DIRECTION, collectEvidence } from './model.mjs';
import { firstInContext, burstContext, implausibleBreadth, breadthChangeContext } from './history.mjs';
import { rankEvidence } from './rank.mjs';
import {
  coverageBoundaries, quarterDisclosureDates, BREADTH_QUARTERS, BREADTH_LOOKBACK_DAYS,
  HISTORY_WINDOW_DAYS, ITEM_TO_TYPE, OPEN_MARKET_BUY,
  quarterLabel, isoDay, usdLabel,
} from './resolve';

const DAY = 86_400_000;
const rows = (res) => res?.rows ?? res ?? [];
const ms = (d) => (d == null ? null : new Date(d).getTime());

/** The widest span the timeline will resolve, matching the engine's own bounded history. */
export const MAX_RANGE_DAYS = HISTORY_WINDOW_DAYS;

// ── insiders, one item per filing date ───────────────────────────────────────

async function insiderTimeline(ticker, { from, to, coverage }) {
  const res = await db.execute(sql`
    select action, transaction_code, total_value, executive, title, filing_date, accession, filing_url,
           coalesce(rule_10b5_1, false) as planned,
           coalesce(is_derivative, false) as derivative,
           coalesce(superseded_by, '')   as superseded,
           coalesce(is_officer, false)   as officer,
           coalesce(is_director, false)  as director
      from insider_trades
     where ticker = ${ticker}
       and filing_date >= (current_date - make_interval(days => ${MAX_RANGE_DAYS}))
       and total_value > 0
     order by filing_date asc
     limit 4000`);
  const all = rows(res).filter((x) => !x.superseded);
  if (!all.length) return [];

  const isBuy = (x) => x.transaction_code === OPEN_MARKET_BUY && !x.derivative;
  const buys = all.filter(isBuy);
  const cov = coverage[FAMILY.INSIDER] ?? null;

  // Group by the public moment. filing_date has day resolution, so a day IS the moment.
  const byDay = new Map();
  for (const x of all) {
    const d = isoDay(x.filing_date);
    if (!d) continue;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(x);
  }

  const out = [];
  for (const [day, items] of byDay) {
    const t = ms(day);
    if (t == null || t < from || t > to) continue;

    const dayBuys = items.filter(isBuy);
    // Discretionary sells only. A 10b5-1 sale was decided months earlier and is the noise the
    // engine filters out everywhere else; it must not become a chart marker either.
    const daySells = items.filter((x) => x.action === 'SELL' && !x.planned);

    if (dayBuys.length) {
      const officer = dayBuys.find((x) => x.officer);
      const buyers = [...new Set(dayBuys.map((x) => x.executive).filter(Boolean))];
      const value = dayBuys.reduce((s, x) => s + Number(x.total_value || 0), 0);

      // AS OF THIS FILING: everything comparable strictly before it.
      const priorBuys = buys.filter((x) => (ms(x.filing_date) ?? 0) < t);
      let context = officer
        ? firstInContext({
          priorTimes: priorBuys.filter((x) => x.officer).map((x) => ms(x.filing_date)),
          coverageStart: cov, now: t, noun: 'officer open-market purchase',
        })
        : null;
      if (!context) {
        context = firstInContext({
          priorTimes: priorBuys.map((x) => ms(x.filing_date)),
          coverageStart: cov, now: t, noun: 'insider open-market purchase',
        });
      }
      if (!context) {
        // A burst is measured backwards from this filing, not from today.
        context = burstContext({
          times: buys.filter((x) => (ms(x.filing_date) ?? 0) <= t).map((x) => ms(x.filing_date)),
          windowDays: 30, now: t, noun: 'open-market purchases',
        });
      }

      const cluster = buyers.length >= 3;
      out.push({
        ticker, family: FAMILY.INSIDER,
        type: cluster ? 'insider_cluster_buy' : officer ? 'insider_officer_buy' : 'insider_buy',
        subtype: officer?.title || dayBuys[0].title || null,
        direction: DIRECTION.POSITIVE,
        materiality: cluster ? 0.85 : officer ? 0.80 : 0.65,
        quality: (officer || dayBuys[0].director) ? 0.95 : 0.85,
        publicTime: day, eventTime: null,
        source: 'sec_form4', sourceId: dayBuys[0].accession,
        url: dayBuys[0].filing_url || null,
        summary: cluster
          ? `${buyers.length} insiders bought ${usdLabel(value) || 'shares'} on the open market`
          : officer
            ? `${officer.title || 'Officer'} open-market purchase${usdLabel(value) ? ` of ${usdLabel(value)}` : ''}`
            : `Insider open-market purchase${usdLabel(value) ? ` of ${usdLabel(value)}` : ''}`,
        facts: {
          buyers: buyers.length, transactions: dayBuys.length,
          totalValue: value || null, totalValueLabel: usdLabel(value),
          executive: officer?.executive || dayBuys[0].executive || null,
          title: officer?.title || dayBuys[0].title || null,
          officer: !!officer,
        },
        context,
      });
    }

    // Selling is reported only when it is broad enough to be a signal rather than one executive's
    // household finances — the same floor the digest uses.
    if (daySells.length >= 2) {
      const sellers = [...new Set(daySells.map((x) => x.executive).filter(Boolean))];
      const value = daySells.reduce((s, x) => s + Number(x.total_value || 0), 0);
      out.push({
        ticker, family: FAMILY.INSIDER, type: 'insider_discretionary_sell',
        direction: DIRECTION.NEGATIVE, materiality: 0.55, quality: 0.90,
        publicTime: day, eventTime: null,
        source: 'sec_form4', sourceId: daySells[0].accession,
        url: daySells[0].filing_url || null,
        summary: `${sellers.length} insider${sellers.length > 1 ? 's' : ''} sold ${usdLabel(value) || 'shares'} outside a 10b5-1 plan`,
        facts: { sellers: sellers.length, transactions: daySells.length, totalValue: value || null },
        context: null,
      });
    }
  }
  return out;
}

// ── catalysts, one item per 8-K ──────────────────────────────────────────────

async function catalystTimeline(ticker, { from, to, coverage }) {
  const res = await db.execute(sql`
    select items, coalesce(material, false) as material, filed_at, accession, report_date,
           filing_url, primary_doc_url
      from eightk_filings
     where ticker = ${ticker}
       and filed_at >= (now() - make_interval(days => ${MAX_RANGE_DAYS}))
     order by filed_at asc
     limit 2000`);
  const all = rows(res);
  if (!all.length) return [];

  const codesOf = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,\s]+/)).map((s) => String(s).trim()).filter(Boolean);
  const specOf = (f) => codesOf(f.items).map((c) => ITEM_TO_TYPE[c]).filter(Boolean)
    .sort((a, b) => b.materiality - a.materiality)[0] || null;

  const out = [];
  for (const f of all) {
    const t = ms(f.filed_at);
    if (t == null || t < from || t > to) continue;
    const spec = specOf(f);
    if (!spec) continue;                       // unmapped item codes produce nothing, by design

    const priorSame = all.filter((x) => (ms(x.filed_at) ?? 0) < t && specOf(x)?.type === spec.type);
    out.push({
      ticker, family: FAMILY.CATALYST, type: spec.type, subtype: codesOf(f.items).join(','),
      direction: spec.direction, materiality: spec.materiality, quality: 0.95,
      // filed_at is a real timestamptz, so an intraday chart can place this to the minute.
      publicTime: f.filed_at,
      eventTime: f.report_date || null,
      source: 'sec_8k', sourceId: f.accession,
      url: f.primary_doc_url || f.filing_url || null,
      summary: spec.label,
      facts: { items: codesOf(f.items), material: f.material },
      context: firstInContext({
        priorTimes: priorSame.map((x) => ms(x.filed_at)),
        coverageStart: coverage[FAMILY.CATALYST] ?? null, now: t,
        noun: `${spec.label.toLowerCase()} filing`,
      }),
    });
  }
  return out;
}

// ── congress, one item per disclosure date ───────────────────────────────────

async function congressTimeline(ticker, { from, to, coverage }) {
  const res = await db.execute(sql`
    select action, amount_range, member_slug, representative, party, chamber, state,
           disclosure_date, transaction_date, link
      from congress_trades
     where ticker = ${ticker}
       and disclosure_date >= (current_date - make_interval(days => ${MAX_RANGE_DAYS}))
     order by disclosure_date asc
     limit 2000`);
  const all = rows(res);
  if (!all.length) return [];

  const byDay = new Map();
  for (const x of all) {
    const d = isoDay(x.disclosure_date);
    if (!d) continue;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(x);
  }

  const out = [];
  for (const [day, items] of byDay) {
    const t = ms(day);
    if (t == null || t < from || t > to) continue;

    const members = [...new Set(items.map((x) => x.member_slug || x.representative).filter(Boolean))];
    const buys = items.filter((x) => String(x.action || '').toUpperCase().startsWith('BUY'));
    const newest = items[0];
    const prior = all.filter((x) => (ms(x.disclosure_date) ?? 0) < t);

    out.push({
      ticker, family: FAMILY.CONGRESS,
      type: members.length > 1 ? 'congress_multi' : 'congress_disclosure',
      subtype: newest.chamber || null,
      direction: buys.length === items.length ? DIRECTION.POSITIVE
        : buys.length === 0 ? DIRECTION.NEGATIVE : DIRECTION.MIXED,
      materiality: members.length > 1 ? 0.65 : 0.55,
      quality: 0.60,
      // ⚠️ THE DISCLOSURE DATE IS THE PUBLIC CLOCK. transaction_date is carried as eventTime for the
      // detail panel and is never the marker's position.
      publicTime: day,
      eventTime: newest.transaction_date || null,
      source: 'congress',
      sourceId: `${newest.member_slug || newest.representative}|${day}|${ticker}`,
      url: newest.link || null,
      summary: members.length > 1
        ? `${members.length} members of Congress disclosed ${buys.length === items.length ? 'purchases' : 'trades'}`
        : `${newest.representative || 'A member of Congress'} disclosed a ${String(newest.action || 'trade').toLowerCase()}`,
      facts: {
        members: members.length, transactions: items.length,
        representative: newest.representative || null, chamber: newest.chamber || null,
        party: newest.party || null, state: newest.state || null,
        amountRange: newest.amount_range || null,
        transactionDate: isoDay(newest.transaction_date),
        disclosureDate: day,
        disclosureLagDays: newest.transaction_date
          ? Math.max(0, Math.round((t - ms(newest.transaction_date)) / DAY)) : null,
      },
      context: firstInContext({
        priorTimes: prior.map((x) => ms(x.disclosure_date)),
        coverageStart: coverage[FAMILY.CONGRESS] ?? null, now: t,
        noun: 'congressional disclosure for this ticker',
      }),
    });
  }
  return out;
}

// ── institutions, one item per quarter's disclosure ──────────────────────────

async function institutionTimeline(ticker, { from, to, now }) {
  // ⚠️ WHICH DAY IS "THE" 13F DISCLOSURE? Thousands of funds file across a ~45-day window, so no
  // single filing is the moment. The answer is the day half the quarter's filers were in — and it
  // is a property of the QUARTER, shared by every security in those filings, because they all
  // became public together. See quarterDisclosureDates(); deriving it per ticker was both slower
  // and less correct.
  const [res, disclosure] = await Promise.all([
    db.execute(sql`
      select quarter, count(distinct cik) as breadth
        from fund_holdings
       where ticker = ${ticker}
         and put_call = ''
         and quarter >= (current_date - make_interval(days => ${BREADTH_LOOKBACK_DAYS}))
       group by quarter
       order by quarter asc
       limit ${BREADTH_QUARTERS}`),
    quarterDisclosureDates({ now }),
  ]);
  const series = rows(res).map((x) => ({
    quarter: x.quarter,
    breadth: Number(x.breadth || 0),
    filed: disclosure.get(isoDay(x.quarter))?.disclosedAt ?? null,
  })).filter((x) => x.filed);
  if (series.length < 2) return [];

  const out = [];
  for (let i = 1; i < series.length; i++) {
    const cur = series[i], prev = series[i - 1];
    const t = ms(cur.filed);
    if (t == null || t < from || t > to) continue;
    // Resolution artifacts are suppressed here exactly as in the digest — the guard is shared.
    if (implausibleBreadth(prev.breadth, cur.breadth)) continue;

    const priorChanges = [];
    for (let j = 1; j < i; j++) priorChanges.push(series[j].breadth - series[j - 1].breadth);
    const change = breadthChangeContext({ from: prev.breadth, to: cur.breadth, priorChanges });
    if (!change) continue;

    out.push({
      ticker, family: FAMILY.INSTITUTION, type: 'institution_breadth_change',
      subtype: quarterLabel(cur.quarter),
      direction: change.delta > 0 ? DIRECTION.POSITIVE : DIRECTION.NEGATIVE,
      materiality: change.unusual ? 0.60 : 0.45,
      quality: 0.80,
      // BOTH CLOCKS. The marker sits on the disclosure; the quarter end lives in the detail.
      publicTime: cur.filed,
      eventTime: cur.quarter,
      referencePeriod: quarterLabel(cur.quarter),
      source: 'sec_13f', sourceId: `13f|${ticker}|${isoDay(cur.quarter)}`,
      url: null,
      summary: change.text,
      facts: {
        quarter: quarterLabel(cur.quarter), quarterEnd: isoDay(cur.quarter),
        breadthFrom: prev.breadth, breadthTo: cur.breadth, delta: change.delta,
        unusual: change.unusual, basis: change.reason,
        disclosedAt: isoDay(cur.filed),
      },
      context: change.note ? { text: change.note, unusual: true } : null,
    });
  }
  return out;
}

// ── public interface ─────────────────────────────────────────────────────────

/**
 * Evidence for a ticker across a time range, at public-moment granularity.
 *
 * Every item passes the same integrity gates and the same dedupe as the digest, because it goes
 * through collectEvidence — so quarantined, future-dated, NONE-ticker and PIT-violating rows can no
 * more reach the chart than they can reach the list.
 */
export async function tickerEvidenceRange(ticker, { from, to, now = Date.now() } = {}) {
  const symbol = String(ticker || '').toUpperCase();
  const toMs = to == null ? now : new Date(to).getTime();
  const fromMs = from == null ? toMs - 365 * DAY : new Date(from).getTime();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) {
    return { ticker: symbol, evidence: [], failedFamilies: [], quarantined: [], range: null };
  }
  // Bounded on the server, not trusted from the client: an unbounded range is an unbounded query.
  const floor = now - MAX_RANGE_DAYS * DAY;
  const lo = Math.max(fromMs, floor);
  const coverage = await coverageBoundaries({ now });

  const families = [
    ['insider', insiderTimeline],
    ['catalyst', catalystTimeline],
    ['congress', congressTimeline],
    ['institution', institutionTimeline],
  ];
  const settled = await Promise.allSettled(
    families.map(([, fn]) => fn(symbol, { from: lo, to: toMs, coverage, now })),
  );

  const raw = [];
  const failed = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') raw.push(...(s.value || []));
    else failed.push({ family: families[i][0], error: String(s.reason?.message || s.reason) });
  });

  const { evidence, quarantined } = collectEvidence(raw, { now });
  return {
    ticker: symbol,
    evidence: rankEvidence(evidence, { now }),
    failedFamilies: failed,
    quarantined: quarantined.map((q) => ({ reason: q.reason, detail: q.detail })),
    range: { from: new Date(lo).toISOString(), to: new Date(toMs).toISOString() },
    calculatedAt: new Date(now).toISOString(),
  };
}
