// "WHAT CHANGED IN MY NAMES?" — one line per watchlist ticker, from what we already hold.
//
// ── ⚠️ THIS INVENTS NOTHING. IT SELECTS. ────────────────────────────────────
//
// Every word this produces is a field that already exists on a canonical record: the 8-K's own item
// classification, the Form 4's own title/action/value, the congressional disclosure's own member and
// amount band, the wire event's own headline. There is no new event type, no derived signal and no
// wording that a source did not state.
//
// ── ⚠️ AND IT DOES NOT SCORE. ───────────────────────────────────────────────
//
// A watchlist row has space for ONE change, so one has to be chosen, and the obvious move is to
// invent an importance number. That would be a new methodology hiding in a prototype — and a bad
// one, because it would be tuned against nothing.
//
// The rule here is a STATED PRECEDENCE: one ordered table of event families, read top to bottom,
// first match wins. Nothing is multiplied, weighted or added; a reader can point at the row of the
// table that decided their line. See PRECEDENCE below — it is the whole of the ordering logic.
//
// ── ⚠️ WHY PRECEDENCE AND NOT PURE RECENCY ──────────────────────────────────
//
// The first version of this chose the most recent qualifying event, full stop. That is predictable
// but it is wrong for the question the line answers, because the families arrive at wildly
// different rates: Form 4s and congressional disclosures land continuously, a material 8-K lands
// rarely. Under pure recency the high-frequency families win almost every row almost every day, and
// the watchlist reads as an insider-trading feed rather than "what changed in my names".
//
// Recency has not been abandoned — it still decides WITHIN a family (newest of two 8-Ks), and it is
// what the per-row windows below measure. What changed is that a routine transaction no longer
// outranks a material company event merely by being six hours newer.

/** The kinds a row can show. Each maps to an existing canonical source and an existing inspector. */
export const CHANGE = Object.freeze({
  FILING: 'filing',
  WIRE: 'wire',
  INSIDER: 'insider',
  CONGRESS: 'congress',
  SCAN: 'scan',
});

/**
 * ⚠️ HIGH IMPORTANCE ON THE WIRE, DUPLICATED ON PURPOSE.
 *
 * The canonical definition is HIGH_IMPORTANCE in lib/enrich-policy.mjs (3 CRITICAL · 2 HIGH ·
 * 1 MEDIUM · 0 LOW, per lib/news-normalize.mjs). That module reaches the trusted-source and
 * Facebook lexicons, and this one is imported by the Terminal client, so importing it would drag
 * all of that into the browser bundle to read one integer. The value is restated here and the
 * verify suite imports BOTH and asserts they are equal, so the two cannot drift apart unnoticed.
 */
export const WIRE_HIGH_IMPORTANCE = 2;

/**
 * ⚠️ AND THE FLOOR BELOW WHICH A WIRE EVENT IS NOT A CHANGE AT ALL.
 *
 * The canonical definition is IMMEDIATE_MIN_IMPORTANCE in lib/enrich-policy.mjs — the line the
 * pipeline ALREADY draws between an item worth handling in real time and one it defers. Restated
 * here for the same bundle reason, and pinned by the same assertion.
 *
 * This is not a quality filter invented for the watchlist. It matters because LOW is where ticker
 * RESOLUTION noise collects: measured on production, both LOW items attributed to ICLR were an
 * "Icon" in the headline, and neither was about the company. Applying the pipeline's own floor
 * keeps those off a row without this file forming an opinion about any individual headline.
 */
export const WIRE_MIN_IMPORTANCE = 1;

/**
 * ⚠️ THE CONVICTION BANDS THAT MAKE A FORM 4 MORE THAN ROUTINE.
 *
 * Not a threshold invented here: conviction is an existing Catalyst Pit model on insider_trades
 * (conviction 0–100, band LOW | MODERATE | HIGH | VERY HIGH | EXTREME), and it is null for anything
 * that is not an eligible open-market purchase. So this promotes exactly what that model already
 * calls high-conviction buying, and never promotes a sale — which is the honest reading, because
 * the model does not claim to grade sales at all.
 */
export const NOTABLE_BANDS = Object.freeze(['HIGH', 'VERY HIGH', 'EXTREME']);
const NOTABLE_BAND_SET = new Set(NOTABLE_BANDS);

/** True when the SOURCE's own flag says this record is not a routine one of its kind. */
const NOTABLE = (c) => c.notable === true;
/** Any record of the family, routine or not. */
const ANY = () => true;

