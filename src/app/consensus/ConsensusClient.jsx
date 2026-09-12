'use client';

import { useEffect, useState } from 'react';
import { C, BrandStyles, TopNav, Footer, TickerLogo, startCheckout } from '../../lib/cp-shared';

const money = (v) => {
  if (v == null || isNaN(v)) return '—';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${Math.round(v)}`;
};

function Badge({ children, tone }) {
  const bg = tone === 'bull' ? C.greenLight : tone === 'bear' ? C.redLight : C.surface;
  const fg = tone === 'bull' ? C.green : tone === 'bear' ? C.red : C.muted;
  return <span style={{ fontSize: 11, fontWeight: 600, color: fg, background: bg, border: `1px solid ${tone === 'bull' ? C.greenBorder : tone === 'bear' ? '#E4B4B4' : C.border}`, borderRadius: 5, padding: '3px 8px' }}>{children}</span>;
}

function Row({ r, dir, rank }) {
  const tone = dir === 'bear' ? 'bear' : 'bull';
  return (
    <a href={`/ticker/${encodeURIComponent(r.ticker)}`} className="card-hov"
      style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '13px 16px', background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, textDecoration: 'none' }}>
      <div className="cp-num" style={{ width: 22, textAlign: 'center', fontSize: 13, fontWeight: 700, color: C.dim }}>{rank}</div>
      <TickerLogo symbol={r.ticker} size={30} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
          <span className="cp-tkr" style={{ fontSize: 15, fontWeight: 800, color: C.ink }}>{r.ticker}</span>
          <span style={{ fontSize: 10, fontWeight: 700, color: tone === 'bull' ? C.green : C.red, background: tone === 'bull' ? C.greenLight : C.redLight, borderRadius: 4, padding: '1px 6px' }}>
            {r.signals}/3 SIGNALS
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {r.insider && <Badge tone={tone}>🏦 {r.insider.execs} insider{r.insider.execs > 1 ? 's' : ''} {dir === 'bear' ? 'sold' : 'bought'} {money(r.insider.val)}</Badge>}
          {r.congress && <Badge tone={tone}>🏛️ {r.congress.members} in Congress {money(r.congress.val)}</Badge>}
          {r.fund && <Badge tone={tone}>🏢 {r.fund.net} fund{r.fund.net > 1 ? 's' : ''} {dir === 'bear' ? 'reducing' : 'adding'}</Badge>}
        </div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div className="cp-num" style={{ fontSize: 20, fontWeight: 800, color: tone === 'bull' ? C.green : C.red }}>{r.score}</div>
        <div style={{ fontSize: 8, color: C.dim, letterSpacing: '0.5px' }}>CONFLUENCE</div>
      </div>
    </a>
  );
}

export default function ConsensusClient() {
  const [dir, setDir] = useState('bull');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      try { const r = await fetch(`/api/confluence?dir=${dir}`, { cache: 'no-store' }); const j = r.ok ? await r.json() : null; if (alive) setData(j); }
      catch { if (alive) setData({ list: [], lockedCount: 0 }); }
      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
  }, [dir]);

  const Tab = ({ id, label }) => (
    <button onClick={() => setDir(id)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '6px 2px', fontSize: 14, fontWeight: dir === id ? 700 : 500, color: dir === id ? C.ink : C.muted, borderBottom: dir === id ? `2px solid ${id === 'bear' ? C.red : C.green}` : '2px solid transparent', fontFamily: "'DM Sans',sans-serif" }}>{label}</button>
  );

  const list = data?.list || [];
  const locked = data?.lockedCount || 0;

  return (
    <div style={{ fontFamily: "'DM Sans',sans-serif", background: C.bg, color: C.text, minHeight: '100vh' }}>
      <BrandStyles />
      <TopNav active="Pit Consensus" />
      <div style={{ maxWidth: 820, margin: '22px auto', padding: '0 20px 48px' }}>
        <h1 style={{ fontFamily: "'Cormorant Garamond',serif", fontSize: 30, fontWeight: 600, color: C.ink, margin: '0 0 2px' }}>Pit Consensus</h1>
        <p style={{ fontSize: 13, color: C.muted, margin: '0 0 14px', fontWeight: 300 }}>
          Where smart money stacks. These are names insiders, Congress, and hedge funds are {dir === 'bear' ? 'all selling' : 'all buying'} at once. Two or more aligned signals to make the board.
        </p>

        <div style={{ display: 'flex', gap: 20, borderBottom: `1px solid ${C.border}`, marginBottom: 16 }}>
          <Tab id="bull" label="📈 Accumulation" />
          <Tab id="bear" label="📉 Distribution" />
        </div>

        {loading ? (
          <div style={{ color: C.dim, fontSize: 13, padding: 30, textAlign: 'center' }}>Scanning insiders · Congress · 13F…</div>
        ) : list.length === 0 ? (
          <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: '40px 20px', textAlign: 'center', color: C.muted, fontSize: 13 }}>
            No confluence right now. No names have two or more aligned {dir === 'bear' ? 'selling' : 'buying'} signals in the last 90 days.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {list.map((r, i) => <Row key={r.ticker} r={r} dir={dir} rank={i + 1} />)}

            {locked > 0 && (
              <div style={{ position: 'relative', marginTop: 2 }}>
                <div style={{ filter: 'blur(5px)', pointerEvents: 'none', display: 'flex', flexDirection: 'column', gap: 10 }} aria-hidden="true">
                  {Array.from({ length: Math.min(locked, 4) }).map((_, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '13px 16px', background: C.white, border: `1px solid ${C.border}`, borderRadius: 10 }}>
                      <div style={{ width: 30, height: 30, borderRadius: '50%', background: C.surface2 }} />
                      <div style={{ flex: 1 }}><div style={{ height: 12, width: '40%', background: C.surface2, borderRadius: 4, marginBottom: 8 }} /><div style={{ height: 10, width: '70%', background: C.surface2, borderRadius: 4 }} /></div>
                      <div style={{ width: 34, height: 20, background: C.surface2, borderRadius: 4 }} />
                    </div>
                  ))}
                </div>
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <div style={{ background: C.white, border: `1px solid ${C.greenBorder}`, borderRadius: 10, padding: '20px 26px', textAlign: 'center', boxShadow: '0 8px 24px rgba(0,0,0,0.12)' }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: C.ink, marginBottom: 6 }}>🔒 {locked} more confluence {locked === 1 ? 'name' : 'names'}</div>
                    <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 14 }}>Unlock the full board with Pro.</div>
                    <button onClick={() => startCheckout()} style={{ background: C.green, color: '#fff', border: 'none', borderRadius: 6, padding: '10px 22px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>Unlock Pro · $12/mo</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        <div style={{ marginTop: 16, fontSize: 11, color: C.dim, lineHeight: 1.5 }}>
          Signals: insider Form 4 trades + congressional STOCK Act trades (last 90 days) + 13F quarter-over-quarter fund activity. 13F is reported up to 45 days after quarter-end. Signal aggregation, not investment advice.
        </div>
      </div>
      <Footer />
    </div>
  );
}
