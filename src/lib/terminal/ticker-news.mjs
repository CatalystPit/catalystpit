// ONE TICKER'S NEWS, FROM THE PATHS THAT ALREADY EXIST.
//
// ── ⚠️ TICKER NEWS IS NOT "THE 8-K TABLE" ───────────────────────────────────
//
// The first version of the news inspector read /api/eightk alone, because that is what the Watchlist
// badge is computed from. That made the badge and the panel consistent and made the PANEL wrong: an
// 8-K row knows which SEC item was filed under and nothing about what the filing said. Meanwhile two
// other canonical per-ticker paths were already serving the site — the evidence engine's catalyst
// events, and the press-release reader that extracts the actual headline from 8-K Exhibit 99.1.
// Three views of the same corporate disclosure, one of which had the words in it.
//
// So this merges all three. It is a JOIN, not a new source: nothing here fetches, classifies,
// scores or ranks. Every field below arrived from a canonical endpoint and is carried through.
//
// ── ⚠️ AND THE THREE OVERLAP, WHICH IS THE WHOLE PROBLEM ────────────────────
//
// One 8-K produces a row in eightk_filings, a catalyst event in the evidence engine, AND a press
// release if it carried an Exhibit 99.1. Concatenating them shows a trader the same disclosure three
// times and makes a quiet day look busy. They are deduped on the one identifier the SEC guarantees
// is unique — the accession number — which every one of the three paths carries, though two of them
// bury it. Where they overlap the richest description wins, because the reason to merge at all is
// that the press release has the headline the 8-K row does not.

/** Where a merged item's description came from. Shown to the reader, and asserted in the suite. */
export const SOURCE = Object.freeze({
  PRESS: 'press-release',
  EVIDENCE: 'evidence',
  FILING: 'sec-8k',
});

/**
 * How good a description is, for choosing between two records of one filing.
 *
 * ⚠️ NOT A MATERIALITY RANKING. This decides which TEXT to show for a disclosure that appeared on
 * more than one path; it never decides whether a disclosure appears at all, and it never reorders
 * the list. The order is time, always.
 */
const RICHNESS = { [SOURCE.PRESS]: 3, [SOURCE.EVIDENCE]: 2, [SOURCE.FILING]: 1 };

/** An SEC accession, anywhere it hides. */
const ACCESSION_RE = /\d{10}-?\d{2}-?\d{6}/;

/**
 * The accession an item refers to, or null.
 *
 * ⚠️ THE EVIDENCE ID CARRIES IT IN A COMPOUND KEY — "MSTR|CATALYST|SEC_8K_OTHER|0001193125-26-401636"
 * — and a press release carries it in its document URL. Reading it out of both is what lets three
 * records of one filing collapse into one row instead of three.
 */
export function accessionOf(item) {
  for (const v of [item?.accession, item?.evidenceId, item?.url, item?.sourceUrl, item?.filingUrl]) {
    const m = typeof v === 'string' ? v.match(ACCESSION_RE) : null;
    if (m) return m[0].replace(/-/g, '');
  }
  return null;
}

