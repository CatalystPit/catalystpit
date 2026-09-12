'use client';
import { useEffect, useState } from 'react';
import { C } from '../../lib/cp-shared';
import { fmtDate, partyStyle, chamberLabel, Avatar } from './ui';
import { formatDisclosureDelay } from '../../lib/disclosure';

// Congress discovery modules: Best 30-Day Record, Most Traded Stocks, Latest Filers.
// Compact by design. These sit above the deep research table and exist to start a search, not to
// be a dashboard. Built from the shared Catalyst Pit palette and the primitives already used by
// the politician cards, so nothing here introduces a second visual vocabulary.
//
// onSelectTicker is how Phase 3 hooks the chart up: clicking a ticker selects it.

const money = (n) => {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${Math.round(v / 1_000)}K`;
  return `$${Math.round(v)}`;
};

const panel = {
  background: C.white, border: `1px solid ${C.border}`, borderRadius: 10,
  display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0,
};
const head = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
  padding: '10px 12px', borderBottom: `1px solid ${C.border}`, background: C.surface,
};
const headText = {
  fontFamily: "'DM Sans',sans-serif", fontSize: 10, fontWeight: 700,
  letterSpacing: '0.8px', color: C.dim, textTransform: 'uppercase', whiteSpace: 'nowrap',
};
const row = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
  borderBottom: `1px solid ${C.surface}`, minWidth: 0,
};
const num = { fontFamily: "'DM Sans',sans-serif", fontVariantNumeric: 'tabular-nums' };

// Small explainer. Opens on hover and on tap, so the methodology is reachable on mobile too.
function Explain({ text, label = 'i' }) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-label="How this is calculated"
        style={{ width: 15, height: 15, borderRadius: '50%', border: `1px solid ${C.border}`,
          background: C.white, color: C.dim, fontSize: 9, fontWeight: 700, lineHeight: 1,
          cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: "'DM Sans',sans-serif", padding: 0 }}>{label}</button>
      {open && (
        <span onClick={(e) => e.stopPropagation()}
          style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 60, width: 290,
            maxWidth: '80vw', background: C.white, border: `1px solid ${C.border}`, color: C.text,
            fontSize: 11, lineHeight: 1.55, padding: '9px 11px', borderRadius: 7, fontWeight: 400,
            boxShadow: '0 8px 24px rgba(0,0,0,0.18)', textAlign: 'left', whiteSpace: 'normal' }}>
          {text}
        </span>
      )}
    </span>
  );
}

const Empty = ({ children }) => (
  <div style={{ padding: '18px 12px', textAlign: 'center', color: C.muted, fontSize: 12 }}>{children}</div>
);

// Most Traded ranges. Values are the window strings /api/congress-overview already accepts, and
// every one of them is floored at the 3 year cap server-side.
const TRADED_RANGES = [['3m', '3M'], ['6m', '6M'], ['1y', '1Y'], ['3y', '3Y']];
const TRADED_DEFAULT = '3m';

export default function CongressOverview({ onSelectTicker, selectedTicker }) {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const [tradedRange, setTradedRange] = useState(TRADED_DEFAULT);
  const [traded, setTraded] = useState(null);       // overrides data.mostTraded once a range is picked
  const [tradedLoading, setTradedLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`/api/congress-overview?window=${TRADED_DEFAULT}&limit=6`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive) { if (j && !j.error) setData(j); else setFailed(true); } })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);

  // Range changes fetch ONLY the Most Traded section. The default range is already in the first
  // response, so selecting it again costs nothing.
  useEffect(() => {
    if (tradedRange === TRADED_DEFAULT) { setTraded(null); return; }
    let alive = true;
    setTradedLoading(true);
    fetch(`/api/congress-overview?section=traded&window=${tradedRange}&limit=6`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive) { setTraded(j && !j.error ? j.mostTraded : []); setTradedLoading(false); } })
      .catch(() => { if (alive) { setTraded([]); setTradedLoading(false); } });
    return () => { alive = false; };
  }, [tradedRange]);

  if (failed) return null;                      // discovery is additive; never block the page
  const best = data?.bestRecord;
  const late = data?.lateFilings;
  const tradedList = traded ?? data?.mostTraded;

  return (
    <div style={{ display: 'grid', gap: 12, marginBottom: 18,
      gridTemplateColumns: 'repeat(auto-fit, minmax(310px, 1fr))' }}>

      {/* ── Best 30-Day Record ─────────────────────────────────────────── */}
      <div style={panel}>
        <div style={head}>
          <span style={headText}>Best 30 Day Record</span>
          <Explain text={
            <>
              <b style={{ display: 'block', marginBottom: 4 }}>What this measures</b>
              The average 30 day return of each member{'’'}s disclosed trades, measured from the
              transaction date to 30 calendar days later.
              <span style={{ display: 'block', marginTop: 6 }}>
                Purchases score the price move. Sales score its inverse, so a sale ahead of a decline reads
                positively. That convention is applied mechanically and is not a claim about intent: many
                sales are rebalancing, tax or liquidity driven.
              </span>
              <span style={{ display: 'block', marginTop: 6, color: C.muted }}>
                Each stock counts once no matter how many times it was traded, so repeated purchases of one
                name cannot carry a ranking. Options are excluded, and a trade is skipped rather than scored
                when a price is missing or the price history breaks inside its 30 day window.
              </span>
              <span style={{ display: 'block', marginTop: 6, color: C.dim }}>
                Minimum {best?.minTrades ?? 5} priced trades across at least {best?.minTickers ?? 5} stocks.
                A trade timing record, not portfolio performance.
              </span>
            </>
          } />
        </div>
        {!data ? <Empty>Loading.</Empty> : !best?.list?.length ? <Empty>Not enough priced trades yet.</Empty> : (
          <>
            {best.list.map((m) => {
              const ps = partyStyle(m.party);
              const up = m.returnPct > 0, flat = m.returnPct === 0;
              return (
                <a key={m.slug} href={`/politicians/${m.slug}`} className="row-hov"
                  style={{ ...row, textDecoration: 'none', color: 'inherit' }}>
                  <Avatar photoUrl={m.photoUrl} name={m.name} ps={ps} size={26} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 12.5, color: C.text, fontWeight: 500,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name}</span>
                    <span style={{ fontSize: 10, color: C.muted }}>
                      {ps.abbr} {'·'} {chamberLabel(m.chamber)} {'·'} {m.winRate}% up
                    </span>
                    {/* The sample gets its own line rather than being appended to the party and
                        chamber run, which overflowed the 310px panel and truncated the very
                        numbers a reader needs to judge the score. */}
                    <span style={{ display: 'block', fontSize: 10, color: C.dim, whiteSpace: 'nowrap' }}>
                      <b style={{ fontWeight: 600, color: C.muted }}>{m.trades}</b> {m.trades === 1 ? 'trade' : 'trades'}
                      {' · '}<b style={{ fontWeight: 600, color: C.muted }}>{m.tickers}</b> {m.tickers === 1 ? 'stock' : 'stocks'}
                    </span>
                  </span>
                  <span style={{ ...num, fontSize: 13.5, fontWeight: 700, whiteSpace: 'nowrap',
                    color: flat ? C.muted : up ? C.green : C.red }}>
                    {up ? '+' : ''}{Number(m.returnPct).toFixed(1)}%
                  </span>
                </a>
              );
            })}
            <div style={{ padding: '7px 12px', fontSize: 10, color: C.dim, lineHeight: 1.5 }}>
              Average 30-day return after disclosed trades. Each stock counts once. Minimum 5 trades
              across 5 stocks. Not portfolio performance.
            </div>
          </>
        )}
      </div>

      {/* ── Most Traded Stocks ─────────────────────────────────────────── */}
      <div style={panel}>
        <div style={head}>
          <span style={headText}>Most Traded Stocks</span>
          {/* Compact range pills. Sized to the 10px header text so the card keeps its height. */}
          <span style={{ display: 'flex', gap: 3, marginLeft: 'auto' }}>
            {TRADED_RANGES.map(([val, label]) => {
              const on = tradedRange === val;
              return (
                <button key={val} type="button" onClick={() => setTradedRange(val)}
                  aria-pressed={on} title={`Most traded over the last ${label}`}
                  style={{ background: on ? C.green : 'transparent', color: on ? '#fff' : C.muted,
                    border: `1px solid ${on ? C.green : C.border}`, borderRadius: 4,
                    padding: '1px 5px', fontSize: 9, fontWeight: 700, letterSpacing: '0.3px',
                    cursor: 'pointer', fontFamily: "'DM Sans',sans-serif", lineHeight: 1.5 }}>
                  {label}
                </button>
              );
            })}
          </span>
          <Explain text={
            <>
              <b style={{ display: 'block', marginBottom: 4 }}>Disclosed activity</b>
              Congressional trades over the selected window, counted by transaction date. The dollar
              figure is the range members actually disclosed, added up. Filers report a bracket such as
              $1,001 to $15,000, never an exact amount, so this is a range and not a precise total.
              <span style={{ display: 'block', marginTop: 6, color: C.dim }}>
                Every window is capped at 3 years, the limit of the history we hold.
              </span>
            </>
          } />
        </div>
        {!data || tradedLoading ? <Empty>Loading.</Empty> : !tradedList?.length ? <Empty>No congressional trading in this period.</Empty> : (
          tradedList.map((t) => {
            const on = selectedTicker === t.ticker;
            return (
              <button key={t.ticker} type="button" onClick={() => onSelectTicker?.(t.ticker)}
                className="row-hov"
                style={{ ...row, width: '100%', textAlign: 'left', border: 'none', cursor: 'pointer',
                  background: on ? C.greenLight : 'transparent', font: 'inherit' }}>
                <span style={{ ...num, fontSize: 13, fontWeight: 700, color: C.green, width: 58, flexShrink: 0 }}>
                  {t.ticker}
                </span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 10.5, color: C.muted }}>
                  {t.trades} trades {'·'} {t.politicians} {t.politicians === 1 ? 'member' : 'members'}
                  <span style={{ display: 'block', color: C.dim }}>
                    {money(t.disclosedMin)} to {money(t.disclosedMax)} disclosed
                  </span>
                </span>
                <span style={{ ...num, fontSize: 11, whiteSpace: 'nowrap', flexShrink: 0 }}>
                  <span style={{ color: C.green, fontWeight: 600 }}>{t.buys}B</span>
                  <span style={{ color: C.dim }}> / </span>
                  <span style={{ color: C.red, fontWeight: 600 }}>{t.sells}S</span>
                </span>
              </button>
            );
          })
        )}
      </div>

      {/* ── Late Filings ───────────────────────────────────────────────── */}
      <div style={panel}>
        <div style={head}>
          <span style={headText}>Late Filings</span>
          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
            {/* The threshold is the whole point of the module, so it is stated on the panel itself
                rather than hidden behind the explainer. */}
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.4px', color: C.red,
              background: C.redLight, padding: '2px 6px', borderRadius: 3, whiteSpace: 'nowrap' }}>
              PAST {late?.threshold ?? 45}-DAY DEADLINE
            </span>
            <Explain text={
              <>
                <b style={{ display: 'block', marginBottom: 4 }}>The {late?.threshold ?? 45} day rule</b>
                The STOCK Act gives members {late?.threshold ?? 45} days from a transaction to disclose it.
                These are the filings that ran past that, worst first. The delay is measured from the
                oldest trade in the filing, because that is the transaction that waited longest. A late
                filing is a reporting failure, not evidence of anything about the trade itself.
              </>
            } />
          </span>
        </div>
        {!data ? <Empty>Loading.</Empty> : !late?.list?.length ? <Empty>No late filings on record.</Empty> : (
          late.list.map((f, i) => {
            const ps = partyStyle(f.party);
            const over = Number(f.daysLate);
            return (
              <a key={`${f.slug}-${f.disclosureDate}-${i}`} href={`/politicians/${f.slug}`} className="row-hov"
                style={{ ...row, textDecoration: 'none', color: 'inherit' }}>
                <Avatar photoUrl={f.photoUrl} name={f.name} ps={ps} size={26} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 12.5, color: C.text, fontWeight: 500,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.name}</span>
                  <span style={{ fontSize: 10, color: C.muted }}>
                    {chamberLabel(f.chamber)} {'·'} {f.transactions} {f.transactions === 1 ? 'trade' : 'trades'}
                    {' · '}filed {fmtDate(f.disclosureDate)}
                  </span>
                </span>
                <span style={{ textAlign: 'right', flexShrink: 0 }}>
                  <span style={{ ...num, display: 'block', fontSize: 12.5, fontWeight: 700, color: C.red }}>
                    {over.toLocaleString('en-US')}d late
                  </span>
                  <span style={{ fontSize: 10, color: C.dim, whiteSpace: 'nowrap' }}>
                    {formatDisclosureDelay({ filingLagDays: f.maxDelay }, { short: true })}
                  </span>
                </span>
              </a>
            );
          })
        )}
      </div>
    </div>
  );
}
