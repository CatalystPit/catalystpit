// "WHAT CHANGED IN MY NAMES?" — one line per watchlist ticker, from what we already hold.
//
// ── ⚠️ THIS INVENTS NOTHING. IT SELECTS. ────────────────────────────────────
//
// Every word this produces is a field that already exists on a canonical record: the 8-K's own item
// classification, the Form 4's own title/action/value, the congressional disclosure's own member and
// amount band, the scan board's own membership. There is no new event type, no derived signal and
// no wording that a source did not state.
//
// ── ⚠️ AND IT DOES NOT SCORE. ───────────────────────────────────────────────
//
// A watchlist row has space for ONE change, so one has to be chosen, and the obvious move is to
// invent an importance number. That would be a new methodology hiding in a prototype — and a bad
// one, because it would be tuned against nothing. The rule here is RECENCY: the most recent
// qualifying event wins, and ties break by a fixed source order that is stated rather than scored.
// A reader can predict it, which is the property that matters for something sitting beside a price.

/** The kinds a row can show. Each maps to an existing canonical source and an existing inspector. */
export const CHANGE = Object.freeze({
  FILING: 'filing',
  INSIDER: 'insider',
  CONGRESS: 'congress',
  SCAN: 'scan',
});

/**
 * Tie-break order when two events share a timestamp, lowest first.
 *
 * ⚠️ NOT AN IMPORTANCE RANKING. It decides nothing except which of two events stamped at the same
 * moment is printed; it never promotes an older event over a newer one. Filings outrank the scan
 * board here only because a board membership has no moment of its own — it is a standing state,
 * dated from the board's build.
 */
const TIE_ORDER = [CHANGE.SCAN, CHANGE.CONGRESS, CHANGE.INSIDER, CHANGE.FILING];

/** How recent something has to be to count as a change worth a line. */
export const WINDOW_DAYS = Object.freeze({
  [CHANGE.FILING]: 7,
  [CHANGE.INSIDER]: 14,
  // ⚠️ LONGER, BECAUSE THE LAW ALLOWS IT. A congressional trade may be disclosed up to 45 days
  // after it happens, so a 7-day window would hide most of them the week they became public. The
  // window is on the DISCLOSURE date — when it became knowable — not the trade date.
  [CHANGE.CONGRESS]: 30,
  [CHANGE.SCAN]: 2,
});

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
    detail: row.material === false ? 'routine' : null,
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
    // The band is what the law requires them to publish; a point estimate would be invented.
    detail: row.amountRange || null,
    url: row.link || null,
  };
}

/**
 * Membership of a Pit Scan board, as a change.
 *
 * ⚠️ A STANDING STATE, DATED FROM THE BOARD'S BUILD. Unlike the other three this has no moment of
 * its own — the ticker is on the board now. It is dated from when the board was built so it can be
 * ordered with the rest, and it is the first thing dropped on a tie for exactly that reason.
 */
export function fromScan(boardName, builtAt) {
  const at = ms(builtAt);
  if (at === null || !boardName) return null;
  return { kind: CHANGE.SCAN, at, label: `On ${boardName}`, detail: null, url: null };
}

/**
 * The one change a row shows, or null.
 *
 * @param candidates the outputs of the from* readers, in any order; nulls are ignored.
 * @param now        injected so the window rule is assertable without waiting for a clock.
 */
export function pickChange(candidates, { now = Date.now() } = {}) {
  const live = (candidates || []).filter((c) => {
    if (!c || !Number.isFinite(c.at)) return false;
    const days = WINDOW_DAYS[c.kind];
    if (!days) return false;
    // ⚠️ A FUTURE TIMESTAMP IS BAD DATA, NOT BREAKING NEWS. Nothing may be dated ahead of now.
    return c.at <= now && now - c.at <= days * 86400000;
  });
  if (!live.length) return null;
  live.sort((a, b) => (b.at - a.at) || (TIE_ORDER.indexOf(b.kind) - TIE_ORDER.indexOf(a.kind)));
  return live[0];
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
