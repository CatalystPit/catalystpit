/**
 * THE SEC XBRL FRAMES CLIENT — ONE REQUEST PER CONCEPT PER PERIOD, FOR THE WHOLE MARKET.
 *
 * ── ⚠️ WHY FRAMES AND NOT companyfacts PER TICKER ────────────────────────────
 *
 * The obvious way to populate fundamentals for ~18,000 securities is to fetch
 * data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json for each one. That is 18,000 requests of several
 * megabytes each, it takes hours, and this session has already watched SEC start returning 429 for
 * exactly that pattern — the metadata backfill earlier in this work was throttled mid-run and reported
 * zero fetched, which read as "SEC has no data" rather than "SEC is refusing us".
 *
 * The frames endpoint answers the inverse question: ONE concept, ONE period, EVERY filer. Measured:
 *
 *   dei/EntityCommonStockSharesOutstanding  CY2026Q2I   4,423 filers in one request
 *   us-gaap/Assets                          CY2026Q2I   5,478
 *   us-gaap/NetIncomeLoss                   CY2026Q2    4,930
 *
 * The whole fundamentals set is ~31 requests for the entire market rather than 18,000 — three orders of
 * magnitude less load on a public service we are a guest of, and fast enough to run inside one job.
 *
 * ── ⚠️ WHAT FRAMES GIVE AND WHAT THEY DO NOT ─────────────────────────────────
 *
 * Each row is { accn, cik, entityName, loc, start, end, val }. That is enough provenance to answer
 * source, CIK, concept, taxonomy, unit, accession and exact period — which is what Phase 9 requires.
 * It does NOT carry `form` or `filed`. SEC selects one fact per entity per frame itself, resolving
 * duplicates and amendments upstream, so "which filing won" is answered by the accession rather than by
 * us re-deriving it. Where a form matters — and for the per-company statements view it does — the
 * companyfacts path in /api/financials remains the right tool; this one is for breadth.
 *
 * ⚠️ AND A FRAME IS NOT A CALENDAR CLAIM. CY2026Q2 does not mean "the three months to 30 June". It means
 * "each company's fiscal quarter that best fits that window", and the row carries the real start and end
 * so the caller can check. Apple's CY2026Q2 row is 2026-03-29 → 2026-06-27, its own fiscal Q3. Any code
 * that treats the frame label as the period rather than reading start/end has made the mistake this
 * comment exists to prevent.
 */
import { isAllowedTaxonomy } from './xbrl-concepts.mjs';

const BASE = 'https://data.sec.gov/api/xbrl/frames';

/**
 * ⚠️ SEC PUBLISHES ITS ACCESS RULES AND WE FOLLOW THEM RATHER THAN DISCOVERING THEM.
 *
 * SEC asks automated clients for a descriptive User-Agent with contact details and limits to 10 requests
 * per second. The pacing below is well inside that, and gzip is requested because these payloads are
 * large and SEC asks that it be used.
 */
const UA = {
  'User-Agent': 'CatalystPit Research bcoghill88@gmail.com',
  'Accept-Encoding': 'gzip',
};
const PACE_MS = 350;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class SecThrottled extends Error {
  constructor(status) { super(`SEC returned ${status}`); this.name = 'SecThrottled'; this.status = status; }
}

let lastCall = 0;
async function paced() {
  const wait = PACE_MS - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
}

/**
 * Fetch one frame.
 *
 * @returns {{ ok: true, rows: Array, meta: object } | { ok: false, reason: string, status: number }}
 *
 * ⚠️ A 404 IS AN ANSWER, NOT A FAILURE. SEC returns 404 for a concept/period combination no filer
 * reported — a perfectly normal state for a narrow tag — and the caller must be able to tell that from
 * being throttled. A 429 or 5xx is a reason to STOP, because continuing is what turns a slow period into
 * a block; see the retry policy in the ingestion job.
 */
