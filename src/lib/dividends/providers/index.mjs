// THE DIVIDEND PROVIDER REGISTRY — the one line that changes when the provider does.
//
// A provider is an object with:
//   id            the string written into dividend_events.source
//   label         what it is called in an operational log
//   temporary     true while its production redistribution rights are unconfirmed
//   fetchWindow({ from, to, apiKey, fetchImpl, asOf }) -> { events, pages, error }
//                 events are CANONICAL events, already normalised by the adapter
//
// Adding the licensed feed later is: write the adapter, add it here, point DIVIDEND_PROVIDER at it.
// No table, no API, no page and no test of the calendar itself changes.

import { tiingoDividendProvider } from './tiingo-dividends.mjs';

/**
 * The adapters ingestion may use.
 *
 * ⚠️ THE POLYGON ADAPTER IS DELETED, AND THE REGISTRY IS WHY IT HAD TO BE. The display side already
 * defaulted to the licensed feed, so the published calendar was safe — but `PROVIDERS[id]` is keyed off
 * DIVIDEND_PROVIDER, so setting DIVIDEND_PROVIDER=polygon selected an unapproved provider for INGESTION
 * with no code change and no review. That is the same shape as the Twelve Data hole in market-data.js: a
 * provider list plus an environment variable is a configuration-sized licensing decision.
 *
 * With one entry there is nothing to select, and an unrecognised DIVIDEND_PROVIDER resolves to the
 * licensed adapter in both functions below — so a typo cannot produce an unlicensed write either.
 */
export const PROVIDERS = {
  [tiingoDividendProvider.id]: tiingoDividendProvider,
};

/**
 * Which adapter ingestion should use. Configuration, so a swap needs no deploy of new logic.
 *
 * ⚠️ THE FALLBACK IS THE LICENSED FEED, AND IT USED TO BE POLYGON. That default predates the Tiingo
 * licence and, once the calendar began reading a single source, it became a silent-freeze hazard rather
 * than a harmless legacy: with DIVIDEND_PROVIDER unset, ingestion wrote polygon rows while the calendar
 * displayed tiingo ones, so the board would quietly stop advancing while every job run reported
 * success. Nothing would have failed — the calendar would simply have gone stale, which is the failure
 * mode this codebase keeps having to hunt down.
 *
 * Both sides now fall back to the same licensed provider, so ingestion and display cannot disagree
 * about which feed is current. Naming a provider explicitly still works and still needs no deploy.
 */
export function activeDividendProvider(env = process.env) {
  const id = String(env.DIVIDEND_PROVIDER || '').toLowerCase();
  return PROVIDERS[id] || tiingoDividendProvider;
}

/**
 * WHO MAY SEE THE CALENDAR, in three states rather than two.
 *
 * Catalyst Pit is not publicly launched. A single on/off switch forced a choice between two wrong
 * answers: hide a finished feature from its own builders, or quietly publish data whose
 * redistribution rights nobody has confirmed. The distinction that actually matters is not
 * on-versus-off, it is WHO IS LOOKING.
 *
 *   'public'    DIVIDENDS_PUBLIC_ENABLED=true  — rights confirmed, cleared for commercial display.
 *   'off'       DIVIDENDS_PUBLIC_ENABLED=false — the kill switch. Nothing renders, nothing is served.
 *   'prelaunch' DIVIDENDS_PUBLIC_ENABLED=prelaunch — the real calendar on real data, carrying a
 *                                                visible notice that its source is temporary. Now an
 *                                                EXPLICIT opt-in, never the default.
 *
 * ── V1 LAUNCH DECISION (2026-09-20): THE DEFAULT FAILS CLOSED ───────────────
 *
 * Dividend data comes from Polygon, a TEMPORARY development source whose redistribution rights are
 * not confirmed. The owner's decision for V1 is that the calendar ships built but NOT publicly
 * exposed, and is revisited when the commercial provider is integrated.
 *
 * So an unset variable now resolves to 'off', not 'prelaunch'. Previously, forgetting to set it
 * published real uncleared data to anyone who found the URL — the one outcome that must not depend
 * on remembering a deployment step. A missing configuration value is exactly the condition under
 * which a rights question should resolve to "do not publish".
 *
 * Opening the gate is unchanged and still requires the exact literal `true`.
 */
export function dividendsDisplayMode(env = process.env) {
  const raw = String(env.DIVIDENDS_PUBLIC_ENABLED ?? '').trim();
  // OPENING the commercial gate takes the exact literal `true` — a deliberate value, not a spelling
  // that happens to look affirmative. KILLING it accepts any casing, because a switch meant to stop
  // publication must not be defeated by a capital letter.
  if (raw === 'true') return 'public';
  if (raw.toLowerCase() === 'prelaunch') return 'prelaunch';
  // 'false', anything unrecognised, and — deliberately — UNSET.
  return 'off';
}

/** Is the calendar cleared for PUBLIC COMMERCIAL display? Still fails closed, still explicit. */
export const dividendsPublicEnabled = (env = process.env) => dividendsDisplayMode(env) === 'public';

/** Should the calendar render its data at all? True pre-launch and public; false only when killed. */
export const dividendsVisible = (env = process.env) => dividendsDisplayMode(env) !== 'off';

/**
 * WHICH SOURCE THE CALENDAR DISPLAYS — exactly one, always.
 *
 * ⚠️ WHY THE CALENDAR NEEDS THIS AND INGESTION DOES NOT. dividend_events is keyed on
 * (source, source_event_id), so every provider that has ever run holds its own row for the same
 * corporate action. That is correct storage and it was a live display bug: the board rendered the same
 * dividend twice whenever two providers described it in any visibly different way — a float written as
 * 0.36719999999999997 rather than 0.3672, a payment_date one provider leaves null, or a supplemental
 * one provider splits out and the other totals. See calendarConditions for the measurements.
 *
 * DISPLAY FOLLOWS INGESTION, deliberately: the provider being kept up to date is the only one whose
 * rows should be shown, so there is one configuration value rather than two that can disagree.
 *
 * ⚠️ BOTH SIDES NOW RESOLVE TO THE LICENSED SOURCE, which they did not always. activeDividendProvider
 * used to fall back to polygon for ingestion-compatibility reasons that predated the licence, while this
 * value fell back to the licensed feed — so an unset DIVIDEND_PROVIDER made ingestion write polygon rows
 * the calendar would never display, and the board would quietly stop advancing while every job run
 * reported success. There is now one adapter, so the two cannot disagree and a missing environment
 * variable cannot cause an unlicensed write or a silent freeze.
 */
export const LICENSED_DIVIDEND_SOURCE = tiingoDividendProvider.id;

export function calendarSource(env = process.env) {
  const id = String(env.DIVIDEND_PROVIDER || '').toLowerCase();
  return PROVIDERS[id] ? id : LICENSED_DIVIDEND_SOURCE;
}
