// THE SECURITY MASTER: one canonical display name per ticker, for the whole product.
//
// WHY THIS EXISTS. Company identity used to be derived inside the screener rebuild, from SEC filings
// only — the Form 4 issuer name, then the 8-K registrant name, then null. That hierarchy is right
// about quality and wrong about COVERAGE, because it only knows securities that file those forms.
// Closed-end funds, ETFs, ADRs, preferred lines and unit trusts file neither, so they resolved to
// null — and the Dividend Calendar, which is largely a board of funds, printed "—" in the Company
// column for 3,343 tickers while the correct names sat in SEC's own ticker file.
//
// The fix is not a bigger query inside the screener. It is admitting that "what is this ticker
// called" is a question several parts of the product ask, and answering it in one place with a
// stated precedence, so the calendar consumes an identity instead of deriving one.
//
// PURE. No database, no network, no clock. The store module supplies the rows; this decides.

import { isSicDescription } from './sic-descriptions.mjs';
import { isValidSymbol } from './ticker-symbol.mjs';

/**
 * PRECEDENCE, HIGHEST FIRST. The order is the whole design, so it is stated once, here.
 *
 *  1. form4       — the issuer name as the issuer itself filed it on a Form 4. The most specific
 *                   claim available: the company naming itself in its own filing.
 *  2. registrant  — the 8-K registrant name, for issuers with no Form 4 under that symbol. Same
 *                   authority, one step less specific.
 *  3. sec_ticker  — the registrant title in SEC's company_tickers.json, keyed by ticker. Still the
 *                   name its owner filed; it is third only because the first two are tied to a
 *                   dated filing and this is a standing list. THIS IS THE ROW THAT COVERS FUNDS —
 *                   every one of the ten reported symbols resolves here and nowhere else.
 *  4. provider    — the security name from the market-data vendor's ticker-details endpoint. LAST,
 *                   always, and recorded as such: a vendor's name for a security is a vendor's
 *                   opinion, it arrives under a licence whose terms are not ours, and the temporary
 *                   provider currently behind it may be replaced. It is the only source that knows
 *                   ETFs, which is why it is here at all rather than absent.
 *
 * Deliberately ABSENT, and staying absent:
 *   - 13F issuer names (ticker_issuer). Measured against SEC names on the overlap they agree 60% of
 *     the time; they are truncated to the filing's field width and carry raw HTML entities
 *     ("FIRST TR INTER DURATN PFD &amp;"). A truncated name is a wrong name.
 *   - FINRA security names: they name the SECURITY, not the company ("Apple Inc. Common Stock").
 *   - SIC industry descriptions. These once filled the column and put "PHARMACEUTICAL PREPARATIONS"
 *     under ZTS. A page titled with an industry is a false fact about a real company; a page with no
 *     name is merely a page with no name. cleanIdentityName refuses them at the door.
 */
export const IDENTITY_SOURCES = Object.freeze(['form4', 'registrant', 'sec_ticker', 'provider']);
const RANK = new Map(IDENTITY_SOURCES.map((s, i) => [s, i]));

// ── IS THIS STRING A TRADEABLE TICKER WE CAN PUT ON A CARD? ──────────────────
//
// The homepage showed "NONE · $9.8M · LIBERTY MUTUAL HOLDING CO INC." on its largest-buy card. The
// ticker was not a rendering bug and not a resolution failure: Form 4 has an issuerTradingSymbol
// field, an unlisted issuer's filer types "NONE" into it, and we stored the filing verbatim. The
// security was 5C Lending Partners Corp, a non-traded fund with no public ticker; Liberty Mutual was
// the BUYER, a 10% owner. Nothing downstream ever asked whether the symbol was a symbol.
//
// TWO RULES, AND BOTH ARE NECESSARY:
//
//   SHAPE. Measured across all 17,880 tickers in the screener universe, every one is 1-5 letters,
//   optionally followed by a dot and a 1-2 letter class suffix — BRK.B, BF.A, MKC.V, NWAX.U. A
//   rule any tighter than that would drop real share classes; any looser admits raw CUSIPs
//   (9 alphanumerics) and free text.
//
//   PLACEHOLDERS. A handful of strings pass the shape test but are filing-form filler, not symbols.
//   This list is deliberately SHORT, because the obvious longer version is wrong: ALL, GO, IT, NA,
//   ON and SO all look like filler and are all real securities in our own universe — Allstate,
//   Grocery Outlet, Gartner, Nano Labs, ON Semiconductor and Southern Company. Rejecting them to be
//   safe would silently delete six listed companies from every card and every board. Only strings
//   with no listed issuer anywhere are named here.
const TICKER_SHAPE = /^[A-Z]{1,5}(\.[A-Z]{1,2})?$/;
// ⚠️ EVERY ADDITION HERE MUST BE CHECKED AGAINST THE LIVE UNIVERSE FIRST.
// 'NAN' was in this list for one draft. It is Nuveen New York Quality Municipal Income Fund, a real
// $357M closed-end fund, and blocking it would have removed a listed security from every card and
// board to guard against a string no source actually emits. The check is one query; the failure is
// silent and indistinguishable from the fund simply not trading.
const TICKER_PLACEHOLDERS = new Set([
  'NONE', 'NULL', 'N/A', 'UNKNOWN', 'UNDEFINED', 'NIL', 'TBD', 'ERROR', 'MISSING', 'PLACEHOLDER',
]);

