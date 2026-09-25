'use client';
import { useEffect, useRef, useState } from 'react';
import { C, TickerLogo } from '../../lib/cp-shared';
import { mergeTickerNews, isFresh, SOURCE } from '../../lib/terminal/ticker-news.mjs';

// ONE TICKER-NEWS IMPLEMENTATION. THREE PLACES USE IT.
//
//   Chart header → News      the fast inspection of the ticker being analysed
//   Watchlist    → NEWS      what happened in a watched name
//   + Add panel  → Ticker News   a persistent panel for anyone who wants one
//
// ── ⚠️ WHY THIS IS ONE COMPONENT AND NOT THREE ──────────────────────────────
//
// Three surfaces asking the same question is exactly how a product ends up with three answers. The
// chart drawer and the standalone panel differ in ONE thing — how much room they have — so that is
// the only thing this takes as a prop. Everything about what news IS for a ticker lives here once.
//
// It fetches from the existing canonical per-ticker paths and merges them in ticker-news.mjs. It
// ingests nothing, classifies nothing and ranks nothing: every headline, label and timestamp below
// arrived from an endpoint that already existed.

/** Bounded, in-session, shared by all three surfaces — so opening the same ticker twice is free. */
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

const json = async (url, signal) => {
  try {
    const r = await fetch(url, { cache: 'no-store', signal });
    return r.ok ? await r.json().catch(() => null) : null;
  } catch { return null; }
};

