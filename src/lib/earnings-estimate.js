// Estimated next-earnings date from historical SEC filing cadence (median gap between
// consecutive report dates, rolled forward to the next future date). ESTIMATE ONLY —
// SEC/EDGAR has no forward calendar. Returns 'YYYY-MM-DD' or null when too few points.
// Shared by the ticker hero (B2) and the watchlist page (B4).
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
