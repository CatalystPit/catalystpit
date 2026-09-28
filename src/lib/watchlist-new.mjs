// DOES THIS EVENT PUT A "NEW" ON A WATCHED TICKER? — the one place that answers it.
//
// ⚠️ WHY THIS EXISTS AS ITS OWN FILE.
//
// The badge used to mean "the Evidence Engine returned something", and the engine returns
// everything it knows about a ticker, correctly — a ticker page SHOULD show a routine Item 8.01
// filing, a small 13F drift, an ordinary Form 4. A watchlist badge is a different claim: it
// interrupts someone to say a company they own did something that matters. Measured on production,
// the difference was stark — MSTR badged for a Reg FD/"Other event" 8-K while NVIDIA's $150bn
// buyback badged nothing, which is precisely the inversion that destroys trust in the feature.
//
// So eligibility is a decision the WATCHLIST makes, on top of the engine, in one function that
// every family passes through. No family has its own rule, no ticker has its own behaviour, and
// nothing here knows the name of a single company.
//
// ── THE CONTRACT ────────────────────────────────────────────────────────────
//
// ONE REAL MATERIAL COMPANY EVENT + CORRECT TICKER ASSOCIATION + UNREAD BY THIS USER = ONE NEW.
//
// Which decomposes into exactly these tests, in this order:
//
//   1. It is a canonical evidence object at all — the engine built it, so ticker association,
//      integrity and clocks were already settled there. This file never re-attributes a ticker.
//   2. Its family is one the watchlist speaks for.
//   3. Its materiality clears the floor below.
//   4. It is inside the freshness window for its family.
//   5. It is newer than this user's watermark — applied by the caller, which owns the watermark.
//   6. It is not another copy of an event already counted — see `countNew`.
//
// ── THE FLOOR, AND WHY IT SITS WHERE IT DOES ────────────────────────────────
//
// Every event type in the engine carries a `materiality` between 0 and 1, assigned where the type
// is defined and shared by every surface. The floor is set at 0.60 because that is the line the
// SEC's own item taxonomy already draws:
//
//   0.45  8-K Item 8.01 "Other material event"     — the MSTR badge. Reg FD and 8.01 are where an
//                                                    issuer puts anything it chose to disclose.
//   0.55  a routine insider transaction, a ticker symbol change
//   0.60  officer/director change, exit costs, a new financial obligation, an unusual 13F change
//   0.70  results of operations, a buyback authorisation, a material contract
//   0.85+ delisting, bankruptcy, non-reliance, guidance withdrawn, CEO departure
//
// Below 0.60 the event is something a diligent reader might want on a ticker page and nobody wants
// as an interruption. At 0.60 and above it names a decision the company took. The floor is a
// constant here rather than a per-family rule so that one number, in one place, moves it.
//
// ⚠️ IT IS A FLOOR, NOT A FILTER ON THE ENGINE. Nothing here changes what a ticker page shows.

export const NEW_MATERIALITY_FLOOR = 0.60;

/** Families the watchlist badge speaks for. A family absent here is silent, not filtered per-event. */
export const NEW_FAMILIES = Object.freeze(['catalyst', 'insider', 'congress', 'institution']);

// How long an event can still be the reason for a badge. This is deliberately SHORTER than the
// engine's own display windows: a 13F stays the most current institutional positioning for a
// quarter and belongs on a ticker page all that time, but "NEW" means new, and a 90-day-old filing
// interrupting someone is not new by any reading. The watermark normally cuts long before this —
// this is the backstop for an account that has not looked in months.
const DAY = 86_400_000;
export const NEW_MAX_AGE_MS = Object.freeze({
  catalyst: 30 * DAY,
  insider: 30 * DAY,
  congress: 45 * DAY,      // the STOCK Act disclosure window; a month-old disclosure is still news
  institution: 45 * DAY,   // the 13F filing lag
});

/**
 * Is this ONE canonical evidence object a reason to badge a watched ticker?
 *
 * PURE. Takes the engine's own object; makes no query, reads no user, knows no ticker by name.
 *
 * @param ev      a canonical evidence object from the Evidence Engine
 * @param now     evaluation clock
 * @returns {boolean}
 */
export function eligibleForNew(ev, { now = Date.now() } = {}) {
  if (!ev || typeof ev !== 'object') return false;
  if (!NEW_FAMILIES.includes(ev.family)) return false;

  // ⚠️ A MISSING MATERIALITY IS NOT A PASS. An event type that never declared one has not been
  // judged, and an unjudged event must not interrupt anybody.
  const m = Number(ev.materiality);
  if (!Number.isFinite(m) || m < NEW_MATERIALITY_FLOOR) return false;

  const t = Date.parse(ev.publicTime);
  if (!Number.isFinite(t)) return false;
  // A publication time in the future is a clock problem or a bad record, never news.
  if (t > now + 3600_000) return false;
  const maxAge = NEW_MAX_AGE_MS[ev.family] ?? 30 * DAY;
  return now - t <= maxAge;
}

