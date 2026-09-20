'use client';

import { useEffect, useState } from 'react';
import ErrorState from '../../components/ErrorState';
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

/**
 * A row that has not arrived yet, at exactly the size of one that has.
 *
 * Built from the same padding, gaps and element sizes as `Row` below, so the board does not jump
 * when the data lands. It is deliberately a dimmed outline of the real thing — rank, logo, ticker,
 * two badges, score — rather than a spinner, because the shape tells you what is coming.
 *
 * This exists because the board used to show a single centred line of text on an otherwise empty
 * page, which reads as broken. It is NOT the fix for slowness; the roll-up behind it was moved to
 * ingestion. This is what honest waiting looks like for the ~300 ms that remain.
 */
function SkeletonRow() {
  const bar = (w, h = 10) => (
    <span style={{ display: 'inline-block', width: w, height: h, borderRadius: 4, background: C.surface }} />
  );
  return (
    <div aria-hidden="true" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '13px 16px', background: C.white, border: `1px solid ${C.border}`, borderRadius: 10 }}>
      <div style={{ width: 22, display: 'flex', justifyContent: 'center' }}>{bar(10)}</div>
      <span style={{ width: 30, height: 30, borderRadius: '50%', background: C.surface, flexShrink: 0 }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 }}>
          {bar(52, 12)}{bar(64, 12)}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>{bar(128, 18)}{bar(104, 18)}</div>
      </div>
      <div style={{ textAlign: 'right' }}>{bar(30, 18)}</div>
    </div>
  );
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
      {/* THE COUNT OF ALIGNED FAMILIES, NOT A SCORE.
          This slot used to show a 0-100 "CONFLUENCE" figure built as
          (execs*20 + value/250k*20 + members*25 + netFunds*18) / 3, multiplied by 1.6 or 2.4.
          None of those constants was validated and no part of the result could be explained to the
          person reading it — while the badges to the left already state the actual facts.
          How many independent families line up is a fact; 73 was not. */}
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div className="cp-num" style={{ fontSize: 20, fontWeight: 800, color: tone === 'bull' ? C.green : C.red }}>
          {r.signals}
        </div>
        <div style={{ fontSize: 8, color: C.dim, letterSpacing: '0.5px' }}>
          {r.signals === 1 ? 'FAMILY' : 'FAMILIES'}
        </div>
      </div>
    </a>
  );
}

export default function ConsensusClient() {
  const [dir, setDir] = useState('bull');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  // A non-2xx or a thrown fetch is a LOAD FAILURE. A 200 carrying an empty list is a real answer —
  // no names cleared the confluence bar today — and keeps the existing empty state.
  const [loadError, setLoadError] = useState(false);
  const [reloadAt, setReloadAt] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const r = await fetch(`/api/confluence?dir=${dir}`, { cache: 'no-store' });
        if (!r.ok) throw new Error('bad status');
        const j = await r.json();
        if (alive) { setData(j); setLoadError(false); }
      } catch { if (alive) { setData(null); setLoadError(true); } }
      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
  }, [dir, reloadAt]);

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

        {loadError && !loading ? (
          <ErrorState
            title="Couldn't load Pit Consensus"
            message="The confluence board didn't come back. This is a loading problem, not an empty board."
            onRetry={() => setReloadAt((n) => n + 1)}
          />
        ) : loading ? (
          // The board's own shape, at its own size, so nothing moves when the rows arrive.
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} aria-busy="true" aria-live="polite">
            {/* Announced to a screen reader, invisible on screen — the skeleton is aria-hidden. */}
            <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>
              Loading the confluence board
            </span>
            {Array.from({ length: 5 }, (_, i) => <SkeletonRow key={i} />)}
          </div>
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
