// HIGH SIGNIFICANCE — one public event large enough to be worth a look on its own.
//
// ⚠️ IT IS AN ATTENTION TAG, NOT A DIRECTION. Consensus answers "what does the evidence say"; this
// answers the different question "is any single item here big enough that a trader would want to
// see it before anything corroborates it". A $3M CEO purchase is worth knowing about whether or
// not institutions agree, and it stays worth knowing about when they disagree.
//
// So it deliberately does NOT touch Positive/Negative/Mixed, does not override contrary evidence,
// and is not a score. A row can be HIGH SIGNIFICANCE and read Negative at the same time — that
// combination is informative rather than contradictory.
//
// ⚠️ EVERY REASON IS A CONCRETE FACT WITH A NUMBER IN IT. "CEO purchased $801K on the open market"
// can be checked against the filing; "notable insider activity" cannot. Nothing here infers
// significance from wording, and no threshold is applied to a family whose data cannot carry it.
//
// Pure: no database, no clock, no network. It reads canonical evidence records.

import { EXCEPTIONAL_SIGNIFICANCE, familySignificance } from './evidence-model.mjs';

export const HIGH_SIGNIFICANCE_VERSION = 'consensus_v1_high_significance';

/**
 * ⚠️ THRESHOLDS ARE STATED, NOT FITTED. None was chosen by testing against subsequent returns, and
 * doing so would turn an attention tag into an unvalidated forecast. They are the sizes at which a
 * disclosure stops being routine:
 *
 *   $500K by a CEO/CFO/President — the roles with the clearest view of the business, at a size
 *                                  that is a real personal commitment rather than a gesture
 *   $1M by any one insider       — role-agnostic, because size alone can carry it
 *   $1M across several insiders  — the same money, arrived at together
 *   $500K congressional purchase — the lower bound of the disclosed band, see buyAmountMin
 */
export const ROLE_PURCHASE_USD = 500_000;
export const ANY_PURCHASE_USD = 1_000_000;
export const CLUSTER_PURCHASE_USD = 1_000_000;
export const CONGRESS_PURCHASE_USD = 500_000;

/**
 * ⚠️ "PRESIDENT" MUST NOT MATCH "VICE PRESIDENT", and a VP is not a lead role. Titles measured on
 * live filings include "Chief Executive Officer", "CEO", "President and CEO", "President & CEO",
 * "President", "Chief Financial Officer", "CFO" — and also "VP", "EVP", "SVP" and
 * "Vice President", which the exclusion below removes before the match is attempted.
 */
const NOT_LEAD = /\b(vice\s*president|vp|evp|svp|avp|assistant)\b/i;
const LEAD = /\b(chief\s+executive(\s+officer)?|ceo|chief\s+financial(\s+officer)?|cfo|president)\b/i;

export function isLeadRole(title) {
  const t = String(title || '').trim();
  if (!t) return false;
  if (NOT_LEAD.test(t)) return false;
  return LEAD.test(t);
}

/**
 * A short, honest role word for the reason line.
 *
 * Exported because the chart labels a prominent insider marker with the SAME word this file uses
 * in its reason line — so "CEO" on a marker and "The CEO purchased..." in a card cannot disagree
 * about who filed. It returns "An officer" when the filed title names no lead role, which is the
 * caller's signal that no title can honestly be claimed.
 */
export function roleWord(title) {
  const t = String(title || '');
  if (/chief\s+executive|(^|\W)ceo(\W|$)/i.test(t)) return 'CEO';
  if (/chief\s+financial|(^|\W)cfo(\W|$)/i.test(t)) return 'CFO';
  if (/president/i.test(t)) return 'President';
  return 'An officer';
}

