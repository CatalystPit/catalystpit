'use client';

// EightKWire — live 8-K catalyst feed (SEC EDGAR). Material catalysts by default with a
// "show all" toggle. Reused on /news (card) and in the Terminal (bare panel). Polls every 60s.
import { useEffect, useState, useCallback } from 'react';
import { C, Dot, TickerLogo, timeAgo, minsSince } from '../lib/cp-shared';

function Row({ f, onPick }) {
  const mat = f.material;
  const chipBg = mat ? '#FFF6E8' : C.surface;
  const chipFg = mat ? '#7A5018' : C.muted;
  const extra = Math.max(0, (f.items?.length || 0) - 1);
  const tickerInner = (
    <>
      <TickerLogo symbol={f.ticker} size={20} />
      <span className="cp-tkr" style={{ fontSize: 13, fontWeight: 700, color: C.green }}>{f.ticker}</span>
    </>
  );
  return (
    <div className="hov" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px',
      borderLeft: `3px solid ${mat ? '#D9A441' : C.border}`, borderBottom: `1px solid ${C.surface}` }}>
      <span className="cp-num" style={{ width: 34, fontSize: 10, color: C.muted, flexShrink: 0 }}>
        {timeAgo(minsSince(f.filedAt))}
      </span>
      {onPick ? (
        // In the Terminal: load the symbol into linked chart panels instead of navigating away.
        <span onClick={() => onPick(f.ticker)} title={`Load ${f.ticker} in chart`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 7, flexShrink: 0, cursor: 'pointer' }}>
          {tickerInner}
        </span>
      ) : (
        <a href={`/ticker/${encodeURIComponent(f.ticker)}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, textDecoration: 'none', flexShrink: 0 }}>
          {tickerInner}
        </a>
      )}
      <div style={{ minWidth: 0, flex: 1, display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ fontSize: 10, fontWeight: 600, background: chipBg, color: chipFg, borderRadius: 3, padding: '2px 7px', whiteSpace: 'nowrap' }}>
          {f.primaryLabel}
        </span>
        {extra > 0 && <span style={{ fontSize: 10, color: C.muted }}>+{extra}</span>}
        <span style={{ fontSize: 11, color: C.muted, fontWeight: 300, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {f.company}
        </span>
      </div>
      {f.url && (
        <a href={f.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 10, color: C.muted, textDecoration: 'none', flexShrink: 0 }}
          onMouseEnter={(e) => (e.currentTarget.style.color = C.green)} onMouseLeave={(e) => (e.currentTarget.style.color = C.muted)}>
          SEC ↗
        </a>
      )}
    </div>
  );
}

export default function EightKWire({ bare = false, limit = 30, onPick = null }) {
  const [all, setAll] = useState(false);
  const [list, setList] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/eightk?limit=${limit}${all ? '&all=1' : ''}`, { cache: 'no-store' });
      const j = r.ok ? await r.json() : null;
      setList(j?.list || []);
    } catch { setList([]); }
  }, [all, limit]);

  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);

  const Toggle = () => (
    <div style={{ display: 'inline-flex', border: `1px solid ${C.border}`, borderRadius: 5, overflow: 'hidden' }}>
      {[['Material', false], ['All', true]].map(([label, v]) => (
        <button key={label} onClick={() => setAll(v)} style={{
          background: all === v ? C.green : C.white, color: all === v ? C.bg : C.muted,
          border: 'none', cursor: 'pointer', fontSize: 10, fontWeight: 600, padding: '3px 9px',
          fontFamily: "'DM Sans',sans-serif" }}>{label}</button>
      ))}
    </div>
  );

  const body = (
    <div style={{ overflowY: 'auto', flex: bare ? 1 : undefined, maxHeight: bare ? undefined : 420 }}>
      {list == null ? (
        <div style={{ padding: '24px 12px', textAlign: 'center', color: C.muted, fontSize: 12 }}>Loading the wire…</div>
      ) : list.length === 0 ? (
        <div style={{ padding: '24px 12px', textAlign: 'center', color: C.muted, fontSize: 12, fontWeight: 300 }}>
          No {all ? '' : 'material '}8-K filings in the last few days.
        </div>
      ) : (
        list.map((f, i) => <Row key={f.ticker + i} f={f} onPick={onPick} />)
      )}
    </div>
  );

  if (bare) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.white }}>
        <div style={{ padding: '8px 12px', borderBottom: `1px solid ${C.border}`, background: C.surface,
          display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0 }}>
          <Dot /><span style={{ fontSize: 12, fontWeight: 600, color: C.ink }}>8-K WIRE</span>
          <span style={{ marginLeft: 'auto' }}><Toggle /></span>
        </div>
        {body}
      </div>
    );
  }

  return (
    <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
      <div style={{ padding: '10px 16px', borderBottom: `1px solid ${C.border}`, background: C.surface,
        display: 'flex', alignItems: 'center', gap: 7 }}>
        <Dot />
        <span style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>8-K WIRE</span>
        <span style={{ fontSize: 9, background: '#FFF6E8', color: '#7A5018', padding: '2px 7px', borderRadius: 3,
          fontFamily: "'DM Sans',sans-serif", fontWeight: 500 }}>SEC · LIVE</span>
        <span style={{ marginLeft: 'auto' }}><Toggle /></span>
      </div>
      {body}
    </div>
  );
}