export async function fetchFrame({ taxonomy, tag, unit, frame, fetchImpl = fetch }) {
  if (!isAllowedTaxonomy(taxonomy)) {
    // ⚠️ REFUSED HERE, NOT FILTERED LATER. A company-extension concept must never be read as if it were
    // standard, and the cheapest place to make that impossible is before the request exists.
    return { ok: false, reason: 'taxonomy-not-allowed', status: 0 };
  }
  await paced();
  const url = `${BASE}/${taxonomy}/${tag}/${unit}/${frame}.json`;
  try {
    const r = await fetchImpl(url, { headers: UA, cache: 'no-store' });
    if (r.status === 429 || r.status >= 500) throw new SecThrottled(r.status);
    if (r.status === 404) return { ok: false, reason: 'no-such-frame', status: 404 };
    if (!r.ok) return { ok: false, reason: `http-${r.status}`, status: r.status };
    const j = await r.json();
    const rows = Array.isArray(j?.data) ? j.data : [];
    return {
      ok: true,
      rows,
      meta: { taxonomy, tag, unit, frame, label: j?.label ?? null, count: rows.length },
    };
  } catch (e) {
    if (e instanceof SecThrottled) throw e;
    return { ok: false, reason: `network: ${e.message}`, status: 0 };
  }
}

/**
 * The calendar frame identifiers for the N most recent completed quarters, newest first.
 *
 * ⚠️ "COMPLETED" IS DOING WORK HERE. A frame for the quarter currently in progress either does not exist
 * or contains the handful of early filers, and including it would produce a TTM built from three real
 * quarters and one nearly-empty one — a number that looks like a TTM and is 25% short. The most recent
 * frame offered is therefore the last quarter that has fully ended, plus a lag for filings to arrive.
 *
 * ⚠️ AND THE FILING LAG IS NOT OPTIONAL. A 10-Q is due 40 days after quarter end for a large filer and
 * 45 for everyone else. Asking for a frame the day after quarter end returns a frame that technically
 * exists and is three-quarters empty. 75 days is past both deadlines.
 */
export function recentQuarterFrames(n = 4, now = new Date()) {
  const LAG_DAYS = 75;
  // ⚠️ "THE QUARTER CONTAINING now MINUS A LAG" IS THE WRONG RULE, AND IT WAS THE FIRST ONE HERE. On
  // 1 October, now − 75 days is 18 July, which falls in Q3 — a quarter that had not even ended on 18 July,
  // let alone been filed. The rule has to be about the period END, not about where a shifted date lands:
  // the newest usable frame is the most recent quarter whose END is itself at least LAG days in the past.
  //
  // On 1 October: Q3 ended 30 September, one day ago → not usable. Q2 ended 30 June, 93 days ago → usable.
  let y = now.getUTCFullYear();
  let q = Math.floor(now.getUTCMonth() / 3) + 1;
  // Step back until the quarter's end is comfortably in the past.
  for (let guard = 0; guard < 8; guard++) {
    const endMonth = q * 3;                                  // 3, 6, 9, 12
    const end = Date.UTC(y, endMonth, 0);                    // day 0 of the next month = last day of this
    if ((now.getTime() - end) / 86_400_000 >= LAG_DAYS) break;
    q -= 1;
    if (q === 0) { q = 4; y -= 1; }
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ frame: `CY${y}Q${q}`, instantFrame: `CY${y}Q${q}I`, year: y, quarter: q });
    q -= 1;
    if (q === 0) { q = 4; y -= 1; }
  }
  return out;
}

/**
 * The most recent ANNUAL frame worth asking for.
 *
 * ⚠️ A 10-K IS DUE 60-90 DAYS AFTER YEAR END and many filers use the full window, so the calendar year
 * that just ended is thinly populated for months. This asks for the last year that is comfortably filed.
 */
export function recentAnnualFrame(now = new Date()) {
  const LAG_DAYS = 150;
  const d = new Date(now.getTime() - LAG_DAYS * 86_400_000);
  // If we are not yet ~5 months past the year end, the previous year is the safe one.
  const y = d.getUTCMonth() >= 4 ? d.getUTCFullYear() - 1 : d.getUTCFullYear() - 2;
  return { frame: `CY${y}`, year: y };
}
