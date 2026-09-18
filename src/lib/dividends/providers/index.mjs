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

import { polygonDividendProvider } from './polygon-dividends.mjs';

export const PROVIDERS = {
  [polygonDividendProvider.id]: polygonDividendProvider,
};

/** Which adapter ingestion should use. Configuration, so a swap needs no deploy of new logic. */
export function activeDividendProvider(env = process.env) {
  const id = String(env.DIVIDEND_PROVIDER || polygonDividendProvider.id).toLowerCase();
  return PROVIDERS[id] || polygonDividendProvider;
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
 *   'prelaunch' unset (today)                  — the real calendar, on real data, carrying a visible
 *                                                notice that its source is temporary and uncleared.
 *
 * THE COMMERCIAL GATE IS UNCHANGED: public display still requires an explicit, deliberate `true`,
 * and it is still the thing to check before launch. What the default no longer does is pretend the
 * feature is unfinished to the people building it.
 *
 * BEFORE PUBLIC LAUNCH this must be set to `true` (rights confirmed) or `false` (kill), never left
 * unset — see HANDOFF.
 */
export function dividendsDisplayMode(env = process.env) {
  const raw = String(env.DIVIDENDS_PUBLIC_ENABLED ?? '').trim();
  // OPENING the commercial gate takes the exact literal `true` — a deliberate value, not a spelling
  // that happens to look affirmative. KILLING it accepts any casing, because a switch meant to stop
  // publication must not be defeated by a capital letter.
  if (raw === 'true') return 'public';
  if (raw.toLowerCase() === 'false') return 'off';
  return 'prelaunch';
}

/** Is the calendar cleared for PUBLIC COMMERCIAL display? Still fails closed, still explicit. */
export const dividendsPublicEnabled = (env = process.env) => dividendsDisplayMode(env) === 'public';

/** Should the calendar render its data at all? True pre-launch and public; false only when killed. */
export const dividendsVisible = (env = process.env) => dividendsDisplayMode(env) !== 'off';
