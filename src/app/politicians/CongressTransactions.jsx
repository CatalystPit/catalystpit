'use client';
import { useCallback, useEffect, useState } from 'react';
import { C, startCheckout } from '../../lib/cp-shared';
import { fmtDate, partyStyle, chamberLabel, Chip } from './ui';
import { formatDisclosureDelay, formatDisclosedAmount, formatSeat, tradeDirection, isLateDisclosure } from '../../lib/disclosure';

// The deep research layer: every congressional transaction, filtered and paged ON THE SERVER.
//
// Nothing here holds more than one page. The previous per-member table loaded every trade and
// filtered in the browser, which shipped 700+ rows for a heavy filer, and its counts only ever
// described what had already been downloaded.

const PAGE_SIZES = [25, 50, 100];
const SEL = {
  background: C.white, border: `1px solid ${C.border}`, color: C.text, padding: '6px 9px',
  borderRadius: 5, fontSize: 12, fontFamily: "'DM Sans',sans-serif", cursor: 'pointer', minWidth: 0,
};
const TH = (align) => ({
  padding: '9px 10px', textAlign: align || 'left', fontFamily: "'DM Sans',sans-serif",
  fontSize: 9, color: C.dim, letterSpacing: '0.8px', fontWeight: 400, whiteSpace: 'nowrap',
  textTransform: 'uppercase', userSelect: 'none',
});
const TD = { padding: '10px', fontSize: 12.5, color: C.text, verticalAlign: 'top' };

const COLUMNS = [
  { key: 'member', label: 'Politician', sort: 'member' },
  { key: 'ticker', label: 'Asset', sort: 'ticker' },
  { key: 'action', label: 'Type', sort: null },
  { key: 'amount', label: 'Disclosed amount', sort: 'amount', align: 'right' },
  { key: 'traded', label: 'Traded', sort: 'transaction' },
  { key: 'disclosed', label: 'Disclosed', sort: 'disclosure' },
  { key: 'delay', label: 'Delay', sort: 'delay', align: 'right' },
  { key: 'source', label: 'Source', sort: null },
];

