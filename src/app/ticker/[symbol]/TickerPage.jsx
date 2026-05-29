'use client';
import { Suspense, useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { C, Skel, Dot, CARD_COLORS, timeAgo, minsSince, TopNav, Footer, BrandStyles } from '../../../lib/cp-shared';

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
  { id: 'earnings',   label: 'Earnings' },
  { id: 'options',    label: 'Options Flow' },
  { id: 'guidance',   label: 'Guidance' },
  { id: 'dividends',  label: 'Dividends' },
  { id: 'analyst',    label: 'Analyst Ratings' },
  { id: 'insider',    label: 'Insider Trades' },
  { id: 'short',      label: 'Short Interest' },
  { id: 'government', label: 'Government Trades' },
  { id: 'financials', label: 'Financials' },
];
const PLACEHOLDERS = {
  earnings:   'Quarterly EPS estimates, actuals, surprise percentage, and earnings history.',
  options:    'Unusual options activity — large call and put buys, premium volume, and bullish/bearish flow signals.',
  guidance:   'Company-issued forward guidance, revenue and EPS forecasts, and guidance revisions.',
  dividends:  'Dividend history, payout schedule, ex-dividend dates, and yield trends.',
  analyst:    'Wall Street analyst ratings, price targets, upgrades, downgrades, and consensus forecasts.',
  short:      'Short interest, days to cover, short interest ratio, and shorting trends over time.',
  financials: 'Quarterly and annual revenue, earnings, cash flows, valuation metrics, and company debt.',
};

// ── primitives ──
function StatCell({ label, value }) {
  return (
    <div>
      <div style={{ fontFamily: "'DM Mono',monospace", fontSize: 9, color: C.dim, letterSpacing: '0.6px', marginBottom: 3 }}>{label}</div>
      <div className="cp-num" style={{ fontFamily: "'DM Mono',monospace", fontSize: 14, fontWeight: 600, color: C.ink }}>{value}</div>
    </div>
  );
}

