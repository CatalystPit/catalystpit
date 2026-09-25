'use client';
import { useEffect, useRef, useState } from 'react';
import { C, TickerLogo } from '../../lib/cp-shared';

// THE TERMINAL'S NEWS INSPECTOR.
//
// ── ⚠️ THE SAME SOURCE AS THE BADGE THAT OPENS IT ───────────────────────────
//
// The Watchlist NEWS badge means one specific thing — a fresh 8-K in the last 24 hours, from
// eightk_filings — and this panel reads that same table through the same /api/eightk route and the
// same classifyItems the site-wide wire uses. That is not a convenience: a panel opened by a badge
// must be able to show the filing that caused the badge. A separate per-ticker news source would be
// a second answer to "what happened at this company" and would drift from the indicator that
// summoned it.
//
// It ingests nothing, classifies nothing and ranks nothing. Every label below — the item
// categories, the primary label, whether a filing is material — arrived on the row.
//
// ── ⚠️ A WIDER WINDOW THAN THE BADGE, AND THAT IS NOT A CONTRADICTION ───────
//
// The badge asks "is there something new TODAY". A trader who has clicked it is asking "what has
// been going on at this company", so the panel requests a longer window and marks which items are
// recent. Showing only the last 24 hours would answer a question nobody asked and leave the panel
// empty the moment the badge aged out from under it.

/** Bounded, in-session. Small on purpose: a rotation, not a research history. */
const MAX_CACHED = 12;
const TTL_MS = 120_000;
const cache = new Map();

function cacheGet(sym, now = Date.now()) {
  const hit = cache.get(sym);
  if (!hit) return null;
  if (now - hit.at > TTL_MS) return null;
  cache.delete(sym); cache.set(sym, hit);          // LRU: a read is a use
  return hit.data;
}
function cachePut(sym, data, now = Date.now()) {
  if (!sym || !data) return;
  if (cache.has(sym)) cache.delete(sym);
  cache.set(sym, { data, at: now });
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
}

/** Exactly what the badge counts as fresh, so "NEW" here and NEWS there mean the same thing. */
const FRESH_MS = 24 * 60 * 60 * 1000;

