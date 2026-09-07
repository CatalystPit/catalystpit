'use client';
import { Suspense, useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { C, Skel, Dot, CARD_COLORS, timeAgo, minsSince, TopNav, Footer, BrandStyles, TickerLogo, startCheckout } from '../../../lib/cp-shared';
import TradingViewChart from '../../../components/TradingViewChart';
import { estimateNextEarnings } from '../../../lib/earnings-estimate';
import AffiliateStrip from '../../../components/AffiliateStrip';
import BullsBears from '../../../components/BullsBears';
import WatchlistStar from '../../../components/WatchlistStar';

// ── formatters (null/NaN → "—", per the null-rather-than-guess rule) ──
const usd      = (n) => (n == null || isNaN(n)) ? '—' : `$${Number(n).toFixed(2)}`;
const fmtNum   = (n) => (n == null || isNaN(n)) ? '—' : Number(n).toFixed(2);
const fmtPct   = (n) => (n == null || isNaN(n)) ? '—' : `${Number(n).toFixed(2)}%`;
const fmtVolM  = (n) => (n == null || isNaN(n)) ? '—' : `${Number(n).toFixed(1)}M`;
const fmtMktCap = (m) => {                 // Finnhub marketCapitalization is in millions
  if (m == null || isNaN(m)) return '—';
  if (m >= 1e6) return `$${(m / 1e6).toFixed(2)}T`;
  if (m >= 1e3) return `$${(m / 1e3).toFixed(2)}B`;
  return `$${Number(m).toFixed(0)}M`;
};
// Earnings formatters — fmtBig takes raw dollars (revenue), EPS keeps 2 decimals, YoY 1 decimal.
const fmtBig = (n) => {
  if (n == null || isNaN(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (a >= 1e9)  return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6)  return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3)  return `$${(n / 1e3).toFixed(2)}K`;
  return `$${Number(n).toFixed(0)}`;
};
const fmtEps = (n) => (n == null || isNaN(n)) ? '—' : (n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`);
const fmtYoy = (v) => (v == null || isNaN(v)) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
// 'YYYY-MM-DD' → "Apr 27, 2026" (UTC-pinned so the date never drifts a day by timezone).
const fmtDateLong = (s) => {
  if (!s) return '—';
  const d = new Date(`${String(s).slice(0, 10)}T00:00:00`);
  return isNaN(d.getTime()) ? s : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};


// ── trade helpers (mirror /insiders) ──
const actionStyle = (t) => t === 'BUY' ? { fg: C.green, bg: C.greenLight }
  : t === 'SELL' ? { fg: C.red, bg: C.redLight } : { fg: C.dim, bg: C.surface };
const fmtMoney = (n) => {
  const v = Number(n);
  if (!v || isNaN(v)) return '—';
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toLocaleString('en-US')}`;
};
const decodeEntities = (s) => typeof s !== 'string' ? s
  : s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
     .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");

// ── government helpers ──
const partyStyle = (party) => {
  const p = (party || '').toLowerCase();
  if (p.startsWith('democrat'))   return { fg: C.blue,  bg: C.blueLight, abbr: 'DEM' };
  if (p.startsWith('republican')) return { fg: C.red,   bg: C.redLight,  abbr: 'REP' };
  if (!party)                     return { fg: C.dim,   bg: C.surface,   abbr: '—'   };
  return { fg: C.muted, bg: C.surface, abbr: 'IND' };
};
const chamberLabel = (c) => c === 'senate' ? 'Senate' : c === 'house' ? 'House' : '—';
const isBioguide = (slug) => /^[A-Z]\d{6}$/.test(slug || '');   // matched member → has a detail page

// Return since trade, recomputed from raw prices at 2-decimal precision. null when
// either price is missing (→ "—"); a genuine flat return → 0 (→ "0.00%"). Distinct types.
const govReturn = (pat, cur) =>
  (pat != null && cur != null && !isNaN(pat) && !isNaN(cur) && pat > 0) ? ((cur - pat) / pat) * 100 : null;
const fmtRet = (r) => r == null ? '—' : `${r > 0 ? '+' : ''}${r.toFixed(2)}%`;
const retColor = (r) => r == null ? C.dim : r > 0 ? C.green : r < 0 ? C.red : C.muted;

// ── tab definitions (order locked; labels sentence-case) ──
const TABS = [
  { id: 'overview',   label: 'Overview' },
  { id: 'news',       label: 'News' },
  { id: 'press',      label: 'Press Releases' },
  { id: 'earnings',   label: 'Earnings' },
  { id: 'options',    label: 'Options Flow' },
  { id: 'guidance',   label: 'Guidance' },
  { id: 'dividends',  label: 'Dividends' },
  { id: 'analyst',    label: 'Analyst Ratings' },
  { id: 'insider',    label: 'Insider Trades' },
  { id: 'short',      label: 'Short Interest' },
  { id: 'government', label: 'Government Trades' },
  { id: 'institutions', label: 'Institutions' },
  { id: 'financials', label: 'Financials' },
];
const PLACEHOLDERS = {
  options:    'Unusual options activity — large call and put buys, premium volume, and bullish/bearish flow signals.',
  guidance:   'Company-issued forward guidance, revenue and EPS forecasts, and guidance revisions.',
  analyst:    'Wall Street analyst ratings, price targets, upgrades, downgrades, and consensus forecasts.',
};

// ── primitives ──
function StatCell({ label, value }) {
  return (
    <div>
      <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 9, color: C.dim, letterSpacing: '0.6px', marginBottom: 3 }}>{label}</div>
      <div className="cp-num" style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 14, fontWeight: 600, color: C.ink }}>{value}</div>
    </div>
  );
}

// White card with a header bar (Dot + title) — shared shell for hero chart + tab sections.
function Section({ title, badge, action, children }) {
  return (
    <div style={{ marginTop: 14, background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '10px 16px', borderBottom: `1px solid ${C.border}`, background: C.surface, display: 'flex', alignItems: 'center', gap: 7 }}>
        <Dot /><span style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>{title}</span>
        {badge && <span style={{ fontSize: 9, background: '#FFF6E8', color: '#7A5018', padding: '2px 7px', borderRadius: 3, fontFamily: "'DM Sans',sans-serif", fontWeight: 500 }}>{badge}</span>}
        {action && <span style={{ marginLeft: 'auto' }}>{action}</span>}
      </div>
      <div style={{ padding: 14 }}>{children}</div>
    </div>
  );
}

// "View all X →" link used in Overview preview headers; switches tabs via router.
function ViewAll({ label, onClick }) {
  return (
    <button onClick={onClick} style={{ background: 'transparent', border: 'none', color: C.green, cursor: 'pointer', fontSize: 11, fontFamily: "'DM Sans',sans-serif", fontWeight: 400 }}>{label} →</button>
  );
}

