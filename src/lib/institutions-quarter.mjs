// WHEN A 13F QUARTER WE ALREADY HAVE CAN BE LEFT ALONE.
//
// storeFilingSuperseded already refuses to rewrite an unchanged quarter, but it decides that AFTER
// the holdings have been downloaded and parsed — by then the only cost worth avoiding has been paid.
// The historical backfill is where that bites: it walks filers missing OLD quarters, while
// ingestFiler re-walks every quarter at or after the cutoff, recent ones included. Measured on the
// live registry mid-run: 33,163 already-stored quarters across the 9,729 remaining filers, ~3.4 per
// filer out of ~8, every one of them fetched and thrown away.
//
// This is the same decision made BEFORE the fetch, and it is deliberately narrower than the
// store-time one. storeFilingSuperseded also rewrites when the stored `holdings_count` disagrees with
// what was parsed, which is how a quarter written by the old restatement-only logic heals itself:
// same head accession, far fewer positions, because an additive amendment had been treated as a
// restatement. That comparison needs the fetched rows, so it cannot be made in advance — and so the
// pre-fetch rule may only skip a quarter where there is provably nothing to heal.
//
// That is exactly one shape: a single filing, not an amendment, carrying the accession already
// stored. One filing means no amendment was layered, so the old logic and the current logic produce
// identical rows. On the live registry 33,082 of the 33,163 fit it; the other 81 take the full path.
// ── THE <infoTable> ELEMENT, WITH OR WITHOUT ATTRIBUTES ──────────────────────
//
// The original patterns were `<(?:\w+:)?infoTable>` — the `>` immediately after the name means the
// element must carry NO attributes. Most filing agents emit it that way, so this looked correct for
// months. Others do not:
//
//   <infoTable xmlns:ns1="http://www.sec.gov/edgar/document/thirteenf/informationtable">
//
// BNP Paribas Asset Management files exactly that, and every one of its quarters from 2025-03-31 to
// 2026-06-30 was read successfully, matched nothing, parsed to zero rows, and was skipped in silence
// by `if (!rows.length) continue`. Nothing was 503ing and nothing was broken upstream — the document
// was in our hands and the regex refused it.
//
// `(?:\s[^>]*)?` accepts an attribute list and still requires a tag boundary, so `<infoTableFoo>`
// cannot match. Both the DETECTOR (does this document hold a table?) and the BLOCK MATCHER (pull
// each position out) must use it — fixing only one turns a silent skip into an empty parse.
export const INFO_TABLE_OPEN = '<(?:\\w+:)?infoTable(?:\\s[^>]*)?>';
export const infoTableDetector = () => new RegExp(INFO_TABLE_OPEN, 'i');
export const infoTableBlocks = () => new RegExp(`${INFO_TABLE_OPEN}[\\s\\S]*?<\\/(?:\\w+:)?infoTable>`, 'gi');

// A field inside one position block. Same attribute tolerance, same boundary requirement — without
// the boundary, `value` would match `valueTotal` and read the wrong number.
export const fieldMatcher = (name) =>
  new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`, 'i');

export function quarterUnchanged(list, storedAccession) {
  if (!storedAccession || !Array.isArray(list) || list.length !== 1) return false;
  const only = list[0];
  // A lone amendment is never a complete quarter: the base it amends was filed before the cutoff and
  // is not in this list, so storing it alone is the ExodusPoint failure — 1,454 positions down to 41.
  if (!only?.accession || !only?.form || String(only.form).endsWith('/A')) return false;
  return only.accession === storedAccession;
}
