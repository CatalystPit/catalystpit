'use client';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { C, Skel, Dot, TopNav, Footer, BrandStyles, TickerLogo } from '../../lib/cp-shared';

// Stock Screener (Finviz-style) — filter the market by exchange, sector, market cap, price, volume.
// Backed by /api/screener (FMP). Dormant/"connecting" until FMP_API_KEY is set server-side.

const SECTORS = ['Basic Materials', 'Communication Services', 'Consumer Cyclical', 'Consumer Defensive', 'Energy', 'Financial Services', 'Healthcare', 'Industrials', 'Real Estate', 'Technology', 'Utilities'];
const EXCHANGES = ['NASDAQ', 'NYSE', 'AMEX'];

const MCAP = [
  { k: 'any',   l: 'Any market cap' },
  { k: 'mega',  l: 'Mega ($200B+)',      min: 200e9 },
  { k: 'large', l: 'Large ($10–200B)',   min: 10e9, max: 200e9 },
  { k: 'mid',   l: 'Mid ($2–10B)',       min: 2e9,  max: 10e9 },
  { k: 'small', l: 'Small ($300M–2B)',   min: 300e6, max: 2e9 },
  { k: 'micro', l: 'Micro ($50–300M)',   min: 50e6, max: 300e6 },
  { k: 'nano',  l: 'Nano (<$50M)',       max: 50e6 },
];
const PRICE = [
  { k: 'any', l: 'Any price' },
  { k: 'u5',  l: 'Under $5',     max: 5 },
  { k: '5-20',  l: '$5 – $20',   min: 5, max: 20 },
  { k: '20-50', l: '$20 – $50',  min: 20, max: 50 },
  { k: '50-100', l: '$50 – $100', min: 50, max: 100 },
  { k: 'o100', l: 'Over $100',   min: 100 },
];
const VOL = [
  { k: 'any', l: 'Any volume' },
  { k: '100k', l: 'Over 100K', min: 100000 },
  { k: '500k', l: 'Over 500K', min: 500000 },
  { k: '1m',  l: 'Over 1M',   min: 1000000 },
  { k: '5m',  l: 'Over 5M',   min: 5000000 },
];