// White card with a header bar (Dot + title) — shared shell for hero chart + tab sections.
function Section({ title, badge, action, children }) {
  return (
    <div style={{ marginTop: 14, background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '10px 16px', borderBottom: `1px solid ${C.border}`, background: C.surface, display: 'flex', alignItems: 'center', gap: 7 }}>
        <Dot /><span style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>{title}</span>
        {badge && <span style={{ fontSize: 9, background: '#FFF6E8', color: '#7A5018', padding: '2px 7px', borderRadius: 3, fontFamily: "'DM Mono',monospace", fontWeight: 500 }}>{badge}</span>}
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

// Mirrors /news NewsRowCard (thumb + source·time + 2-line headline), minus tag/ticker chips.
function NewsRow({ n, idx }) {
  const [bg1, bg2] = CARD_COLORS[idx % CARD_COLORS.length];
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = n.image && !imgFailed;
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
          <span style={{ fontFamily: "'DM Mono',monospace", fontSize: 10, color: C.dim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.source}</span>
          {n.datetime && <span className="cp-num" style={{ marginLeft: 'auto', fontFamily: "'DM Mono',monospace", fontSize: 10, color: C.dim, whiteSpace: 'nowrap' }}>{newsTime(n.datetime)}</span>}
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

// ── HERO (always visible, above tabs): header + price/5-stat + chart placeholder ──
function Hero({ data }) {
  const q = data.quote || {};
  const m = data.metric || {};
  const up = (q.dp ?? 0) >= 0;
  return (
    <>
      {/* identity */}
      <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: '20px 22px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <span className="cp-tkr" style={{ fontFamily: "'DM Mono',monospace", fontSize: 26, fontWeight: 700, color: C.green }}>{data.symbol}</span>
          <span style={{ fontSize: 18, fontWeight: 600, color: C.ink }}>{data.name}</span>
        </div>
        <div style={{ fontFamily: "'DM Mono',monospace", fontSize: 11, color: C.dim, marginTop: 4, letterSpacing: '0.5px' }}>
          {data.exchange || '—'}{data.industry ? ` · ${data.industry}` : ''}
        </div>
      </div>

      {/* price + 5-stat */}
      <div style={{ marginTop: 14, background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: '20px 22px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
          <span className="cp-num" style={{ fontFamily: "'DM Mono',monospace", fontSize: 34, fontWeight: 700, color: C.ink }}>{usd(q.c)}</span>
          {q.c != null && q.dp != null && (
            <span className="cp-num" style={{ fontFamily: "'DM Mono',monospace", fontSize: 15, fontWeight: 700,
              color: up ? C.green : C.red, background: up ? C.greenLight : C.redLight, padding: '3px 10px', borderRadius: 5 }}>
              {up ? '▲' : '▼'} {q.d >= 0 ? '+' : ''}{fmtNum(q.d)} ({q.dp >= 0 ? '+' : ''}{fmtNum(q.dp)}%)
            </span>
          )}
        </div>
        <div style={{ fontFamily: "'DM Mono',monospace", fontSize: 11, color: C.dim, marginTop: 6 }}>
          Day {usd(q.l)} – {usd(q.h)} · Prev close {usd(q.pc)}
        </div>
        <div style={{ marginTop: 18, paddingTop: 16, borderTop: `1px solid ${C.surface}`,
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 16 }}>
          <StatCell label="52-WEEK RANGE" value={(m.low52 != null && m.high52 != null) ? `${usd(m.low52)} – ${usd(m.high52)}` : '—'} />
          <StatCell label="MARKET CAP"    value={fmtMktCap(m.marketCap)} />
          <StatCell label="P/E (TTM)"     value={fmtNum(m.peTTM)} />
          <StatCell label="DIV YIELD"     value={fmtPct(m.divYield)} />
          <StatCell label="AVG VOL (10D)" value={fmtVolM(m.avgVol10d)} />
        </div>
      </div>

      {/* chart placeholder (real chart = Session 2) */}
      <Section title="Price chart">
        <div style={{ padding: '36px 24px', textAlign: 'center', color: C.muted, fontSize: 14, fontStyle: 'italic', fontWeight: 300 }}>
          Interactive chart with insider and congress trade markers — launching this week.
        </div>
      </Section>
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
            <th key={h} style={{ padding: '8px 16px', textAlign: al, fontFamily: "'DM Mono',monospace", fontSize: 9, color: C.dim, letterSpacing: '0.8px', fontWeight: 400, whiteSpace: 'nowrap' }}>{h.toUpperCase()}</th>
          ))}
        </tr></thead>
        <tbody>
          {rows.map((r, i) => {
            const as = actionStyle(r.action);
            return (
              <tr key={r.id || i} style={{ borderBottom: i < rows.length - 1 ? `1px solid ${C.surface}` : 'none', borderLeft: `3px solid ${as.fg}` }}>
                <td className="cp-num" style={{ padding: '11px 16px', fontFamily: "'DM Mono',monospace", fontSize: 11, color: C.dim, whiteSpace: 'nowrap' }}>{r.filingDate || '—'}</td>
                <td className="cp-tkr" style={{ padding: '11px 16px', fontFamily: "'DM Mono',monospace", fontSize: 13, fontWeight: 700, color: C.green }}>{r.ticker || '—'}</td>
                <td style={{ padding: '11px 16px', fontSize: 13, color: C.text, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{decodeEntities(r.company || '')}</td>
                <td style={{ padding: '11px 16px', fontSize: 13, color: C.text }}>
                  <div>{decodeEntities(r.executive || '')}</div>
                  {r.title && <div style={{ fontSize: 11, color: C.muted, fontWeight: 300, marginTop: 2 }}>{decodeEntities(r.title)}</div>}
                </td>
                <td style={{ padding: '11px 16px' }}>
                  <span style={{ fontSize: 10, padding: '3px 9px', borderRadius: 3, fontFamily: "'DM Mono',monospace", fontWeight: 600, background: as.bg, color: as.fg }}>{r.action}</span>
                </td>
                <td className="cp-num" style={{ padding: '11px 16px', textAlign: 'right', fontFamily: "'DM Mono',monospace", fontSize: 13, fontWeight: 500, color: C.text, whiteSpace: 'nowrap' }}>{r.shares > 0 ? Number(r.shares).toLocaleString('en-US') : '—'}</td>
                <td className="cp-num" style={{ padding: '11px 16px', textAlign: 'right', fontFamily: "'DM Mono',monospace", fontSize: 13, fontWeight: 500, color: C.muted, whiteSpace: 'nowrap' }}>{usd(r.pricePerShare)}</td>
                <td className="cp-num" style={{ padding: '11px 16px', textAlign: 'right', fontFamily: "'DM Mono',monospace", fontSize: 14, fontWeight: 700, color: as.fg, whiteSpace: 'nowrap' }}>{fmtMoney(r.totalValue)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Insider Trades tab — /api/insiders?ticker=.
function InsiderTab({ symbol, insider }) {
  const loading = insider == null;
  const rows = insider?.trades || [];
  return (
    <Section title="Insider trades">
      {loading ? <div>{Array(6).fill(0).map((_, i) => <Skel key={i} h={16} mb={10} />)}</div>
        : rows.length === 0 ? <div style={{ padding: '16px 4px', textAlign: 'center', color: C.muted, fontSize: 13 }}>No insider trades on file for {symbol}.</div>
        : <InsiderTable rows={rows} />}
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
            <th key={h} style={{ padding: '8px 16px', textAlign: al, fontFamily: "'DM Mono',monospace", fontSize: 9, color: C.dim, letterSpacing: '0.8px', fontWeight: 400, whiteSpace: 'nowrap' }}>{h.toUpperCase()}</th>
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
                <td className="cp-num" style={{ padding: '11px 16px', fontFamily: "'DM Mono',monospace", fontSize: 11, color: C.dim, whiteSpace: 'nowrap' }}>{r.transactionDate || '—'}</td>
                <td style={{ padding: '11px 16px', fontSize: 13, color: C.text, minWidth: 160 }}>
                  <div>
                    {matched
                      ? <a href={`/politicians/${r.slug}`} className="sym-lnk" style={{ color: C.text, textDecoration: 'none', fontWeight: 500 }}>{r.representative || '—'}</a>
                      : <span style={{ fontWeight: 500 }}>{r.representative || '—'}</span>}
                  </div>
                  <div style={{ display: 'flex', gap: 5, marginTop: 4 }}>
                    <span style={{ fontFamily: "'DM Mono',monospace", fontSize: 9, fontWeight: 600, background: ps.bg, color: ps.fg, padding: '2px 6px', borderRadius: 3 }}>{ps.abbr}</span>
                    {r.state && <span style={{ fontFamily: "'DM Mono',monospace", fontSize: 9, fontWeight: 600, background: C.surface, color: C.muted, padding: '2px 6px', borderRadius: 3 }}>{r.state}</span>}
                  </div>
                </td>
                <td style={{ padding: '11px 16px', fontSize: 12, color: C.muted, whiteSpace: 'nowrap' }}>{chamberLabel(r.chamber)}</td>
                <td style={{ padding: '11px 16px' }}>
                  <span style={{ fontSize: 10, padding: '3px 9px', borderRadius: 3, fontFamily: "'DM Mono',monospace", fontWeight: 600, background: as.bg, color: as.fg }}>{r.action}</span>
                </td>
                <td className="cp-num" style={{ padding: '11px 16px', textAlign: 'right', fontFamily: "'DM Mono',monospace", fontSize: 12, color: C.text, whiteSpace: 'nowrap' }}>{r.amountRange || '—'}</td>
                <td className="cp-num" style={{ padding: '11px 16px', textAlign: 'right', fontFamily: "'DM Mono',monospace", fontSize: 12, color: C.muted, whiteSpace: 'nowrap' }}>{usd(r.priceAtTrade)}</td>
                <td className="cp-num" style={{ padding: '11px 16px', textAlign: 'right', fontFamily: "'DM Mono',monospace", fontSize: 12, color: C.muted, whiteSpace: 'nowrap' }}>{usd(r.currentPrice)}</td>
                <td className="cp-num" style={{ padding: '11px 16px', textAlign: 'right', fontFamily: "'DM Mono',monospace", fontSize: 13, fontWeight: 700, color: retColor(ret), whiteSpace: 'nowrap' }}>{fmtRet(ret)}</td>
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
  const loading = gov == null;
  const rows = gov?.trades || [];
  return (
    <Section title="Government trades">
      {loading ? <div>{Array(6).fill(0).map((_, i) => <Skel key={i} h={16} mb={10} />)}</div>
        : rows.length === 0 ? <div style={{ padding: '16px 4px', textAlign: 'center', color: C.muted, fontSize: 13 }}>No government trades on file for {symbol}.</div>
        : <GovTable rows={rows} />}
    </Section>
  );
}

const fmtIpo = (s) => {
  if (!s) return '—';
  const d = new Date(`${String(s).slice(0, 10)}T00:00:00`);
  return isNaN(d.getTime()) ? s : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};
const cleanUrl = (u) => (u || '').replace(/^https?:\/\//, '').replace(/\/$/, '');

// Label-left / value-right row for Key Statistics + About (DM Mono values; link variant for Website).
function DefRow({ label, value, link }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16, padding: '9px 0', borderBottom: `1px solid ${C.surface}` }}>
      <span style={{ fontSize: 12, color: C.muted, whiteSpace: 'nowrap' }}>{label}</span>
      {link
        ? <a href={link} target="_blank" rel="noopener noreferrer" style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 13, color: C.green, textDecoration: 'none', textAlign: 'right', wordBreak: 'break-all' }}>{value}</a>
        : <span className="cp-num" style={{ fontFamily: "'DM Mono',monospace", fontSize: 13, fontWeight: 600, color: C.ink, textAlign: 'right' }}>{value}</span>}
    </div>
  );
}

// Overview tab — expanded Key Statistics (9; Volume returns in Session 2) + About + 3-row previews.
function OverviewTab({ data, insider, gov, onTab }) {
  const q = data.quote || {};
  const m = data.metric || {};
  // Volume returns in Session 2 once Tiingo candle cache exists (Finnhub /quote has no volume).
  const stats = [
    ['Open', usd(q.o)],
    ['Previous Close', usd(q.pc)],
    ['Day Range', (q.l != null && q.h != null) ? `${usd(q.l)} – ${usd(q.h)}` : '—'],
    ['52-Week Range', (m.low52 != null && m.high52 != null) ? `${usd(m.low52)} – ${usd(m.high52)}` : '—'],
    ['Avg Volume (10D)', fmtVolM(m.avgVol10d)],
    ['Market Cap', fmtMktCap(m.marketCap)],
    ['P/E Ratio (TTM)', fmtNum(m.peTTM)],
    ['Dividend Yield', fmtPct(m.divYield)],
    ['Exchange', data.exchange || '—'],
  ];
  const about = [
    ['Industry', data.industry || '—'],
    ['Exchange', data.exchange || '—'],
    ['Country', data.country || '—'],
    ['IPO Date', fmtIpo(data.ipo)],
  ];
  const newsRows = (data.news || []).slice(0, 3);
  const insRows = (insider?.trades || []).slice(0, 3);
  const govRows = (gov?.trades || []).slice(0, 3);

  return (
    <>
      <Section title="Key statistics">
        <div className="tk-keystats">
          {stats.map(([label, value]) => <DefRow key={label} label={label} value={value} />)}
        </div>
      </Section>

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
    </>
  );
}

function TabContent({ tab, data, insider, gov, onTab }) {
  if (tab === 'overview') return <OverviewTab data={data} insider={insider} gov={gov} onTab={onTab} />;
  if (tab === 'news') return <NewsTab data={data} />;
  if (tab === 'insider') return <InsiderTab symbol={data.symbol} insider={insider} />;
  if (tab === 'government') return <GovernmentTab symbol={data.symbol} gov={gov} />;
  if (PLACEHOLDERS[tab]) {
    const t = TABS.find((x) => x.id === tab);
    return <TabPlaceholder label={t.label} copy={PLACEHOLDERS[tab]} />;
  }
  const t = TABS.find((x) => x.id === tab) || TABS[0];
  return <BuildingStub label={t.label} />;
}

function ValidView({ data, tab, onTab, insider, gov }) {
  return (
    <>
      <Hero data={data} />
      <TabBar active={tab} onSelect={onTab} />
      <TabContent tab={tab} data={data} insider={insider} gov={gov} onTab={onTab} />
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
      <div style={{ fontFamily: "'Cormorant Garamond',serif", fontSize: 26, fontWeight: 600, color: C.ink, marginBottom: 6 }}>Ticker not found</div>
      <div style={{ fontSize: 14, color: C.muted, fontWeight: 300 }}>
        We couldn&apos;t find a ticker matching <span style={{ fontFamily: "'DM Mono',monospace", color: C.ink, fontWeight: 600 }}>{symbol}</span>.
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
    setInsider(null); setGov(null);
    const grab = async (url, set) => {
      try {
        const r = await fetch(url);
        const j = r.ok ? await r.json() : null;
        if (alive) set(j && !j.error ? j : { trades: [] });
      } catch { if (alive) set({ trades: [] }); }
    };
    grab(`/api/insiders?ticker=${encodeURIComponent(symbol)}`, setInsider);
    grab(`/api/politicians?ticker=${encodeURIComponent(symbol)}`, setGov);
    return () => { alive = false; };
  }, [symbol]);

  if (loading) return <LoadingShell />;
  if (error) return <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, padding: '40px 16px', textAlign: 'center', color: C.red, fontSize: 13 }}>Failed to load {symbol}: {error}</div>;
  if (!data?.valid) return <NotFound symbol={data?.symbol || symbol} />;
  return <ValidView data={data} tab={tab} onTab={onTab} insider={insider} gov={gov} />;
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
