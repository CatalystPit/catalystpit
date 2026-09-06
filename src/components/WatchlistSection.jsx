'use client';
import { useState, useEffect } from 'react';
import { C, Skel, TickerLogo } from '../lib/cp-shared';
import { estimateNextEarnings } from '../lib/earnings-estimate';

const usd = (n) => (n == null || isNaN(n)) ? '—' : `$${Number(n).toFixed(2)}`;
const pct = (n) => (n == null || isNaN(n)) ? null : `${n >= 0 ? '+' : ''}${Number(n).toFixed(2)}%`;

// 'YYYY-MM-DD...' / ISO → "Apr 27, 2026". UTC-pinned so the date never drifts.
const fmtAdded = (s) => {
  if (!s) return '';
  const d = new Date(s);
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

const MiniLabel = ({ children }) => (
  <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 8, color: C.dim, letterSpacing: '0.5px', marginBottom: 3 }}>{children}</div>
);

function Row({ item, onRemove, removing }) {
  const pending = item.price === undefined;   // price + last Form 4 resolve together (?prices=1)
  const change = pct(item.changePct);
  const up = (item.changePct ?? 0) >= 0;
  const f4 = item.lastForm4;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px',
      borderBottom: `1px solid ${C.border}`, opacity: removing ? 0.45 : 1,
      transition: 'opacity 0.15s',
    }}>
      <a href={`/ticker/${encodeURIComponent(item.ticker)}`} style={{
        flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10,
        textDecoration: 'none',
      }}>
        <TickerLogo symbol={item.ticker} size={22} />
        <span className="cp-tkr" style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 16, fontWeight: 700, color: C.green }}>
          {item.ticker}
        </span>
        <span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 11, color: C.dim }}>
          Added {fmtAdded(item.added_at)}
        </span>
      </a>

      {/* LAST FORM 4 (P/S code · filing date) */}
      <div style={{ width: 116, textAlign: 'right', flexShrink: 0 }}>
        <MiniLabel>LAST FORM 4</MiniLabel>
        {pending ? <Skel w={76} h={12} mb={0} />
          : f4 ? (
            <span className="cp-num" style={{
              fontFamily: "'DM Sans',sans-serif", fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 4, whiteSpace: 'nowrap',
              background: f4.action === 'BUY' ? C.greenLight : C.redLight,
              color: f4.action === 'BUY' ? C.green : C.red,
            }}>{(f4.code || (f4.action === 'BUY' ? 'P' : 'S'))} · {fmtAdded(f4.date)}</span>
          ) : <span style={{ fontSize: 11, color: C.dim }}>—</span>}
      </div>

      {/* NEXT EARNINGS (SEC-cadence estimate, filled lazily) */}
      <div style={{ width: 92, textAlign: 'right', flexShrink: 0 }}>
        <MiniLabel>NEXT EARN · EST</MiniLabel>
        {item.nextEarnings === undefined ? <Skel w={58} h={12} mb={0} />
          : item.nextEarnings ? <span className="cp-num" style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 11, color: C.text, whiteSpace: 'nowrap' }}>{fmtAdded(item.nextEarnings)}</span>
          : <span style={{ fontSize: 11, color: C.dim }}>—</span>}
      </div>

      {/* PRICE */}
      <div style={{ width: 96, textAlign: 'right', flexShrink: 0 }}>
        <MiniLabel>PRICE</MiniLabel>
        {pending ? <Skel w={76} h={12} mb={0} /> : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
            <span className="cp-num" style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 14, fontWeight: 600, color: C.ink, whiteSpace: 'nowrap' }}>{usd(item.price)}</span>
            {change && (
              <span className="cp-num" style={{
                fontFamily: "'DM Sans',sans-serif", fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap',
                color: up ? C.green : C.red, background: up ? C.greenLight : C.redLight,
                padding: '2px 6px', borderRadius: 4,
              }}>{change}</span>
            )}
          </div>
        )}
      </div>

      <button
        onClick={() => onRemove(item.ticker)}
        disabled={removing}
        title={`Remove ${item.ticker} from watchlist`}
        aria-label={`Remove ${item.ticker} from watchlist`}
        style={{
          background: 'transparent', border: `1px solid ${C.border}`, color: C.muted,
          borderRadius: 5, width: 28, height: 28, cursor: removing ? 'default' : 'pointer',
          fontSize: 14, lineHeight: 1, flexShrink: 0, fontFamily: "'DM Sans',sans-serif",
        }}
        onMouseEnter={e => { if (!removing) { e.currentTarget.style.borderColor = C.red; e.currentTarget.style.color = C.red; } }}
        onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.color = C.muted; }}
      >
        ✕
      </button>
    </div>
  );
}