export default function CongressTransactions({ ticker, onSelectTicker }) {
  const [f, setF] = useState({ q: '', action: '', chamber: '', party: '', owner: '', minValue: '', maxDelay: '', late: false });
  const [sort, setSort] = useState('transaction');
  const [dir, setDir] = useState('desc');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const p = new URLSearchParams({ sort, dir, page: String(page), pageSize: String(pageSize) });
    if (ticker) p.set('ticker', ticker);
    for (const [k, v] of Object.entries(f)) {
      if (v === '' || v === false) continue;
      p.set(k, v === true ? '1' : String(v));
    }
    try {
      const r = await fetch(`/api/congress-trades?${p}`);
      const j = r.ok ? await r.json() : null;
      setData(j && !j.error ? j : null);
    } catch { setData(null); }
    setLoading(false);
  }, [f, sort, dir, page, pageSize, ticker]);

  useEffect(() => { load(); }, [load]);
  // Any change to the filters, the sort or the selected ticker invalidates the current page number.
  useEffect(() => { setPage(0); }, [f, sort, dir, pageSize, ticker]);

  const set = (k) => (e) => setF((prev) => ({ ...prev, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const clickSort = (key) => {
    if (!key) return;
    if (sort === key) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSort(key); setDir('desc'); }
  };

  const rows = data?.trades || [];
  const total = data?.total || 0;
  const pages = data?.pages || 0;
  const locked = data?.lockedCount || 0;

  return (
    <div style={{ marginTop: 22 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 11, fontWeight: 700, letterSpacing: '0.8px', color: C.dim, textTransform: 'uppercase' }}>
          All Transactions{ticker ? ` · ${ticker}` : ''}
        </span>
        <span style={{ fontSize: 11.5, color: C.muted }}>
          {loading ? 'Loading.' : `${total.toLocaleString('en-US')} ${total === 1 ? 'transaction' : 'transactions'}`}
          {ticker && (
            <button type="button" onClick={() => onSelectTicker?.(null)}
              style={{ marginLeft: 8, border: 'none', background: 'transparent', color: C.green, cursor: 'pointer', fontSize: 11.5, fontFamily: "'DM Sans',sans-serif" }}>
              clear ticker
            </button>
          )}
        </span>
      </div>

      {/* filters */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10, alignItems: 'center' }}>
        <input value={f.q} onChange={set('q')} placeholder="Search politician, ticker or asset"
          style={{ ...SEL, width: 240, cursor: 'text' }} />
        <select value={f.action} onChange={set('action')} style={SEL}>
          <option value="">All types</option><option value="buy">Purchases</option>
          <option value="sell">Sales</option><option value="other">Other</option>
        </select>
        <select value={f.chamber} onChange={set('chamber')} style={SEL}>
          <option value="">Both chambers</option><option value="house">House</option><option value="senate">Senate</option>
        </select>
        <select value={f.party} onChange={set('party')} style={SEL}>
          <option value="">All parties</option><option value="Democrat">Democrat</option><option value="Republican">Republican</option>
        </select>
        <select value={f.owner} onChange={set('owner')} style={SEL}>
          <option value="">Any owner</option><option value="Self">Self</option>
          <option value="Spouse">Spouse</option><option value="Joint">Joint</option><option value="Dependent">Dependent</option>
        </select>
        <select value={f.minValue} onChange={set('minValue')} style={SEL}>
          <option value="">Any size</option><option value="15000">$15K and up</option>
          <option value="50000">$50K and up</option><option value="250000">$250K and up</option><option value="1000000">$1M and up</option>
        </select>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: C.muted, cursor: 'pointer' }}>
          <input type="checkbox" checked={f.late} onChange={set('late')} style={{ cursor: 'pointer' }} />
          Filed late
        </label>
      </div>

      <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', minWidth: 940, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}>
                {COLUMNS.map((c) => {
                  const active = c.sort && sort === c.sort;
                  return (
                    <th key={c.key} onClick={() => clickSort(c.sort)}
                      style={{ ...TH(c.align), cursor: c.sort ? 'pointer' : 'default', color: active ? C.green : C.dim }}>
                      {c.label}{active ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {loading && !rows.length ? (
                <tr><td colSpan={COLUMNS.length} style={{ padding: '34px 10px', textAlign: 'center', color: C.muted, fontSize: 12.5 }}>Loading.</td></tr>
              ) : !rows.length ? (
                <tr><td colSpan={COLUMNS.length} style={{ padding: '34px 10px', textAlign: 'center', color: C.muted, fontSize: 12.5 }}>No transactions match these filters.</td></tr>
              ) : rows.map((t, i) => {
                const dirn = tradeDirection(t);
                const ps = partyStyle(t.party);
                const col = dirn === 'buy' ? C.green : dirn === 'sell' ? C.red : C.muted;
                const bg = dirn === 'buy' ? C.greenLight : dirn === 'sell' ? C.redLight : C.surface;
                const label = dirn === 'buy' ? 'BUY' : dirn === 'sell' ? 'SELL' : String(t.type || 'OTHER').toUpperCase();
                const late = isLateDisclosure(t);
                return (
                  <tr key={t.id} style={{ borderBottom: i < rows.length - 1 ? `1px solid ${C.surface}` : 'none', borderLeft: `3px solid ${col}` }}>
                    <td style={TD}>
                      <a href={`/politicians/${t.memberSlug}`} style={{ color: C.text, textDecoration: 'none', fontWeight: 500 }}>{t.representative}</a>
                      <div style={{ fontSize: 10.5, color: C.muted, marginTop: 2 }}>
                        {formatSeat(t) || chamberLabel(t.chamber)}{t.party ? ` · ${ps.abbr}` : ''}{t.owner ? ` · ${t.owner}` : ''}
                      </div>
                    </td>
                    <td style={TD}>
                      {t.ticker ? (
                        <button type="button" onClick={() => onSelectTicker?.(t.ticker)}
                          style={{ border: 'none', background: 'transparent', color: C.green, fontWeight: 700, fontSize: 12.5, cursor: 'pointer', padding: 0, fontFamily: "'DM Sans',sans-serif" }}>
                          {t.ticker}
                        </button>
                      ) : <span style={{ color: C.dim }}>not listed</span>}
                      <div title={t.assetDescription || ''} style={{ fontSize: 10.5, color: C.muted, marginTop: 2, maxWidth: 210, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {t.assetDescription || ''}
                      </div>
                    </td>
                    <td style={TD}><Chip bg={bg} fg={col}>{label}</Chip></td>
                    {/* The filer's disclosed bracket, verbatim. Never a midpoint shown as an amount. */}
                    <td style={{ ...TD, textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 500 }}>{formatDisclosedAmount(t) || <span style={{ color: C.dim, fontWeight: 400 }}>not disclosed</span>}</td>
                    <td style={{ ...TD, whiteSpace: 'nowrap', color: C.muted }}>{fmtDate(t.transactionDate)}</td>
                    <td style={{ ...TD, whiteSpace: 'nowrap', color: C.muted }}>{fmtDate(t.disclosureDate)}</td>
                    <td style={{ ...TD, textAlign: 'right', whiteSpace: 'nowrap', color: late ? C.red : C.muted, fontWeight: late ? 600 : 400 }}>
                      {formatDisclosureDelay(t, { short: true }) || <span style={{ color: C.dim }}>unknown</span>}
                    </td>
                    <td style={TD}>
                      {t.link ? (
                        <a href={t.link} target="_blank" rel="noopener noreferrer"
                          style={{ fontSize: 11, color: C.green, textDecoration: 'none', fontWeight: 600, whiteSpace: 'nowrap' }}>
                          Official filing
                        </a>
                      ) : <span style={{ fontSize: 11, color: C.dim }}>none</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {locked > 0 && (
          <div style={{ padding: '14px 12px', borderTop: `1px solid ${C.border}`, background: C.surface, textAlign: 'center' }}>
            <div style={{ fontSize: 12.5, color: C.text, marginBottom: 8 }}>
              {locked.toLocaleString('en-US')} more transactions. Sign in to see the full record.
            </div>
            <button onClick={() => startCheckout()} style={{ background: C.green, color: '#fff', border: 'none', borderRadius: 6, padding: '8px 18px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>
              Unlock Pro {'·'} $12/mo
            </button>
          </div>
        )}

        {!locked && pages > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '9px 12px', borderTop: `1px solid ${C.border}`, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11.5, color: C.muted }}>Page {page + 1} of {pages.toLocaleString('en-US')}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} style={SEL}>
                {PAGE_SIZES.map((n) => <option key={n} value={n}>{n} per page</option>)}
              </select>
              <button type="button" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}
                style={{ ...SEL, opacity: page === 0 ? 0.4 : 1, cursor: page === 0 ? 'default' : 'pointer' }}>Previous</button>
              <button type="button" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}
                style={{ ...SEL, opacity: page + 1 >= pages ? 0.4 : 1, cursor: page + 1 >= pages ? 'default' : 'pointer' }}>Next</button>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