/**
 * True when `t` can be shown to a user AS a ticker and linked to a security page.
 *
 * This is the single eligibility gate for every ticker-facing surface. It answers "may this be
 * rendered", never "what should this be" — it resolves nothing, guesses nothing and derives nothing
 * from a company name.
 */
export function isRenderableTicker(t) {
  if (typeof t !== 'string') return false;
  const s = t.trim().toUpperCase();
  if (!s) return false;
  if (TICKER_PLACEHOLDERS.has(s)) return false;
  return TICKER_SHAPE.test(s);
}

// ── MAY THIS STRING BE STORED AS A TICKER AT ALL? ────────────────────────────
//
// ⚠️ A DIFFERENT, DELIBERATELY LOOSER QUESTION THAN isRenderableTicker. That one decides what may
// go on a CARD and answers it with the 1-5-letter shape the screener universe actually uses. This
// one guards the INGEST boundary, and it has to admit every symbol the product legitimately
// stores — including the ones the card rule excludes.
//
// Measured before choosing: gating inserts on isRenderableTicker would have rejected 391 rows of
// AXIA3, plus BRK.A, NYT.A, SBSP3, PHXE.P and PRTFTM. Deleting real filings to keep a table tidy
// is a worse outcome than the dirt, so the ingest gate uses the SECURITY grammar from
// ticker-symbol.mjs — the same one /ticker/[symbol] accepts, verified against all 19,199 symbols
// we hold — and adds only the placeholder rejection on top.
//
// What it therefore rejects is exactly what no security can be: the filler strings above, and
// strings that are not one symbol at all. Those are real and still arriving — "Z AND ZG" (230
// rows), "NYSE: VTEX" (88), "GEF, GEF-B" (85), "ASX:LNW" (71), "(CALX)" (44), "MOGA/MOGB" (41).
// A filer typed two symbols, an exchange prefix or a parenthetical into a one-symbol field.
//
// ⚠️ IT REJECTS, IT DOES NOT REPAIR. "(CALX)" is obviously Calix and "NYSE: VTEX" is obviously
// VTEX, and unwrapping them would be a guess dressed as a parse — the same class of move as
// inventing a SIC code. A filing we cannot read the symbol of is quarantined with its accession
// and CIK intact, which is recoverable; a filing silently reassigned to the wrong issuer is not.
export function isIngestableTicker(t) {
  if (typeof t !== 'string') return false;
  const s = t.trim().toUpperCase();
  if (!s) return false;
  if (TICKER_PLACEHOLDERS.has(s)) return false;
  return isValidSymbol(s);
}

/**
 * The first candidate whose ticker can actually be rendered, or null when none can.
 *
 * Candidates arrive already ranked by whatever the card cares about — value, recency, breadth — and
 * that order is preserved exactly. Ineligible entries are SKIPPED rather than blanked, because a
 * card built around a listed security must either name one or stand down; showing the strongest
 * event with its symbol hidden is the same false claim in quieter clothing.
 */
export function firstRenderable(candidates, getTicker = (c) => c?.ticker) {
  if (!Array.isArray(candidates)) return null;
  for (const c of candidates) if (isRenderableTicker(getTicker(c))) return c;
  return null;
}

/** Where a source sits in the precedence, or Infinity if it is not one we recognise. */
export const sourceRank = (s) => (RANK.has(s) ? RANK.get(s) : Number.POSITIVE_INFINITY);

/**
 * May an incoming identity replace the one already stored?
 *
 * ── WHY THIS IS NOT UNCONDITIONAL ───────────────────────────────────────────
 *
 * The nightly rebuild upserted `name = excluded.name` with no comparison at all, and the fetch it
 * depends on fails SOFT by design: an SEC outage returns an empty map rather than aborting the
 * rebuild. Those two decisions are individually reasonable and together they lose data. When
 * sec_ticker (rank 3) is missing for a night, any ticker named by BOTH SEC and the vendor falls
 * through to `provider` (rank 4), and the vendor's name is written over the SEC name that was
 * already there. The run then reports ok:true, because from its point of view nothing failed.
 *
 * The damage is quiet and it is durable: the next night SEC returns, the SEC name wins again, and
 * nothing records that the product displayed a vendor's name in between. A company name is the kind
 * of fact users notice and we do not.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 *
 * An identity may be replaced by one of EQUAL OR HIGHER authority, never lower.
 *
 *   equal   — a corrected form4 name replaces an older form4 name. Refreshes must still work, or
 *             the table freezes at whatever it first learned.
 *   higher  — provider → sec_ticker is a genuine promotion and must not be blocked.
 *   lower   — sec_ticker → provider is the outage case, and is refused.
 *
 * An unknown or absent stored source ranks lowest, so a row written before this existed can still be
 * corrected by anything; an unknown INCOMING source also ranks lowest and therefore cannot displace
 * a known one.
 */
