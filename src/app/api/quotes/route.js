export const runtime = 'nodejs';
export const maxDuration = 15;

// Batch delayed quotes for a set of tickers — cache-first (shared KV quote cache), then a bounded
// live Finnhub fill for misses (write-through). Used by the screener to price the VISIBLE page on
// demand (like the ticker page prices one), instead of pre-pricing the whole universe.
const FINNHUB_KEY = process.env.FINNHUB_KEY;
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TICKER_RE = /^[A-Z0-9.\-]{1,10}$/;
const MAX_LIVE = 45;                 // bounded live fetches per request (keeps under Finnhub 60/min)
const qKey = (s) => `catalystpit:ticker:${s}:quote`;

async function kvGet(t) {
  if (!KV_URL || !KV_TOKEN) return null;
  try { const r = await fetch(`${KV_URL}/get/${encodeURIComponent(qKey(t))}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } }); if (!r.ok) return null; const d = await r.json(); if (!d.result) return null; const q = JSON.parse(d.result); return (q && q.c) ? q : null; } catch { return null; }
}
async function kvSet(t, q) {
  if (!KV_URL || !KV_TOKEN) return;
  try { await fetch(`${KV_URL}/set/${encodeURIComponent(qKey(t))}?ex=300`, { method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'text/plain' }, body: JSON.stringify(q) }); } catch { /* non-fatal */ }
}

export async function GET(request) {
  const raw = (new URL(request.url).searchParams.get('symbols') || '').toUpperCase();
  const syms = [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => TICKER_RE.test(s)))].slice(0, 80);
  if (!syms.length) return Response.json({}, { headers: { 'Cache-Control': 'private, no-store' } });

  const out = {};
  // 1) shared-cache reads (parallel, cheap)
  const cached = await Promise.all(syms.map(kvGet));
  const miss = [];
  syms.forEach((s, i) => { const q = cached[i]; if (q) out[s] = { price: q.c, changePct: q.dp ?? null }; else miss.push(s); });

  // 2) bounded live fill for misses → write-through
  if (FINNHUB_KEY && miss.length) {
    for (const s of miss.slice(0, MAX_LIVE)) {
      try {
        const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(s)}&token=${FINNHUB_KEY}`, { cache: 'no-store', signal: AbortSignal.timeout(4000) });
        if (r.ok) { const q = await r.json(); if (q && q.c) { out[s] = { price: q.c, changePct: q.dp ?? null }; kvSet(s, { c: q.c, d: q.d ?? null, dp: q.dp ?? null, h: q.h ?? null, l: q.l ?? null, o: q.o ?? null, pc: q.pc ?? null }); } }
      } catch { /* skip */ }
    }
  }
  return Response.json(out, { headers: { 'Cache-Control': 'private, no-store' } });
}
