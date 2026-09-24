// EDGAR DAILY INDEX — the complete filing list for a given day, by form type.
//
// ── ⚠️ WHY THIS EXISTS: getcurrent IS A WINDOW, NOT A RECORD ────────────────
//
// Every SEC ingest in Catalyst Pit reads `browse-edgar?action=getcurrent`, which returns the most
// recent few hundred filings and nothing else. That is fine while the cron runs. It is useless the
// moment anything is missed, and it is why two previous investigations ended with "cannot be
// backfilled from our existing sources":
//
//   SRZN  Form 25-NSE, 2026-08-07  — outside the window by the time we looked
//   SPCX  Form 144,    2026-09-23  — outside the window by three hours
//
// That conclusion was wrong. SEC publishes a complete daily index of every filing it disseminated,
// by form type, free, under the same terms as the rest of EDGAR:
//
//   https://www.sec.gov/Archives/edgar/daily-index/{YYYY}/QTR{n}/form.{YYYYMMDD}.idx
//
// Measured on 2026-09-23: 112 Form 144, 4 Form 25-NSE, 177 8-K. No vendor, no scraping, no key.
//
// ── ⚠️ THE TWO SOURCES ARE COMPLEMENTARY AND BOTH ARE KEPT ──────────────────
//
//   getcurrent    seconds old, incomplete    → a filing is seen within one cron tick
//   daily index   complete, up to a day old  → nothing stays missed
//
// A caller reads both and dedupes on the accession, which is unique and is already the conflict
// key on every table these feed.
//
// ── ⚠️ FIXED-WIDTH, AND THAT IS NOT A DETAIL ────────────────────────────────
//
// The .idx form file is column-aligned, and company names contain the separators a naive split
// would use. The parse below reads the trailing fields from the END of the line — CIK, date and
// path are unambiguous there — and treats everything before them as the name.

export const SEC_HEADERS = { 'User-Agent': 'CatalystPit contact@catalystpit.com', 'Accept-Encoding': 'gzip, deflate' };

/** 2026-09-23 -> https://.../daily-index/2026/QTR3/form.20260923.idx */
export function dailyIndexUrl(dateIso) {
  const m = String(dateIso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const qtr = Math.floor((Number(mo) - 1) / 3) + 1;
  return `https://www.sec.gov/Archives/edgar/daily-index/${y}/QTR${qtr}/form.${y}${mo}${d}.idx`;
}

/**
 * Parse one line of the form index.
 *
 * Exported for the regression suite: a silent mis-parse here would produce filings attributed to
 * the wrong company, which is the one failure mode this file could introduce.
 *
 * @returns {{form,company,cik,date,accession,cikPath}|null}
 */
export function parseIndexLine(line) {
  const s = String(line || '').trimEnd();
  // The tail is always: <CIK> <YYYYMMDD> edgar/data/<cik>/<accession>.txt
  const m = s.match(/\s(\d+)\s+(\d{8})\s+(edgar\/data\/(\d+)\/([\d-]+)\.txt)\s*$/);
  if (!m) return null;
  const [, cik, yyyymmdd, , cikPath, accession] = m;
  const head = s.slice(0, m.index);
  // The form type is the first whitespace-delimited token; the rest of the head is the name.
  const fm = head.match(/^(\S+(?:\s\S+)*?)\s{2,}(.*)$/);
  if (!fm) return null;
  return {
    form: fm[1].trim(),
    company: fm[2].trim(),
    cik,
    cikPath,
    accession,
    date: `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`,
  };
}

/**
 * Every filing of the given form types disseminated on one day.
 *
 * @param {string} dateIso  YYYY-MM-DD
 * @param {Set<string>|string[]} forms  exact form types, e.g. ['144'] or ['25','25-NSE']
 * @returns {Promise<Array<{form,company,cik,cikPath,accession,date}>>} empty when the day has no
 *   index yet — weekends, holidays and the current day before dissemination completes.
 */
export async function dailyIndexFilings(dateIso, forms) {
  const want = forms instanceof Set ? forms : new Set(forms || []);
  const url = dailyIndexUrl(dateIso);
  if (!url || !want.size) return [];
  let text;
  try {
    const r = await fetch(url, { headers: SEC_HEADERS });
    // 403/404 is the normal answer for a day SEC has not published, and is not an error condition.
    if (!r.ok) return [];
    text = await r.text();
  } catch { return []; }

  const out = [];
  for (const line of text.split('\n')) {
    // Cheap prefix test before the regex — the file is ~10k lines and most are other forms.
    const head = line.slice(0, 16).trimEnd();
    if (!want.has(head)) continue;
    const row = parseIndexLine(line);
    if (row && want.has(row.form)) out.push(row);
  }
  return out;
}

/** The last `days` calendar days ending today, newest first, as YYYY-MM-DD. */
export function recentDays(days, now = Date.now()) {
  const out = [];
  for (let i = 0; i < days; i++) out.push(new Date(now - i * 86_400_000).toISOString().slice(0, 10));
  return out;
}

// ── CIK -> ticker ────────────────────────────────────────────────────────────
//
// ⚠️ NOT submissionDetail. The 8-K and Form 25 ingests resolve a ticker by pulling the issuer's
// whole submissions JSON, which is megabytes and is worth it there because they also need the item
// codes and the report date from it. Form 144 needs neither — the XML carries everything — so all
// that remains is the CIK-to-ticker mapping, and SEC publishes that as one file for every listed
// company. One ~1MB fetch per process against thousands of multi-megabyte ones.
//
// A CIK missing from this file has no ticker, which is the same "not a tradeable name" skip the
// other two ingests apply.
let _cikMap = null;
let _cikMapAt = 0;
const CIK_MAP_TTL_MS = 6 * 3600e3;

export async function cikTickerMap({ now = Date.now() } = {}) {
  if (_cikMap && now - _cikMapAt < CIK_MAP_TTL_MS) return _cikMap;
  const m = new Map();
  try {
    const r = await fetch('https://www.sec.gov/files/company_tickers.json', { headers: SEC_HEADERS });
    if (r.ok) {
      const data = await r.json();
      for (const k of Object.keys(data)) {
        const row = data[k];
        if (!row?.cik_str || !row?.ticker) continue;
        const cik = String(row.cik_str);
        // The FIRST ticker wins: company_tickers.json lists classes in order and the common one
        // leads, so a dual-class issuer resolves to the class the market quotes.
        if (!m.has(cik)) m.set(cik, { ticker: String(row.ticker).toUpperCase(), name: row.title || null });
      }
    }
  } catch { /* an empty map means every filing is skipped this run, which is safe */ }
  if (m.size) { _cikMap = m; _cikMapAt = now; }
  return _cikMap || m;
}

/** Test seam. */
export function __setCikMap(m) { _cikMap = m; _cikMapAt = Date.now(); }