/**
 * ── ⚠️ THE ORDERING. ALL OF IT. ────────────────────────────────────────────
 *
 * Read top to bottom; the first row whose family matches, whose test passes AND whose window still
 * covers the event decides the line. Ties within a row break by recency.
 *
 * Two properties worth naming, because they are what make this a precedence and not a score:
 *
 *   1. `notable` IS ALWAYS THE SOURCE'S OWN FLAG. Material is the 8-K item classification's;
 *      high importance is the wire's; the conviction band is the Form 4 model's. Nothing in this
 *      file decides that an event is important — it only reads what the source already said.
 *   2. A PROMOTION DECAYS. Where a family appears twice, the promoted row carries the SHORTER
 *      window, so a high-conviction buy outranks an 8-K only while it is fresh and then falls back
 *      to the ordinary insider row. That is how recency survives inside a precedence.
 *
 * ⚠️ SCAN IS IN THE TABLE AND IS DELIBERATELY NOT POPULATED. Board membership is a standing state:
 * we hold "this ticker is on the board now", not "this ticker joined the board at T". Dating it
 * from the board's build time would invent an event time for the ticker, and it would be true again
 * every time the board rebuilt — volume, not information. The row stays so that the day membership
 * carries a real joined-at, the place it belongs is already decided.
 */
export const PRECEDENCE = Object.freeze([
  // A material company event. The 8-K's own classification, which is also where earnings live
  // (item 2.02 → "Earnings"), so earnings needs no family of its own.
  { id: 'material-filing', kind: CHANGE.FILING, when: NOTABLE, days: 7 },
  // A HIGH or CRITICAL wire story that NAMES the ticker. Attribution is the event's own tickers
  // array; generic market news is not attributed to anything and never reaches here.
  { id: 'major-news', kind: CHANGE.WIRE, when: NOTABLE, days: 3 },
  // High-conviction open-market buying, while it is fresh.
  { id: 'notable-insider', kind: CHANGE.INSIDER, when: NOTABLE, days: 7 },
  { id: 'scan', kind: CHANGE.SCAN, when: ANY, days: 2 },
  // An ordinary ticker-attributed story.
  { id: 'news', kind: CHANGE.WIRE, when: ANY, days: 2 },
  // ⚠️ THE TRANSACTION FAMILIES SIT BELOW THE COMPANY-EVENT FAMILIES, AND THAT IS THE FIX. They are
  // not hidden and not downgraded in what they say — they win the row whenever nothing above them
  // has anything to report, which on a quiet name is most days.
  { id: 'insider', kind: CHANGE.INSIDER, when: ANY, days: 14 },
  // ⚠️ LONGER, BECAUSE THE LAW ALLOWS IT. A congressional trade may be disclosed up to 45 days
  // after it happens, so a 7-day window would hide most of them the week they became public. The
  // window is on the DISCLOSURE date — when it became knowable — not the trade date.
  { id: 'congress', kind: CHANGE.CONGRESS, when: ANY, days: 30 },
  // ⚠️ LAST, AND SHORT-LIVED. "Exhibits" and "Other event" are filings a company must make, not
  // developments; one of them is worth a line only when it is today's news and nothing else is.
  { id: 'routine-filing', kind: CHANGE.FILING, when: ANY, days: 3 },
]);

/**
 * The widest window any row of the table gives a family — the bound a query needs so that every
 * candidate the precedence could still accept is fetched, and no more.
 */
export const WINDOW_DAYS = Object.freeze(Object.fromEntries(
  Object.values(CHANGE).map((k) => [k, Math.max(...PRECEDENCE.filter((p) => p.kind === k).map((p) => p.days), 0)]),
));

/**
 * ── ⚠️ THE FALLBACK'S OWN BOUND, AND WHY IT IS NOT A PRECEDENCE ROW ────────
 *
 * When nothing above qualifies, a row that has traded insiders or congressional disclosures in its
 * history has more to say than a blank line — so the fallback names the most recent one and shows
 * its real age. It is deliberately NOT a row in PRECEDENCE: a row in that table can beat something
 * else, and this must never beat anything. It runs only where the table produced nothing at all.
 *
 * The bound is one year because the query has to be bounded and because a transaction older than a
 * year is not a "change" under any reading — not because a year means something. It is a display
 * bound on data we already hold, and the age shown is always the true one.
 */
export const HISTORY_DAYS = 365;

const ms = (v) => {
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

const money = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
};