// <24h → "Xm/Xh ago"; older → short date (company-news spans ~14 days).
const newsTime = (iso) => {
  const mins = minsSince(iso);
  if (mins == null) return '';
  if (mins < 1440) return timeAgo(mins);
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

// Yahoo-via-Finnhub always returns this one generic placeholder (no real Yahoo thumbnails
// exist in our feed) → treat it as "no image" so we fall back to the gradient, not a y!fi wall.
const isYfiPlaceholder = (url) => /\/yahoo_finance_[a-z-]+_h_p_finance/i.test(url || '');

// Mirrors /news NewsRowCard (thumb + source·time + 2-line headline), minus tag/ticker chips.
function NewsRow({ n, idx }) {
  const [bg1, bg2] = CARD_COLORS[idx % CARD_COLORS.length];
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = n.image && !imgFailed && !isYfiPlaceholder(n.image);
  const inner = (
    <div className="card-hov" style={{ display: 'flex', gap: 14, padding: 12, background: C.white,
      border: `1px solid ${C.border}`, borderRadius: 6, transition: 'all 0.2s', cursor: 'pointer' }}>
      <div style={{ width: 120, height: 80, borderRadius: 5, overflow: 'hidden', flexShrink: 0,
        position: 'relative', background: `linear-gradient(135deg,${bg1},${bg2})` }}>
        {showImg && (
          <img src={n.image} alt="" onError={() => setImgFailed(true)}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center top', display: 'block' }} />
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5, justifyContent: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 10, color: C.dim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.source}</span>
          {n.datetime && <span className="cp-num" style={{ marginLeft: 'auto', fontFamily: "'DM Sans',sans-serif", fontSize: 10, color: C.dim, whiteSpace: 'nowrap' }}>{newsTime(n.datetime)}</span>}
        </div>
        <div style={{ fontSize: 14, fontWeight: 600, color: C.ink, lineHeight: 1.35, fontFamily: "'DM Sans',sans-serif",
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          {n.headline}
        </div>
      </div>
    </div>
  );
  return n.url
    ? <a href={n.url} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}>{inner}</a>
    : inner;
}

// ── HERO (always visible, above tabs): identity + key stats + TradingView chart ──
function Hero({ data, earnings }) {
  const m = data.metric || {};
  const nextEarnings = estimateNextEarnings(earnings?.earnings || []);
  return (
    <>
      {/* identity */}
      <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: '20px 22px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <TickerLogo symbol={data.symbol} size={30} />
            <span className="cp-tkr" style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 26, fontWeight: 700, color: C.green }}>{data.symbol}</span>
          </span>
          <span style={{ fontSize: 18, fontWeight: 600, color: C.ink }}>{data.name}</span>
          <span style={{ marginLeft: 'auto', alignSelf: 'center' }}><WatchlistStar symbol={data.symbol} /></span>
        </div>
        <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 11, color: C.dim, marginTop: 4, letterSpacing: '0.5px' }}>
          {data.exchange || '—'}{data.industry ? ` · ${data.industry}` : ''}
        </div>
        {nextEarnings && (
          <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>
            Next earnings <span style={{ fontWeight: 600, color: C.ink }}>{fmtDateLong(nextEarnings)}</span>
            <span style={{ color: C.dim }}> · estimated from filing history</span>
          </div>
        )}
      </div>

      {/* key statistics — NO last-sale price (production = EDGAR + widget); live price is in
          the TradingView chart below. Fundamentals/52w are historical; short interest = FINRA. */}
      <div style={{ marginTop: 14, background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: '20px 22px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 13, fontWeight: 600, color: C.ink }}>Key statistics</span>
          <span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 11, color: C.dim }}>Live price &amp; interactive chart below</span>
        </div>
        <div className="tk-hero-grid" style={{ marginTop: 16 }}>
          <StatCell label="52-WEEK RANGE"  value={(m.low52 != null && m.high52 != null) ? `${usd(m.low52)} – ${usd(m.high52)}` : '—'} />
          <StatCell label="MARKET CAP"     value={fmtMktCap(m.marketCap)} />
          <StatCell label="P/E (TTM)"      value={fmtNum(m.peTTM)} />
          <StatCell label="EPS (TTM)"      value={fmtEps(m.epsTTM)} />
          <StatCell label="DIVIDEND YIELD" value={fmtPct(m.divYield)} />
          <StatCell label="AVG VOLUME (10D)" value={fmtVolM(m.avgVol10d)} />
          <StatCell label="50-DAY MA"      value={usd(data.fiftyDayMA)} />
          <StatCell label="BETA"           value={fmtNum(m.beta)} />
          <StatCell label="INDUSTRY"       value={data.industry || '—'} />
          <StatCell label="SHORT INTEREST" value={fmtShares(data.shortInterest?.shortIntShares)} />
          <StatCell label="SHORT % FLOAT"  value={fmtPct(data.shortInterest?.pctFloat)} />
          <StatCell label="DAYS TO COVER"  value={fmtNum(data.shortInterest?.daysToCover)} />
        </div>
      </div>

      {/* price chart — licensed TradingView embed (A4); replaces self-plotted Polygon/Tiingo bars */}
      <TradingViewChart ticker={data.symbol} />
    </>
  );
}