export default function WatchlistSection() {
  const [list, setList] = useState(null);   // null = loading; [] = empty; [...] = loaded
  const [error, setError] = useState(false);
  const [removing, setRemoving] = useState({});  // ticker -> true while its DELETE is in flight

  // Two-phase load: bare list first (rows render instantly with the price column
  // in a loading state), then ?prices=1 to resolve each price. A row's price is
  // `undefined` while pending, then number | null once resolved — so cold-cache
  // latency reads as "loading prices" rather than a blank/"—" slot.
  useEffect(() => {
    let alive = true;
    (async () => {
      let tickers = [];
      let proceed = false;
      try {
        const r = await fetch('/api/watchlist');            // phase 1: bare {ticker, added_at}
        const bare = r.ok ? await r.json() : null;
        if (alive) {
          if (Array.isArray(bare)) { setList(bare); tickers = bare.map(x => x.ticker); proceed = bare.length > 0; }
          else { setList([]); setError(true); }
        }
      } catch {
        if (alive) { setList([]); setError(true); }
      }
      if (!alive || !proceed) return;

      // phase 2: prices + last Form 4 (one enriched call)
      try {
        const r = await fetch('/api/watchlist?prices=1');
        const priced = r.ok ? await r.json() : null;
        if (alive && Array.isArray(priced)) setList(priced);
        else if (alive) setList(prev => (prev || []).map(x => x.price === undefined ? { ...x, price: null } : x));
      } catch {
        // Phase-2 failure → resolve pending rows to "—" so they don't shimmer forever.
        if (alive) setList(prev => (prev || []).map(x => x.price === undefined ? { ...x, price: null } : x));
      }

      // phase 3: next-earnings estimate per ticker (lazy; /api/earnings is KV-cached 24h)
      await Promise.all(tickers.map(async (t) => {
        let est = null;
        try {
          const er = await fetch(`/api/earnings?ticker=${encodeURIComponent(t)}`);
          const ej = er.ok ? await er.json() : null;
          est = estimateNextEarnings(ej?.earnings || []);
        } catch { est = null; }
        if (alive) setList(prev => (prev || []).map(x => x.ticker === t ? { ...x, nextEarnings: est } : x));
      }));
    })();
    return () => { alive = false; };
  }, []);

  async function remove(ticker) {
    setRemoving(m => ({ ...m, [ticker]: true }));
    try {
      const r = await fetch('/api/watchlist', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker }),
      });
      if (r.ok) {
        const updated = await r.json();   // DELETE returns the updated list (bare shape)
        // Preserve prices from current state — the bare list has no price fields.
        setList(prev => {
          const priceBy = new Map((prev || []).map(x => [x.ticker, x]));
          return Array.isArray(updated) ? updated.map(u => priceBy.get(u.ticker) ?? u) : prev;
        });
      } else {
        setRemoving(m => { const n = { ...m }; delete n[ticker]; return n; });
      }
    } catch {
      setRemoving(m => { const n = { ...m }; delete n[ticker]; return n; });
    }
  }

  return (
    <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
      <div style={{
        padding: '14px 16px', borderBottom: `1px solid ${C.border}`, background: C.surface,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 14, fontWeight: 700, color: C.ink }}>
          Watchlist
        </span>
        {Array.isArray(list) && list.length > 0 && (
          <span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 11, color: C.muted }}>
            {list.length} {list.length === 1 ? 'ticker' : 'tickers'}
          </span>
        )}
      </div>

      {list === null ? (
        <div style={{ padding: '28px 16px', textAlign: 'center', color: C.muted, fontSize: 13, fontFamily: "'DM Sans',sans-serif" }}>
          Loading…
        </div>
      ) : list.length === 0 ? (
        <div style={{ padding: '36px 16px', textAlign: 'center', fontFamily: "'DM Sans',sans-serif" }}>
          <div style={{ fontSize: 22, marginBottom: 8 }}>☆</div>
          <div style={{ fontSize: 14, color: C.ink, fontWeight: 600, marginBottom: 4 }}>
            No tickers in your watchlist yet
          </div>
          <div style={{ fontSize: 12, color: C.muted, fontWeight: 300 }}>
            {error
              ? 'Couldn’t load your watchlist. Refresh to try again.'
              : 'Add tickers from any stock page using the ☆ Watchlist button.'}
          </div>
        </div>
      ) : (
        <div>
          {list.map(item => (
            <Row key={item.ticker} item={item} onRemove={remove} removing={!!removing[item.ticker]} />
          ))}
        </div>
      )}
    </div>
  );
}