/**
 * A material 8-K, as a change.
 *
 * ⚠️ THE LABEL IS THE CLASSIFIER'S, NOT OURS. The caller passes the same primaryLabel the 8-K wire
 * and the news drawer print, so the three cannot describe one filing three ways.
 */
export function fromFiling(row) {
  const at = ms(row?.filedAt);
  if (at === null) return null;
  return {
    kind: CHANGE.FILING,
    at,
    label: row.primaryLabel || (Array.isArray(row.items) ? row.items[0] : null) || 'New SEC filing',
    // Material is the filing's own flag; a routine 8-K says so rather than being hidden or promoted.
    notable: row.material === true,
    detail: row.material === false ? 'routine' : null,
    url: row.url || null,
  };
}

/**
 * A ticker-attributed Pit Wire event, as a change.
 *
 * ⚠️ ATTRIBUTION IS THE EVENT'S OWN, NOT A SEARCH. A canonical event carries the tickers it was
 * resolved to; a story that names no ticker is never pinned to one here. That is the difference
 * between company news and "the market fell today" printed under a company's name.
 */
export function fromWire(row) {
  const at = ms(row?.publishedAt);
  if (at === null) return null;
  const headline = String(row.headline || '').trim();
  if (!headline) return null;
  // Below the pipeline's own real-time floor this is not a change, the way a Form 4 whose verb we
  // cannot read plainly is not a change.
  if ((Number(row.importance) || 0) < WIRE_MIN_IMPORTANCE) return null;
  return {
    kind: CHANGE.WIRE,
    at,
    label: headline,
    // The wire's own importance, not a re-judgement of the headline.
    notable: (Number(row.importance) || 0) >= WIRE_HIGH_IMPORTANCE,
    detail: String(row.source || '').trim() || null,
    url: row.url || null,
  };
}

/**
 * A Form 4, as a change.
 *
 * ⚠️ THE ROLE AND THE DIRECTION ARE STATED ON THE FILING. "Director bought" is two fields printed
 * next to each other, not an interpretation — and the value is the filing's own total.
 */
export function fromInsider(row) {
  const at = ms(row?.filingDate);
  if (at === null) return null;
  const who = (row.title || '').trim() || 'Insider';
  const act = String(row.action || '').toLowerCase();
  // Only the two directions a Form 4 states plainly. Anything else is named, never guessed at.
  const verb = act.includes('buy') || act === 'purchase' ? 'bought'
    : act.includes('sell') || act === 'sale' ? 'sold'
      : null;
  if (!verb) return null;
  const amount = money(row.totalValue);
  return {
    kind: CHANGE.INSIDER,
    at,
    label: `${who} ${verb}${amount ? ` ${amount}` : ''}`,
    notable: NOTABLE_BAND_SET.has(String(row.convictionBand || '').trim().toUpperCase()),
    detail: null,
    url: row.filingUrl || null,
  };
}

/**
 * A congressional disclosure, as a change.
 *
 * ⚠️ DATED FROM DISCLOSURE, NOT FROM THE TRADE. The trade may be weeks old; what changed for a
 * reader is that it became public. The trade date is not hidden — it is simply not what the
 * recency window is measured on.
 *
 * ⚠️ NEVER "NOTABLE". There is no existing Catalyst Pit flag that grades a disclosure, and the
 * amount band is far too coarse to become one here without inventing a threshold. So this family
 * has exactly one row in the table.
 */
export function fromCongress(row) {
  const at = ms(row?.disclosureDate);
  if (at === null) return null;
  const who = (row.representative || '').trim() || 'A member of Congress';
  const t = String(row.type || row.action || '').toLowerCase();
  const verb = t.includes('purchase') || t.includes('buy') ? 'bought'
    : t.includes('sale') || t.includes('sell') ? 'sold'
      : null;
  if (!verb) return null;
  return {
    kind: CHANGE.CONGRESS,
    at,
    label: `${who} ${verb}`,
    notable: false,
    // The band is what the law requires them to publish; a point estimate would be invented.
    detail: row.amountRange || null,
    url: row.link || null,
  };
}

/**
 * Membership of a Pit Scan board, as a change.
 *
 * ⚠️ NOT WIRED, AND THE COMMENT ON PRECEDENCE SAYS WHY: the board tells us a ticker is on it now,
 * not when it joined, so `builtAt` is the board's moment and not the ticker's. Kept because the
 * shape is right for the day a joined-at exists.
 */
