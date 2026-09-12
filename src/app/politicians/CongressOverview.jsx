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

export default function CongressOverview({ onSelectTicker, selectedTicker }) {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch('/api/congress-overview?window=3m&limit=6')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive) { if (j && !j.error) setData(j); else setFailed(true); } })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);

  if (failed) return null;                      // discovery is additive; never block the page
  const best = data?.bestRecord;
  const late = data?.lateFilings;

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
                      {ps.abbr} {'·'} {chamberLabel(m.chamber)} {'·'} {m.trades} trades in {m.tickers} stocks {'·'} {m.winRate}% up
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
              30 days after each trade. Each stock counts once. Not portfolio performance.
            </div>
          </>
        )}
      </div>

      {/* ── Most Traded Stocks ─────────────────────────────────────────── */}
      <div style={panel}>
        <div style={head}>
          <span style={headText}>Most Traded Stocks</span>
          <Explain text={
            <>
              <b style={{ display: 'block', marginBottom: 4 }}>Disclosed activity</b>
              Congressional trades over the last 3 months. The dollar figure is the range members
              actually disclosed, added up. Filers report a bracket such as $1,001 to $15,000, never an
              exact amount, so this is a range and not a precise total.
            </>
          } />
        </div>
        {!data ? <Empty>Loading.</Empty> : !data.mostTraded?.length ? <Empty>No congressional trading in this period.</Empty> : (
          data.mostTraded.map((t) => {
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
