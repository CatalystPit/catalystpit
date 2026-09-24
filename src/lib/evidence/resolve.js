// EVIDENCE RESOLUTION — turning our own filing tables into canonical evidence objects.
//
// The only part of the Market Evidence Engine that touches the database. model.mjs, history.mjs and
// rank.mjs stay pure so the rules can be tested without fixtures; everything schema- and PIT-specific
// lives here.
//
// ── THIS LAYER JOINS AND INTERPRETS. IT DOES NOT STORE. ─────────────────────
//
// No new table holds a copy of a Form 4 or an 8-K. Those records are already correct where they
// live, and a second copy is a second thing to keep in sync and a second thing to be wrong. What
// this file adds is the JOIN and the INTERPRETATION — which of those records is a CHANGE worth a
// trader's attention, and how unusual it is for this company.
//
// ── POINT-IN-TIME, AS EVERYWHERE ELSE ───────────────────────────────────────
//
//   Form 4    filing_date      the SEC publication, never transaction_date
//   Congress  disclosure_date  never the trade date; the STOCK Act allows a 45-day lag
//   13F       filed_date       quarter end carried separately as the reference period
//   8-K       filed_at
//
// ── QUERY SHAPE ─────────────────────────────────────────────────────────────
//
// One bounded query per family, all families in parallel, no per-row follow-up. Each family needs
// two horizons — the DISPLAY window (what changed lately) and the HISTORY window (what makes it
// unusual) — and both come back in the same round trip, because "first CEO purchase in 842 days"
// cannot be answered from a 30-day window and must not cost 842 queries.

import { sql } from 'drizzle-orm';
import {
  classifyCompanyEvent, extractScheduledDate, sourceQuality, stillRelevant, MAX_RELEVANCE_DAYS,
} from './company-events.mjs';
import { isLeadRole } from '../consensus/high-significance.mjs';
import { db } from '../db';
import { FAMILY, DIRECTION, collectEvidence } from './model.mjs';
import { firstInContext, burstContext, extremeContext, breadthChangeContext, streakContext, implausibleBreadth } from './history.mjs';
import { rankEvidence } from './rank.mjs';

const DAY = 86_400_000;
const rows = (res) => res?.rows ?? res ?? [];
const num = (v) => (v == null ? null : Number(v));
const ms = (d) => (d == null ? null : new Date(d).getTime());

/** How far back the display window looks. Anything older is context, not a change. */
export const DISPLAY_WINDOW_DAYS = 45;
/** How far back the unusualness comparison looks. Bounded so the query stays indexed and cheap. */
export const HISTORY_WINDOW_DAYS = 1460;   // four years

