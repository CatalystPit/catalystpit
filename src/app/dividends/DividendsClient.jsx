'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { C, BrandStyles, TopNav, Footer, TickerLogo } from '../../lib/cp-shared';
import { frequencyLabel } from '../../lib/dividends/dividend-event.mjs';
import { SECTORS } from '../../lib/screener-filters';
import { useTickerHover, TickerHoverPreview } from '../../components/TickerHoverChart';
import InfoTip from '../../components/InfoTip';
import {
  iso, shiftDays, rangeFor, stepFor, sortEvents, groupByDate, calendarQuery, EMPTY_FILTERS, COLUMN_HELP,
} from '../../lib/dividends/dividend-view.mjs';

// THE DIVIDEND CALENDAR.
//
// Organised by EX-DIVIDEND DATE, because that is the date that decides who receives the dividend and
// the one a trader acts on. The payment date sits beside it in its own column — they are different
// questions, and conflating them is the mistake this page exists to avoid.
//
// Every row is an ANNOUNCED event. Nothing is projected from a company's history: a business that
// has paid quarterly for thirty years has no row here until it declares. A date the provider has not
// published renders "—" and is never inferred from the others.
//
// The date logic, sorting and grouping live in dividend-view.mjs so they can be tested without a
// browser; this file is layout, controls and state.

