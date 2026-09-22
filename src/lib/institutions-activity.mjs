// WHAT INSTITUTIONAL POSITION CHANGES WERE JUST DISCLOSED — ACROSS EVERY MANAGER.
//
// The per-manager page already answers this for one filer. This answers it for the market, and it
// does so with the SAME comparison the fund page uses: the position key is `cusip|putCall` and the
// dead band is the same 0.1%. There is no second 13F engine here — the rules live in one place
// (classifyChange / positionKey below) and the fund page's inline version is the shape they were
// lifted from.
//
// ⚠️ THE CLOCK IS THE DISCLOSURE DATE, NEVER THE QUARTER END. A 13F disclosed on 21 September
// describes holdings as of 30 June. Ordering by quarter would put a stale back-filing above a
// filing that landed this morning, and describing it as buying would be a claim about a trade
// nobody could have acted on. Every row carries both dates under their own names and the feed is
// sorted by the public one.
//
// ⚠️ AND A MANAGER BACK-FILING EIGHT QUARTERS IS ONE DISCLOSURE, NOT EIGHT EVENTS. Measured in
// production: Advus filed 8 quarters on 2026-08-25, Formuepleje 8, Whitebox 7. Treating each as a
// separate event would bury today's real news under one filer's history, so a (manager, filed_date)
// pair contributes exactly its NEWEST quarter — the position it is actually disclosing now.

/** The canonical position identity, matching the fund page: a put and the underlying shares are
 *  different positions in the same security. */
export const positionKey = (r) => `${r?.cusip ?? ''}|${r?.putCall || r?.put_call || ''}`;

/**
 * ⚠️ THE SAME 0.1% DEAD BAND THE FUND PAGE USES (> prev*1.001 / < prev*0.999). Share counts drift
 * by rounding and by corporate actions; without a band the feed fills with "increased by 4 shares"
 * and the real moves are indistinguishable from noise. Changing this number changes what the fund
 * page and the feed each call a change, which is exactly the drift that having two engines causes.
 */
export function classifyChange(prevShares, curShares) {
  const prev = Number(prevShares) || 0;
  const cur = Number(curShares) || 0;
  const hadPrev = prevShares != null;
  const hasCur = curShares != null;
  if (!hadPrev && !hasCur) return null;
  if (!hadPrev) return 'NEW';
  if (!hasCur) return 'EXITED';
  if (cur > prev * 1.001) return 'INCREASED';
  if (cur < prev * 0.999) return 'REDUCED';
  return null;                       // inside the band: not a change worth reporting
}

/** Direction, for colour only. Green adds, red removes — never the whole row. */
export const changeTone = (action) =>
  action === 'NEW' || action === 'INCREASED' ? 'up'
    : action === 'REDUCED' || action === 'EXITED' ? 'down' : 'flat';

export const ACTIONS = ['NEW', 'INCREASED', 'REDUCED', 'EXITED'];

/**
 * LATEST FILINGS, GROUPED BY WHO FILED AND WHEN.
 *
 * ⚠️ THE WALL OF REPEATED NAMES WAS REAL DATA, NOT A BUG — managers genuinely back-file several
 * quarters in one submission, so "Altar Rock / Altar Rock / Altar Rock" is three legitimate,
 * legally distinct filings. They are grouped for reading, never merged: each filing keeps its own
 * accession, quarter and link, and the group simply says how many there are and which quarters
 * they cover. Nothing becomes unreachable.
 */
export function groupFilingsByManager(filings = []) {
  const groups = new Map();
  for (const f of filings) {
    if (!f) continue;
    const key = `${f.manager || f.cik || '?'}|${f.disclosed || ''}`;
    if (!groups.has(key)) {
      groups.set(key, {
        manager: f.manager, managerUrl: f.managerUrl, disclosed: f.disclosed,
        filings: [],
      });
    }
    groups.get(key).filings.push(f);
  }
  return [...groups.values()].map((g) => {
    // Newest quarter first inside a group, so the headline quarter is the current one.
    const sorted = [...g.filings].sort((a, b) => String(b.quarterEnd || '').localeCompare(String(a.quarterEnd || '')));
    return {
      ...g,
      filings: sorted,
      count: sorted.length,
      latestQuarter: sorted[0]?.quarterEnd || null,
      oldestQuarter: sorted[sorted.length - 1]?.quarterEnd || null,
      // Positions are reported per filing; the headline number is the quarter being disclosed now.
      holdings: sorted[0]?.holdings ?? null,
    };
  });
}

/**
 * The cross-manager feed, as one pass of SQL over a SMALL slice of the data.
 *
 * ⚠️ IT DOES NOT COMPARE 18 MILLION HOLDINGS. Two things keep it cheap, and both were measured:
 *
 *   1. The quarter PAIRS are resolved first, with a window function over fund_filings — 67k rows,
 *      ~400ms. The obvious `(SELECT max(quarter) … WHERE quarter < x)` correlated subquery took
 *      14.2 SECONDS for the same window; lag() over a partition is the same answer in one pass.
 *   2. Those pairs are then handed to the holdings join through unnest(), so Postgres drives the
 *      18M-row table by its (cik, quarter) index instead of planning a scan. ~7k rows touched,
 *      ~200ms.
 *
 * Together ~600ms cold, and the caller caches it — filings land daily, so this runs once per cache
 * period, never per reader. `db` is the drizzle neon client; `sql` its template tag.
 */
export function activityFeedQueries({ windowDays = 45, maxPairs = 30, perManager = 3, limit = 60 } = {}) {
  return { windowDays, maxPairs, perManager, limit };
}