const time = (v) => {
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/** The canonical 8-K read (lib/eightk recentEightK), as a news item. */
export function fromEightK(rows) {
  return (rows || []).map((r) => ({
    key: accessionOf(r) || `8k:${r.ticker}:${r.filedAt}`,
    accession: accessionOf(r),
    source: SOURCE.FILING,
    sourceLabel: 'SEC 8-K',
    ticker: String(r.ticker || '').toUpperCase(),
    company: r.company || null,
    // An 8-K's "headline" is the item it was filed under — already phrased by classifyItems.
    headline: r.primaryLabel || (Array.isArray(r.items) ? r.items[0] : null) || '8-K filing',
    detail: Array.isArray(r.items) && r.items.length > 1 ? r.items.slice(1, 4).join(' · ') : null,
    at: time(r.filedAt),
    url: r.url || null,
    material: r.material !== false,
  })).filter((x) => x.at !== null);
}

/**
 * The evidence engine's catalyst events, as news items.
 *
 * ⚠️ CATALYSTS ONLY. The evidence payload also carries insider, institution and congress families —
 * that is research, and it belongs to the Evidence inspector. A news panel listing a Form 4 as
 * "news" would be a second, worse Evidence.
 */
export function fromEvidence(events) {
  return (events || [])
    .filter((e) => e && String(e.family || '').toLowerCase() === 'catalyst')
    .map((e) => ({
      key: accessionOf(e) || `ev:${e.evidenceId || `${e.ticker}:${e.publicTime}`}`,
      accession: accessionOf(e),
      source: SOURCE.EVIDENCE,
      sourceLabel: e.sourceLabel || 'SEC filing',
      ticker: String(e.ticker || '').toUpperCase(),
      company: e.company || null,
      headline: e.headline || e.label || e.summary || prettyType(e.type),
      detail: e.subtype && !e.headline ? `Item ${e.subtype}` : null,
      // ⚠️ publicTime, NOT eventTime. When the market could first have known is what makes a
      // disclosure news; when the event itself happened is a different fact and is often earlier.
      at: time(e.publicTime) ?? time(e.eventTime),
      url: e.url || e.sourceUrl || null,
      material: e.materiality == null ? true : Number(e.materiality) >= 0.5,
    }))
    .filter((x) => x.at !== null && x.headline);
}

const prettyType = (t) => String(t || '')
  .replace(/^sec_/, '').replace(/_/g, ' ').replace(/\b8k\b/i, '8-K').trim() || 'SEC filing';

/** The press-release reader (8-K Exhibit 99.1), as news items — the path that has the words. */
export function fromPressReleases(list, ticker, company) {
  return (list || []).map((p) => ({
    key: accessionOf(p) || `pr:${ticker}:${p.filingDate}:${(p.headline || '').slice(0, 40)}`,
    accession: accessionOf(p),
    source: SOURCE.PRESS,
    sourceLabel: 'Press release',
    ticker: String(ticker || '').toUpperCase(),
    company: company || null,
    headline: p.headline || 'Press release',
    detail: p.excerpt ? String(p.excerpt).slice(0, 220) : null,
    at: time(p.filingDate),
    url: p.url || p.documentUrl || null,
    material: true,
    items: Array.isArray(p.items) ? p.items : null,
  })).filter((x) => x.at !== null);
}

/**
 * One list, newest first, one row per disclosure.
 *
 * ⚠️ TIME DECIDES THE ORDER; RICHNESS ONLY DECIDES THE WORDS. A merge that sorted by how good a
 * description was would put an old press release above this morning's filing, which is the opposite
 * of what a news panel is for.
 *
 * ⚠️ AND A RECORD WITHOUT AN ACCESSION IS NEVER MERGED INTO ONE THAT HAS A DIFFERENT ONE. Matching
 * on date or headline text would silently fold two genuinely different filings by one issuer on the
 * same day into a single row — the exact mistake the accession exists to prevent.
 */
export function mergeTickerNews({ eightk = [], evidence = [], pressReleases = [], ticker = null, company = null } = {}) {
  const all = [
    ...fromPressReleases(pressReleases, ticker, company),
    ...fromEvidence(evidence),
    ...fromEightK(eightk),
  ];
  const byKey = new Map();
  for (const item of all) {
    const k = item.key;
    const prev = byKey.get(k);
    if (!prev) { byKey.set(k, item); continue; }
    // Same disclosure, two records: keep the richer description, and the earliest time either
    // path reports it as public — the earlier one is when a reader could first have seen it.
    const winner = RICHNESS[item.source] > RICHNESS[prev.source] ? item : prev;
    const other = winner === item ? prev : item;
    byKey.set(k, {
      ...winner,
      at: Math.min(winner.at, other.at),
      url: winner.url || other.url,
      company: winner.company || other.company,
      detail: winner.detail || other.detail,
      // ⚠️ THE MERGED ROW REMEMBERS EVERY PATH IT CAME FROM, so the panel can say "press release ·
      // also filed as an 8-K" rather than implying one source where there were two.
      alsoFrom: [...new Set([...(prev.alsoFrom || []), ...(item.alsoFrom || []), other.source])]
        .filter((s) => s !== winner.source),
    });
  }
  return [...byKey.values()].sort((a, b) => b.at - a.at);
}

/** Exactly what the Watchlist badge counts as fresh, so NEW here and NEWS there agree. */
export const FRESH_MS = 24 * 60 * 60 * 1000;
export const isFresh = (at, now = Date.now()) => Number.isFinite(at) && now - at < FRESH_MS;