const fmtCap = (n) => {
  if (n == null || isNaN(n)) return '—';
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${Math.round(n).toLocaleString()}`;
};
const fmtVol = (n) => {
  if (n == null || isNaN(n)) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(n);
};
const fmtPrice = (n) => (n == null || isNaN(n)) ? '—' : `$${Number(n).toFixed(2)}`;

const selStyle = { background: C.white, border: `1px solid ${C.border}`, borderRadius: 6, padding: '7px 10px', fontSize: 12.5, color: C.text, fontFamily: "'DM Sans',sans-serif", cursor: 'pointer', outline: 'none' };

export default function ScreenerClient() {
  const router = useRouter();
  const [exchange, setExchange] = useState('');
  const [sector, setSector] = useState('');
  const [mcap, setMcap] = useState('any');
  const [price, setPrice] = useState('any');
  const [vol, setVol] = useState('any');
  const [sort, setSort] = useState('marketCap');
  const [dir, setDir] = useState('desc');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (exchange) p.set('exchange', exchange);
    if (sector) p.set('sector', sector);
    const mc = MCAP.find((x) => x.k === mcap); if (mc?.min) p.set('marketCapMin', String(mc.min)); if (mc?.max) p.set('marketCapMax', String(mc.max));
    const pr = PRICE.find((x) => x.k === price); if (pr?.min) p.set('priceMin', String(pr.min)); if (pr?.max) p.set('priceMax', String(pr.max));
    const vl = VOL.find((x) => x.k === vol); if (vl?.min) p.set('volumeMin', String(vl.min));
    p.set('sort', sort); p.set('dir', dir); p.set('limit', '150');
    return p.toString();
  }, [exchange, sector, mcap, price, vol, sort, dir]);

  const load = useCallback(async () => {
    setLoading(true);
    try { const r = await fetch(`/api/screener?${params}`, { cache: 'no-store' }); const j = r.ok ? await r.json() : null; setData(j); }
    catch { setData({ configured: true, rows: [] }); }
    setLoading(false);
  }, [params]);
  useEffect(() => { load(); }, [load]);

  const reset = () => { setExchange(''); setSector(''); setMcap('any'); setPrice('any'); setVol('any'); setSort('marketCap'); setDir('desc'); };
  const goTicker = (s) => { if (s) router.push(`/ticker/${encodeURIComponent(s)}`); };
  const toggleSort = (col) => { if (sort === col) setDir((d) => (d === 'asc' ? 'desc' : 'asc')); else { setSort(col); setDir('desc'); } };

  const rows = data?.rows || [];
  const configured = data?.configured !== false;

  const Th = ({ label, col, align }) => {
    const active = sort === col;
    return (
      <th onClick={col ? () => toggleSort(col) : undefined}
        style={{ padding: '10px 14px', textAlign: align || 'left', fontFamily: "'DM Sans',sans-serif", fontSize: 9, color: active ? C.green : C.dim, letterSpacing: '0.8px', fontWeight: 400, cursor: col ? 'pointer' : 'default', userSelect: 'none', whiteSpace: 'nowrap' }}>
        {label.toUpperCase()}{active ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}
      </th>
    );
  };

  return (
    <div style={{ fontFamily: "'DM Sans',sans-serif", background: C.bg, color: C.text, minHeight: '100vh' }}>
      <BrandStyles />
      <TopNav active="Screener" />

      <div style={{ background: C.white, borderBottom: `1px solid ${C.border}`, padding: '18px 24px' }}>
        <div style={{ maxWidth: 1380, margin: '0 auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <Dot /><span style={{ fontSize: 10, color: C.muted, letterSpacing: '1px' }}>MARKET SCREENER</span>
          </div>
          <h1 style={{ fontFamily: "'Cormorant Garamond',serif", fontSize: 30, fontWeight: 600, color: C.ink, margin: 0 }}>Stock Screener</h1>
          <p style={{ fontSize: 13, color: C.muted, margin: '4px 0 0', fontWeight: 300 }}>Filter the market by exchange, sector, market cap, price, and volume.</p>
        </div>
      </div>

      {/* FILTER BAR */}
      <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, padding: '12px 24px' }}>
        <div style={{ maxWidth: 1380, margin: '0 auto', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select value={exchange} onChange={(e) => setExchange(e.target.value)} style={selStyle}>
            <option value="">Any exchange</option>
            {EXCHANGES.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
          <select value={sector} onChange={(e) => setSector(e.target.value)} style={selStyle}>
            <option value="">Any sector</option>
            {SECTORS.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
          <select value={mcap} onChange={(e) => setMcap(e.target.value)} style={selStyle}>
            {MCAP.map((x) => <option key={x.k} value={x.k}>{x.l}</option>)}
          </select>
          <select value={price} onChange={(e) => setPrice(e.target.value)} style={selStyle}>
            {PRICE.map((x) => <option key={x.k} value={x.k}>{x.l}</option>)}
          </select>
          <select value={vol} onChange={(e) => setVol(e.target.value)} style={selStyle}>
            {VOL.map((x) => <option key={x.k} value={x.k}>{x.l}</option>)}
          </select>
          <button onClick={reset} style={{ background: 'transparent', border: 'none', color: C.muted, cursor: 'pointer', fontSize: 12, textDecoration: 'underline', fontFamily: "'DM Sans',sans-serif" }}>Reset</button>
          <span style={{ marginLeft: 'auto', fontSize: 11, color: C.dim, fontFamily: "'DM Sans',sans-serif" }} className="cp-num">
            {loading ? '…' : configured ? `${rows.length} matches` : ''}
          </span>
        </div>
      </div>

      <div style={{ maxWidth: 1380, margin: '16px auto', padding: '0 24px 48px' }}>
        {!configured ? (
          <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: '48px 24px', textAlign: 'center' }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: C.ink, marginBottom: 8 }}>Screener is connecting to its data source</div>
            <div style={{ fontSize: 13, color: C.muted, fontWeight: 300, maxWidth: 480, margin: '0 auto', lineHeight: 1.6 }}>
              The stock screener is built and ready — it lights up as soon as the market-data feed is connected. Insider screening lives on the <a href="/insiders" style={{ color: C.green, fontWeight: 600 }}>Insiders</a> page.
            </div>
          </div>
        ) : loading ? (
          <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16 }}>
            {Array(10).fill(0).map((_, i) => <Skel key={i} h={16} mb={10} />)}
          </div>
        ) : rows.length === 0 ? (
          <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: '40px 20px', textAlign: 'center', color: C.muted, fontSize: 13 }}>
            No stocks match these filters. Try widening them.
          </div>
        ) : (
          <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}>
                    <Th label="Ticker" col="symbol" />
                    <Th label="Company" />
                    <Th label="Price" col="price" align="right" />
                    <Th label="Market Cap" col="marketCap" align="right" />
                    <Th label="Volume" col="volume" align="right" />
                    <Th label="Sector" />
                    <Th label="Exch" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.symbol} className="row-hov" onClick={() => goTicker(r.symbol)}
                      style={{ borderBottom: i < rows.length - 1 ? `1px solid ${C.surface}` : 'none', cursor: 'pointer' }}>
                      <td className="cp-tkr" style={{ padding: '11px 14px', fontSize: 13, fontWeight: 700, color: C.green, whiteSpace: 'nowrap' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><TickerLogo symbol={r.symbol} size={18} />{r.symbol}</span>
                      </td>
                      <td style={{ padding: '11px 14px', fontSize: 13, color: C.text, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</td>
                      <td className="cp-num" style={{ padding: '11px 14px', textAlign: 'right', fontSize: 13, fontWeight: 600, color: C.ink, whiteSpace: 'nowrap' }}>{fmtPrice(r.price)}</td>
                      <td className="cp-num" style={{ padding: '11px 14px', textAlign: 'right', fontSize: 13, color: C.text, whiteSpace: 'nowrap' }}>{fmtCap(r.marketCap)}</td>
                      <td className="cp-num" style={{ padding: '11px 14px', textAlign: 'right', fontSize: 13, color: C.text, whiteSpace: 'nowrap' }}>{fmtVol(r.volume)}</td>
                      <td style={{ padding: '11px 14px', fontSize: 12, color: C.muted, whiteSpace: 'nowrap' }}>{r.sector || '—'}</td>
                      <td style={{ padding: '11px 14px', fontSize: 11, color: C.dim, whiteSpace: 'nowrap' }}>{r.exchange || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div style={{ marginTop: 14, fontSize: 11, color: C.dim, lineHeight: 1.5 }}>
          Fundamentals screener — price, market cap, and volume are delayed/EOD. Not investment advice.
        </div>
      </div>
      <Footer />
      <style>{`.row-hov:hover{background:${C.surface}!important}`}</style>
    </div>
  );
}