// ── tab bar: full-width single row, horizontal-scroll on mobile, green-underline active ──
function TabBar({ active, onSelect }) {
  return (
    <div style={{ marginTop: 16, borderBottom: `1px solid ${C.border}`, overflowX: 'auto' }}>
      <div style={{ display: 'flex', minWidth: 'max-content' }}>
        {TABS.map((t) => {
          const on = active === t.id;
          return (
            <button key={t.id} onClick={() => onSelect(t.id)}
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: '10px 14px',
                fontFamily: "'DM Sans',sans-serif", fontSize: 13, whiteSpace: 'nowrap',
                color: on ? C.ink : C.muted, fontWeight: on ? 700 : 400,
                borderBottom: on ? `2px solid ${C.green}` : '2px solid transparent' }}>
              {t.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TabPlaceholder({ label, copy }) {
  return (
    <div style={{ marginTop: 14, background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: '48px 24px', textAlign: 'center' }}>
      <div style={{ fontFamily: "'Cormorant Garamond',serif", fontSize: 24, fontWeight: 600, color: C.ink, marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 14, color: C.muted, fontStyle: 'italic', fontWeight: 300, maxWidth: 520, margin: '0 auto', lineHeight: 1.5 }}>{copy}</div>
    </div>
  );
}

// Step-1 stub for content tabs not yet built (Overview, Insider, Government).
function BuildingStub({ label }) {
  return (
    <div style={{ marginTop: 14, background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: '40px 24px', textAlign: 'center', color: C.dim, fontSize: 13 }}>
      {label} — building in the next step.
    </div>
  );
}

function NewsTab({ data }) {
  return (
    <Section title="News">
      {(data.news || []).length === 0 ? (
        <div style={{ padding: '16px 4px', textAlign: 'center', color: C.muted, fontSize: 13 }}>No recent news for {data.symbol}.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {data.news.map((n, i) => <NewsRow key={i} n={n} idx={i} />)}
        </div>
      )}
    </Section>
  );
}

// Insider table (shared by the full tab + the Overview preview) — mirrors /insiders markup.
function InsiderTable({ rows }) {
  const headers = [['Date', 'left'], ['Ticker', 'left'], ['Company', 'left'], ['Insider', 'left'],
    ['Type', 'left'], ['Shares', 'right'], ['Avg Price', 'right'], ['Value', 'right']];
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
        <thead><tr style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}>
          {headers.map(([h, al]) => (
            <th key={h} style={{ padding: '8px 16px', textAlign: al, fontFamily: "'DM Sans',sans-serif", fontSize: 9, color: C.dim, letterSpacing: '0.8px', fontWeight: 400, whiteSpace: 'nowrap' }}>{h.toUpperCase()}</th>
          ))}
        </tr></thead>
        <tbody>
          {rows.map((r, i) => {
            const as = actionStyle(r.action);
            return (
              <tr key={r.id || i} style={{ borderBottom: i < rows.length - 1 ? `1px solid ${C.surface}` : 'none', borderLeft: `3px solid ${as.fg}` }}>
                <td className="cp-num" style={{ padding: '11px 16px', fontFamily: "'DM Sans',sans-serif", fontSize: 11, color: C.dim, whiteSpace: 'nowrap' }}>{r.filingDate || '—'}</td>
                <td className="cp-tkr" style={{ padding: '11px 16px', fontFamily: "'DM Sans',sans-serif", fontSize: 13, fontWeight: 700, color: C.green }}>{r.ticker || '—'}</td>
                <td style={{ padding: '11px 16px', fontSize: 13, color: C.text, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{decodeEntities(r.company || '')}</td>
                <td style={{ padding: '11px 16px', fontSize: 13, color: C.text }}>
                  <div>{decodeEntities(r.executive || '')}</div>
                  {r.title && <div style={{ fontSize: 11, color: C.muted, fontWeight: 300, marginTop: 2 }}>{decodeEntities(r.title)}</div>}
                </td>
                <td style={{ padding: '11px 16px' }}>
                  <span style={{ fontSize: 10, padding: '3px 9px', borderRadius: 3, fontFamily: "'DM Sans',sans-serif", fontWeight: 600, background: as.bg, color: as.fg }}>{r.action}</span>
                </td>
                <td className="cp-num" style={{ padding: '11px 16px', textAlign: 'right', fontFamily: "'DM Sans',sans-serif", fontSize: 13, fontWeight: 500, color: C.text, whiteSpace: 'nowrap' }}>{r.shares > 0 ? Number(r.shares).toLocaleString('en-US') : '—'}</td>
                <td className="cp-num" style={{ padding: '11px 16px', textAlign: 'right', fontFamily: "'DM Sans',sans-serif", fontSize: 13, fontWeight: 500, color: C.muted, whiteSpace: 'nowrap' }}>{usd(r.pricePerShare)}</td>
                <td className="cp-num" style={{ padding: '11px 16px', textAlign: 'right', fontFamily: "'DM Sans',sans-serif", fontSize: 14, fontWeight: 700, color: as.fg, whiteSpace: 'nowrap' }}>{fmtMoney(r.totalValue)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Tier check — Pro/Elite unlock full depth. null while resolving.
function usePro() {
  const [pro, setPro] = useState(null);
  useEffect(() => {
    let alive = true;
    (async () => { try { const r = await fetch('/api/me/plan'); const j = r.ok ? await r.json() : null; if (alive) setPro(j?.tier === 'pro' || j?.tier === 'elite'); } catch { if (alive) setPro(false); } })();
    return () => { alive = false; };
  }, []);
  return pro;
}

// Blurred locked rows + centered Pro unlock card — teaser after the free cap (not a hard cutoff).
function LockedRows({ what, remaining }) {
  return (
    <div style={{ position: 'relative', overflow: 'hidden' }}>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} style={{ display: 'flex', gap: 16, alignItems: 'center', padding: '13px 16px', borderTop: `1px solid ${C.surface}`,
          filter: 'blur(4px)', userSelect: 'none', pointerEvents: 'none', opacity: 0.55 }}>
          <div style={{ width: 64, height: 12, background: C.border2, borderRadius: 4 }} />
          <div style={{ flex: 1, height: 12, background: C.border, borderRadius: 4 }} />
          <div style={{ width: 90, height: 12, background: C.border, borderRadius: 4 }} />
          <div style={{ width: 60, height: 12, background: C.border2, borderRadius: 4 }} />
        </div>
      ))}
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(245,246,243,0.55)', padding: 12 }}>
        <div style={{ background: C.white, border: `1px solid ${C.greenBorder}`, borderRadius: 8, padding: '12px 18px', display: 'flex', alignItems: 'center',
          gap: 12, boxShadow: '0 4px 16px rgba(0,0,0,0.08)', flexWrap: 'wrap', justifyContent: 'center' }}>
          <span style={{ fontSize: 16 }}>🔒</span>
          <div>
            <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 13, fontWeight: 600, color: C.ink }}>{remaining} more {what}</div>
            <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 12, color: C.muted, fontWeight: 300 }}>Unlock the full history with Pro</div>
          </div>
          <button onClick={() => startCheckout()} style={{ background: C.green, color: '#fff', border: 'none', whiteSpace: 'nowrap',
            padding: '8px 16px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>
            Unlock Pro — $12/mo
          </button>
        </div>
      </div>
    </div>
  );
}

// Insider Trades tab — /api/insiders?ticker=. Free tier sees the latest 10; Pro unlocks full depth.
function InsiderTab({ symbol, insider }) {
  const pro = usePro();
  const loading = insider == null;
  const all = insider?.trades || [];
  const FREE = 10;
  const rows = pro === true ? all : all.slice(0, FREE);
  const locked = pro === false ? Math.max(0, all.length - FREE) : 0;
  return (
    <Section title="Insider trades">
      {loading ? <div>{Array(6).fill(0).map((_, i) => <Skel key={i} h={16} mb={10} />)}</div>
        : all.length === 0 ? <div style={{ padding: '16px 4px', textAlign: 'center', color: C.muted, fontSize: 13 }}>No insider trades on file for {symbol}.</div>
        : (
          <>
            <InsiderTable rows={rows} />
            {locked > 0 && <LockedRows what="insider filings" remaining={locked} />}
          </>
        )}
    </Section>
  );
}

// Government table (shared by the full tab + the Overview preview) — return-since-trade column.
function GovTable({ rows }) {
  const headers = [['Date', 'left'], ['Politician', 'left'], ['Chamber', 'left'], ['Type', 'left'],
    ['Amount', 'right'], ['Price at trade', 'right'], ['Current price', 'right'], ['Return since', 'right']];
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
        <thead><tr style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}>
          {headers.map(([h, al]) => (
            <th key={h} style={{ padding: '8px 16px', textAlign: al, fontFamily: "'DM Sans',sans-serif", fontSize: 9, color: C.dim, letterSpacing: '0.8px', fontWeight: 400, whiteSpace: 'nowrap' }}>{h.toUpperCase()}</th>
          ))}
        </tr></thead>
        <tbody>
          {rows.map((r, i) => {
            const as = actionStyle(r.action);
            const ps = partyStyle(r.party);
            const matched = isBioguide(r.slug);
            const ret = govReturn(r.priceAtTrade, r.currentPrice);
            return (
              <tr key={r.id || i} style={{ borderBottom: i < rows.length - 1 ? `1px solid ${C.surface}` : 'none', borderLeft: `3px solid ${as.fg}` }}>
                <td className="cp-num" style={{ padding: '11px 16px', fontFamily: "'DM Sans',sans-serif", fontSize: 11, color: C.dim, whiteSpace: 'nowrap' }}>{r.transactionDate || '—'}</td>
                <td style={{ padding: '11px 16px', fontSize: 13, color: C.text, minWidth: 160 }}>
                  <div>
                    {matched
                      ? <a href={`/politicians/${r.slug}`} className="sym-lnk" style={{ color: C.text, textDecoration: 'none', fontWeight: 500 }}>{r.representative || '—'}</a>
                      : <span style={{ fontWeight: 500 }}>{r.representative || '—'}</span>}
                  </div>
                  <div style={{ display: 'flex', gap: 5, marginTop: 4 }}>
                    <span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 9, fontWeight: 600, background: ps.bg, color: ps.fg, padding: '2px 6px', borderRadius: 3 }}>{ps.abbr}</span>
                    {r.state && <span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 9, fontWeight: 600, background: C.surface, color: C.muted, padding: '2px 6px', borderRadius: 3 }}>{r.state}</span>}
                  </div>
                </td>
                <td style={{ padding: '11px 16px', fontSize: 12, color: C.muted, whiteSpace: 'nowrap' }}>{chamberLabel(r.chamber)}</td>
                <td style={{ padding: '11px 16px' }}>
                  <span style={{ fontSize: 10, padding: '3px 9px', borderRadius: 3, fontFamily: "'DM Sans',sans-serif", fontWeight: 600, background: as.bg, color: as.fg }}>{r.action}</span>
                </td>
                <td className="cp-num" style={{ padding: '11px 16px', textAlign: 'right', fontFamily: "'DM Sans',sans-serif", fontSize: 12, color: C.text, whiteSpace: 'nowrap' }}>{r.amountRange || '—'}</td>
                <td className="cp-num" style={{ padding: '11px 16px', textAlign: 'right', fontFamily: "'DM Sans',sans-serif", fontSize: 12, color: C.muted, whiteSpace: 'nowrap' }}>{usd(r.priceAtTrade)}</td>
                <td className="cp-num" style={{ padding: '11px 16px', textAlign: 'right', fontFamily: "'DM Sans',sans-serif", fontSize: 12, color: C.muted, whiteSpace: 'nowrap' }}>{usd(r.currentPrice)}</td>
                <td className="cp-num" style={{ padding: '11px 16px', textAlign: 'right', fontFamily: "'DM Sans',sans-serif", fontSize: 13, fontWeight: 700, color: retColor(ret), whiteSpace: 'nowrap' }}>{fmtRet(ret)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Government Trades tab — /api/politicians?ticker=, with the killer return-since-trade column.
function GovernmentTab({ symbol, gov }) {
  const pro = usePro();
  const loading = gov == null;
  const all = gov?.trades || [];
  const FREE = 10;
  const rows = pro === true ? all : all.slice(0, FREE);
  const locked = pro === false ? Math.max(0, all.length - FREE) : 0;
  return (
    <Section title="Government trades">
      {loading ? <div>{Array(6).fill(0).map((_, i) => <Skel key={i} h={16} mb={10} />)}</div>
        : all.length === 0 ? <div style={{ padding: '16px 4px', textAlign: 'center', color: C.muted, fontSize: 13 }}>No government trades on file for {symbol}.</div>
        : (
          <>
            <GovTable rows={rows} />
            {locked > 0 && <LockedRows what="Congress trades" remaining={locked} />}
          </>
        )}
    </Section>
  );
}

// Earnings table — SEC EDGAR quarterly history (mirrors the insider/gov table markup).
function EarningsTable({ rows }) {
  const headers = [['Quarter', 'left'], ['Report date', 'left'], ['Revenue', 'right'], ['Rev YoY', 'right'],
    ['EPS (basic)', 'right'], ['EPS YoY', 'right'], ['Filing', 'right']];
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
        <thead><tr style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}>
          {headers.map(([h, al]) => (
            <th key={h} style={{ padding: '8px 16px', textAlign: al, fontFamily: "'DM Sans',sans-serif", fontSize: 9, color: C.dim, letterSpacing: '0.8px', fontWeight: 400, whiteSpace: 'nowrap' }}>{h.toUpperCase()}</th>
          ))}
        </tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderBottom: i < rows.length - 1 ? `1px solid ${C.surface}` : 'none' }}>
              <td style={{ padding: '11px 16px', fontFamily: "'DM Sans',sans-serif", fontSize: 13, fontWeight: 400, color: C.ink, whiteSpace: 'nowrap' }}>
                {r.quarter}{r.derived && <sup title="Q4 derived from the annual 10-K (full year minus Q1–Q3)" style={{ color: C.dim, fontWeight: 400, marginLeft: 2, cursor: 'help' }}>↑</sup>}
              </td>
              <td className="cp-num" style={{ padding: '11px 16px', fontFamily: "'DM Sans',sans-serif", fontSize: 11, color: C.dim, whiteSpace: 'nowrap' }}>{r.report_date || '—'}</td>
              <td className="cp-num" style={{ padding: '11px 16px', textAlign: 'right', fontFamily: "'DM Sans',sans-serif", fontSize: 13, fontWeight: 600, color: C.text, whiteSpace: 'nowrap' }}>{fmtBig(r.revenue)}</td>
              <td className="cp-num" style={{ padding: '11px 16px', textAlign: 'right', fontFamily: "'DM Sans',sans-serif", fontSize: 12, fontWeight: 600, color: retColor(r.revenue_yoy_pct), whiteSpace: 'nowrap' }}>{fmtYoy(r.revenue_yoy_pct)}</td>
              <td className="cp-num" style={{ padding: '11px 16px', textAlign: 'right', fontFamily: "'DM Sans',sans-serif", fontSize: 13, fontWeight: 600, color: C.text, whiteSpace: 'nowrap' }}>{fmtEps(r.eps_basic)}</td>
              <td className="cp-num" style={{ padding: '11px 16px', textAlign: 'right', fontFamily: "'DM Sans',sans-serif", fontSize: 12, fontWeight: 600, color: retColor(r.eps_yoy_pct), whiteSpace: 'nowrap' }}>{fmtYoy(r.eps_yoy_pct)}</td>
              <td style={{ padding: '11px 16px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                {r.filing_url
                  ? <a href={r.filing_url} target="_blank" rel="noopener noreferrer" className="sym-lnk" style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 11, color: C.green, textDecoration: 'none' }}>{r.form} ↗</a>
                  : <span style={{ color: C.dim }}>—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Compact share count: 138782718 → "138.8M". Null/NaN → "—".
const fmtShares = (n) => {
  if (n == null || isNaN(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return `${Math.round(n)}`;
};
// % of float = short shares / free-float shares (FMP, raw share count — true float,
// excludes restricted/insider). null when float is missing/0 (e.g. ETFs) → "—",
// never a misleading 0%.
const pctFloat = (shortShares, floatShares) => {
  if (shortShares == null || floatShares == null || !(floatShares > 0)) return null;
  return (shortShares / floatShares) * 100;
};

// Short Interest tab — /api/short-interest?ticker= (FINRA bi-monthly). Summary card + 12-period history.
// % of float uses FMP free-float shares (payload.float); "—" when float is missing/0 (e.g. ETFs).
function ShortInterestTab({ symbol, short }) {
  const loading = short == null;
  const history = short?.history || [];
  const latest = short?.latest || null;
  const floatShares = short?.float?.float_shares ?? null;   // FMP free float (raw shares); null/0 → "—"
  const headers = [['Settlement', 'left'], ['Short Interest', 'right'], ['Avg Daily Volume', 'right'],
    ['Days to Cover', 'right'], ['% of Float', 'right'], ['Change', 'right']];

  return (
    <Section title="Short interest">
      {loading ? <div>{Array(6).fill(0).map((_, i) => <Skel key={i} h={16} mb={10} />)}</div>
        : history.length === 0 ? (
          <div style={{ padding: '16px 4px', textAlign: 'center', color: C.muted, fontSize: 13 }}>
            No short interest data on file for {symbol}.
          </div>
        ) : (
          <>
            {/* SUMMARY CARD — latest settlement period */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 28, padding: '4px 2px 16px', borderBottom: `1px solid ${C.surface}` }}>
              <div>
                <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 9, color: C.dim, letterSpacing: '0.8px', marginBottom: 3 }}>SETTLEMENT DATE</div>
                <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 14, fontWeight: 600, color: C.ink }}>{fmtDateLong(latest.settlement_date)}</div>
              </div>
              <div>
                <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 9, color: C.dim, letterSpacing: '0.8px', marginBottom: 3 }}>SHORT INTEREST</div>
                <div className="cp-num" style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 14, fontWeight: 600, color: C.ink }}>{fmtShares(latest.short_int_shares)}</div>
              </div>
              <div>
                <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 9, color: C.dim, letterSpacing: '0.8px', marginBottom: 3 }}>DAYS TO COVER</div>
                <div className="cp-num" style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 14, fontWeight: 600, color: C.ink }}>{fmtNum(latest.days_to_cover)}</div>
              </div>
              <div>
                <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 9, color: C.dim, letterSpacing: '0.8px', marginBottom: 3 }}>% OF FLOAT</div>
                <div className="cp-num" style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 14, fontWeight: 600, color: C.ink }}>{fmtPct(pctFloat(latest.short_int_shares, floatShares))}</div>
              </div>
              <div>
                <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 9, color: C.dim, letterSpacing: '0.8px', marginBottom: 3 }}>CHANGE</div>
                <div className="cp-num" style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 14, fontWeight: 700, color: retColor(latest.change_percent) }}>{fmtYoy(latest.change_percent)}</div>
              </div>
            </div>

            {/* HISTORY TABLE — last 12 settlement periods */}
            <div style={{ overflowX: 'auto', marginTop: 4 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
                <thead><tr style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}>
                  {headers.map(([h, al]) => (
                    <th key={h} style={{ padding: '8px 16px', textAlign: al, fontFamily: "'DM Sans',sans-serif", fontSize: 9, color: C.dim, letterSpacing: '0.8px', fontWeight: 400, whiteSpace: 'nowrap' }}>{h.toUpperCase()}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {history.map((r, i) => (
                    <tr key={r.settlement_date || i} style={{ borderBottom: i < history.length - 1 ? `1px solid ${C.surface}` : 'none' }}>
                      <td style={{ padding: '11px 16px', fontFamily: "'DM Sans',sans-serif", fontSize: 13, color: C.text, whiteSpace: 'nowrap' }}>{fmtDateLong(r.settlement_date)}</td>
                      <td className="cp-num" style={{ padding: '11px 16px', textAlign: 'right', fontFamily: "'DM Sans',sans-serif", fontSize: 13, fontWeight: 600, color: C.text, whiteSpace: 'nowrap' }}>{fmtShares(r.short_int_shares)}</td>
                      <td className="cp-num" style={{ padding: '11px 16px', textAlign: 'right', fontFamily: "'DM Sans',sans-serif", fontSize: 12, color: C.muted, whiteSpace: 'nowrap' }}>{fmtShares(r.avg_daily_volume)}</td>
                      <td className="cp-num" style={{ padding: '11px 16px', textAlign: 'right', fontFamily: "'DM Sans',sans-serif", fontSize: 13, color: C.text, whiteSpace: 'nowrap' }}>{fmtNum(r.days_to_cover)}</td>
                      <td className="cp-num" style={{ padding: '11px 16px', textAlign: 'right', fontFamily: "'DM Sans',sans-serif", fontSize: 12, color: C.muted, whiteSpace: 'nowrap' }}>{fmtPct(pctFloat(r.short_int_shares, floatShares))}</td>
                      <td className="cp-num" style={{ padding: '11px 16px', textAlign: 'right', fontFamily: "'DM Sans',sans-serif", fontSize: 12, fontWeight: 600, color: retColor(r.change_percent), whiteSpace: 'nowrap' }}>{fmtYoy(r.change_percent)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ marginTop: 12, fontSize: 11, color: C.dim, fontWeight: 300, lineHeight: 1.5 }}>
              Reported bi-monthly by FINRA. Latest data has a ~2 week reporting lag.
            </div>
          </>
        )}
    </Section>
  );
}

// ── Financials tab — /api/financials?ticker= (SEC EDGAR XBRL companyfacts) ──
// Universal-core + conditional rows: the route omits any line item whose tag doesn't resolve for
// the filer, so a bank renders without broken empty rows. Self-fetches on mount. Annual/Quarterly toggle.
function FinancialValue({ v, perShare }) {
  if (v == null || isNaN(v)) return <span style={{ color: C.hint }}>—</span>;
  const neg = v < 0;
  const text = perShare ? fmtEps(v) : fmtBig(v);
  return <span style={{ color: neg ? C.red : C.ink }}>{text}</span>;
}

function FinancialSection({ title, data }) {
  if (!data || !data.rows?.length) return null;
  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: C.ink, letterSpacing: '0.3px', marginBottom: 8 }}>{title}</div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${C.border}` }}>
              <th style={{ padding: '8px 10px 8px 4px', textAlign: 'left', fontFamily: "'DM Sans',sans-serif", fontSize: 9, color: C.dim, letterSpacing: '0.6px', fontWeight: 400, whiteSpace: 'nowrap' }}>LINE ITEM</th>
              {data.columns.map((c, i) => (
                <th key={i} className="cp-num" style={{ padding: '8px 4px 8px 10px', textAlign: 'right', fontFamily: "'DM Sans',sans-serif", fontSize: 9, color: C.dim, letterSpacing: '0.6px', fontWeight: 400, whiteSpace: 'nowrap' }}>{c.toUpperCase()}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r, ri) => (
              <tr key={ri} style={{ borderBottom: ri < data.rows.length - 1 ? `1px solid ${C.surface}` : 'none' }}>
                <td style={{ padding: '10px 10px 10px 4px', fontSize: 13, color: C.text, whiteSpace: 'nowrap' }}>{r.label}</td>
                {r.values.map((v, vi) => (
                  <td key={vi} className="cp-num" style={{ padding: '10px 4px 10px 10px', textAlign: 'right', fontFamily: "'DM Sans',sans-serif", fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>
                    <FinancialValue v={v} perShare={r.perShare} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FinancialsTab({ symbol }) {
  const [state, setState] = useState({ loading: true, error: false, data: null });
  const [mode, setMode] = useState('annual');
  useEffect(() => {
    let alive = true;
    setState({ loading: true, error: false, data: null });
    (async () => {
      try {
        const r = await fetch(`/api/financials?ticker=${encodeURIComponent(symbol)}`);
        const j = r.ok ? await r.json() : null;
        if (!alive) return;
        if (!j || j.error === true) setState({ loading: false, error: true, data: null });
        else setState({ loading: false, error: false, data: j });
      } catch { if (alive) setState({ loading: false, error: true, data: null }); }
    })();
    return () => { alive = false; };
  }, [symbol]);

  const { loading, error, data } = state;
  if (loading) return <Section title="Financials"><div>{Array(6).fill(0).map((_, i) => <Skel key={i} h={18} mb={10} />)}</div></Section>;
  if (error) return <Section title="Financials"><div style={{ padding: '16px 4px', textAlign: 'center', color: C.muted, fontSize: 13 }}>Couldn&apos;t load financials right now.</div></Section>;
  if (!data || !data.available) {
    return (
      <Section title="Financials">
        <div style={{ padding: '32px 16px', textAlign: 'center' }}>
          <div style={{ fontSize: 14, color: C.ink, fontWeight: 600, marginBottom: 4 }}>Financial statements not available</div>
          <div style={{ fontSize: 12, color: C.muted, fontWeight: 300 }}>No SEC XBRL filings on file for {symbol}.</div>
        </div>
      </Section>
    );
  }

  const periods = data[mode] || {};
  const Toggle = (
    <div style={{ display: 'flex', gap: 0, border: `1px solid ${C.border}`, borderRadius: 6, overflow: 'hidden' }}>
      {['annual', 'quarterly'].map((m) => (
        <button key={m} onClick={() => setMode(m)}
          style={{ background: mode === m ? C.green : C.white, color: mode === m ? '#fff' : C.muted, border: 'none',
            padding: '5px 12px', fontSize: 11, fontFamily: "'DM Sans',sans-serif", fontWeight: 600, cursor: 'pointer', textTransform: 'capitalize' }}>
          {m}
        </button>
      ))}
    </div>
  );

  return (
    <Section title="Financials" badge="SEC EDGAR" action={Toggle}>
      <FinancialSection title="Income Statement" data={periods.income} />
      <FinancialSection title="Balance Sheet" data={periods.balance} />
      <FinancialSection title="Cash Flow" data={periods.cashflow} />
      <div style={{ marginTop: 16, fontSize: 11, color: C.dim, fontWeight: 300, lineHeight: 1.5 }}>
        Reported figures from SEC EDGAR XBRL filings (10-K / 10-Q). Line items vary by filer; rows a company doesn&apos;t report are omitted. Quarterly cash flow derived from year-to-date filings.
      </div>
    </Section>
  );
}

// ── Dividends tab — /api/dividends?ticker= (Tiingo EOD divCash). Ex-date + amount only. ──
// Yield is recomputed against the live hero price when available (route's currentPrice = the
// latest Tiingo EOD close is the fallback). Self-fetches on mount.
const fmtDiv = (n) => (n == null || isNaN(n)) ? '—' : `$${(+n).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;

function DividendStat({ label, value, accent }) {
  return (
    <div>
      <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 9, color: C.dim, letterSpacing: '0.6px', marginBottom: 3 }}>{label}</div>
      <div className="cp-num" style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 18, fontWeight: 700, color: accent || C.ink }}>{value}</div>
    </div>
  );
}

