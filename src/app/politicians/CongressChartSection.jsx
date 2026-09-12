'use client';
import { useEffect, useState } from 'react';
import { C } from '../../lib/cp-shared';
import CongressChart from './CongressChart';

// Ticker rail on the left, chart on the right. Selecting a ticker updates the chart in place with
// no page reload, and the selection survives switching chart periods because the period lives
// inside CongressChart while the ticker lives here.
//
// The rail surfaces where Congress is actually active rather than acting as a ticker directory,
// so it is ranked by disclosed activity and each row carries its own evidence.

const SORTS = [
  { key: 'trades', label: 'Most traded' },
  { key: 'recent', label: 'Most recent' },
  { key: 'value', label: 'Largest' },
];

const money = (n) => {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${Math.round(v / 1_000)}K`;
  return `$${Math.round(v)}`;
};

export default function CongressChartSection({ ticker, onSelectTicker }) {
  const [sort, setSort] = useState('trades');
  const [list, setList] = useState(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/congress-overview?window=3y&limit=3&tickers=24&sort=${sort}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive && j && !j.error) setList(j.tickerList || []); })
      .catch(() => { if (alive) setList([]); });
    return () => { alive = false; };
  }, [sort]);

  // Default to the busiest name so the chart is never an empty frame on first load.
  useEffect(() => {
    if (!ticker && list?.length) onSelectTicker?.(list[0].ticker);
  }, [list, ticker, onSelectTicker]);

  return (
    <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'minmax(0, 230px) minmax(0, 1fr)',
      alignItems: 'start' }} className="cp-congress-chart-grid">
      {/* ── ticker rail ── */}
      <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden',
        display: 'flex', flexDirection: 'column', maxHeight: 404 }}>
        <div style={{ padding: '9px 10px', borderBottom: `1px solid ${C.border}`, background: C.surface }}>
          <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 10, fontWeight: 700, letterSpacing: '0.8px',
            color: C.dim, textTransform: 'uppercase', marginBottom: 7 }}>Congress Activity</div>
          <div style={{ display: 'flex', gap: 4 }}>
            {SORTS.map((s) => (
              <button key={s.key} type="button" onClick={() => setSort(s.key)}
                style={{ flex: 1, background: sort === s.key ? C.green : C.white,
                  color: sort === s.key ? '#fff' : C.muted,
                  border: `1px solid ${sort === s.key ? C.green : C.border}`, borderRadius: 5,
                  padding: '4px 2px', fontSize: 9.5, fontWeight: 600, cursor: 'pointer',
                  fontFamily: "'DM Sans',sans-serif", whiteSpace: 'nowrap' }}>{s.label}</button>
            ))}
          </div>
        </div>
        <div style={{ overflowY: 'auto' }}>
          {!list ? (
            <div style={{ padding: 16, textAlign: 'center', color: C.muted, fontSize: 12 }}>Loading.</div>
          ) : !list.length ? (
            <div style={{ padding: 16, textAlign: 'center', color: C.muted, fontSize: 12 }}>No congressional activity.</div>
          ) : list.map((t) => {
            const on = ticker === t.ticker;
            return (
              <button key={t.ticker} type="button" onClick={() => onSelectTicker?.(t.ticker)} className="row-hov"
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                  padding: '7px 10px', border: 'none', cursor: 'pointer', font: 'inherit',
                  borderBottom: `1px solid ${C.surface}`,
                  borderLeft: `3px solid ${on ? C.green : 'transparent'}`,
                  background: on ? C.greenLight : 'transparent' }}>
                <span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 12.5, fontWeight: 700,
                  color: C.green, width: 54, flexShrink: 0 }}>{t.ticker}</span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 10, color: C.muted, lineHeight: 1.4 }}>
                  {t.trades} {t.trades === 1 ? 'trade' : 'trades'}
                  {' · '}{t.politicians} {t.politicians === 1 ? 'member' : 'members'}
                  <span style={{ display: 'block', color: C.dim }}>{money(t.disclosedMin)} to {money(t.disclosedMax)}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── chart ── */}
      <CongressChart ticker={ticker} onSelectTicker={onSelectTicker} />

      <style>{`
        @media (max-width: 780px) {
          .cp-congress-chart-grid { grid-template-columns: minmax(0, 1fr) !important; }
        }
      `}</style>
    </div>
  );
}
