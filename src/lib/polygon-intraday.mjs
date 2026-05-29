// Polygon aggregates (intraday minute bars). Mirrors the fetchTiingoDaily helper shape.
// Returns { ok, results } — ok:true means Polygon responded (results may be []), ok:false
// means an HTTP/network failure (caller falls back to stale cache). Bars: { o,c,h,l,v,vw,t,n }
// where t is epoch MILLISECONDS (UTC). On the Stocks Starter tier status is "DELAYED".
export async function fetchPolygonMinuteAggs(ticker, multiplier, from, to, apiKey) {
  const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}`
    + `/range/${multiplier}/minute/${from}/${to}`
    + `?adjusted=true&sort=asc&limit=50000&apiKey=${apiKey}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return { ok: false, results: null };
    const d = await r.json();
    return { ok: true, results: Array.isArray(d.results) ? d.results : [] };
  } catch {
    return { ok: false, results: null };
  }
}