const fmtDay = (s) => (s ? new Date(`${s}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }) : '—');
const fmtLong = (s) => (s ? new Date(`${s}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }) : '');
const money = (v, cur) => {
  if (v == null || !Number.isFinite(v)) return '—';
  const sym = !cur || cur === 'USD' ? '$' : '';
  const s = v < 1 ? v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') : v.toFixed(2);
  return sym ? `${sym}${s}` : `${s} ${cur}`;
};
const bigCap = (v) => {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v >= 1e12) return `${(v / 1e12).toFixed(1)}T`;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(0)}M`;
  return String(Math.round(v));
};

function Tag({ children, tone }) {
  const t = tone === 'special'
    ? { bg: C.greenLight, fg: C.green, border: C.greenBorder }
    : { bg: C.surface, fg: C.muted, border: C.border };
  return (
    <span style={{ fontSize: 10, fontWeight: 600, color: t.fg, background: t.bg,
      border: `1px solid ${t.border}`, borderRadius: 4, padding: '1px 6px', whiteSpace: 'nowrap' }}>{children}</span>
  );
}

const TD = ({ children, align = 'left', style }) => (
  <td style={{ textAlign: align, padding: '9px 10px', fontSize: 13, color: C.ink,
    borderTop: `1px solid ${C.border}`, whiteSpace: 'nowrap', ...style }}>{children}</td>
);

export default function DividendsClient({ enabled, display = 'prelaunch', initial }) {
  const [view, setView] = useState('week');
  const [anchor, setAnchor] = useState(initial?.from || iso(new Date()));
  const [mode, setMode] = useState(initial?.mode || 'ex');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [sort, setSort] = useState({ key: null, dir: 'asc' });
  const [data, setData] = useState(initial);
  const [status, setStatus] = useState('ready');        // ready | loading | error
  // Finviz-style ticker-hover daily-chart preview — the same component and behaviour as the Screener.
  const { hover, bind: bindHover } = useTickerHover();
  const first = useRef(true);

  const range = useMemo(() => rangeFor(view, anchor), [view, anchor]);
  const setFilter = (k, v) => setFilters((f) => ({ ...f, [k]: v }));

  const load = useCallback(async () => {
    if (!enabled) return;
    setStatus('loading');
    try {
      const r = await fetch(`/api/dividends/calendar?${calendarQuery({ ...range, mode, filters })}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setData(j);
      setStatus('ready');
    } catch {
      // The board is not blanked on a failure — the previous answer stays on screen and the state is
      // named, because an empty table and a broken request look identical and mean opposite things.
      setStatus('error');
    }
  }, [enabled, range.from, range.to, mode, filters]);   // eslint-disable-line react-hooks/exhaustive-deps

  // The server already rendered the opening week; the first effect must not refetch it.
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const t = setTimeout(load, filters.q ? 250 : 0);     // debounce only the text field
    return () => clearTimeout(t);
  }, [load, filters.q]);

  const events = data?.events || [];
  const sorted = useMemo(() => (sort.key ? sortEvents(events, sort.key, sort.dir) : events), [events, sort]);
  // A sorted board is one list: re-grouping it by day would put the days back in date order and
  // undo the sort the reader just asked for.
  const groups = useMemo(() => (sort.key ? null : groupByDate(events, mode)), [events, mode, sort.key]);

  const toggleSort = (key) => setSort((s) => (s.key === key
    ? (s.dir === 'asc' ? { key, dir: 'desc' } : { key: null, dir: 'asc' })
    : { key, dir: 'asc' }));

  const Tab = ({ id, label }) => (
    <button onClick={() => { setView(id); setAnchor(iso(new Date())); }}
      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '6px 2px', fontSize: 14,
        fontWeight: view === id ? 700 : 500, color: view === id ? C.ink : C.muted,
        borderBottom: view === id ? `2px solid ${C.green}` : '2px solid transparent',
        fontFamily: "'DM Sans',sans-serif" }}>{label}</button>
  );

  const field = { fontFamily: "'DM Sans',sans-serif", fontSize: 12, color: C.ink, background: C.white,
    border: `1px solid ${C.border}`, borderRadius: 6, padding: '5px 8px' };
  const btn = { ...field, cursor: 'pointer' };

  // The help text is looked up by the column's OWN sort key, so a column cannot acquire an
  // explanation it does not have a definition for, and Symbol/Company/Type simply have none.
  const TH = ({ children, align = 'left', width, sortKey }) => {
    const help = sortKey ? COLUMN_HELP[sortKey] : null;
    return (
      <th onClick={sortKey ? () => toggleSort(sortKey) : undefined}
        title={sortKey ? 'Sort' : undefined}
        style={{ textAlign: align, width, fontSize: 10, fontWeight: 600, letterSpacing: '0.04em',
          color: sort.key === sortKey ? C.ink : C.dim, textTransform: 'uppercase',
          padding: '0 10px 7px', whiteSpace: 'nowrap', cursor: sortKey ? 'pointer' : 'default',
          userSelect: 'none' }}>
        {/* Inline-flex rather than trailing text, so the icon sits on the label's baseline and a
            right-aligned numeric header keeps its alignment with the column beneath it. */}
        <span style={{ display: 'inline-flex', alignItems: 'center',
          justifyContent: align === 'right' ? 'flex-end' : 'flex-start' }}>
          {children}{sortKey && sort.key === sortKey ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
          {help && <InfoTip title={help.title} body={help.body} label={help.title} />}
        </span>
      </th>
    );
  };

  const Row = ({ e }) => (
    <tr>
      <TD>
        {/* Hovering pops the shared daily-chart preview; the link itself is untouched, so clicking
            (or tabbing to and activating) the symbol still opens its Catalyst Pit page. */}
        <a href={`/ticker/${encodeURIComponent(e.ticker)}`} {...bindHover(e.ticker)}
          style={{ display: 'flex', alignItems: 'center', gap: 8, textDecoration: 'none' }}>
          <TickerLogo symbol={e.ticker} size={22} />
          <span className="cp-tkr" style={{ fontWeight: 700, color: C.ink }}>{e.ticker}</span>
        </a>
      </TD>
      <TD style={{ color: C.muted, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.company || '—'}</TD>
      <TD align="right" style={{ fontWeight: 600 }}>{money(e.cashAmount, e.currency)}</TD>
      <TD align="right" style={{ color: e.yieldPct == null ? C.dim : C.ink }}>
        {e.yieldPct == null ? '—' : `${e.yieldPct.toFixed(2)}%`}
      </TD>
      {/* All four dates. A date the provider has not published shows "—" and is NEVER inferred. */}
      <TD align="right" style={{ color: C.muted }}>{fmtDay(e.exDividendDate)}</TD>
      <TD align="right" style={{ color: C.muted }}>{fmtDay(e.paymentDate)}</TD>
      <TD align="right" style={{ color: C.muted }}>{fmtDay(e.recordDate)}</TD>
      <TD align="right" style={{ color: C.muted }}>{fmtDay(e.declarationDate)}</TD>
      <TD align="right" style={{ color: C.muted }}>{frequencyLabel(e.frequency)}</TD>
      {/* ⚠️ "n/a" IS NOT THE SAME STATEMENT AS "—". An ETF has no market capitalisation — it has
          net assets, a different quantity we do not publish here — so a blank cell claimed we had
          failed to find a number that does not exist. Measured: 3,294 of the 5,142 blank cells on
          this calendar are ETFs. The dimmer tone keeps it quieter than a real value, using the
          palette the table already uses for absent data. */}
      <TD align="right" style={{ color: e.marketCapApplies === false ? C.dim : C.muted }}>
        {e.marketCapApplies === false && e.marketCap == null ? 'n/a' : bigCap(e.marketCap)}
      </TD>
      <TD align="right">
        {e.dividendType === 'special' ? <Tag tone="special">Special</Tag>
          : e.dividendType === 'capital_gain' ? <Tag>Cap gain</Tag>
            : <span style={{ fontSize: 11, color: C.dim }}>Regular</span>}
      </TD>
    </tr>
  );

  const Head = () => (
    <thead><tr>
      <TH width={140} sortKey="ticker">Symbol</TH>
      <TH sortKey="company">Company</TH>
      <TH align="right" width={88} sortKey="cashAmount">Amount</TH>
      <TH align="right" width={68} sortKey="yieldPct">Yield</TH>
      <TH align="right" width={82} sortKey="exDividendDate">Ex-Div</TH>
      <TH align="right" width={82} sortKey="paymentDate">Payment</TH>
      <TH align="right" width={82} sortKey="recordDate">Record</TH>
      <TH align="right" width={82} sortKey="declarationDate">Declared</TH>
      <TH align="right" width={92} sortKey="frequency">Frequency</TH>
      <TH align="right" width={84} sortKey="marketCap">Mkt cap</TH>
      <TH align="right" width={70}>Type</TH>
    </tr></thead>
  );

  const total = data?.total ?? events.length;

  return (
    <div style={{ fontFamily: "'DM Sans',sans-serif", background: C.bg, color: C.text, minHeight: '100vh' }}>
      <BrandStyles />
      <TopNav active="Dividends" />
      <div style={{ maxWidth: 1180, margin: '22px auto', padding: '0 20px 48px' }}>
        <h1 style={{ fontFamily: "'Cormorant Garamond',serif", fontSize: 30, fontWeight: 600, color: C.ink, margin: '0 0 2px' }}>
          Dividend Calendar
        </h1>
        <p style={{ fontSize: 13, color: C.muted, margin: '0 0 14px', fontWeight: 300 }}>
          Announced dividends, organised by {mode === 'payment' ? 'payment date' : 'ex-dividend date'}.
          Only events a company has actually declared — nothing here is estimated from past payments.
        </p>

        {/* PRE-LAUNCH. Real data, from a TEMPORARY source whose redistribution rights are not
            confirmed. Stated on the page rather than only in a config file, because the person
            looking at it is the one who has to decide whether it may ever be published. */}
        {enabled && display === 'prelaunch' && (
          <div style={{ background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 8,
            padding: '8px 12px', marginBottom: 12, fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
            <strong style={{ color: C.ink, fontWeight: 600 }}>Pre-launch preview.</strong>{' '}
            Live dividend data from a temporary development source. Redistribution rights are not
            confirmed, so this must not be published commercially until the final market-data provider
            is connected or those rights are cleared.
          </div>
        )}

        {!enabled ? (
          <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: '40px 24px', textAlign: 'center' }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: C.ink, marginBottom: 6 }}>Temporarily unavailable</div>
            <div style={{ fontSize: 13, color: C.muted, maxWidth: 460, margin: '0 auto', lineHeight: 1.6 }}>
              The dividend calendar is switched off pending a licensed market-data source.
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
              <div style={{ display: 'flex', marginBottom: 6, border: `1px solid ${C.border}`, borderRadius: 6, overflow: 'hidden' }}>
                {[['ex', 'Ex-Dividend'], ['payment', 'Payment']].map(([id, label]) => (
                  <button key={id} onClick={() => setMode(id)}
                    style={{ border: 'none', cursor: 'pointer', fontSize: 11, padding: '5px 10px',
                      fontFamily: "'DM Sans',sans-serif", fontWeight: mode === id ? 600 : 400,
                      background: mode === id ? C.surface : C.white, color: mode === id ? C.ink : C.muted }}>{label}</button>
                ))}
              </div>
            </div>

            {/* Date navigation */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
              <button onClick={() => setAnchor(shiftDays(anchor, -stepFor(view)))} style={btn} aria-label="Previous">← Prev</button>
              <button onClick={() => setAnchor(iso(new Date()))} style={btn}>Today</button>
              <button onClick={() => setAnchor(shiftDays(anchor, stepFor(view)))} style={btn} aria-label="Next">Next →</button>
              <input type="date" value={anchor} onChange={(e) => e.target.value && setAnchor(e.target.value)} style={field} />
              <span style={{ fontSize: 11, color: C.dim }}>{range.from} → {range.to}</span>
              <span style={{ fontSize: 11, color: C.dim, marginLeft: 'auto' }}>
                {status === 'loading' ? 'Loading…' : `${total} event${total === 1 ? '' : 's'}`}
              </span>
            </div>

            {/* Filters — every one of these is applied in SQL against stored data, never a provider call. */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
              <input value={filters.q} onChange={(e) => setFilter('q', e.target.value)}
                placeholder="Ticker or company" style={{ ...field, minWidth: 170 }} />
              <select value={filters.sector} onChange={(e) => setFilter('sector', e.target.value)} style={field}>
                <option value="">All sectors</option>
                {SECTORS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <select value={filters.type} onChange={(e) => setFilter('type', e.target.value)} style={field}>
                <option value="">All types</option>
                <option value="regular">Regular</option>
                <option value="special">Special</option>
                <option value="capital_gain">Capital gain</option>
              </select>
              <select value={filters.frequency} onChange={(e) => setFilter('frequency', e.target.value)} style={field}>
                <option value="">Any frequency</option>
                <option value="12">Monthly</option>
                <option value="4">Quarterly</option>
                <option value="2">Semi-annual</option>
                <option value="1">Annual</option>
                <option value="0">One-time</option>
              </select>
              <select value={filters.minYield} onChange={(e) => setFilter('minYield', e.target.value)} style={field}>
                <option value="">Any yield</option>
                <option value="2">Yield 2%+</option>
                <option value="4">Yield 4%+</option>
                <option value="6">Yield 6%+</option>
                <option value="8">Yield 8%+</option>
              </select>
              <select value={filters.minAmount} onChange={(e) => setFilter('minAmount', e.target.value)} style={field}>
                <option value="">Any amount</option>
                <option value="0.1">$0.10+</option>
                <option value="0.5">$0.50+</option>
                <option value="1">$1.00+</option>
              </select>
              <select value={filters.minMarketCap} onChange={(e) => setFilter('minMarketCap', e.target.value)} style={field}>
                <option value="">Any size</option>
                <option value="300000000">Small cap+</option>
                <option value="2000000000">Mid cap+</option>
                <option value="10000000000">Large cap+</option>
              </select>
              {Object.values(filters).some(Boolean) && (
                <button onClick={() => setFilters(EMPTY_FILTERS)} style={{ ...btn, color: C.muted }}>Clear</button>
              )}
            </div>

            {status === 'error' ? (
              <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: '32px 20px', textAlign: 'center' }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: C.ink, marginBottom: 4 }}>Couldn&apos;t load the calendar</div>
                <div style={{ fontSize: 13, color: C.muted, marginBottom: 12 }}>
                  This is a loading problem, not an empty calendar.
                </div>
                <button onClick={load} style={btn}>Try again</button>
              </div>
            ) : events.length === 0 ? (
              <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: '40px 20px', textAlign: 'center', color: C.muted, fontSize: 13 }}>
                {status === 'loading' ? 'Loading…'
                  : `No announced dividends ${Object.values(filters).some(Boolean) ? 'match these filters' : 'in this range'}.`}
              </div>
            ) : sort.key ? (
              // Sorted: one flat board, because grouping by day would undo the sort.
              <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 940 }}>
                  <Head />
                  <tbody>{sorted.map((e, i) => <Row key={`${e.ticker}-${e.exDividendDate}-${i}`} e={e} />)}</tbody>
                </table>
              </div>
            ) : groups.map(([date, rows]) => (
              <div key={date} style={{ marginBottom: 18 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: C.ink, margin: '0 0 6px 2px' }}>
                  {date === 'unknown' ? 'Date not published' : fmtLong(date)}
                  <span style={{ color: C.dim, fontWeight: 400 }}> · {rows.length}</span>
                </div>
                <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 940 }}>
                    <Head />
                    <tbody>{rows.map((e, i) => <Row key={`${e.ticker}-${e.exDividendDate}-${i}`} e={e} />)}</tbody>
                  </table>
                </div>
              </div>
            ))}

            {data?.asOf && (
              <div style={{ fontSize: 11, color: C.dim, marginTop: 10 }}>
                Announced events only · yield from the last stored close · last synced {new Date(data.asOf).toLocaleString()}.
              </div>
            )}
          </>
        )}
      </div>
      <TickerHoverPreview hover={hover} />
      <Footer />
    </div>
  );
}