/**
 * The identity of the REAL-WORLD EVENT behind a piece of evidence, for counting.
 *
 * ⚠️ THIS IS WHAT MAKES ONE ANNOUNCEMENT ONE BADGE. Bloomberg, Reuters, GlobeNewswire, the WSJ and
 * two aggregators all carried NVIDIA's buyback; they are six records of one decision. Counting
 * records would have shown "6 NEW" for a single event, which is the same lie as showing none.
 *
 * Identity is (ticker, type, day). Not the URL, not the source, not our row id — those differ per
 * outlet by definition. The day is included so that a company doing the SAME KIND of thing twice in
 * one month — two contract awards, two offerings — still counts twice, while the same announcement
 * repeated across a morning counts once.
 */
// ⚠️ ONE EVENT REACHES US IN TWO SHAPES, AND THEY HAVE DIFFERENT TYPE NAMES.
//
// A company reports its quarter: the 8-K Item 2.02 becomes `sec_8k_results` and the press release
// becomes `earn_results`. Two records, two types, ONE earnings. Measured on the audit sample, COST
// showed "2 NEW" for a single set of results and VKTX showed a priced offering and its convertible
// note as two financings. A CEO transition arrives as a departure and an appointment, usually hours
// apart, and is one decision.
//
// So counting collapses to an EVENT CLASS, not a type. Only same-day pairs collapse — the day is
// still part of the key — so an agreement in March and its completion in June stay two events,
// which they are. A type absent from this map is its own class, which is the conservative default.
const EVENT_CLASS = Object.freeze({
  sec_8k_results: 'results', earn_results: 'results', earn_preliminary: 'results',
  sec_8k_officer_change: 'officer', mgmt_ceo_departure: 'officer', mgmt_ceo_appointed: 'officer',
  mgmt_cfo_departure: 'officer', mgmt_cfo_appointed: 'officer',
  sec_8k_acquisition: 'acquisition', ma_completed: 'acquisition', ma_agreement: 'acquisition',
  ma_to_be_acquired: 'acquisition', ma_tender_offer: 'acquisition',
  cap_offering_priced: 'offering', cap_offering_closed: 'offering', cap_registered_direct: 'offering',
  cap_pipe: 'offering', cap_convertible: 'offering', cap_atm: 'offering',
  sec_8k_unregistered_sale: 'offering', cap_debt_financing: 'offering',
  sec_8k_bankruptcy: 'bankruptcy', sec_8k_delisting: 'listing', list_delisting_notice: 'listing',
  sec_8k_material_agreement: 'agreement', ma_contract_award: 'agreement', ma_licensing: 'agreement',
});

export function newEventKey(ev) {
  const day = String(ev?.publicTime || '').slice(0, 10);
  const type = String(ev?.type ?? '');
  const cls = EVENT_CLASS[type] || type;
  // The FAMILY is deliberately absent: the whole point is that an 8-K and the press release about
  // the same decision must land on one key, and those arrive in the same family today but need not.
  return [ev?.ticker ?? '', cls, day].map((s) => String(s).toUpperCase()).join('|');
}

/**
 * The badge count for one ticker: qualifying events, collapsed to one per real-world event.
 *
 * @param evidence  canonical evidence objects, already cut to "since the user last looked"
 * @returns {{ count:number, events:Array }} the count and the surviving representative of each event
 */
export function countNew(evidence, { now = Date.now() } = {}) {
  const seen = new Map();
  for (const ev of Array.isArray(evidence) ? evidence : []) {
    if (!eligibleForNew(ev, { now })) continue;
    const key = newEventKey(ev);
    const prior = seen.get(key);
    // ⚠️ THE SURVIVOR IS THE MOST MATERIAL ONE, NOT THE FIRST. When a class collapses two shapes of
    // one event — a CEO departure and the appointment that came with it — the line the user reads
    // should be the departure. Ties break on the EARLIEST copy: the first outlet to carry it is
    // when the market learned, and a badge that restamps itself to the latest rewrite would keep
    // looking newer than it is.
    if (!prior
      || Number(ev.materiality) > Number(prior.materiality)
      || (Number(ev.materiality) === Number(prior.materiality)
          && Date.parse(ev.publicTime) < Date.parse(prior.publicTime))) seen.set(key, ev);
  }
  const events = [...seen.values()].sort((a, b) => Date.parse(b.publicTime) - Date.parse(a.publicTime));
  return { count: events.length, events };
}
