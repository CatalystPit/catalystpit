'use client';
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { C, Dot, Skel, TopNav, Footer, BrandStyles } from '../../lib/cp-shared';

// Screener v1 (C3): a flexible scan over insider filings (our densest data), backed by
// /api/insiders row-views + the new ?days=/?minValue= params. The plan's "earnings in 14d"
// leg is deferred until a forward earnings calendar exists (same blocker as B2).
const fmtMoney = (n) => {
  const v = Number(n);
  if (!v || isNaN(v)) return '—';
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toLocaleString('en-US')}`;
};
const actionStyle = (t) => t === 'BUY' ? { fg: C.green, bg: C.greenLight } : t === 'SELL' ? { fg: C.red, bg: C.redLight } : { fg: C.dim, bg: C.surface };
const decodeEntities = (s) => typeof s !== 'string' ? s
  : s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");

const ACTIONS = [{ k: 'buying', l: 'Buys' }, { k: 'selling', l: 'Sells' }, { k: 'transactions', l: 'Both' }];
const WINDOWS = [{ k: 7, l: '7d' }, { k: 30, l: '30d' }, { k: 90, l: '90d' }];
const VALUES  = [{ k: 25000, l: '$25K+' }, { k: 100000, l: '$100K+' }, { k: 1000000, l: '$1M+' }];
const PRESETS = [
  { key: 'pit',      label: 'Pit Scan',     hint: 'open-market buys · 30d · $100K+',  view: 'buying',       days: 30,   minValue: 100000 },
  { key: 'clusters', label: 'Cluster Buys', hint: '3+ insiders · same ticker · 30d',  view: 'cluster_buys', days: null, minValue: null },
  { key: 'bigsell',  label: 'Big Sells',    hint: 'sells · 30d · $1M+',                view: 'selling',      days: 30,   minValue: 1000000 },
];

function FilterGroup({ label, opts, val, on }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 10, color: C.dim, letterSpacing: '0.5px' }}>{label.toUpperCase()}</span>
      <div style={{ display: 'flex', gap: 4 }}>
        {opts.map(o => {
          const active = o.k === val;
          return (
            <button key={o.k} onClick={() => on(o.k)}
              style={{ background: active ? C.green : C.white, color: active ? '#fff' : C.muted, border: `1px solid ${active ? C.green : C.border}`, borderRadius: 5, padding: '5px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>
              {o.l}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function ScreenerClient() {
  const router = useRouter();
  const [view, setView] = useState('buying');
  const [days, setDays] = useState(30);
  const [minValue, setMinValue] = useState(100000);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const goTicker = (s) => { if (s && s !== '?') router.push(`/ticker/${encodeURIComponent(s)}`); };
  const applyPreset = (p) => { setView(p.view); if (p.days != null) setDays(p.days); if (p.minValue != null) setMinValue(p.minValue); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const url = view === 'cluster_buys'
        ? `/api/insiders?view=cluster_buys`
        : `/api/insiders?view=${view}&days=${days}&minValue=${minValue}&limit=100`;
      const r = await fetch(url);
      const j = r.ok ? await r.json() : null;
      setData(j && !j.error ? j : null);
    } catch { setData(null); }
    finally { setLoading(false); }
  }, [view, days, minValue]);

  useEffect(() => { load(); }, [load]);

  const isCluster = data?.view === 'cluster_buys';
  const rows = Array.isArray(data?.trades) ? data.trades : [];
  const clusters = Array.isArray(data?.clusters) ? data.clusters : [];
  const lockedCount = data?.lockedCount || 0;
  const th = (label, align) => (
    <th key={label} style={{ padding: '8px 16px', textAlign: align || 'left', fontFamily: "'DM Sans',sans-serif", fontSize: 9, color: C.dim, letterSpacing: '0.8px', fontWeight: 400, whiteSpace: 'nowrap' }}>{label.toUpperCase()}</th>
  );

  return (
    <div style={{ fontFamily: "'DM Sans',sans-serif", background: C.bg, color: C.text, minHeight: '100vh' }}>
      <BrandStyles />
      <TopNav active="Screener" />

      <div style={{ background: C.white, borderBottom: `1px solid ${C.border}`, padding: '20px 24px' }}>
        <div style={{ maxWidth: 1380, margin: '0 auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <Dot /><span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 10, color: C.muted, letterSpacing: '1px' }}>FORM 4 · SEC EDGAR</span>
          </div>
          <h1 style={{ fontFamily: "'Cormorant Garamond',serif", fontSize: 32, fontWeight: 600, color: C.ink, margin: '0 0 4px', letterSpacing: '-0.5px' }}>Screener</h1>
          <p style={{ fontSize: 13, color: C.muted, margin: 0, fontWeight: 300 }}>Scan insider filings by window, size, and direction. Start with a preset, then tune.</p>
        </div>
      </div>

      <div style={{ maxWidth: 1380, margin: '0 auto', padding: '16px 24px 0', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          {PRESETS.map(p => {
            const active = p.view === view && (p.days == null || p.days === days) && (p.minValue == null || p.minValue === minValue);
            return (
              <button key={p.key} onClick={() => applyPreset(p)} className="cat"
                style={{ textAlign: 'left', background: active ? C.green : C.white, border: `1px solid ${active ? C.green : C.border}`, borderRadius: 8, padding: '12px 14px', cursor: 'pointer' }}>
                <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 12, fontWeight: 600, color: active ? '#fff' : C.ink }}>{p.label}</div>
                <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 10, marginTop: 3, color: active ? 'rgba(255,255,255,0.8)' : C.dim }}>{p.hint}</div>
              </button>
            );
          })}
        </div>

        {!isCluster && (
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            <FilterGroup label="Direction" opts={ACTIONS} val={view} on={setView} />
            <FilterGroup label="Window" opts={WINDOWS} val={days} on={setDays} />
            <FilterGroup label="Min value" opts={VALUES} val={minValue} on={setMinValue} />
          </div>
        )}

        <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 11, color: C.dim }}>
          {loading ? 'Scanning…' : isCluster ? `${clusters.length} clusters` : `${rows.length} matches`}
          <span style={{ marginLeft: 10, color: C.hint }}>· Earnings-window filter coming with the earnings calendar.</span>
        </div>
      </div>

      <div style={{ maxWidth: 1380, margin: '12px auto', padding: '0 24px 40px' }}>
        <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            {loading ? (
              <div style={{ padding: 16 }}>{Array(8).fill(0).map((_, i) => <Skel key={i} h={16} mb={10} />)}</div>
            ) : isCluster ? (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}>
                  {[['Ticker'], ['Company'], ['Buyers', 'right'], ['Trades', 'right'], ['Total $', 'right'], ['Window']].map(([h, a]) => th(h, a))}
                </tr></thead>
                <tbody>
                  {clusters.length === 0 ? (
                    <tr><td colSpan={6} style={{ padding: '40px 16px', textAlign: 'center', color: C.muted, fontSize: 13 }}>No clusters right now.</td></tr>
                  ) : clusters.map((c, i) => (
                    <tr key={i} className="hov" onClick={() => goTicker(c.ticker)} style={{ borderBottom: i < clusters.length - 1 ? `1px solid ${C.surface}` : 'none', borderLeft: `3px solid ${C.green}`, cursor: 'pointer' }}>
                      <td style={{ padding: '13px 16px', fontFamily: "'DM Sans',sans-serif", fontSize: 13, fontWeight: 700, color: C.green }}>{c.ticker}</td>
                      <td style={{ padding: '13px 16px', fontSize: 13, color: C.text, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{decodeEntities(c.company || '')}</td>
                      <td style={{ padding: '13px 16px', textAlign: 'right', fontFamily: "'DM Sans',sans-serif", fontSize: 14, fontWeight: 700, color: C.green }}>{c.buyers}</td>
                      <td style={{ padding: '13px 16px', textAlign: 'right', fontFamily: "'DM Sans',sans-serif", fontSize: 13, color: C.text }}>{c.trades}</td>
                      <td style={{ padding: '13px 16px', textAlign: 'right', fontFamily: "'DM Sans',sans-serif", fontSize: 13, fontWeight: 600, color: C.text }}>{fmtMoney(c.totalValue)}</td>
                      <td style={{ padding: '13px 16px', fontFamily: "'DM Sans',sans-serif", fontSize: 11, color: C.dim, whiteSpace: 'nowrap' }}>{c.firstBuy} → {c.lastBuy}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}>
                  {[['Traded'], ['Ticker'], ['Company'], ['Insider'], ['Type'], ['Code'], ['Value', 'right']].map(([h, a]) => th(h, a))}
                </tr></thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr><td colSpan={7} style={{ padding: '40px 16px', textAlign: 'center', color: C.muted, fontSize: 13 }}>No filings match this scan. Widen the window or lower the min value.</td></tr>
                  ) : rows.map((r, i) => {
                    const as = actionStyle(r.action);
                    return (
                      <tr key={r.id || i} className="hov" onClick={() => goTicker(r.ticker)} style={{ borderBottom: i < rows.length - 1 ? `1px solid ${C.surface}` : 'none', borderLeft: `3px solid ${as.fg}`, cursor: 'pointer' }}>
                        <td style={{ padding: '11px 16px', fontFamily: "'DM Sans',sans-serif", fontSize: 11, color: C.dim, whiteSpace: 'nowrap' }}>{r.transactionDate || r.filingDate || '—'}</td>
                        <td style={{ padding: '11px 16px', fontFamily: "'DM Sans',sans-serif", fontSize: 13, fontWeight: 700, color: C.green }}>{r.ticker}</td>
                        <td style={{ padding: '11px 16px', fontSize: 13, color: C.text, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{decodeEntities(r.company || '')}</td>
                        <td style={{ padding: '11px 16px', fontSize: 13, color: C.text }}>
                          <div>{decodeEntities(r.executive || '')}</div>
                          {r.title && <div style={{ fontSize: 11, color: C.muted, fontWeight: 300, marginTop: 2 }}>{decodeEntities(r.title)}</div>}
                        </td>
                        <td style={{ padding: '11px 16px' }}><span style={{ fontSize: 10, padding: '3px 9px', borderRadius: 3, fontFamily: "'DM Sans',sans-serif", fontWeight: 600, background: as.bg, color: as.fg }}>{r.action}</span></td>
                        <td style={{ padding: '11px 16px', fontFamily: "'DM Sans',sans-serif", fontSize: 11, color: C.muted }}>{r.transactionCode || '—'}</td>
                        <td style={{ padding: '11px 16px', textAlign: 'right', fontFamily: "'DM Sans',sans-serif", fontSize: 14, fontWeight: 700, color: as.fg, whiteSpace: 'nowrap' }}>{fmtMoney(r.totalValue)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {lockedCount > 0 && (
          <div style={{ marginTop: 12, padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', background: C.greenLight, border: `1px solid ${C.greenBorder}`, borderRadius: 8 }}>
            <span style={{ flex: 1, minWidth: 0, fontFamily: "'DM Sans',sans-serif", fontSize: 13, color: C.ink }}>🔒 Sign in to see all {lockedCount} matches</span>
            <a href="/sign-in" style={{ background: C.green, color: '#fff', textDecoration: 'none', whiteSpace: 'nowrap', padding: '10px 18px', borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: "'DM Sans',sans-serif" }}>Sign in</a>
          </div>
        )}
      </div>

      <Footer />
    </div>
  );
}