function ago(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const m = Math.max(0, Math.round((now - t) / 60000));
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d}d ago` : new Date(t).toISOString().slice(0, 10);
}

function Item({ n }) {
  const fresh = Date.now() - Date.parse(n.filedAt) < FRESH_MS;
  const labels = Array.isArray(n.items) ? n.items : [];
  return (
    <div style={{ padding: '8px 0', borderTop: `1px solid ${C.border}` }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
        {/* ⚠️ THE ITEM CATEGORY IS THE HEADLINE. An 8-K has no publisher headline; what it has is
            the SEC item it was filed under, which classifyItems already turned into a phrase. Any
            sentence written here instead would be this panel inventing an interpretation. */}
        <span style={{ fontSize: 12, fontWeight: 700, color: C.ink, lineHeight: 1.35 }}>
          {n.primaryLabel || labels[0] || '8-K filing'}
        </span>
        {fresh && (
          <span style={{ fontSize: 8, fontWeight: 800, color: C.green, background: C.greenLight,
            borderRadius: 3, padding: '1px 4px' }}>NEW</span>
        )}
        {n.material === false && (
          <span style={{ fontSize: 8.5, color: C.dim, letterSpacing: '0.3px' }}>routine</span>
        )}
      </div>
      {labels.length > 1 && (
        <div style={{ fontSize: 10.5, color: C.muted, marginTop: 2, lineHeight: 1.4 }}>
          {labels.slice(1, 4).join(' · ')}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
        <span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 9.5, color: C.dim }}>
          SEC 8-K · {ago(n.filedAt)}
        </span>
        {/* WHERE TO VERIFY IT — the filing itself, never our summary of it. */}
        {n.url && (
          <a href={n.url} target="_blank" rel="noopener noreferrer"
            style={{ fontSize: 10, fontWeight: 700, color: C.green, textDecoration: 'none' }}>Filing →</a>
        )}
      </div>
    </div>
  );
}

export default function NewsPanel({ symbol }) {
  const [data, setData] = useState(null);
  const [state, setState] = useState('idle');       // idle | loading | ready | error
  const reqRef = useRef(0);

  useEffect(() => {
    const sym = symbol ? String(symbol).toUpperCase() : null;
    if (!sym) { setData(null); setState('idle'); return undefined; }

    // ⚠️ KEYED BY SYMBOL, so a hit is by definition this ticker's news; a miss CLEARS rather than
    // leaving the previous ticker's stories on screen under the new name.
    const cached = cacheGet(sym);
    if (cached) { setData(cached); setState('ready'); } else { setData(null); setState('loading'); }

    let alive = true;
    const gen = ++reqRef.current;
    (async () => {
      try {
        const r = await fetch(`/api/eightk?ticker=${encodeURIComponent(sym)}&limit=25`,
          { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
        const j = await r.json().catch(() => null);
        // ⚠️ A NEWER SELECTION WINS. MSTR then NVDA two seconds apart leaves both in flight and they
        // resolve in whatever order the network decides.
        if (!alive || gen !== reqRef.current) return;
        if (!r.ok || !j) { if (!cached) setState('error'); return; }
        const payload = { ticker: String(j.ticker || sym).toUpperCase(), list: Array.isArray(j.list) ? j.list : [] };
        cachePut(sym, payload);
        setData(payload);
        setState('ready');
      } catch {
        if (alive && gen === reqRef.current && !cached) setState('error');
      }
    })();
    return () => { alive = false; };
  }, [symbol]);

  const sym = symbol ? String(symbol).toUpperCase() : null;
  // ⚠️ THE SECOND GUARD, AND THE ONE THAT COVERS THE RENDER. Even with the request race handled, a
  // payload for the previous ticker must not be painted under this ticker's name for one frame.
  const shown = data && data.ticker === sym ? data : null;
  const list = shown?.list || [];
  // The company name as the canonical filing carries it — not a name this panel decided on.
  const company = list.find((n) => n.company)?.company || null;

  if (!sym) {
    return (
      <div style={{ padding: 16, fontSize: 12, color: C.dim, lineHeight: 1.5 }}>
        Click the <b style={{ color: C.muted }}>NEWS</b> badge on any Watchlist ticker to read what was filed — without leaving the Terminal.
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '10px 12px 14px', fontFamily: "'DM Sans',sans-serif" }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 2 }}>
        <TickerLogo symbol={sym} size={20} />
        <span className="cp-tkr" style={{ fontSize: 15, fontWeight: 700, color: C.ink }}>{sym}</span>
        <span style={{ fontSize: 8.5, fontWeight: 800, color: C.green, background: C.greenLight,
          borderRadius: 3, padding: '1px 5px', letterSpacing: '0.5px' }}>NEWS</span>
        {/* ⚠️ LEAVING THE TERMINAL STAYS A DELIBERATE CLICK — the whole point of the inspector. */}
        <a href={`/ticker/${encodeURIComponent(sym)}#news`} target="_blank" rel="noopener noreferrer"
          style={{ marginLeft: 'auto', fontSize: 10.5, fontWeight: 700, color: C.green, textDecoration: 'none', whiteSpace: 'nowrap' }}>
          Open full ticker news →
        </a>
      </div>
      {company && (
        <div style={{ fontSize: 11, color: C.muted, marginBottom: 6, lineHeight: 1.3 }}>{company}</div>
      )}

      {state === 'loading' && !shown && (
        <div style={{ fontSize: 12, color: C.dim, padding: '12px 0' }}>Loading news for {sym}…</div>
      )}
      {state === 'error' && !shown && (
        <div style={{ fontSize: 12, color: C.muted, padding: '12px 0', lineHeight: 1.5 }}>
          News for {sym} is unavailable right now. This is not a statement that there is none.
        </div>
      )}
      {shown && list.length === 0 && (
        // ⚠️ "NOTHING FILED" IS NOT "NOTHING HAPPENED". The badge is 8-K based; a company can move
        // on something that was never an 8-K, and this must not be read as saying otherwise.
        <div style={{ fontSize: 12, color: C.muted, padding: '12px 0', lineHeight: 1.5 }}>
          No 8-K filings for {sym} in the recent window. Other news may exist that was not filed as an 8-K.
        </div>
      )}
      {/* Newest first — the order the canonical read already returns them in. */}
      {list.map((n) => <Item key={n.accession || `${n.ticker}-${n.filedAt}`} n={n} />)}
    </div>
  );
}