function ago(at, now = Date.now()) {
  if (!Number.isFinite(at)) return '';
  const m = Math.max(0, Math.round((now - at) / 60000));
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d}d ago` : new Date(at).toISOString().slice(0, 10);
}

const SOURCE_TONE = { [SOURCE.PRESS]: C.green, [SOURCE.EVIDENCE]: C.blue, [SOURCE.FILING]: C.muted };

/**
 * THE SHARED FETCH.
 *
 * ⚠️ THREE REQUESTS IN PARALLEL, AND A PARTIAL ANSWER IS STILL AN ANSWER. If the press-release
 * reader is slow or down, the filings and the evidence events still render — one path failing must
 * not blank a panel that has two working ones. Each returns null on failure and the merge simply
 * has less to merge.
 */
export function useTickerNews(symbol) {
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
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20_000);
    (async () => {
      const q = encodeURIComponent(sym);
      const [ek, evi, pr] = await Promise.all([
        json(`/api/eightk?ticker=${q}&limit=25`, ctl.signal),
        json(`/api/evidence?ticker=${q}`, ctl.signal),
        json(`/api/press-releases?ticker=${q}`, ctl.signal),
      ]);
      clearTimeout(timer);
      // ⚠️ A NEWER SELECTION WINS. MSTR then NVDA two seconds apart leaves all six requests in
      // flight and they resolve in whatever order the network decides.
      if (!alive || gen !== reqRef.current) return;
      if (!ek && !evi && !pr) { if (!cached) setState('error'); return; }
      const company = pr?.companyName || null;
      const items = mergeTickerNews({
        eightk: ek?.list || [],
        evidence: evi?.evidence || [],
        pressReleases: pr?.pressReleases || [],
        ticker: sym,
        company,
      });
      const payload = { ticker: sym, company, items };
      cachePut(sym, payload);
      setData(payload);
      setState('ready');
    })();
    return () => { alive = false; clearTimeout(timer); ctl.abort(); };
  }, [symbol]);

  const sym = symbol ? String(symbol).toUpperCase() : null;
  // ⚠️ THE SECOND GUARD, COVERING THE RENDER. Even with the request race handled, a payload for the
  // previous ticker must not be painted under this ticker's name for one frame.
  const shown = data && data.ticker === sym ? data : null;
  return { data: shown, state, symbol: sym };
}

function Item({ n, compact }) {
  const fresh = isFresh(n.at);
  return (
    <div style={{ padding: compact ? '6px 0' : '8px 0', borderTop: `1px solid ${C.border}` }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: compact ? 11.5 : 12, fontWeight: 700, color: C.ink, lineHeight: 1.35 }}>
          {n.headline}
        </span>
        {fresh && (
          <span style={{ fontSize: 8, fontWeight: 800, color: C.green, background: C.greenLight,
            borderRadius: 3, padding: '1px 4px' }}>NEW</span>
        )}
        {!n.material && <span style={{ fontSize: 8.5, color: C.dim }}>routine</span>}
      </div>
      {n.detail && (
        <div style={{ fontSize: 10.5, color: C.muted, marginTop: 2, lineHeight: 1.4 }}>{n.detail}</div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 9.5, color: SOURCE_TONE[n.source] || C.dim }}>
          {n.sourceLabel}
          {/* ⚠️ SAID, NOT IMPLIED. One disclosure can appear on two of our paths; the row names both
              rather than picking one and looking like the only place it exists. */}
          {n.alsoFrom?.length ? ` · also ${n.alsoFrom.join(' · ')}` : ''}
        </span>
        <span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 9.5, color: C.dim }}>{ago(n.at)}</span>
        {n.url && (
          <a href={n.url} target="_blank" rel="noopener noreferrer"
            style={{ fontSize: 10, fontWeight: 700, color: C.green, textDecoration: 'none' }}>Source →</a>
        )}
      </div>
    </div>
  );
}

/**
 * THE BODY EVERY SURFACE RENDERS.
 *
 * @param compact  the chart drawer, which has less room than a dedicated panel. It is the ONLY
 *                 difference between the three surfaces, which is why it is the only prop.
 */
export default function TickerNewsBody({ symbol, compact = false, onClose = null }) {
  const { data, state, symbol: sym } = useTickerNews(symbol);
  const items = data?.items || [];

  if (!sym) {
    return (
      <div style={{ padding: 16, fontSize: 12, color: C.dim, lineHeight: 1.5 }}>
        Open a ticker to read what has been filed and released — without leaving the Terminal.
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: compact ? '8px 10px 12px' : '10px 12px 14px', fontFamily: "'DM Sans',sans-serif" }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 2 }}>
        <TickerLogo symbol={sym} size={compact ? 16 : 20} />
        <span className="cp-tkr" style={{ fontSize: compact ? 13 : 15, fontWeight: 700, color: C.ink }}>{sym}</span>
        <span style={{ fontSize: 8.5, fontWeight: 800, color: C.green, background: C.greenLight,
          borderRadius: 3, padding: '1px 5px', letterSpacing: '0.5px' }}>NEWS</span>
        {/* ⚠️ LEAVING THE TERMINAL STAYS A DELIBERATE CLICK — the point of every inspector here. */}
        <a href={`/ticker/${encodeURIComponent(sym)}#news`} target="_blank" rel="noopener noreferrer"
          style={{ marginLeft: 'auto', fontSize: 10.5, fontWeight: 700, color: C.green, textDecoration: 'none', whiteSpace: 'nowrap' }}>
          {compact ? 'Full news →' : 'Open full ticker news →'}
        </a>
        {onClose && (
          <button type="button" onClick={onClose} title="Close news"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.dim, fontSize: 14, lineHeight: 1, padding: '0 2px' }}>✕</button>
        )}
      </div>
      {data?.company && (
        <div style={{ fontSize: 11, color: C.muted, marginBottom: 6, lineHeight: 1.3 }}>{data.company}</div>
      )}

      {state === 'loading' && !data && (
        <div style={{ fontSize: 12, color: C.dim, padding: '12px 0' }}>Loading news for {sym}…</div>
      )}
      {state === 'error' && !data && (
        <div style={{ fontSize: 12, color: C.muted, padding: '12px 0', lineHeight: 1.5 }}>
          News for {sym} is unavailable right now. This is not a statement that there is none.
        </div>
      )}
      {data && items.length === 0 && (
        // ⚠️ "NOTHING ON OUR PATHS" IS NOT "NOTHING HAPPENED". These are SEC-derived disclosures; a
        // company can move on something that was never filed, and this must not read otherwise.
        <div style={{ fontSize: 12, color: C.muted, padding: '12px 0', lineHeight: 1.5 }}>
          No filings or press releases for {sym} in the recent window. Other news may exist that was not filed.
        </div>
      )}
      {items.map((n) => <Item key={n.key} n={n} compact={compact} />)}
    </div>
  );
}