export function shouldReplaceIdentity(storedSource, incomingSource) {
  return sourceRank(incomingSource) <= sourceRank(storedSource);
}

/**
 * A name we are willing to print, or null.
 *
 * Whitespace is collapsed because filings pad and wrap. An SIC description is refused whatever
 * source it arrives from — defence in depth, since the column must never be ABLE to carry one.
 */
export function cleanIdentityName(v) {
  const t = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (isSicDescription(t)) return null;
  return t;
}

/**
 * The name to use for one ticker, given every candidate we hold.
 *
 * `candidates` is [{ name, source }]. Returns { name, source } or null when nothing survives
 * cleaning — null is a real answer here, and preferable to a guess.
 */
export function pickIdentity(candidates) {
  let best = null;
  for (const c of candidates || []) {
    const name = cleanIdentityName(c?.name);
    if (!name) continue;
    const rank = sourceRank(c?.source);
    if (rank === Number.POSITIVE_INFINITY) continue;
    if (!best || rank < best.rank) best = { name, source: c.source, rank };
  }
  return best ? { name: best.name, source: best.source } : null;
}

/**
 * The filer name for one ticker, from its filings.
 *
 * WHY THIS IS NOT JUST "MOST RECENT". The obvious `distinct on (ticker) ... order by filing_date
 * desc` is not a TOTAL order, and the ties are not hypothetical: VKI had three Form 4 rows on the
 * same date, two naming the issuer ("Invesco Advantage Municipal Income Trust II") and one naming a
 * 10% holder that had filed against it ("BANK OF AMERICA CORP /DE/"). Postgres picked the third
 * arbitrarily, and the screener printed Bank of America on an Invesco municipal trust — a
 * confidently wrong name, which is worse than the blank this whole module exists to fill.
 *
 * So: the latest filing date wins, because a company that renames files again. Among rows sharing
 * that date, the name the MOST filings agree on wins, because an issuer files for itself far more
 * often than any one holder files against it. Remaining ties break alphabetically, so the answer is
 * total and the same rows always give the same name.
 *
 * `rows` is [{ name, date, count }] — count being how many filings carry that exact name.
 */
export function resolveFilerName(rows) {
  const seen = new Map();
  for (const r of rows || []) {
    const name = cleanIdentityName(r?.name);
    if (!name) continue;
    const date = r?.date == null ? '' : String(r.date);
    const count = Number(r?.count) || 1;
    const prev = seen.get(name);
    // One entry per distinct name: its best date, and its total weight across every date.
    if (prev) { if (date > prev.date) prev.date = date; prev.count += count; }
    else seen.set(name, { name, date, count });
  }
  if (!seen.size) return null;

  const all = [...seen.values()];
  const latest = all.reduce((a, b) => (b.date > a.date ? b : a)).date;
  const tied = all.filter((x) => x.date === latest);
  tied.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return tied[0].name;
}

/**
 * SEC's company_tickers.json → [{ ticker, name }].
 *
 * The file is an object keyed by an opaque index, with { cik_str, ticker, title } values. Tolerant
 * of shape: a malformed entry is skipped, not thrown on, because this runs inside a nightly rebuild
 * that must not fail over one bad row in somebody else's file.
 */
export function parseSecTickerFile(json) {
  const out = [];
  for (const v of Object.values(json || {})) {
    const ticker = String(v?.ticker ?? '').trim().toUpperCase();
    const name = cleanIdentityName(v?.title);
    if (ticker && name) out.push({ ticker, name });
  }
  return out;
}

/**
 * Fold every source into one row per ticker.
 *
 * `sources` is { form4: Map, registrant: Map, sec_ticker: Map, provider: Map }, each ticker → name.
 * Returns [{ ticker, name, source }] for every ticker ANY source can name — a ticker no source can
 * name is simply absent, never present with a placeholder.
 */
export function buildIdentities(sources = {}) {
  const tickers = new Set();
  for (const key of IDENTITY_SOURCES) {
    for (const t of (sources[key]?.keys?.() ?? [])) tickers.add(t);
  }
  const out = [];
  for (const ticker of tickers) {
    const picked = pickIdentity(IDENTITY_SOURCES.map((source) => ({ source, name: sources[source]?.get(ticker) })));
    if (picked) out.push({ ticker, name: picked.name, source: picked.source });
  }
  return out.sort((a, b) => a.ticker.localeCompare(b.ticker));
}