function DividendsTab({ symbol, price }) {
  const [state, setState] = useState({ loading: true, error: false, data: null });
  useEffect(() => {
    let alive = true;
    setState({ loading: true, error: false, data: null });
    (async () => {
      try {
        const r = await fetch(`/api/dividends?ticker=${encodeURIComponent(symbol)}`);
        const j = r.ok ? await r.json() : null;
        if (!alive) return;
        if (!j || j.error === true) setState({ loading: false, error: true, data: null });
        else setState({ loading: false, error: false, data: j });
      } catch { if (alive) setState({ loading: false, error: true, data: null }); }
    })();
    return () => { alive = false; };
  }, [symbol]);

  const { loading, error, data } = state;
  if (loading) return <Section title="Dividends"><div>{Array(4).fill(0).map((_, i) => <Skel key={i} h={18} mb={10} />)}</div></Section>;
  if (error) return <Section title="Dividends"><div style={{ padding: '16px 4px', textAlign: 'center', color: C.muted, fontSize: 13 }}>Couldn&apos;t load dividend data right now.</div></Section>;
  if (!data || !data.payer || !data.events?.length) {
    return (
      <Section title="Dividends">
        <div style={{ padding: '32px 16px', textAlign: 'center' }}>
          <div style={{ fontSize: 14, color: C.ink, fontWeight: 600, marginBottom: 4 }}>{symbol} does not currently pay a dividend</div>
          <div style={{ fontSize: 12, color: C.muted, fontWeight: 300 }}>No dividend distributions found in the last {3} years.</div>
        </div>
      </Section>
    );
  }

  // recompute yield against the live hero price when we have it; else fall back to route's value
  const annual = data.ttmDividend;
  const liveYield = (price && price > 0 && annual > 0) ? (annual / price) * 100 : null;
  const shownYield = liveYield != null ? liveYield : data.ttmYield;

  return (
    <Section title="Dividends" badge="Tiingo EOD">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 16,
        paddingBottom: 14, borderBottom: `1px solid ${C.surface}` }}>
        <DividendStat label="TTM YIELD" value={shownYield != null ? `${shownYield.toFixed(2)}%` : '—'} accent={C.green} />
        <DividendStat label="ANNUAL DIVIDEND (TTM)" value={fmtDiv(annual)} />
        <DividendStat label="FREQUENCY" value={data.frequency || '—'} />
        <DividendStat label="MOST RECENT EX-DATE" value={data.mostRecent ? fmtDateLong(data.mostRecent.exDate) : '—'} />
        <DividendStat label="MOST RECENT AMOUNT" value={data.mostRecent ? fmtDiv(data.mostRecent.amount) : '—'} />
      </div>

      <div style={{ marginTop: 14 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${C.border}` }}>
              <th style={{ padding: '8px 4px', textAlign: 'left', fontFamily: "'DM Sans',sans-serif", fontSize: 9, color: C.dim, letterSpacing: '0.8px', fontWeight: 400 }}>EX-DATE</th>
              <th style={{ padding: '8px 4px', textAlign: 'right', fontFamily: "'DM Sans',sans-serif", fontSize: 9, color: C.dim, letterSpacing: '0.8px', fontWeight: 400 }}>AMOUNT</th>
            </tr>
          </thead>
          <tbody>
            {data.events.slice(0, 12).map((e, i) => (
              <tr key={i} style={{ borderBottom: i < Math.min(data.events.length, 12) - 1 ? `1px solid ${C.surface}` : 'none' }}>
                <td className="cp-num" style={{ padding: '10px 4px', fontFamily: "'DM Sans',sans-serif", fontSize: 13, color: C.text, whiteSpace: 'nowrap' }}>{fmtDateLong(e.exDate)}</td>
                <td className="cp-num" style={{ padding: '10px 4px', textAlign: 'right', fontFamily: "'DM Sans',sans-serif", fontSize: 13, fontWeight: 600, color: C.ink, whiteSpace: 'nowrap' }}>{fmtDiv(e.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ marginTop: 12, fontSize: 11, color: C.dim, fontWeight: 300, lineHeight: 1.5 }}>
          Ex-date + amount from Tiingo EOD. Pay/record dates not shown. Yield computed from trailing-12-month dividends ÷ current price.
        </div>
      </div>
    </Section>
  );
}

// ── Press Releases tab — /api/press-releases?ticker= (SEC EDGAR 8-K Exhibit 99.1) ──
// PR-only feed: only 8-Ks that attach a 99.1. Self-fetches on mount (lazy — the ~15 SEC
// index fetches fire only when this tab is opened, not on every ticker page load).
const ITEM_LABELS = {
  '1.01': 'Material agreement', '1.02': 'Agreement termination', '2.01': 'Acquisition / disposition',
  '2.02': 'Results of operations', '2.03': 'Direct financial obligation', '3.02': 'Unregistered equity sale',
  '5.02': 'Officer / director change', '5.03': 'Bylaw amendment', '5.07': 'Shareholder vote',
  '7.01': 'Reg FD disclosure', '8.01': 'Other events', '9.01': 'Financial statements & exhibits',
};
const itemLabel = (code) => ITEM_LABELS[code] || `Item ${code}`;

function PressReleaseCard({ pr }) {
  const [open, setOpen] = useState(false);
  const paras = (pr.bodyText || '').split('\n').map((p) => p.trim()).filter(Boolean);
  const long = paras.length > 3 || (pr.bodyText || '').length > 420;
  const shown = open ? paras : paras.slice(0, 3);
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: '14px 16px', marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <span className="cp-num" style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 11, color: C.dim, whiteSpace: 'nowrap' }}>{fmtDateLong(pr.filingDate)}</span>
        {(pr.items || []).map((code) => (
          <span key={code} style={{ fontSize: 9, background: C.surface, color: C.muted, padding: '2px 7px', borderRadius: 3, fontFamily: "'DM Sans',sans-serif", fontWeight: 500, whiteSpace: 'nowrap' }}>{itemLabel(code)}</span>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: 9, background: '#FFF6E8', color: '#7A5018', padding: '2px 7px', borderRadius: 3, fontFamily: "'DM Sans',sans-serif", fontWeight: 500 }}>8-K · EX-99.1</span>
      </div>
      <a href={pr.filingUrl} target="_blank" rel="noopener noreferrer"
        style={{ fontSize: 15, fontWeight: 700, color: C.ink, lineHeight: 1.35, textDecoration: 'none', display: 'block' }}>
        {pr.headline}
      </a>
      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {shown.map((p, i) => (
          <p key={i} style={{ margin: 0, fontSize: 13, color: C.text, lineHeight: 1.6, fontWeight: 300 }}>{p}</p>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 10 }}>
        {long && (
          <button onClick={() => setOpen((o) => !o)}
            style={{ background: 'transparent', border: 'none', color: C.green, cursor: 'pointer', fontSize: 12, fontFamily: "'DM Sans',sans-serif", fontWeight: 500, padding: 0 }}>
            {open ? 'Show less' : 'Read full release'}
          </button>
        )}
        <a href={pr.filingUrl} target="_blank" rel="noopener noreferrer"
          style={{ fontSize: 11, color: C.dim, textDecoration: 'none', marginLeft: long ? 0 : 'auto' }}>
          View on SEC EDGAR →
        </a>
      </div>
    </div>
  );
}

function PressReleasesTab({ symbol }) {
  const [state, setState] = useState({ loading: true, error: false, list: [] });
  useEffect(() => {
    let alive = true;
    setState({ loading: true, error: false, list: [] });
    (async () => {
      try {
        const r = await fetch(`/api/press-releases?ticker=${encodeURIComponent(symbol)}`);
        const j = r.ok ? await r.json() : null;
        if (!alive) return;
        if (!j || j.error) setState({ loading: false, error: true, list: [] });
        else setState({ loading: false, error: false, list: j.pressReleases || [] });
      } catch { if (alive) setState({ loading: false, error: true, list: [] }); }
    })();
    return () => { alive = false; };
  }, [symbol]);

  return (
    <Section title="Press releases" badge="SEC 8-K">
      {state.loading ? <div>{Array(3).fill(0).map((_, i) => <Skel key={i} h={64} mb={12} />)}</div>
        : state.error ? <div style={{ padding: '16px 4px', textAlign: 'center', color: C.muted, fontSize: 13 }}>Couldn&apos;t load press releases right now.</div>
        : state.list.length === 0 ? <div style={{ padding: '16px 4px', textAlign: 'center', color: C.muted, fontSize: 13 }}>No recent press releases for {symbol}.</div>
        : (
          <>
            {state.list.map((pr, i) => <PressReleaseCard key={i} pr={pr} />)}
            <div style={{ marginTop: 4, fontSize: 11, color: C.dim, fontWeight: 300, lineHeight: 1.5 }}>
              Full press-release text from SEC 8-K Exhibit 99.1 filings (most recent {state.list.length}). Source: SEC EDGAR.
            </div>
          </>
        )}
    </Section>
  );
}

// Earnings tab — /api/earnings?ticker= (SEC EDGAR XBRL). Reported figures only; estimates = Pro.
function EarningsTab({ symbol, earnings }) {
  const loading = earnings == null;
  const rows = earnings?.earnings || [];
  const hasDerived = rows.some((r) => r.derived);
  return (
    <Section title="Earnings history">
      {loading ? <div>{Array(6).fill(0).map((_, i) => <Skel key={i} h={16} mb={10} />)}</div>
        : rows.length === 0 ? <div style={{ padding: '16px 4px', textAlign: 'center', color: C.muted, fontSize: 13 }}>No earnings filings on file for {symbol}.</div>
        : (
          <>
            <EarningsTable rows={rows} />
            <div style={{ marginTop: 12, fontSize: 11, color: C.dim, fontWeight: 300, lineHeight: 1.5 }}>
              Reported figures from SEC filings. Analyst estimates and consensus available with Pro.
              {hasDerived && <><br />↑ Q4 derived from the annual 10-K (full year minus Q1–Q3).</>}
            </div>
          </>
        )}
    </Section>
  );
}

const fmtIpo = (s) => {
  if (!s) return '—';
  const d = new Date(`${String(s).slice(0, 10)}T00:00:00`);
  return isNaN(d.getTime()) ? s : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};
const cleanUrl = (u) => (u || '').replace(/^https?:\/\//, '').replace(/\/$/, '');

// Label-left / value-right row for Key Statistics + About (DM Sans values; link variant for Website).
function DefRow({ label, value, link }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16, padding: '9px 0', borderBottom: `1px solid ${C.surface}` }}>
      <span style={{ fontSize: 12, color: C.muted, whiteSpace: 'nowrap' }}>{label}</span>
      {link
        ? <a href={link} target="_blank" rel="noopener noreferrer" style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 13, color: C.green, textDecoration: 'none', textAlign: 'right', wordBreak: 'break-all' }}>{value}</a>
        : <span className="cp-num" style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 13, fontWeight: 600, color: C.ink, textAlign: 'right' }}>{value}</span>}
    </div>
  );
}

// Overview tab — About + 3-row previews. (Key statistics now live in the always-visible hero.)
function OverviewTab({ data, insider, gov, onTab }) {
  const about = [
    ['Industry', data.industry || '—'],
    ['Exchange', data.exchange || '—'],
    ['Country', data.country || '—'],
    ['IPO Date', fmtIpo(data.ipo)],
  ];
  const newsRows = (data.news || []).slice(0, 3);
  const insRows = (insider?.trades || []).slice(0, 5);
  const govRows = (gov?.trades || []).slice(0, 3);

  return (
    <>
      {/* Bull & Bear synthesis — first Overview section (hero + chart sit above the tab bar). */}
      <BullsBears ticker={data.symbol} />

      <Section title="About">
        <div style={{ maxWidth: 640 }}>
          {about.map(([label, value]) => <DefRow key={label} label={label} value={value} />)}
          <DefRow label="Website" value={data.weburl ? cleanUrl(data.weburl) : '—'} link={data.weburl || null} />
        </div>
      </Section>

      <Section title="News" action={<ViewAll label="View all news" onClick={() => onTab('news')} />}>
        {newsRows.length === 0
          ? <div style={{ padding: '16px 4px', textAlign: 'center', color: C.muted, fontSize: 13 }}>No recent news for {data.symbol}.</div>
          : <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{newsRows.map((n, i) => <NewsRow key={i} n={n} idx={i} />)}</div>}
      </Section>

      <Section title="Insider trades" action={<ViewAll label="View all insider trades" onClick={() => onTab('insider')} />}>
        {insider == null ? <div>{Array(3).fill(0).map((_, i) => <Skel key={i} h={16} mb={10} />)}</div>
          : insRows.length === 0 ? <div style={{ padding: '16px 4px', textAlign: 'center', color: C.muted, fontSize: 13 }}>No insider trades on file for {data.symbol}.</div>
          : <InsiderTable rows={insRows} />}
      </Section>

      <Section title="Government trades" action={<ViewAll label="View all government trades" onClick={() => onTab('government')} />}>
        {gov == null ? <div>{Array(3).fill(0).map((_, i) => <Skel key={i} h={16} mb={10} />)}</div>
          : govRows.length === 0 ? <div style={{ padding: '16px 4px', textAlign: 'center', color: C.muted, fontSize: 13 }}>No government trades on file for {data.symbol}.</div>
          : <GovTable rows={govRows} />}
      </Section>

      <AffiliateStrip />
    </>
  );
}

// Institutions tab — which tracked funds hold this ticker (reverse 13F view). Self-fetches.
function InstitutionsTab({ symbol }) {
  const [state, setState] = useState({ loading: true, error: false, funds: [] });
  useEffect(() => {
    let alive = true;
    setState({ loading: true, error: false, funds: [] });
    (async () => {
      try {
        const r = await fetch(`/api/institutions?ticker=${encodeURIComponent(symbol)}`);
        const j = r.ok ? await r.json() : null;
        if (!alive) return;
        if (!j || j.error) setState({ loading: false, error: true, funds: [] });
        else setState({ loading: false, error: false, funds: j.funds || [] });
      } catch { if (alive) setState({ loading: false, error: true, funds: [] }); }
    })();
    return () => { alive = false; };
  }, [symbol]);

  const { loading, error, funds } = state;
  return (
    <Section title="Institutional holders" badge="13F · SEC">
      {loading ? <div>{Array(6).fill(0).map((_, i) => <Skel key={i} h={16} mb={10} />)}</div>
        : error ? <div style={{ padding: '16px 4px', textAlign: 'center', color: C.muted, fontSize: 13 }}>Couldn&apos;t load institutional holders right now.</div>
        : funds.length === 0 ? <div style={{ padding: '16px 4px', textAlign: 'center', color: C.muted, fontSize: 13 }}>None of the funds we track report holding {symbol}.</div>
        : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
                <thead><tr style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}>
                  {[['Fund', 'left'], ['Shares', 'right'], ['Value', 'right'], ['% of fund', 'right'], ['As of', 'right']].map(([h, al]) => (
                    <th key={h} style={{ padding: '8px 16px', textAlign: al, fontFamily: "'DM Sans',sans-serif", fontSize: 9, color: C.dim, letterSpacing: '0.8px', fontWeight: 400, whiteSpace: 'nowrap' }}>{h.toUpperCase()}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {funds.map((f, i) => {
                    const put = /put/i.test(f.putCall || ''); const call = /call/i.test(f.putCall || '');
                    return (
                      <tr key={i} style={{ borderBottom: i < funds.length - 1 ? `1px solid ${C.surface}` : 'none' }}>
                        <td style={{ padding: '11px 16px' }}>
                          <a href={`/institutions/${f.slug}`} className="sym-lnk" style={{ color: C.ink, textDecoration: 'none', fontWeight: 600, fontSize: 13 }}>{f.label}</a>
                          {(put || call) && <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 3, marginLeft: 6, background: put ? C.redLight : C.greenLight, color: put ? C.red : C.green }}>{f.putCall.toUpperCase()}</span>}
                          <div style={{ fontSize: 11, color: C.muted, fontWeight: 300 }}>{f.manager}</div>
                        </td>
                        <td className="cp-num" style={{ padding: '11px 16px', textAlign: 'right', fontSize: 13, color: C.text, whiteSpace: 'nowrap' }}>{fmtShares(f.shares)}</td>
                        <td className="cp-num" style={{ padding: '11px 16px', textAlign: 'right', fontSize: 13, fontWeight: 600, color: C.ink, whiteSpace: 'nowrap' }}>{fmtBig(f.value)}</td>
                        <td className="cp-num" style={{ padding: '11px 16px', textAlign: 'right', fontSize: 12, color: C.muted, whiteSpace: 'nowrap' }}>{f.pctPort != null ? `${f.pctPort}%` : '—'}</td>
                        <td className="cp-num" style={{ padding: '11px 16px', textAlign: 'right', fontSize: 11, color: C.dim, whiteSpace: 'nowrap' }}>{fmtDateLong(f.quarter)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ marginTop: 12, fontSize: 11, color: C.dim, fontWeight: 300, lineHeight: 1.5 }}>
              From the managers we track on <a href="/institutions" style={{ color: C.green, textDecoration: 'none' }}>Institutions</a> — each fund&apos;s latest 13F (reported up to 45 days after quarter-end). PUT/CALL = options positions (bearish/bullish), not share ownership. Not financial advice.
            </div>
          </>
        )}
    </Section>
  );
}

function TabContent({ tab, data, insider, gov, earnings, short, onTab }) {
  if (tab === 'overview') return <OverviewTab data={data} insider={insider} gov={gov} onTab={onTab} />;
  if (tab === 'news') return <NewsTab data={data} />;
  if (tab === 'press') return <PressReleasesTab symbol={data.symbol} />;
  if (tab === 'dividends') return <DividendsTab symbol={data.symbol} price={data.quote?.c ?? null} />;
  if (tab === 'earnings') return <EarningsTab symbol={data.symbol} earnings={earnings} />;
  if (tab === 'insider') return <InsiderTab symbol={data.symbol} insider={insider} />;
  if (tab === 'government') return <GovernmentTab symbol={data.symbol} gov={gov} />;
  if (tab === 'institutions') return <InstitutionsTab symbol={data.symbol} />;
  if (tab === 'short') return <ShortInterestTab symbol={data.symbol} short={short} />;
  if (tab === 'financials') return <FinancialsTab symbol={data.symbol} />;
  if (PLACEHOLDERS[tab]) {
    const t = TABS.find((x) => x.id === tab);
    return <TabPlaceholder label={t.label} copy={PLACEHOLDERS[tab]} />;
  }
  const t = TABS.find((x) => x.id === tab) || TABS[0];
  return <BuildingStub label={t.label} />;
}

function ValidView({ data, tab, onTab, insider, gov, earnings, short }) {
  return (
    <>
      <Hero data={data} earnings={earnings} />
      <TabBar active={tab} onSelect={onTab} />
      <TabContent tab={tab} data={data} insider={insider} gov={gov} earnings={earnings} short={short} onTab={onTab} />
    </>
  );
}

// ── not-found retry search (polished TopNav SymbolSearch comes in a later step) ──
function RetrySearch() {
  const router = useRouter();
  const [v, setV] = useState('');
  const go = () => { const s = v.trim().toUpperCase(); if (s) router.push(`/ticker/${encodeURIComponent(s)}`); };
  return (
    <div style={{ display: 'flex', gap: 8, marginTop: 18, justifyContent: 'center', flexWrap: 'wrap' }}>
      <input value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()}
        placeholder="Try another symbol (e.g. AAPL)"
        style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 6, padding: '9px 12px',
          fontSize: 13, fontFamily: "'DM Sans',sans-serif", outline: 'none', width: 220, maxWidth: '100%' }} />
      <button onClick={go} style={{ background: C.green, border: 'none', color: '#fff', padding: '9px 16px',
        borderRadius: 6, fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>
        Search
      </button>
    </div>
  );
}

function LoadingShell() {
  return (
    <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: 20 }}>
      <Skel w="180px" h={26} mb={10} /><Skel w="280px" h={14} mb={0} />
    </div>
  );
}

function NotFound({ symbol }) {
  return (
    <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: '48px 24px', textAlign: 'center' }}>
      <div style={{ fontSize: 40, marginBottom: 8 }}>🔍</div>
      <div style={{ fontFamily: "'Cormorant Garamond',serif", fontSize: 26, fontWeight: 600, color: C.ink, marginBottom: 6 }}>No filings yet</div>
      <div style={{ fontSize: 14, color: C.muted, fontWeight: 300 }}>
        We don&apos;t have filings yet for <span style={{ fontFamily: "'DM Sans',sans-serif", color: C.ink, fontWeight: 600 }}>{symbol}</span>. Try another symbol, or check back later.
      </div>
      <RetrySearch />
    </div>
  );
}

// Reads ?tab= for URL state (wrapped in Suspense by TickerPage); fetches the aggregator.
function TickerBody({ symbol }) {
  const router = useRouter();
  const params = useSearchParams();
  const tab = params.get('tab') || 'overview';
  const onTab = (id) => router.push(`/ticker/${encodeURIComponent(symbol)}${id === 'overview' ? '' : `?tab=${id}`}`, { scroll: false });

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [insider, setInsider] = useState(null);   // null = loading; { trades } = loaded
  const [gov, setGov] = useState(null);            // null = loading; { trades } = loaded
  const [earnings, setEarnings] = useState(null);  // null = loading; { earnings:[] } = loaded
  const [short, setShort] = useState(null);        // null = loading; { latest, history } = loaded

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true); setError(null);
      try {
        const r = await fetch(`/api/ticker?symbol=${encodeURIComponent(symbol)}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (alive) setData(j);
      } catch (e) {
        if (alive) { setError(e.message); setData(null); }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [symbol]);

  // Insider + government trades from Postgres (also feed the Overview previews in step 5).
  useEffect(() => {
    let alive = true;
    setInsider(null); setGov(null); setEarnings(null); setShort(null);
    const grab = async (url, set, fallback = { trades: [] }) => {
      try {
        const r = await fetch(url);
        const j = r.ok ? await r.json() : null;
        if (alive) set(j && !j.error ? j : fallback);
      } catch { if (alive) set(fallback); }
    };
    grab(`/api/insiders?ticker=${encodeURIComponent(symbol)}`, setInsider);
    grab(`/api/politicians?ticker=${encodeURIComponent(symbol)}`, setGov);
    grab(`/api/earnings?ticker=${encodeURIComponent(symbol)}`, setEarnings, { earnings: [] });
    grab(`/api/short-interest?ticker=${encodeURIComponent(symbol)}`, setShort, { latest: null, history: [] });
    return () => { alive = false; };
  }, [symbol]);

  if (loading) return <LoadingShell />;
  if (error) return <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, padding: '40px 16px', textAlign: 'center', color: C.red, fontSize: 13 }}>Failed to load {symbol}: {error}</div>;
  if (!data?.valid) return <NotFound symbol={data?.symbol || symbol} />;
  return <ValidView data={data} tab={tab} onTab={onTab} insider={insider} gov={gov} earnings={earnings} short={short} />;
}

export default function TickerPage({ symbol }) {
  return (
    <div style={{ fontFamily: "'DM Sans',sans-serif", background: C.bg, color: C.text, minHeight: '100vh' }}>
      <BrandStyles />
      <TopNav />
      <div style={{ maxWidth: 1440, margin: '0 auto', padding: '24px 24px 40px' }}>
        <Suspense fallback={<LoadingShell />}>
          <TickerBody symbol={symbol} />
        </Suspense>
      </div>
      <Footer />
    </div>
  );
}
