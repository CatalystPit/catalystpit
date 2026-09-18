'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { C, BrandStyles, TopNav, Footer, TickerLogo } from '../../lib/cp-shared';
import { frequencyLabel } from '../../lib/dividends/dividend-event.mjs';

// THE DIVIDEND CALENDAR.
//
// Organised by EX-DIVIDEND DATE, which is the date that decides who receives the dividend and the
// one a trader acts on. The payment date sits beside it in its own column, because they are
// different questions and conflating them is the mistake this page exists to avoid.
//
// A row is an ANNOUNCED event. Nothing here is projected from a company's history: if an issuer has
// not declared its next dividend, it has no row, however reliably it has paid for thirty years.
// A payment date the provider has not published renders as "—" and is never inferred.

const iso = (d) => d.toISOString().slice(0, 10);
const shift = (base, days) => { const d = new Date(`${base}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return iso(d); };
const monthEnd = (base) => { const d = new Date(`${base}T00:00:00Z`); return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))); };
/** Monday of the week a date falls in — the calendar's week runs with the market's. */
const weekStart = (base) => { const d = new Date(`${base}T00:00:00Z`); const dow = (d.getUTCDay() + 6) % 7; return shift(base, -dow); };

const fmtDay = (s) => (s ? new Date(`${s}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }) : '—');
const fmtDow = (s) => (s ? new Date(`${s}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }) : '');
const money = (v, cur) => {
  if (v == null || !Number.isFinite(v)) return '—';
  const sym = !cur || cur === 'USD' ? '$' : '';
  const s = v < 1 ? v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') : v.toFixed(2);
  return `${sym}${s}${sym ? '' : ` ${cur}`}`;
};
const bigCap = (v) => {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v >= 1e12) return `${(v / 1e12).toFixed(1)}T`;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(0)}M`;
  return String(Math.round(v));
};

/** The four ranges a reader actually asks for, plus explicit navigation for anything else. */
function rangeFor(view, anchor) {
  switch (view) {
    case 'today': return { from: anchor, to: anchor };
    case 'week': { const s = weekStart(anchor); return { from: s, to: shift(s, 6) }; }
    case 'next': { const s = shift(weekStart(anchor), 7); return { from: s, to: shift(s, 6) }; }
    case 'month': return { from: anchor, to: monthEnd(anchor) };
    default: return { from: anchor, to: shift(anchor, 6) };
  }
}

const TYPE_TONE = { special: { bg: C.greenLight, fg: C.green, border: C.greenBorder } };

function Tag({ children, tone }) {
  const t = TYPE_TONE[tone] || { bg: C.surface, fg: C.muted, border: C.border };
  return (
    <span style={{ fontSize: 10, fontWeight: 600, color: t.fg, background: t.bg,
      border: `1px solid ${t.border}`, borderRadius: 4, padding: '1px 6px', whiteSpace: 'nowrap' }}>
      {children}
    </span>
  );
}

const TH = ({ children, align = 'left', width }) => (
  <th style={{ textAlign: align, width, fontSize: 10, fontWeight: 600, letterSpacing: '0.04em',
    color: C.dim, textTransform: 'uppercase', padding: '0 10px 7px', whiteSpace: 'nowrap' }}>{children}</th>
);
const TD = ({ children, align = 'left', style }) => (
  <td style={{ textAlign: align, padding: '9px 10px', fontSize: 13, color: C.ink,
    borderTop: `1px solid ${C.border}`, whiteSpace: 'nowrap', ...style }}>{children}</td>
);

export default function DividendsClient({ enabled, initial }) {
  const [view, setView] = useState('week');
  const [anchor, setAnchor] = useState(initial?.from || iso(new Date()));
  const [mode, setMode] = useState(initial?.mode || 'ex');
  const [data, setData] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [minYield, setMinYield] = useState('');
  const first = useRef(true);

  const range = useMemo(() => rangeFor(view, anchor), [view, anchor]);

  const load = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    const p = new URLSearchParams({ from: range.from, to: range.to, mode, limit: '500' });
    if (q.trim()) p.set('q', q.trim());
    if (type) p.set('type', type);
    if (minYield) p.set('minYield', minYield);
    try {
      const r = await fetch(`/api/dividends/calendar?${p}`);
      const j = await r.json();
      setData(j);
    } catch { /* keep what is on screen rather than blanking it */ }
    setLoading(false);
  }, [enabled, range.from, range.to, mode, q, type, minYield]);

  // The server already rendered the opening week, so the first effect must not refetch it.
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const t = setTimeout(load, q ? 250 : 0);   // debounce only the text field
    return () => clearTimeout(t);
  }, [load, q]);

  const events = data?.events || [];
  // Grouped by the date the calendar is organised on, so the eye scans days, not rows.
  const groups = useMemo(() => {
    const key = mode === 'payment' ? 'paymentDate' : 'exDividendDate';
    const m = new Map();
    for (const e of events) {
      const k = e[key] || 'unknown';
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(e);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [events, mode]);

  const Tab = ({ id, label }) => (
    <button onClick={() => { setView(id); setAnchor(iso(new Date())); }}
      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '6px 2px', fontSize: 14,
        fontWeight: view === id ? 700 : 500, color: view === id ? C.ink : C.muted,
        borderBottom: view === id ? `2px solid ${C.green}` : '2px solid transparent',
        fontFamily: "'DM Sans',sans-serif" }}>{label}</button>
  );

  const field = { fontFamily: "'DM Sans',sans-serif", fontSize: 12, color: C.ink, background: C.white,
    border: `1px solid ${C.border}`, borderRadius: 6, padding: '5px 8px' };

  return (
    <div style={{ fontFamily: "'DM Sans',sans-serif", background: C.bg, color: C.text, minHeight: '100vh' }}>
      <BrandStyles />
      <TopNav active="Dividends" />
      <div style={{ maxWidth: 1080, margin: '22px auto', padding: '0 20px 48px' }}>
        <h1 style={{ fontFamily: "'Cormorant Garamond',serif", fontSize: 30, fontWeight: 600, color: C.ink, margin: '0 0 2px' }}>
          Dividend Calendar
        </h1>
        <p style={{ fontSize: 13, color: C.muted, margin: '0 0 14px', fontWeight: 300 }}>
          Announced dividends, organised by {mode === 'payment' ? 'payment date' : 'ex-dividend date'}.
          Only events a company has actually declared — nothing here is estimated from past payments.
        </p>

        {!enabled ? (
          <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: '40px 24px', textAlign: 'center' }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: C.ink, marginBottom: 6 }}>Coming soon</div>
            <div style={{ fontSize: 13, color: C.muted, maxWidth: 460, margin: '0 auto', lineHeight: 1.6 }}>
              The dividend calendar is built and loading data. It opens once its market-data source is
              finalised.
            </div>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 20, alignItems: 'center', borderBottom: `1px solid ${C.border}`, marginBottom: 12, flexWrap: 'wrap' }}>
              <Tab id="today" label="Today" />
              <Tab id="week" label="This Week" />
              <Tab id="next" label="Next Week" />
              <Tab id="month" label="This Month" />
              <div style={{ flex: 1 }} />
              {/* Ex-dividend is the default axis; payment date is the same query on another index. */}
              <div style={{ display: 'flex', gap: 0, marginBottom: 6, border: `1px solid ${C.border}`, borderRadius: 6, overflow: 'hidden' }}>
                {[['ex', 'Ex-Dividend'], ['payment', 'Payment']].map(([id, label]) => (
                  <button key={id} onClick={() => setMode(id)}
                    style={{ border: 'none', cursor: 'pointer', fontSize: 11, padding: '5px 10px',
                      fontFamily: "'DM Sans',sans-serif", fontWeight: mode === id ? 600 : 400,
                      background: mode === id ? C.surface : C.white, color: mode === id ? C.ink : C.muted }}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
              <button onClick={() => setAnchor(shift(anchor, view === 'month' ? -30 : -7))}
                style={{ ...field, cursor: 'pointer' }} aria-label="Earlier">←</button>
              <input type="date" value={anchor} onChange={(e) => e.target.value && setAnchor(e.target.value)} style={field} />
              <button onClick={() => setAnchor(shift(anchor, view === 'month' ? 30 : 7))}
                style={{ ...field, cursor: 'pointer' }} aria-label="Later">→</button>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ticker or company"
                style={{ ...field, minWidth: 170 }} />
              <select value={type} onChange={(e) => setType(e.target.value)} style={field}>
                <option value="">All types</option>
                <option value="regular">Regular</option>
                <option value="special">Special</option>
              </select>
              <select value={minYield} onChange={(e) => setMinYield(e.target.value)} style={field}>
                <option value="">Any yield</option>
                <option value="2">Yield 2%+</option>
                <option value="4">Yield 4%+</option>
                <option value="6">Yield 6%+</option>
              </select>
              <span style={{ fontSize: 11, color: C.dim, marginLeft: 'auto' }}>
                {loading ? 'Loading…' : `${data?.total ?? events.length} event${(data?.total ?? events.length) === 1 ? '' : 's'} · ${range.from} → ${range.to}`}
              </span>
            </div>

            {events.length === 0 ? (
              <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: '40px 20px', textAlign: 'center', color: C.muted, fontSize: 13 }}>
                {loading ? 'Loading…' : 'No announced dividends in this range.'}
              </div>
            ) : groups.map(([date, rows]) => (
              <div key={date} style={{ marginBottom: 18 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: C.ink, margin: '0 0 6px 2px' }}>
                  {date === 'unknown' ? 'Date not published' : fmtDow(date)}
                  <span style={{ color: C.dim, fontWeight: 400 }}> · {rows.length}</span>
                </div>
                <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
                    <thead><tr>
                      <TH width={150}>Symbol</TH>
                      <TH>Company</TH>
                      <TH align="right" width={92}>Amount</TH>
                      <TH align="right" width={70}>Yield</TH>
                      <TH align="right" width={88}>{mode === 'payment' ? 'Ex-Div' : 'Payment'}</TH>
                      <TH align="right" width={96}>Frequency</TH>
                      <TH align="right" width={90}>Mkt cap</TH>
                      <TH align="right" width={72}>Type</TH>
                    </tr></thead>
                    <tbody>
                      {rows.map((e, i) => (
                        <tr key={`${e.ticker}-${e.exDividendDate}-${i}`}>
                          <TD>
                            <a href={`/ticker/${encodeURIComponent(e.ticker)}`}
                              style={{ display: 'flex', alignItems: 'center', gap: 8, textDecoration: 'none' }}>
                              <TickerLogo symbol={e.ticker} size={22} />
                              <span className="cp-tkr" style={{ fontWeight: 700, color: C.ink }}>{e.ticker}</span>
                            </a>
                          </TD>
                          <TD style={{ color: C.muted, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {e.company || '—'}
                          </TD>
                          <TD align="right" style={{ fontWeight: 600 }}>{money(e.cashAmount, e.currency)}</TD>
                          {/* Omitted, not zeroed, when the stored price cannot support it. */}
                          <TD align="right" style={{ color: e.yieldPct == null ? C.dim : C.ink }}>
                            {e.yieldPct == null ? '—' : `${e.yieldPct.toFixed(2)}%`}
                          </TD>
                          {/* The other date. NEVER inferred — "—" when the provider has not published one. */}
                          <TD align="right" style={{ color: C.muted }}>
                            {fmtDay(mode === 'payment' ? e.exDividendDate : e.paymentDate)}
                          </TD>
                          <TD align="right" style={{ color: C.muted }}>{frequencyLabel(e.frequency)}</TD>
                          <TD align="right" style={{ color: C.muted }}>{bigCap(e.marketCap)}</TD>
                          <TD align="right">
                            {e.dividendType === 'special' ? <Tag tone="special">Special</Tag>
                              : e.dividendType === 'capital_gain' ? <Tag>Cap gain</Tag>
                                : <span style={{ fontSize: 11, color: C.dim }}>Regular</span>}
                          </TD>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}

            {data?.asOf && (
              <div style={{ fontSize: 11, color: C.dim, marginTop: 10 }}>
                Announced events only. Last synced {new Date(data.asOf).toLocaleString()}.
              </div>
            )}
          </>
        )}
      </div>
      <Footer />
    </div>
  );
}