export function fromScan(boardName, builtAt) {
  const at = ms(builtAt);
  if (at === null || !boardName) return null;
  return { kind: CHANGE.SCAN, at, label: `On ${boardName}`, notable: false, detail: null, url: null };
}

/**
 * The row of PRECEDENCE that decides a candidate, or -1 when none does.
 *
 * ⚠️ THE WINDOW IS PART OF THE MATCH, NOT A FILTER APPLIED AFTER IT. That is what lets a promotion
 * decay: a high-conviction buy eight days old fails the `notable-insider` row on its window and
 * falls through to the ordinary `insider` row, which still covers it.
 */
export function rankOf(change, now = Date.now()) {
  if (!change || !Number.isFinite(change.at)) return -1;
  // ⚠️ A FUTURE TIMESTAMP IS BAD DATA, NOT BREAKING NEWS. Nothing may be dated ahead of now.
  if (change.at > now) return -1;
  const age = now - change.at;
  return PRECEDENCE.findIndex((p) => p.kind === change.kind && p.when(change) && age <= p.days * 86400000);
}

/**
 * The one change a row shows, or null.
 *
 * @param candidates the outputs of the from* readers, in any order; nulls are ignored.
 * @param now        injected so the window rule is assertable without waiting for a clock.
 * @returns the chosen change with `why` set to the id of the PRECEDENCE row that chose it, so the
 *          reason a line beat the others is readable off the payload rather than reconstructed.
 */
export function pickChange(candidates, { now = Date.now() } = {}) {
  const live = [];
  for (const c of candidates || []) {
    const rank = rankOf(c, now);
    if (rank >= 0) live.push({ c, rank });
  }
  if (!live.length) return null;
  // Family precedence first; recency only within a row of the table.
  live.sort((a, b) => (a.rank - b.rank) || (b.c.at - a.c.at));
  const { c, rank } = live[0];
  return { ...c, why: PRECEDENCE[rank].id };
}

/** The two families that can stand in for a blank row, most-recent-first on a tie of timestamps. */
const FALLBACK_KINDS = [CHANGE.INSIDER, CHANGE.CONGRESS];

/**
 * The most recently PUBLIC insider or congressional buy/sell, or null.
 *
 * ⚠️ RECENCY ONLY, AND NOTHING ELSE. There is no precedence here and there must not be: this line
 * exists because the row would otherwise be empty, so the only question worth asking is which of
 * the two became public most recently. No family outranks the other, nothing is promoted, and the
 * conviction band is deliberately not consulted — a promoted line implies currency this cannot have.
 *
 * ⚠️ AND IT FAILS CLOSED. A candidate with no readable public timestamp is dropped rather than
 * shown with a guessed age, exactly as an undated record is dropped from the main path. The
 * buy/sell rule is already enforced upstream: fromInsider and fromCongress return null for anything
 * that is not a plainly stated purchase or sale, so an OTHER-coded Form 4 can never reach here.
 */
export function pickFallback(candidates, { now = Date.now() } = {}) {
  const live = (candidates || []).filter((c) => {
    if (!c || !Number.isFinite(c.at)) return false;
    if (!FALLBACK_KINDS.includes(c.kind)) return false;
    if (c.at > now) return false;
    return now - c.at <= HISTORY_DAYS * 86400000;
  });
  if (!live.length) return null;
  live.sort((a, b) => (b.at - a.at) || (FALLBACK_KINDS.indexOf(a.kind) - FALLBACK_KINDS.indexOf(b.kind)));
  const c = live[0];
  // `historical` is what the row reads to render itself quietly. It is a provenance flag, not a
  // grade: it says "this became public a while ago", which is a fact about the timestamp.
  return { ...c, historical: true, why: `historical-${c.kind}` };
}

/**
 * The one line a watchlist row shows, or null.
 *
 * ⚠️ THE ORDER OF THESE TWO CALLS IS THE WHOLE GUARANTEE. The fallback is only ever reached when
 * the precedence produced nothing, so no historical transaction can displace a qualifying recent
 * company event. Expressed as one function rather than left to each caller, because a caller that
 * got the order wrong would silently weaken the precedence the table exists to state.
 */
export function pickLine({ recent, historical }, { now = Date.now() } = {}) {
  return pickChange(recent, { now }) || pickFallback(historical, { now });
}

/** "4h", "2d" — the same shorthand the rest of the Terminal uses. */
export function ago(at, now = Date.now()) {
  if (!Number.isFinite(at)) return '';
  const m = Math.max(0, Math.round((now - at) / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