const usd = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return null;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`;
  return `$${Math.round(v / 1000)}K`;
};

/** The families a reason can come from, so a caller can count and filter by source. */
export const SIGNIFICANCE_SOURCE = Object.freeze({
  INSIDER: 'insider', CONGRESS: 'congress', CATALYST: 'catalyst', INSTITUTION: 'institution',
});

/**
 * WHICH SINGLE EVENTS ON THIS TICKER ARE BIG ENOUGH TO STAND ALONE.
 *
 * @param records canonical evidence records (the same objects the cards render from)
 * @returns { high, reasons: [{ source, reason, value }] } — `high` is simply reasons.length > 0
 */
export function highSignificance(records = []) {
  const reasons = [];
  const list = Array.isArray(records) ? records : [];

  for (const ev of list) {
    const f = ev?.facts || {};
    const fam = String(ev?.family || '').toLowerCase();

    // ── INSIDERS ─────────────────────────────────────────────────────────
    // Open-market purchases only: the resolver already restricts these record types to
    // transaction code P, non-derivative, so no option exercise or award can reach here.
    if (fam === 'insider' && /buy/i.test(String(ev.type || ''))) {
      const lead = Number(f.leadRoleValue) || 0;
      const top = Number(f.topBuyerValue) || 0;
      const total = Number(f.totalValue) || 0;
      const buyers = Number(f.buyers) || 0;

      if (lead >= ROLE_PURCHASE_USD) {
        reasons.push({ source: SIGNIFICANCE_SOURCE.INSIDER, value: lead,
          reason: `${roleWord(f.leadRoleTitle)} purchased ${usd(lead)} on the open market` });
      }
      // ⚠️ ONLY IF IT IS NOT THE SAME MONEY ALREADY REPORTED ABOVE. A CEO who bought $1.2M would
      // otherwise produce two reasons for one purchase and look like two events.
      if (top >= ANY_PURCHASE_USD && top > lead) {
        reasons.push({ source: SIGNIFICANCE_SOURCE.INSIDER, value: top,
          reason: `One insider purchased ${usd(top)} on the open market` });
      }
      if (buyers >= 2 && total >= CLUSTER_PURCHASE_USD && total > top) {
        reasons.push({ source: SIGNIFICANCE_SOURCE.INSIDER, value: total,
          reason: `${buyers} insiders purchased ${usd(total)} on the open market` });
      }
      // Rarity STRENGTHENS a reason that already qualified; it never creates one on its own.
      // "First purchase in 312 days" is as true of a $9,000 odd lot as of a $25M cluster.
      if (reasons.length && ev.context?.text && /first|no .* since|in our/i.test(ev.context.text)) {
        const last = reasons[reasons.length - 1];
        if (last.source === SIGNIFICANCE_SOURCE.INSIDER && !last.rarity) last.rarity = ev.context.text;
      }
    }

    // ── CONGRESS ─────────────────────────────────────────────────────────
    // ⚠️ THE BAND'S LOWER BOUND. buyAmountMin is the smallest the disclosure could possibly be, so
    // a ">= $500K" claim is true of the whole band rather than of its midpoint.
    if (fam === 'congress') {
      const min = Number(f.buyAmountMin) || 0;
      if (min >= CONGRESS_PURCHASE_USD) {
        reasons.push({ source: SIGNIFICANCE_SOURCE.CONGRESS, value: min,
          reason: `${usd(min)}+ congressional purchase disclosed${f.amountRange ? ` (${f.amountRange})` : ''}` });
      }
    }

    // ── CATALYSTS ────────────────────────────────────────────────────────
    // ⚠️ THE ENGINE'S OWN CLASSIFICATION, NOT HEADLINE WORDING. A catalyst qualifies only when the
    // existing materiality already calls it exceptional; nothing here reads the title text.
    if (fam === 'catalyst') {
      // ⚠️ SIGNIFICANCE, NOT MATERIALITY — AND THE DIFFERENCE IS THE WHOLE RULE. evidence-model
      // says it outright: "MATERIALITY IS NOT SIGNIFICANCE. Using the engine's materiality directly
      // scored a routine officer change at 0.588 and a material agreement at 0.735 — measured, 84%
      // of catalyst records cleared the meaningful bar." Built against materiality first, this rule
      // tagged 83 of 99 board rows, which is not a signal. familySignificance() applies the
      // engine's own discounts (non-material floors at 0.05, a generic 8.01 is cut to 30%, and a
      // quality discount follows), so the exceptional bar means what it says.
      const sig = familySignificance(ev);
      if (Number.isFinite(sig) && sig >= EXCEPTIONAL_SIGNIFICANCE && ev.summary) {
        reasons.push({ source: SIGNIFICANCE_SOURCE.CATALYST, value: sig,
          reason: `${ev.summary} — filed as a material event` });
      }
    }

    // ── INSTITUTIONS ─────────────────────────────────────────────────────
    // ⚠️ NO DOLLAR THRESHOLD, DELIBERATELY. 13F breadth exists for almost every company and is a
    // quarter stale, so a flat $500K bar would tag the whole market. The only institutional fact
    // that can stand alone is one the canonical history ALREADY calls historically unusual — and
    // that flag currently reads insufficient_history nearly everywhere, so this will rarely fire.
    // That is the honest outcome, not a gap to fill with a new number.
    // ⚠️ facts.unusual IS THE CANONICAL FLAG; context.unusual is not always mirrored onto it.
    // Measured: GPUS carries facts.unusual=true with context.unusual undefined, so reading context
    // alone silently drops real hits.
    if (fam === 'institution' && (ev.facts?.unusual === true || ev.context?.unusual === true) && ev.summary) {
      reasons.push({ source: SIGNIFICANCE_SOURCE.INSTITUTION, value: null,
        reason: `${ev.summary} — historically unusual for this company` });
    }
  }

  // Largest first, so the card's one-line reason is the biggest fact.
  reasons.sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0));
  return { version: HIGH_SIGNIFICANCE_VERSION, high: reasons.length > 0, reasons };
}
