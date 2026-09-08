'use client';

import { useEffect, useState } from 'react';
import { C, BrandStyles, TopNav, Footer, TickerLogo, startCheckout } from '../../lib/cp-shared';

const fmtTime = (d, t) => {
  if (!t) return '—';
  // Nasdaq feed times are ET; show HH:MM (drop seconds) with an ET tag.
  const hhmm = String(t).slice(0, 5);
  return `${hhmm} ET`;
};

function HaltScanner() {
  const [halts, setHalts] = useState(null);
  const [asOf, setAsOf] = useState(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch('/api/halts', { cache: 'no-store' });
        const j = r.ok ? await r.json() : null;
        if (!alive) return;
        setHalts(j?.halts || []);
        setAsOf(j?.asOf || null);
      } catch { if (alive) setHalts([]); }
    };
    load();
    const id = setInterval(load, 45000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  return (
    <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '12px 16px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: C.red, display: 'inline-block' }} />
        <span style={{ fontSize: 14, fontWeight: 700, color: C.ink }}>Halt Scanner</span>
        <span style={{ fontSize: 10, color: C.dim, letterSpacing: 0.5 }}>US EXCHANGES · LIVE</span>
        <span style={{ marginLeft: 'auto', fontSize: 10, color: C.dim }}>
          {asOf ? `updated ${new Date(asOf).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}
        </span>
      </div>

      <div style={{ maxHeight: 560, overflowY: 'auto' }}>
        {halts === null ? (
          <div style={{ padding: 30, textAlign: 'center', color: C.dim, fontSize: 13 }}>Loading halts…</div>
        ) : halts.length === 0 ? (
          <div style={{ padding: '40px 20px', textAlign: 'center', color: C.muted, fontSize: 13 }}>
            No trading halts reported yet today. This lights up the moment a stock halts.
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: C.surface }}>
                {['Symbol', 'Reason', 'Halted', 'Resume', 'Status'].map((h, i) => (
                  <th key={h} style={{ textAlign: i === 0 ? 'left' : 'left', padding: '8px 14px', fontSize: 10, color: C.muted, letterSpacing: 0.5, fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {halts.map((h, i) => (
                <tr key={`${h.symbol}-${h.haltTime}-${i}`} style={{ borderTop: `1px solid ${C.surface}` }}>
                  <td style={{ padding: '9px 14px' }}>
                    <a href={`/ticker/${encodeURIComponent(h.symbol)}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, textDecoration: 'none' }}>
                      <TickerLogo symbol={h.symbol} size={18} />
                      <span className="cp-tkr" style={{ color: C.ink, fontWeight: 700 }}>{h.symbol}</span>
                    </a>
                    {h.name && <div style={{ fontSize: 10, color: C.dim, marginTop: 1, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.name}</div>}
                  </td>
                  <td style={{ padding: '9px 14px', color: C.text }}>{h.reason}{h.market ? <span style={{ color: C.dim }}> · {h.market}</span> : null}</td>
                  <td className="cp-num" style={{ padding: '9px 14px', color: C.muted, whiteSpace: 'nowrap' }}>{fmtTime(h.haltDate, h.haltTime)}</td>
                  <td className="cp-num" style={{ padding: '9px 14px', color: C.muted, whiteSpace: 'nowrap' }}>{h.resumed ? fmtTime(h.resumeDate, h.resumeTrade) : '—'}</td>
                  <td style={{ padding: '9px 14px' }}>
                    <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
                      color: h.resumed ? C.green : C.red, background: h.resumed ? C.greenLight : C.redLight }}>
                      {h.resumed ? 'Resumed' : 'Halted'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function MoversPlaceholder() {
  return (
    <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '12px 16px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: C.green, display: 'inline-block' }} />
        <span style={{ fontSize: 14, fontWeight: 700, color: C.ink }}>Movers</span>
        <span style={{ fontSize: 10, color: C.dim, letterSpacing: 0.5 }}>COMING SOON</span>
      </div>
      <div style={{ padding: '40px 20px', textAlign: 'center', color: C.muted, fontSize: 13 }}>
        Top gainers, losers, and unusual volume — landing here next.
      </div>
    </div>
  );
}

export default function TerminalClient() {
  const [tier, setTier] = useState(null);   // null = loading
  const [admin, setAdmin] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [p, a] = await Promise.all([
          fetch('/api/me/plan', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
          fetch('/api/me/admin', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        ]);
        setTier(p?.tier || 'free');
        setAdmin(!!a?.admin);
      } catch { setTier('free'); }
    })();
  }, []);

  const isPro = tier === 'pro' || tier === 'elite' || admin;

  return (
    <div style={{ fontFamily: "'DM Sans',sans-serif", background: C.bg, color: C.text, minHeight: '100vh' }}>
      <BrandStyles />
      <TopNav active="Terminal" />
      <div style={{ maxWidth: 1380, margin: '20px auto', padding: '0 20px 48px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
          <h1 style={{ fontFamily: "'Cormorant Garamond',serif", fontSize: 30, fontWeight: 600, color: C.ink, margin: 0 }}>Terminal</h1>
          <span style={{ fontSize: 10, fontWeight: 800, color: '#fff', background: '#B8860B', borderRadius: 3, padding: '2px 6px', letterSpacing: 0.5 }}>PRO</span>
        </div>
        <p style={{ fontSize: 13, color: C.muted, margin: '0 0 18px', fontWeight: 300 }}>
          Live scanners for active traders — halts now, movers and catalysts next.
        </p>

        {tier === null ? (
          <div style={{ color: C.dim, fontSize: 13, padding: 40, textAlign: 'center' }}>Loading…</div>
        ) : !isPro ? (
          <div style={{ background: C.white, border: `1px solid ${C.greenBorder}`, borderRadius: 10, padding: '40px 24px', textAlign: 'center' }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: C.ink, marginBottom: 8 }}>The Terminal is a Pro feature</div>
            <div style={{ fontSize: 14, color: C.muted, marginBottom: 18, maxWidth: 440, margin: '0 auto 18px' }}>
              Live halt scanner, movers, and catalyst tools built for active traders. Upgrade to unlock the full dashboard.
            </div>
            <button onClick={() => startCheckout()}
              style={{ background: C.green, color: '#fff', border: 'none', borderRadius: 6, padding: '12px 26px', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>
              Start Pro — $12/mo
            </button>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)', gap: 16, alignItems: 'start' }} className="term-grid">
            <HaltScanner />
            <MoversPlaceholder />
          </div>
        )}
      </div>
      <Footer />
      <style>{`@media (max-width: 900px){ .term-grid{ grid-template-columns: 1fr !important; } }`}</style>
    </div>
  );
}
