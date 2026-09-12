'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { C, Dot, Skel, TopNav, Footer, BrandStyles, fetchKey, toArr, TickerLogo } from '../../lib/cp-shared';

// C4 — Markets = "names with catalysts today" from the pit_snapshot. NO last-sale/prices
// (compliance): this is a catalyst board (filings + Congress + headlines), not a gainers tape.
const fmtVal = (n) => {
  const v = Number(n);
  if (!v || isNaN(v)) return '—';
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toLocaleString('en-US')}`;
};
const insStyle = (t) => t === 'BUY' ? { fg: C.green, bg: C.greenLight } : t === 'SELL' ? { fg: C.red, bg: C.redLight } : { fg: C.dim, bg: C.surface };

function Card({ title, badge, children }) {
  return (
    <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
      <div style={{ padding: '10px 16px', borderBottom: `1px solid ${C.border}`, background: C.surface, display: 'flex', alignItems: 'center', gap: 7 }}>
        <Dot /><span style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>{title}</span>
        {badge && <span style={{ marginLeft: 'auto', fontFamily: "'DM Sans',sans-serif", fontSize: 9, color: C.dim, letterSpacing: '0.8px' }}>{badge}</span>}
      </div>
      {children}
    </div>
  );
}

export default function MarketsClient() {
  const router = useRouter();
  const [snap, setSnap] = useState(null);
  const [loading, setLoading] = useState(true);
  const go = (s) => { if (s && s !== '?') router.push(`/ticker/${encodeURIComponent(s)}`); };

  useEffect(() => {
    let alive = true;
    (async () => {
      const s = await fetchKey('pit_snapshot');
      if (alive) { setSnap(s && typeof s === 'object' ? s : null); setLoading(false); }
    })();
    return () => { alive = false; };
  }, []);

  const catalysts = toArr(snap?.catalysts);
  const insiders = toArr(snap?.insiders).filter(i => i.action === 'BUY');
  const congress = toArr(snap?.congress);
  const stories = toArr(snap?.stories);

  return (
    <div style={{ fontFamily: "'DM Sans',sans-serif", background: C.bg, color: C.text, minHeight: '100vh' }}>
      <BrandStyles />
      <TopNav active="Markets" />

      <div style={{ background: C.white, borderBottom: `1px solid ${C.border}`, padding: '20px 24px' }}>
        <div style={{ maxWidth: 1380, margin: '0 auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <Dot /><span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 10, color: C.muted, letterSpacing: '1px' }}>CATALYSTS · FILINGS · CONGRESS</span>
          </div>
          <h1 style={{ fontFamily: "'Cormorant Garamond',serif", fontSize: 32, fontWeight: 600, color: C.ink, margin: '0 0 4px', letterSpacing: '-0.5px' }}>Markets</h1>
          <p style={{ fontSize: 13, color: C.muted, margin: 0, fontWeight: 300 }}>What&apos;s moving by catalyst today: the names with fresh filings, Congress trades, and headlines.</p>
        </div>
      </div>

      <div style={{ maxWidth: 1380, margin: '16px auto', padding: '0 24px 40px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* CATALYSTS */}
        <Card title="TODAY'S CATALYSTS" badge="FROM FILINGS">
          <div style={{ padding: 14 }}>
            {loading ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
                {Array(4).fill(0).map((_, i) => <div key={i} style={{ background: C.surface, borderRadius: 7, padding: 14, border: `1px solid ${C.border}` }}><Skel w="60%" h={10} mb={8} /><Skel h={18} mb={6} /><Skel w="70%" h={11} mb={0} /></div>)}
              </div>
            ) : catalysts.length === 0 ? (
              <div style={{ padding: '20px 8px', textAlign: 'center', fontSize: 12, color: C.muted, fontWeight: 300 }}>No catalysts to show yet. Filings land here through the session.</div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
                {catalysts.map((c, i) => (
                  <div key={i} className="hov" onClick={() => go(c.sym)} style={{ background: C.surface, borderRadius: 7, padding: 14, border: `1px solid ${C.border}`, borderLeft: `3px solid ${insStyle(c.kind).fg}`, cursor: 'pointer' }}>
                    <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 9, color: C.dim, letterSpacing: '0.8px', marginBottom: 7 }}>{c.label}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
                      <TickerLogo symbol={c.sym} size={20} />
                      <span className="cp-tkr" style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 15, fontWeight: 700, color: C.green }}>{c.sym}</span>
                      <span style={{ fontSize: 9, padding: '2px 7px', borderRadius: 3, fontFamily: "'DM Sans',sans-serif", fontWeight: 600, background: insStyle(c.kind).bg, color: insStyle(c.kind).fg }}>{c.value}</span>
                    </div>
                    <div style={{ fontSize: 12, color: C.muted, fontWeight: 300 }}>{c.line}{c.date ? ` · ${c.date}` : ''}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>

        <div className="cp-body-grid" style={{ gap: 16 }}>
          {/* INSIDER BUYS */}
          <Card title="OPEN-MARKET INSIDER BUYS" badge="FORM 4 · SEC">
            {loading ? Array(5).fill(0).map((_, i) => <div key={i} style={{ padding: '11px 16px', borderBottom: `1px solid ${C.surface}` }}><Skel h={14} mb={0} /></div>)
              : insiders.length === 0 ? <div style={{ padding: '20px 16px', textAlign: 'center', fontSize: 12, color: C.muted }}>No open-market buys in the latest snapshot.</div>
              : insiders.map((i2, i) => (
                <div key={i} className="hov" onClick={() => go(i2.ticker)} style={{ padding: '11px 16px', borderBottom: `1px solid ${C.surface}`, cursor: 'pointer', display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                  <div style={{ minWidth: 0 }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><TickerLogo symbol={i2.ticker} size={16} /><span className="cp-tkr" style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 13, fontWeight: 700, color: C.green }}>{i2.ticker}</span></span>
                    <span style={{ fontSize: 12, color: C.muted, fontWeight: 300, marginLeft: 8 }}>{i2.executive || 'Insider'}</span>
                  </div>
                  <span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 13, fontWeight: 700, color: C.green, whiteSpace: 'nowrap' }}>{fmtVal(i2.totalValue)}</span>
                </div>
              ))}
          </Card>

          {/* CONGRESS */}
          <Card title="CONGRESS TRADES" badge="STOCK ACT">
            {loading ? Array(3).fill(0).map((_, i) => <div key={i} style={{ padding: '11px 16px', borderBottom: `1px solid ${C.surface}` }}><Skel h={14} mb={0} /></div>)
              : congress.length === 0 ? <div style={{ padding: '20px 16px', textAlign: 'center', fontSize: 12, color: C.muted }}>No Congress trades in the latest snapshot.</div>
              : congress.map((p, i) => (
                <div key={i} className="hov" onClick={() => go(p.ticker)} style={{ padding: '11px 16px', borderBottom: `1px solid ${C.surface}`, cursor: 'pointer', display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                  <div style={{ minWidth: 0 }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><TickerLogo symbol={p.ticker} size={16} /><span className="cp-tkr" style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 13, fontWeight: 700, color: C.green }}>{p.ticker || '—'}</span></span>
                    <span style={{ fontSize: 12, color: C.muted, fontWeight: 300, marginLeft: 8 }}>{p.representative}</span>
                  </div>
                  <span style={{ fontSize: 10, padding: '3px 9px', borderRadius: 3, fontFamily: "'DM Sans',sans-serif", fontWeight: 600, background: insStyle(p.action).bg, color: insStyle(p.action).fg, whiteSpace: 'nowrap' }}>{p.action}</span>
                </div>
              ))}
          </Card>
        </div>

        {/* HEADLINES */}
        {stories.length > 0 && (
          <Card title="HEADLINES">
            {stories.slice(0, 8).map((s, i) => (
              <a key={i} href={s.url || (s.ticker ? `/ticker/${s.ticker}` : '#')} target={s.url && s.url.startsWith('http') ? '_blank' : undefined} rel="noopener noreferrer"
                className="hov" style={{ display: 'block', padding: '11px 16px', borderBottom: `1px solid ${C.surface}`, textDecoration: 'none', color: 'inherit' }}>
                <div style={{ fontSize: 13, color: C.ink, fontWeight: 500 }}>{s.title || s.headline}</div>
                <div style={{ fontSize: 11, color: C.dim, marginTop: 2 }}>{s.source || 'Market News'}{s.ticker ? ` · ${s.ticker}` : ''}</div>
              </a>
            ))}
          </Card>
        )}

        <div style={{ fontSize: 11, color: C.dim, fontWeight: 300 }}>
          Catalyst board, sourced from SEC filings and STOCK Act disclosures. No last-sale prices. Not financial advice.
        </div>
      </div>

      <Footer />
    </div>
  );
}
