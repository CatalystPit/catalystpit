// ⚠️ THIS RETURNS AN ESTIMATED SEC FILING DATE. IT IS NOT AN ANNOUNCEMENT DATE.
//
// `report_date` on every row it is handed is the date the 10-Q/10-K was FILED, so what this
// projects is the next such filing — not the 8-K press release that actually reports the quarter.
// Measured over 2,472 real pairs, the announcement lands a MEDIAN OF 5 DAYS BEFORE the filing
// (p10 0, p90 24). The function keeps its name because every caller and test uses it; the callers
// are responsible for saying "estimated", and verify-legal-copy.mjs holds them to it.
//
// ACCURACY, measured walk-forward against EDGAR (2,360 predictions, 84 issuers): exact 24.6%,
// within 1 day 34.7%, within 3 days 41.5%, within 7 days 53.3%; median |error| 7 days, p90 35 days.
// It is a rough marker, not a calendar entry, and it must never be rendered as a scheduled date.
//
// Method: median gap between consecutive filing dates (quarterly gaps only, 40–140 days), added to
// the last filing and rolled forward to the next future date. No fiscal-quarter awareness and no
// weekend or holiday adjustment — 6.7% of live estimates land on a Saturday or Sunday.
// Returns 'YYYY-MM-DD', or null when there are too few points. Used by the ticker hero and watchlist.
export function estimateNextEarnings(rows) {
  const reports = (rows || []).map((r) => r.report_date).filter(Boolean).sort();   // ascending
  if (reports.length < 3) return null;
  const gaps = [];
  for (let i = 1; i < reports.length; i++) {
    const g = (Date.parse(reports[i]) - Date.parse(reports[i - 1])) / 86_400_000;
    if (g > 40 && g < 140) gaps.push(g);                                            // sane quarterly gaps only
  }
  if (!gaps.length) return null;
  gaps.sort((a, b) => a - b);
  const medGap = gaps[Math.floor(gaps.length / 2)];
  let t = Date.parse(reports[reports.length - 1]) + medGap * 86_400_000;
  if (isNaN(t)) return null;
  for (let guard = 0; t < Date.now() && guard < 8; guard++) t += medGap * 86_400_000;  // roll forward to a future date
  return new Date(t).toISOString().slice(0, 10);
}
