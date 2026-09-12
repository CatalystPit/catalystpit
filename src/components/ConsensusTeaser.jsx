'use client';

// ConsensusTeaser — homepage box surfacing the top Pit Consensus names (where insiders,
// Congress, and funds are stacking the same direction). Teaser only: top 3, linking to the
// full board at /consensus.
import { useEffect, useState } from 'react';
import { C, Dot, Skel, TickerLogo } from '../lib/cp-shared';

const money = (v) => {
  if (v == null || isNaN(v)) return '';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${Math.round(v)}`;
};

function summarize(r) {
  const parts = [];
  if (r.insider) parts.push(`${r.insider.execs} insider${r.insider.execs > 1 ? 's' : ''}`);
  if (r.congress) parts.push(`${r.congress.members} in Congress`);
  if (r.fund) parts.push(`${r.fund.net} fund${r.fund.net > 1 ? 's' : ''}`);
  return parts.join(' · ');
}

export default function ConsensusTeaser() {
  const [rows, setRows] = useState(null);   // null = loading, [] = none

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch('/api/confluence?dir=bull', { cache: 'no-store' });
        const j = r.ok ? await r.json() : null;
        if (alive) setRows((j?.list || []).slice(0, 3));
      } catch { if (alive) setRows([]); }
    })();
    return () => { alive = false; };
  }, []);

  return (
    <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
      <div style={{ padding: '10px 16px', borderBottom: `1px solid ${C.border}`, background: C.surface,
        display: 'flex', alignItems: 'center', gap: 7 }}>
        <Dot />
        <span style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>PIT CONSENSUS</span>
        <span style={{ fontSize: 9, background: C.greenLight, color: C.green, padding: '2px 7px',
          borderRadius: 3, fontFamily: "'DM Sans',sans-serif", fontWeight: 600 }}>SMART MONEY STACKING</span>
        <a href="/consensus" style={{ marginLeft: 'auto', fontSize: 11, color: C.green, textDecoration: 'none', fontWeight: 600 }}>
          Full board →
        </a>
      </div>
      <div style={{ padding: 8 }}>
        {rows == null ? (
          <div style={{ padding: 8 }}>{[0, 1, 2].map((i) => <Skel key={i} h={40} mb={i < 2 ? 8 : 0} />)}</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: '18px 8px', textAlign: 'center', fontSize: 12, color: C.muted, fontWeight: 300 }}>
            No confluence right now. This lights up when insiders, Congress, and funds line up on the same name.
          </div>
        ) : (
          rows.map((r, i) => (
            <a key={r.ticker} href={`/ticker/${encodeURIComponent(r.ticker)}`} className="hov"
              style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '9px 8px', borderRadius: 7,
                textDecoration: 'none', borderBottom: i < rows.length - 1 ? `1px solid ${C.surface}` : 'none' }}>
              <span className="cp-num" style={{ width: 16, textAlign: 'center', fontSize: 12, fontWeight: 700, color: C.dim }}>{i + 1}</span>
              <TickerLogo symbol={r.ticker} size={24} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span className="cp-tkr" style={{ fontSize: 14, fontWeight: 800, color: C.ink }}>{r.ticker}</span>
                  <span style={{ fontSize: 9, fontWeight: 700, color: C.green, background: C.greenLight, borderRadius: 3, padding: '1px 6px' }}>
                    {r.signals}/3
                  </span>
                </div>
                <div style={{ fontSize: 11, color: C.muted, fontWeight: 300, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {summarize(r)}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div className="cp-num" style={{ fontSize: 16, fontWeight: 800, color: C.green }}>{r.score}</div>
                <div style={{ fontSize: 7, color: C.dim, letterSpacing: '0.5px' }}>SCORE</div>
              </div>
            </a>
          ))
        )}
      </div>
    </div>
  );
}