export const usdLabel = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return null;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${Math.round(v / 1e3)}K`;
  return `$${Math.round(v)}`;
};

// ── coverage boundaries ──────────────────────────────────────────────────────
// A rarity claim is only honest against a KNOWN boundary — see history.mjs. The boundary is the
// earliest date our ingestion could have seen such a record AT ALL, which is a property of the
// dataset rather than of the ticker: a company that first filed last year has thin ticker history
// but our coverage is still three years, and conflating the two produces "first in our 1-month
// history" on a company whose Form 4s we simply do not have.
//
// Table-wide, so it is computed once per process rather than per request.
let _coverage = null;
let _coverageAt = 0;
const COVERAGE_TTL_MS = 6 * 3600e3;

export async function coverageBoundaries({ now = Date.now() } = {}) {
  if (_coverage && now - _coverageAt < COVERAGE_TTL_MS) return _coverage;
  try {
    const res = await db.execute(sql`
      select
        -- insider_history_meta is the existing singleton recording how far back the Form 4 backfill
        -- actually reached. It is the honest boundary and outranks min(filing_date), which only says
        -- where the rows happen to start and would silently drift as backfill progresses.
        (select covered_from from insider_history_meta where id = 1) as insider_declared,
        (select min(filing_date)     from insider_trades)  as insider_observed,
        (select min(disclosure_date) from congress_trades) as congress,
        (select min(filed_at)        from eightk_filings)  as catalyst`);
    const r = rows(res)[0] || {};
    _coverage = {
      [FAMILY.INSIDER]: ms(r.insider_declared) ?? ms(r.insider_observed),
      [FAMILY.CONGRESS]: ms(r.congress),
      [FAMILY.CATALYST]: ms(r.catalyst),
    };
    _coverageAt = now;
  } catch {
    // Unknown boundary → history.mjs makes NO rarity claim. Degrading to "no context" is correct;
    // guessing a boundary would manufacture rarity, which is the one thing that file forbids.
    _coverage = {};
  }
  return _coverage;
}

/** Test seam: lets a suite inject boundaries without a database. */
export function __setCoverage(c) { _coverage = c; _coverageAt = Date.now(); }

// ── when a 13F quarter became public ─────────────────────────────────────────
//
// ⚠️ THIS IS A PROPERTY OF THE QUARTER, NOT OF THE TICKER, and treating it as per-ticker was both
// slower and less correct.
//
// Thousands of funds file across a ~45-day window, so no single filing is "the" disclosure. The
// honest marker is the day half the quarter's filers were in — and that day is the same for every
// security in those filings, because they all became public together. Two tickers' Q2 markers
// landing on different days would be an artifact of which funds happen to hold them.
//
// It is also ~7x faster. Deriving it per ticker needs filed_date from fund_holdings, which is NOT
// in the covering index idx_fund_holdings_qoq — so every row of a mega-cap's 120k holdings takes a
// heap lookup, measured at 3,459ms cold for GOOGL. fund_filings has one row per (cik, quarter),
// ~8,900 per quarter, and answers for ALL quarters at once in ~230ms.
let _quarterDisclosure = null;
let _quarterDisclosureAt = 0;

export async function quarterDisclosureDates({ now = Date.now() } = {}) {
  if (_quarterDisclosure && now - _quarterDisclosureAt < COVERAGE_TTL_MS) return _quarterDisclosure;
  const map = new Map();
  try {
    const res = await db.execute(sql`
      select quarter,
             percentile_disc(0.5) within group (order by filed_date) as median_filed,
             count(*) as filers
        from fund_filings
       where filed_date is not null
       group by quarter
       order by quarter desc
       limit 24`);
    for (const r of rows(res)) {
      const q = isoDay(r.quarter);
      if (q && r.median_filed) map.set(q, { disclosedAt: r.median_filed, filers: Number(r.filers || 0) });
    }
    _quarterDisclosure = map;
    _quarterDisclosureAt = now;
  } catch {
    // No disclosure date means no honest marker placement, so the family simply produces nothing
    // rather than falling back to the quarter end — which would date it months early.
    _quarterDisclosure = map;
  }
  return _quarterDisclosure;
}

/** Test seam. */
export function __setQuarterDisclosure(m) { _quarterDisclosure = m; _quarterDisclosureAt = Date.now(); }

/** How many quarters back the breadth series reaches. Bounds the scan; see the note above. */
export const BREADTH_QUARTERS = 9;
export const BREADTH_LOOKBACK_DAYS = 900;

// ── 1. INSIDERS (Form 4) ─────────────────────────────────────────────────────
//
// THE DISCRIMINATION THAT MATTERS: an open-market purchase (transaction code P) is a decision; a
// grant (A), an option exercise (M) and a tax withholding (F) are administrative, and a 10b5-1 sale
// was decided months ago. Section 5 of the brief is explicit that routine activity must not
// dominate, so only discretionary transactions become evidence and the rest never qualify a row.

export const OPEN_MARKET_BUY = 'P';

export async function insiderEvidence(ticker, { now = Date.now(), coverage = {} } = {}) {
  const res = await db.execute(sql`
    select action, transaction_code, total_value, shares, executive, title, filing_date, accession,
           filing_url,
           coalesce(rule_10b5_1, false) as planned,
           coalesce(is_derivative, false) as derivative,
           coalesce(superseded_by, '') as superseded,
           coalesce(is_officer, false) as officer, coalesce(is_director, false) as director
      from insider_trades
     where ticker = ${ticker}
       and filing_date >= (current_date - make_interval(days => ${HISTORY_WINDOW_DAYS}))
       and total_value > 0
     order by filing_date desc
     limit 2000`);
  const r = rows(res).filter((x) => !x.superseded);   // a 4/A replaced this row; it is not evidence
  if (!r.length) return [];

  const cutoff = now - DISPLAY_WINDOW_DAYS * DAY;
  // THE CANONICAL OPEN-MARKET PURCHASE, matching form4.mjs's isOpenMarketBuy and the OM_BUY
  // predicate the context builder uses: transaction code P, non-derivative.
  //
  // ⚠️ `action` is NOT sufficient and a missing code is NOT a purchase. classifyAction() collapses
  // A (grant), M (option exercise) and F (tax withholding) into 'OTHER', but an earlier draft of
  // this file admitted rows with a null transaction_code — which would have let administrative
  // grants be reported as conviction buys. That is precisely the noise section 5 forbids.
  const isOpenMarketBuy = (x) => x.transaction_code === OPEN_MARKET_BUY && !x.derivative;
  const recent = r.filter((x) => (ms(x.filing_date) ?? 0) >= cutoff);

  const out = [];

  // ── open-market purchases, the highest-information insider event ──
  const recentBuys = recent.filter(isOpenMarketBuy);
  if (recentBuys.length) {
    const buyers = [...new Set(recentBuys.map((x) => x.executive).filter(Boolean))];
    const officerBuy = recentBuys.find((x) => x.officer);
    const newest = recentBuys[0];
    const totalValue = recentBuys.reduce((s, x) => s + Number(x.total_value || 0), 0);

    // Historical comparison uses ONLY comparable prior events, and excludes the ones we are
    // reporting — otherwise every purchase is "the first in 0 days".
    const priorBuys = r.filter((x) => isOpenMarketBuy(x) && (ms(x.filing_date) ?? 0) < cutoff);
    const cov = coverage[FAMILY.INSIDER] ?? null;

    let context = null;
    if (officerBuy) {
      const priorOfficer = priorBuys.filter((x) => x.officer);
      context = firstInContext({
        priorTimes: priorOfficer.map((x) => ms(x.filing_date)),
        coverageStart: cov, now, noun: 'officer open-market purchase',
      });
    }
    if (!context) {
      context = firstInContext({
        priorTimes: priorBuys.map((x) => ms(x.filing_date)),
        coverageStart: cov, now, noun: 'insider open-market purchase',
      });
    }
    // A burst outranks a gap claim: three purchases in two weeks is the more striking fact.
    const burst = burstContext({
      times: recentBuys.map((x) => ms(x.filing_date)), windowDays: 30, now, noun: 'open-market purchases',
    });
    if (burst && recentBuys.length >= 3) context = burst;
    if (!context) {
      context = extremeContext({
        value: Number(newest.total_value || 0),
        priorValues: priorBuys.map((x) => Number(x.total_value || 0)),
        coverageStart: cov, now, noun: 'insider purchase',
      });
    }

    const cluster = buyers.length >= 3;
    out.push({
      ticker, family: FAMILY.INSIDER,
      type: cluster ? 'insider_cluster_buy' : officerBuy ? 'insider_officer_buy' : 'insider_buy',
      subtype: officerBuy?.title || newest.title || null,
      direction: DIRECTION.POSITIVE,
      materiality: cluster ? 0.85 : officerBuy ? 0.80 : 0.65,
      quality: (officerBuy || newest.director) ? 0.95 : 0.85,
      eventTime: null,                       // transaction_date is not carried on this row set
      publicTime: newest.filing_date,
      source: 'sec_form4', sourceId: newest.accession,
      url: newest.filing_url || null,
      summary: buildInsiderSummary({ recentBuys, buyers, officerBuy, totalValue, cluster }),
      facts: {
        buyers: buyers.length, transactions: recentBuys.length,
        totalValue: totalValue || null, totalValueLabel: usdLabel(totalValue),
        officer: !!officerBuy, executive: officerBuy?.executive || newest.executive || null,
        title: officerBuy?.title || newest.title || null,
        // ⚠️ STRUCTURED FIGURES FOR THE SIGNIFICANCE RULES, computed from the SAME recentBuys set
        // the summary is built from. Without these a "$1M single purchase" rule would have to parse
        // the summary sentence, which is prose and would break the first time the wording changed.
        //
        // topBuyer is the largest single insider's TOTAL across the window, not their largest
        // ticket: three $400K purchases by one officer is a $1.2M commitment by one person, and
        // splitting it across filings should not hide it.
        ...(() => {
          const byPerson = new Map();
          for (const x of recentBuys) {
            const k = x.executive || '(unknown)';
            byPerson.set(k, (byPerson.get(k) || 0) + Number(x.total_value || 0));
          }
          let topBuyer = null, topBuyerValue = 0;
          for (const [k, v] of byPerson) if (v > topBuyerValue) { topBuyer = k; topBuyerValue = v; }
          // The filed title is the only role source; it is present on 100% of buys measured.
          const lead = recentBuys.filter((x) => isLeadRole(x.title));
          const leadValue = lead.reduce((sum, x) => sum + Number(x.total_value || 0), 0);
          return {
            topBuyer, topBuyerValue: topBuyerValue || null,
            leadRoleValue: leadValue || null,
            leadRoleTitle: lead[0]?.title || null,
            leadRoleExecutive: lead[0]?.executive || null,
          };
        })(),
      },
      context,
    });
  }

  // ── discretionary selling. Reported, never as the mirror of buying. ──
  const discSells = recent.filter((x) => x.action === 'SELL' && !x.planned);
  if (discSells.length >= 2) {
    const sellers = [...new Set(discSells.map((x) => x.executive).filter(Boolean))];
    const newest = discSells[0];
    const totalValue = discSells.reduce((s, x) => s + Number(x.total_value || 0), 0);
    out.push({
      ticker, family: FAMILY.INSIDER, type: 'insider_discretionary_sell',
      direction: DIRECTION.NEGATIVE, materiality: 0.55, quality: 0.90,
      publicTime: newest.filing_date,
      source: 'sec_form4', sourceId: newest.accession,
      url: newest.filing_url || null,
      summary: `${sellers.length} insider${sellers.length > 1 ? 's' : ''} sold ${usdLabel(totalValue) || 'shares'} outside a 10b5-1 plan`,
      facts: { sellers: sellers.length, transactions: discSells.length, totalValue: totalValue || null },
      context: null,
    });
  }

  // 10b5-1 sales and administrative codes are deliberately NOT emitted. They are the noise the
  // section exists to filter out, and a routine plan sale on every mega-cap every month would
  // train a reader to stop reading.
  return out;
}

function buildInsiderSummary({ recentBuys, buyers, officerBuy, totalValue, cluster }) {
  const amount = usdLabel(totalValue);
  if (cluster) return `${buyers.length} insiders bought${amount ? ` ${amount}` : ''} on the open market`;
  if (officerBuy) {
    const who = officerBuy.title || 'Officer';
    return `${who} open-market purchase${amount ? ` of ${amount}` : ''}`;
  }
  if (recentBuys.length === 1) return `Insider open-market purchase${amount ? ` of ${amount}` : ''}`;
  return `${recentBuys.length} insider open-market purchases${amount ? ` totalling ${amount}` : ''}`;
}

// Provenance is always the URL the ingester already stored (`filing_url` / `primary_doc_url`).
// An earlier draft of this file SYNTHESISED an EDGAR full-text-search link from the accession. That
// link is not the document, and for many accessions it resolves to nothing — a "View Filing" button
// that does not open the filing is worse than no button, because it looks like verification.

// ── 2. CATALYSTS (8-K) ───────────────────────────────────────────────────────
//
// The SEC's own item taxonomy, not a publisher's opinion about importance. Unmapped item codes
// deliberately produce nothing rather than a vague "corporate event".

export const ITEM_TO_TYPE = Object.freeze({
  '4.02': { type: 'sec_8k_non_reliance', label: 'Non-reliance on prior financials', materiality: 1.00, direction: DIRECTION.NEGATIVE },
  '3.01': { type: 'sec_8k_delisting', label: 'Delisting / listing-standard notice', materiality: 0.95, direction: DIRECTION.NEGATIVE },
  '4.01': { type: 'sec_8k_auditor_change', label: 'Auditor change', materiality: 0.85, direction: DIRECTION.NEGATIVE },
  '2.04': { type: 'sec_8k_obligation', label: 'Financial obligation triggered', materiality: 0.80, direction: DIRECTION.NEGATIVE },
  '1.01': { type: 'sec_8k_material_agreement', label: 'Material agreement', materiality: 0.75, direction: DIRECTION.POSITIVE },
  '1.02': { type: 'sec_8k_agreement_ended', label: 'Material agreement terminated', materiality: 0.75, direction: DIRECTION.NEGATIVE },
  '2.02': { type: 'sec_8k_results', label: 'Results of operations', materiality: 0.70, direction: DIRECTION.UNKNOWN },
  '5.02': { type: 'sec_8k_officer_change', label: 'Officer / director change', materiality: 0.60, direction: DIRECTION.UNKNOWN },
  '8.01': { type: 'sec_8k_other', label: 'Other material event', materiality: 0.45, direction: DIRECTION.UNKNOWN },

  // ── ⚠️ ITEMS THAT WERE BEING DISCARDED ENTIRELY ────────────────────────────
  //
  // This map is the REAL gate on canonical catalyst evidence — `if (!spec) continue` below — and it
  // held nine of the SEC's twenty-five item codes. So a bankruptcy, a change of control and a
  // completed acquisition all produced NOTHING, not a weak signal: nothing. APUS filed items
  // 3.03/5.03/9.01 and the filing never became evidence, which is what sent a +144% mover to Pit
  // Scan labelled "no matching evidence" while the 8-K sat in our own table.
  //
  // Every addition below is a NUMBERED SEC ITEM WHOSE OWN TITLE ASSERTS THE EVENT — the same
  // standard the nine originals used, not a judgement about importance. Routine items stay out:
  // 5.03 bylaw amendments, 5.07 shareholder votes, 7.01 Reg FD, 9.01 exhibits and the 6.x ABS
  // series are unmapped by design, so conservative filtering is preserved.
  '1.03': { type: 'sec_8k_bankruptcy', label: 'Bankruptcy or receivership', materiality: 1.00, direction: DIRECTION.NEGATIVE },
  '5.01': { type: 'sec_8k_control_change', label: 'Change in control', materiality: 0.90, direction: DIRECTION.UNKNOWN },
  '2.01': { type: 'sec_8k_acquisition', label: 'Acquisition or disposition completed', materiality: 0.80, direction: DIRECTION.UNKNOWN },
  '1.05': { type: 'sec_8k_cyber', label: 'Material cybersecurity incident', materiality: 0.75, direction: DIRECTION.NEGATIVE },
  // "Material Modification to Rights of Security Holders" — the SEC's own words. Direction is
  // UNKNOWN because the same item covers a reverse split, a rights plan and a charter change.
  '3.03': { type: 'sec_8k_holder_rights', label: 'Modification of security-holder rights', materiality: 0.70, direction: DIRECTION.UNKNOWN },
  '3.02': { type: 'sec_8k_unregistered_sale', label: 'Unregistered equity sale', materiality: 0.70, direction: DIRECTION.NEGATIVE },
  '2.06': { type: 'sec_8k_impairment', label: 'Material impairment', materiality: 0.70, direction: DIRECTION.NEGATIVE },
  '5.06': { type: 'sec_8k_shell_status', label: 'Change in shell company status', materiality: 0.70, direction: DIRECTION.UNKNOWN },
  '2.05': { type: 'sec_8k_exit_costs', label: 'Exit or disposal costs', materiality: 0.60, direction: DIRECTION.NEGATIVE },
  '2.03': { type: 'sec_8k_obligation_created', label: 'Direct financial obligation created', materiality: 0.60, direction: DIRECTION.UNKNOWN },

  // ── FORM 25 — DELISTING, CARRIED ON THE SAME PATH ──────────────────────────
  //
  // ⚠️ THE FORM TYPE ESTABLISHES WHO ACTED, so neither label is speculative. 25-NSE is filed BY THE
  // EXCHANGE (Notification of Removal from Listing); a plain Form 25 is filed by the issuer to
  // withdraw its own security. Stored in the same table under these pseudo-codes so dedupe,
  // point-in-time ordering and the evidence path are the ones that already work — see eightk.js.
  //
  // ⚠️ AND NEITHER SAYS THE COMPANY IS FINISHED. A Form 25 also covers a move between exchanges and
  // the retirement of a single class of security, so the summary states what was filed and stops.
  '25-NSE': { type: 'sec_25_removal', label: 'Exchange filed notice of removal from listing', materiality: 0.90, direction: DIRECTION.NEGATIVE },
  '25': { type: 'sec_25_withdrawal', label: 'Notice to withdraw security from listing', materiality: 0.80, direction: DIRECTION.NEGATIVE },
});

export async function catalystEvidence(ticker, { now = Date.now(), coverage = {} } = {}) {
  const res = await db.execute(sql`
    select items, coalesce(material, false) as material, filed_at, accession, report_date,
           filing_url, primary_doc_url
      from eightk_filings
     where ticker = ${ticker}
       and filed_at >= (now() - make_interval(days => ${HISTORY_WINDOW_DAYS}))
     order by filed_at desc
     limit 1000`);
  const r = rows(res);
  // ⚠️ NO 8-K IS NOT NO CATALYST, AND THIS EARLY RETURN WAS THE BUG IN MINIATURE.
  //
  // It returned before the press-release path at the end of this function, so a company that files
  // no 8-K got no catalyst evidence at all — precisely the population that path exists for.
  // Measured: LLY's FDA approval and ANIP's both resolved inside pressReleaseEvidence and were then
  // discarded here, while QNRX worked only because it happened to have an 8-K as well.
  if (!r.length) {
    try { return await pressReleaseEvidence(ticker, { now }); } catch { return []; }
  }

  const cutoff = now - DISPLAY_WINDOW_DAYS * DAY;
  const out = [];
  const recent = r.filter((x) => (ms(x.filed_at) ?? 0) >= cutoff);

  for (const f of recent) {
    const items = Array.isArray(f.items) ? f.items : String(f.items || '').split(/[,\s]+/).filter(Boolean);
    // The most material mapped item decides the row. An 8-K carrying both 2.02 and 8.01 is a
    // results filing, not an "other event".
    const mapped = items.map((i) => ITEM_TO_TYPE[String(i).trim()]).filter(Boolean)
      .sort((a, b) => b.materiality - a.materiality);
    const spec = mapped[0];
    if (!spec) continue;                       // unmapped → nothing, by design

    const priorSame = r.filter((x) => {
      const t = ms(x.filed_at) ?? 0;
      if (t >= cutoff) return false;
      const its = Array.isArray(x.items) ? x.items : String(x.items || '').split(/[,\s]+/);
      return its.some((i) => ITEM_TO_TYPE[String(i).trim()]?.type === spec.type);
    });

    out.push({
      ticker, family: FAMILY.CATALYST, type: spec.type, subtype: items.join(','),
      direction: spec.direction, materiality: spec.materiality, quality: 0.95,
      eventTime: f.report_date || null,
      publicTime: f.filed_at,
      source: 'sec_8k', sourceId: f.accession,
      // The document itself where we have it, the EDGAR index page otherwise.
      url: f.primary_doc_url || f.filing_url || null,
      summary: spec.label,
      facts: { items, material: f.material },
      context: firstInContext({
        priorTimes: priorSame.map((x) => ms(x.filed_at)),
        coverageStart: coverage[FAMILY.CATALYST] ?? null, now,
        noun: spec.label.toLowerCase() + ' filing',
      }),
    });
  }

  // "Third material 8-K in 5 trading days" — a burst of material filings is itself a signal, and
  // is attached to the freshest one rather than emitted as a separate phantom row.
  const materialRecent = recent.filter((x) => x.material);
  if (out.length && materialRecent.length >= 3) {
    const burst = burstContext({
      times: materialRecent.map((x) => ms(x.filed_at)), windowDays: 14, now, noun: 'material 8-K filings',
    });
    if (burst && !out[0].context) out[0].context = burst;
  }

  // ⚠️ A PRESS RELEASE IS ALSO A PUBLIC EVENT, and until now none could ever become evidence.
  // See pressReleaseEvidence: small biotechs announce INDs, topline data and designations by wire
  // and often file no 8-K at all, so the whole class was invisible to every consumer.
  try {
    out.push(...await pressReleaseEvidence(ticker, { now }));
  } catch { /* the filing evidence above stands on its own */ }
  return out;
}

/**
 * CLASSIFIED COMPANY PRESS RELEASES AS CANONICAL CATALYST EVIDENCE.
 *
 * ── ⚠️ THE TICKER MUST ALREADY BE RESOLVED ──────────────────────────────────
 *
 * This reads `tickers`, the column the wire's own canonical resolver populates. It does NOT attempt
 * its own attribution, so the CRCW failure class — a headline matched to a company because a word
 * looked like a name — cannot recur here. No resolution, no evidence.
 *
 * ── ⚠️ AND THE SOURCE MUST BE A RECORD, NOT A COLUMN ────────────────────────
 *
 * sourceQuality() decides. An issuer's own wire release and a professional news desk qualify;
 * aggregator research and retail commentary do not, and returning null there is what keeps
 * "SpaceX: Why I'm Turning Bullish After The Drop" from becoming a canonical SPCX event. The
 * number it returns is also the record's quality — a desk report is weaker than the issuer's own.
 *
 * ── ⚠️ AND THE HEADLINE MUST STATE AN EVENT ─────────────────────────────────
 *
 * classifyCompanyEvent refuses conference invitations, awards, analyst ratings, litigation spam,
 * roundups and marketing before it looks for anything else, so event VOCABULARY alone produces
 * nothing. An unclassified release stays what it always was: a wire item, not evidence.
 */
export async function pressReleaseEvidence(ticker, { now = Date.now() } = {}) {
  // The longest event-type window bounds the query; each row is then held to its OWN window below.
  const maxDays = MAX_RELEVANCE_DAYS;
  const res = await db.execute(sql`
    select seq, source, coalesce(source_headline, headline) as headline, summary,
           published_at, canonical_url, original_url, content_hash
      from primary_events
     where ${ticker} = any(tickers)
       and published_at >= (now() - make_interval(days => ${maxDays}))
     order by published_at desc
     limit 60`);

  const seen = new Set();
  const out = [];
  for (const e of rows(res)) {
    // ⚠️ THE SOURCE GATE COMES FIRST and is also where quality comes from — see sourceQuality.
    const quality = sourceQuality(e.source);
    if (quality == null) continue;
    const spec = classifyCompanyEvent(e.headline, e.summary);
    if (!spec) continue;
    const publicMs = ms(e.published_at);
    if (publicMs == null) continue;
    // ⚠️ EACH TYPE KEEPS ITS OWN RELEVANCE WINDOW. A trial-start notice is stale long before an
    // IND submission is, and applying one global window would either bury the regulatory events or
    // drag operational noise along with them.
    // ⚠️ AND A SCHEDULED EVENT IS MEASURED FROM WHEN IT HAPPENS, NOT FROM WHEN IT WAS ANNOUNCED —
    // see stillRelevant, and the SPCX measurement that produced it.
    const scheduledFor = extractScheduledDate(`${e.headline || ''} ${e.summary || ''}`, spec.type, publicMs);
    const eventMs = scheduledFor ? Date.parse(`${scheduledFor}T00:00:00Z`) : null;
    if (!stillRelevant(spec.type, publicMs, eventMs, now)) continue;
    // One record per event TYPE — the newest. A wire that republishes the same announcement four
    // times must not look like four separate catalysts.
    if (seen.has(spec.type)) continue;
    seen.add(spec.type);

    out.push({
      ticker, family: FAMILY.CATALYST, type: spec.type, subtype: e.source || null,
      direction: spec.direction, materiality: spec.materiality,
      // Lower than a filing's 0.95: a company describing its own news is a weaker record than a
      // document filed with the SEC under liability, and confidence reads this.
      quality,
      // ⚠️ A SCHEDULED DATE IS NOT AN eventTime, AND PUTTING IT THERE WAS A REAL MISTAKE I MADE.
      //
      // model.mjs defines eventTime as WHEN THE THING HAPPENED and enforces publicTime >= eventTime
      // as the invariant the whole engine rests on. A launch announced on the 17th for the 28th has
      // not happened, so setting eventTime = the 28th quarantines the record as `future` — which is
      // the model being right. The schedule is a DISCLOSED FACT about the future, so it lives in
      // facts.scheduledFor, and eventTime stays null until there is an occurrence to date.
      eventTime: null,
      publicTime: e.published_at,      // ⚠️ POINT-IN-TIME: when the public could first act on it
      source: 'press_release', sourceId: e.content_hash || String(e.seq),
      url: e.canonical_url || e.original_url || null,
      summary: scheduledFor ? `${spec.label} — scheduled ${scheduledFor}` : spec.label,
      facts: {
        headline: String(e.headline || '').split('\n')[0].slice(0, 180),
        wire: e.source || null,
        scheduledFor,
      },
      context: null,
    });
  }
  return out;
}

// ── 2b. PROPOSED INSIDER SALES (Form 144) ────────────────────────────────────
//
// ── ⚠️ THE SEMANTICS ARE THE WHOLE POINT ────────────────────────────────────
//
// A Form 144 is NOTICE OF A PROPOSED SALE. It is not a sale, and the summary this builds never
// says one happened — "President/COO filed notice to sell $52.0M" is the strongest form of words
// the document supports. The executed sale, if there is one, arrives later on a Form 4 and is
// already a separate evidence family with its own direction and its own history.
//
// ── ⚠️ MOST FORM 144s ARE ROUTINE AND MUST NOT BECOME EVIDENCE ──────────────
//
// Restricted stock vests and the recipient files a 144 to sell enough to cover tax. Hundreds a day.
// MIN_VALUE and MIN_PCT are the floor, and a notice below BOTH produces nothing at all rather than
// a weak signal, because a board full of $250K vesting sales is worse than an empty board.
//
// ── ⚠️ AND DIRECTION IS UNKNOWN, DELIBERATELY ───────────────────────────────
//
// It is tempting to call a proposed insider sale bearish. But a 10b5-1 sale was decided months
// ago, a diversification sale says nothing about the business, and marking hundreds of routine
// notices NEGATIVE would inject a standing bearish tilt into Consensus for every large employer in
// the market. The record states what was filed; the reader decides what it means.

/** Proposed value at or above which a notice is worth showing on its own. */
export const FORM144_MIN_VALUE = 5_000_000;
/** Or, for a smaller company, this share of the class outstanding. */
export const FORM144_MIN_PCT = 0.005;

export async function form144Evidence(ticker, { now = Date.now() } = {}) {
  const res = await db.execute(sql`
    select accession, seller, relationship, shares, aggregate_value, shares_outstanding,
           approx_sale_date, filed_at, primary_doc_url, filing_url
      from form144_filings
     where ticker = ${ticker}
       and filed_at >= (now() - make_interval(days => ${DISPLAY_WINDOW_DAYS}))
     order by filed_at desc
     limit 100`);

  const out = [];
  for (const f of rows(res)) {
    const value = num(f.aggregate_value);
    const shares = num(f.shares);
    const outstanding = num(f.shares_outstanding);
    const pct = shares && outstanding ? shares / outstanding : null;
    const big = (value != null && value >= FORM144_MIN_VALUE) || (pct != null && pct >= FORM144_MIN_PCT);
    if (!big) continue;

    const who = f.relationship || 'Affiliate';
    const amount = usdLabel(value);
    const pctText = pct != null && pct >= 0.001 ? ` (${(pct * 100).toFixed(1)}% of shares outstanding)` : '';
    out.push({
      ticker, family: FAMILY.INSIDER, type: 'sec_144_proposed_sale',
      subtype: f.relationship || null,
      direction: DIRECTION.UNKNOWN,
      // Scaled by size within the qualifying population: a 5% notice is not a $5M notice.
      materiality: pct != null && pct >= 0.02 ? 0.75 : value != null && value >= 50_000_000 ? 0.70 : 0.60,
      quality: 0.95,                       // a document filed with the SEC under liability
      // ⚠️ THE PROPOSED SALE DATE IS NOT AN eventTime EITHER, FOR THE SAME REASON.
      //
      // It is the date the affiliate INTENDS to sell on. Nothing happened on it, and it is often
      // in the future, which model.mjs quarantines as `future` — correctly: publicTime >= eventTime
      // is the point-in-time invariant and a proposal has no occurrence to date. It is carried as a
      // stated fact below, where a reader can see it without the engine claiming it as history.
      eventTime: null,
      publicTime: f.filed_at,              // ⚠️ POINT-IN-TIME: when the notice became public
      source: 'sec_144', sourceId: f.accession,
      url: f.primary_doc_url || f.filing_url || null,
      // ⚠️ "filed notice to sell", never "sold".
      summary: `${who} filed notice to sell${amount ? ` ${amount}` : ''}${pctText}`
        + (f.approx_sale_date ? `, proposed on or after ${isoDay(f.approx_sale_date)}` : ''),
      facts: {
        seller: f.seller || null, relationship: f.relationship || null,
        shares, aggregateValue: value, pctOutstanding: pct,
        proposedSaleDate: f.approx_sale_date || null,
        note: 'Form 144 is notice of a proposed sale; it does not establish that a sale occurred.',
      },
      context: null,
    });
  }
  return out;
}

// ── 3. CONGRESS ──────────────────────────────────────────────────────────────
//
// Freshness is the DISCLOSURE. The transaction date is retained as eventTime so the UI can show
// both, but nothing is ever measured from it — a purchase made in June and disclosed in September
// became knowable in September.

export async function congressEvidence(ticker, { now = Date.now(), coverage = {} } = {}) {
  const res = await db.execute(sql`
    select action, amount_mid, amount_min, amount_range, member_slug, representative, party, chamber, state,
           disclosure_date, transaction_date, link
      from congress_trades
     where ticker = ${ticker}
       and disclosure_date >= (current_date - make_interval(days => ${HISTORY_WINDOW_DAYS}))
     order by disclosure_date desc
     limit 1000`);
  const r = rows(res);
  if (!r.length) return [];

  const cutoff = now - DISPLAY_WINDOW_DAYS * DAY;
  const recent = r.filter((x) => (ms(x.disclosure_date) ?? 0) >= cutoff);
  if (!recent.length) return [];

  const buys = recent.filter((x) => String(x.action || '').toUpperCase().startsWith('BUY'));
  const members = [...new Set(recent.map((x) => x.member_slug || x.representative).filter(Boolean))];
  const newest = recent[0];
  const prior = r.filter((x) => (ms(x.disclosure_date) ?? 0) < cutoff);

  let context = firstInContext({
    priorTimes: prior.map((x) => ms(x.disclosure_date)),
    coverageStart: coverage[FAMILY.CONGRESS] ?? null, now,
    noun: 'congressional disclosure for this ticker',
  });
  if (members.length >= 2) {
    const span = Math.max(1, Math.ceil((now - Math.min(...recent.map((x) => ms(x.disclosure_date) ?? now))) / DAY));
    context = { text: `${members.length} members disclosed in the last ${span} days`, unusual: members.length >= 3 };
  }

  const direction = buys.length && buys.length === recent.length ? DIRECTION.POSITIVE
    : buys.length === 0 ? DIRECTION.NEGATIVE : DIRECTION.MIXED;

  return [{
    ticker, family: FAMILY.CONGRESS,
    type: members.length > 1 ? 'congress_multi' : 'congress_disclosure',
    subtype: newest.chamber || null,
    direction,
    materiality: members.length > 1 ? 0.65 : 0.55,
    quality: 0.60,                              // self-reported, banded amounts, long lag
    eventTime: newest.transaction_date || null, // retained, never measured from
    publicTime: newest.disclosure_date,
    source: 'congress', sourceId: `${newest.member_slug || newest.representative}|${newest.disclosure_date}|${ticker}`,
    url: newest.link || null,          // the PTR document itself
    summary: members.length > 1
      ? `${members.length} members of Congress disclosed ${buys.length === recent.length ? 'purchases' : 'trades'}`
      : `${newest.representative || 'A member of Congress'} disclosed a ${String(newest.action || 'trade').toLowerCase()}`,
    facts: {
      members: members.length, transactions: recent.length,
      representative: newest.representative || null, chamber: newest.chamber || null,
      party: newest.party || null, state: newest.state || null,
      amountRange: newest.amount_range || null,
      // ⚠️ THE LOWER BOUND, NOT THE MIDPOINT. Congressional amounts are disclosed as bands, and a
      // "$500K+ purchase" claim must be true of the whole band: the $250,001-$500,000 band has a
      // midpoint of $375,000 and a maximum of $500,000, so only amount_min can support the claim.
      // Reported for purchases only — a disclosed sale of the same size is not the same fact.
      buyAmountMin: buys.length
        ? buys.reduce((mx, x) => Math.max(mx, Number(x.amount_min || 0)), 0) || null
        : null,
      transactionDate: newest.transaction_date || null,
      disclosureDate: newest.disclosure_date || null,
      // The lag is a fact worth showing: it is the difference between when it happened and when
      // anyone could know.
      disclosureLagDays: newest.transaction_date && newest.disclosure_date
        ? Math.max(0, Math.round((ms(newest.disclosure_date) - ms(newest.transaction_date)) / DAY)) : null,
    },
    context,
  }];
}

// ── 4. INSTITUTIONS (13F) ────────────────────────────────────────────────────
//
// SLOW EVIDENCE, AND NEVER CURRENT POSITIONING. Both clocks are mandatory: the quarter the position
// describes, and the day the filing made it knowable. A 13F published yesterday describes holdings
// up to ~135 days old, and a surface that shows only one of those dates is lying by omission.
//
// Breadth is compared against THIS TICKER'S OWN history — "116 funds added" is meaningless until you
// know this ticker's quarters normally move by eight.

export async function institutionEvidence(ticker, { now = Date.now() } = {}) {
  // fund_holdings is ~3M rows, so the shape of this query matters. It rides the existing partial
  // covering index idx_fund_holdings_qoq (quarter, ticker) INCLUDE (cik, shares)
  // WHERE put_call = '' AND ticker IS NOT NULL — hence the literal `put_call = ''` rather than a
  // coalesce, which would not match the index predicate. No join to fund_filings: filed_date is
  // carried on the holdings row itself, and joining 3M rows to get it would undo the index.
  // BREADTH ONLY — no filed_date. That column is not in the covering index
  // idx_fund_holdings_qoq (quarter, ticker) INCLUDE (cik, shares) WHERE put_call = '', so selecting
  // it forces a heap lookup per row and cost 3,459ms cold on a mega-cap. The disclosure date comes
  // from quarterDisclosureDates() instead, which is a property of the quarter anyway.
  //
  // The quarter bound is what lets the index skip: unbounded, MSFT measured 1,981ms; bounded, 491ms.
  const [res, disclosure] = await Promise.all([
    db.execute(sql`
      select quarter, count(distinct cik) as breadth
        from fund_holdings
       where ticker = ${ticker}
         and put_call = ''
         and quarter >= (current_date - make_interval(days => ${BREADTH_LOOKBACK_DAYS}))
       group by quarter
       order by quarter desc
       limit ${BREADTH_QUARTERS}`),
    quarterDisclosureDates({ now }),
  ]);
  const r = rows(res);
  if (r.length < 2) return [];                 // nothing to compare is nothing to report

  // Oldest-first for the streak and change series.
  const series = [...r].reverse().map((x) => ({
    quarter: x.quarter,
    breadth: Number(x.breadth || 0),
    filed: disclosure.get(isoDay(x.quarter))?.disclosedAt ?? null,
  }));
  const latest = series[series.length - 1];
  const prev = series[series.length - 2];
  if (!latest?.filed) return [];

  // A change too extreme to be real is a ticker-resolution artifact, not an event. The rule lives
  // in history.mjs with the other methodology, so it is unit-testable without a database — and it
  // is load-bearing: CTRA and HON are both live examples in our current data.
  if (implausibleBreadth(prev.breadth, latest.breadth)) return [];

  const priorChanges = [];
  for (let i = 1; i < series.length - 1; i++) priorChanges.push(series[i].breadth - series[i - 1].breadth);

  const change = breadthChangeContext({ from: prev.breadth, to: latest.breadth, priorChanges });
  if (!change) return [];
  const streak = streakContext({ series: series.map((s) => s.breadth) });

  return [{
    ticker, family: FAMILY.INSTITUTION, type: 'institution_breadth_change',
    subtype: latest.quarter,
    direction: change.delta > 0 ? DIRECTION.POSITIVE : DIRECTION.NEGATIVE,
    // Deliberately below a fresh 8-K: this is background positioning, months old by construction.
    materiality: change.unusual ? 0.60 : 0.45,
    quality: 0.80,
    // BOTH CLOCKS, and they are months apart. `quarter` is already the quarter-END DATE as stored
    // (a `date` column, not a '2026Q2' string), so it IS the event time; `filed_date` is the day
    // the market could know it.
    eventTime: latest.quarter,
    publicTime: latest.filed,
    referencePeriod: quarterLabel(latest.quarter),
    source: 'sec_13f', sourceId: `13f|${ticker}|${isoDay(latest.quarter)}`,
    url: null,
    summary: change.text,
    facts: {
      quarter: quarterLabel(latest.quarter), quarterEnd: isoDay(latest.quarter),
      breadthFrom: prev.breadth, breadthTo: latest.breadth, delta: change.delta,
      unusual: change.unusual, basis: change.reason,
      disclosedAt: latest.filed,
    },
    // A streak is the more striking observation where one exists; otherwise the unusualness note,
    // which is deliberately NOT the summary repeated back.
    context: streak || (change.note ? { text: change.note, unusual: true } : null),
  }];
}

/** A quarter-end DATE → 'Q2 2026'. The stored column is the date; the label is for display only. */
export function quarterLabel(qDate) {
  const t = ms(qDate);
  if (t == null) return null;
  const d = new Date(t);
  return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
}

/** A date value → 'YYYY-MM-DD', or null. */
export function isoDay(v) {
  const t = ms(v);
  return t == null ? null : new Date(t).toISOString().slice(0, 10);
}

// ── the public interface ─────────────────────────────────────────────────────

/**
 * Everything the engine knows about one ticker, ranked for display.
 *
 * A failing family degrades to nothing rather than failing the request: one broken feed must not
 * blank a ticker page. Which families failed is REPORTED, because a silently shorter list is how a
 * regression hides — the same reason collectEvidence returns its quarantine.
 */
export async function tickerEvidence(ticker, { now = Date.now(), since = null } = {}) {
  const symbol = String(ticker || '').toUpperCase();
  const coverage = await coverageBoundaries({ now });

  const families = [
    ['insider', insiderEvidence],
    ['form144', form144Evidence],
    ['catalyst', catalystEvidence],
    ['congress', congressEvidence],
    ['institution', institutionEvidence],
  ];
  const settled = await Promise.allSettled(
    families.map(([, fn]) => fn(symbol, { now, coverage })),
  );

  const raw = [];
  const failed = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') raw.push(...(s.value || []));
    else failed.push({ family: families[i][0], error: String(s.reason?.message || s.reason) });
  });

  const { evidence, quarantined } = collectEvidence(raw, { now });
  const ranked = rankEvidence(evidence, { now });
  const visible = since
    ? ranked.filter((e) => new Date(e.publicTime).getTime() > new Date(since).getTime())
    : ranked;

  return {
    ticker: symbol,
    evidence: visible,
    counts: { total: ranked.length, returned: visible.length },
    failedFamilies: failed,
    quarantined: quarantined.map((q) => ({ reason: q.reason, detail: q.detail })),
    coverage,
    calculatedAt: new Date(now).toISOString(),
  };
}
