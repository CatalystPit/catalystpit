'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { C, TickerLogo } from '../../lib/cp-shared';

// THE CUSTOM SCANNER — Finviz speed on the surface, Catalyst Pit's engine underneath.
//
// COMPACT DROPDOWNS, DELIBERATELY. A trader who screens for a living sets eight conditions in eight
// seconds this way. A field/operator/value rule builder is more general and much slower to drive, so
// the composable model stays INTERNAL: every dropdown choice is a { min, max, eq } condition against
// a named field, which is the same vocabulary the Pit Scan engine evaluates. One selection, one
// condition, no builder.
//
// ONE VOCABULARY, TWO SOURCES. Daily fields compile to SQL against screener_stocks; live fields are
// computed from market state. The panel renders both from one merged list and does not care which is
// which — a live field simply arrives marked unavailable, with the capability it is waiting for, and
// becomes selectable the day the provider supplies it. No redesign, no second UI.

const fmt2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—');
const big = (v) => {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return String(Math.round(v));
};
const pct = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : '—');

/** Columns the results table can show. `sort` is the /api/screener sort key where one exists. */
const COLUMNS = [
  { id: 'ticker', label: 'Ticker', w: 96, align: 'left', sort: null },
  { id: 'company', label: 'Company', w: 150, align: 'left', sort: null },
  { id: 'price', label: 'Price', w: 62, sort: 'price', read: (r) => r.price, fmt: fmt2 },
  { id: 'changePct', label: 'Chg', w: 62, sort: 'changePct', read: (r) => r.changePct, fmt: pct, signed: true },
  { id: 'gap', label: 'Gap', w: 58, sort: 'gap', read: (r) => r.gap, fmt: pct, signed: true },
  { id: 'volume', label: 'Vol', w: 62, sort: 'volume', read: (r) => r.volume, fmt: big },
  { id: 'relVol', label: 'RVOL', w: 56, sort: 'relVol', read: (r) => r.relVol, fmt: (v) => (Number.isFinite(v) ? `${v.toFixed(2)}×` : '—') },
  { id: 'avgVol', label: 'Avg Vol', w: 64, sort: 'avgVol', read: (r) => r.avgVol, fmt: big },
  { id: 'marketCap', label: 'Mkt Cap', w: 70, sort: 'marketCap', read: (r) => r.marketCap, fmt: big },
  { id: 'floatShares', label: 'Float', w: 62, sort: 'floatShares', read: (r) => r.floatShares, fmt: big },
  { id: 'sector', label: 'Sector', w: 110, align: 'left', read: (r) => r.sector, fmt: (v) => v || '—' },
  { id: 'atr14', label: 'ATR', w: 56, read: (r) => r.atr14, fmt: fmt2 },
  { id: 'rsi14', label: 'RSI', w: 50, sort: 'rsi14', read: (r) => r.rsi14, fmt: (v) => (Number.isFinite(v) ? v.toFixed(0) : '—') },
  { id: 'perf1w', label: '1W', w: 56, sort: 'perf1w', read: (r) => r.perf1w, fmt: pct, signed: true },
  { id: 'perf1m', label: '1M', w: 56, sort: 'perf1m', read: (r) => r.perf1m, fmt: pct, signed: true },
  { id: 'consensusScore', label: 'Pit', w: 46, sort: 'consensusScore', read: (r) => r.consensusScore, fmt: (v) => (Number.isFinite(v) ? String(v) : '—') },
];
const COLUMN_BY_ID = new Map(COLUMNS.map((c) => [c.id, c]));
const DEFAULT_COLS = ['ticker', 'price', 'changePct', 'volume', 'relVol', 'marketCap'];
const LAYOUT_KEY = 'cp_scanner_columns';

export default function CustomScannerPanel({ onPick }) {
  const [meta, setMeta] = useState(null);
  const [caps, setCaps] = useState(null);
  const [conds, setConds] = useState([]);          // [{ key, cond }] — cond is null until chosen
  const [rows, setRows] = useState(null);
  const [running, setRunning] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [colsOpen, setColsOpen] = useState(false);
  const [saved, setSaved] = useState([]);
  const [sort, setSort] = useState({ by: 'changePct', dir: 'desc' });
  const [cols, setCols] = useState(DEFAULT_COLS);
  const [width, setWidth] = useState(9999);
  const hostRef = useRef(null);

  // Column choice is a per-trader preference, so it lives in the browser under the same cp_ key
  // convention the rest of the Terminal uses. Saved SCANS are account-backed; this is not.
  useEffect(() => {
    try {
      const raw = JSON.parse(window.localStorage.getItem(LAYOUT_KEY) || 'null');
      if (Array.isArray(raw) && raw.length) setCols(raw.filter((id) => COLUMN_BY_ID.has(id)));
    } catch { /* a corrupt preference is not worth failing over */ }
  }, []);
  const saveCols = (next) => {
    setCols(next);
    try { window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  };

  useEffect(() => {
    const el = hostRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((e) => setWidth(e[0]?.contentRect?.width || 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const loadSaved = useCallback(() => {
    fetch('/api/screener/saved?scope=terminal', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null)).then((j) => setSaved(j?.saved || [])).catch(() => {});
  }, []);

  useEffect(() => {
    fetch('/api/screener?meta=1', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { setMeta(j?.filters || {}); setCaps(j?.capabilities || null); })
      .catch(() => setMeta({}));
    loadSaved();
  }, [loadSaved]);

  // Grouped for the Add Filter menu: available first within each category, unavailable listed after
  // with the capability they need. Showing what is coming is more useful than hiding it.
  const byCategory = useMemo(() => {
    const out = new Map();
    for (const [key, def] of Object.entries(meta || {})) {
      const cat = def.category || 'Other';
      if (!out.has(cat)) out.set(cat, []);
      out.get(cat).push([key, def]);
    }
    for (const list of out.values()) {
      list.sort((a, b) => (b[1].available === true) - (a[1].available === true)
        || String(a[1].label).localeCompare(String(b[1].label)));
    }
    return out;
  }, [meta]);

  const addFilter = (key) => {
    setConds((c) => (c.some((x) => x.key === key) ? c : [...c, { key, cond: null }]));
    setAddOpen(false);
  };
  const setCond = (i, cond) => setConds((c) => c.map((x, j) => (j === i ? { ...x, cond } : x)));
  const removeCond = (i) => setConds((c) => c.filter((_, j) => j !== i));

  // ONLY DAILY FIELDS REACH THE QUERY. A live field can be chosen and saved, but until a provider
  // serves it the scan must not silently behave as though the condition were applied.
  const activeFilters = useCallback((list) => {
    const out = {};
    for (const c of list) {
      const def = meta?.[c.key];
      if (!c.cond || !def || def.live || !def.available) continue;
      out[c.key] = c.cond;
    }
    return out;
  }, [meta]);

  const pendingLive = conds.filter((c) => c.cond && meta?.[c.key]?.live);

  const run = useCallback(async (list = conds, sortState = sort) => {
    setRunning(true);
    try {
      const qs = new URLSearchParams({
        filters: JSON.stringify(activeFilters(list)),
        pageSize: '100',
        sort: sortState.by,
        dir: sortState.dir,
      });
      const r = await fetch(`/api/screener?${qs}`, { cache: 'no-store' });
      const j = r.ok ? await r.json() : null;
      setRows(j?.rows || []);
    } catch { setRows([]); }
    setRunning(false);
  }, [conds, sort, activeFilters]);

  const sortBy = (col) => {
    if (!col.sort) return;
    const next = { by: col.sort, dir: sort.by === col.sort && sort.dir === 'desc' ? 'asc' : 'desc' };
    setSort(next);
    if (rows) run(conds, next);
  };

  const save = async () => {
    const name = window.prompt('Save this scan as:');
    if (!name) return;
    // The WHOLE selection is stored, live fields included, so a scan saved today comes back complete
    // when the provider lands rather than quietly losing half its conditions.
    const filters = {};
    for (const c of conds) if (c.cond) filters[c.key] = c.cond;
    await fetch('/api/screener/saved', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, filters, scope: 'terminal', columns: cols, sortBy: sort.by, sortDir: sort.dir }),
    }).catch(() => {});
    loadSaved();
  };
  const loadScan = (s) => {
    const c = Object.entries(s.filters || {}).map(([key, cond]) => ({ key, cond }));
    setConds(c);
    if (Array.isArray(s.columns) && s.columns.length) saveCols(s.columns.filter((id) => COLUMN_BY_ID.has(id)));
    const next = { by: s.sortBy || sort.by, dir: s.sortDir || sort.dir };
    setSort(next);
    run(c, next);
  };
  const delScan = async (id) => {
    await fetch(`/api/screener/saved?scope=terminal&id=${id}`, { method: 'DELETE' }).catch(() => {});
    loadSaved();
  };

  // Density over decoration: the panel drops columns as it narrows rather than wrapping or scrolling
  // sideways, and the visible set is the trader's chosen order, trimmed to what fits.
  const visibleCols = useMemo(() => {
    const chosen = cols.map((id) => COLUMN_BY_ID.get(id)).filter(Boolean);
    let budget = width - 8;
    const out = [];
    for (const c of chosen) {
      if (out.length && budget - c.w < 0) break;
      budget -= c.w;
      out.push(c);
    }
    return out.length ? out : chosen.slice(0, 2);
  }, [cols, width]);

  const btn = {
    fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 5, cursor: 'pointer',
    fontFamily: "'DM Sans',sans-serif", border: `1px solid ${C.border}`, background: C.white, color: C.muted,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ padding: 8, borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', position: 'relative', flexWrap: 'wrap' }}>
          <button onClick={() => { setAddOpen((v) => !v); setColsOpen(false); }}
            style={{ ...btn, color: C.green, borderColor: C.greenBorder }}>+ Filter</button>
          <button onClick={() => run()} style={{ ...btn, background: C.green, color: '#fff', border: 'none' }}>
            {running ? 'Running…' : 'Run'}
          </button>
          <button onClick={save} disabled={!conds.length} style={{ ...btn, opacity: conds.length ? 1 : 0.5 }}>Save</button>
          <button onClick={() => { setColsOpen((v) => !v); setAddOpen(false); }} style={btn}>Columns</button>
          {conds.length > 0 && (
            <button onClick={() => { setConds([]); setRows(null); }}
              style={{ ...btn, border: 'none', background: 'transparent', color: C.dim, textDecoration: 'underline' }}>Clear</button>
          )}

          {addOpen && (
            <FilterMenu byCategory={byCategory} chosen={conds} onPick={addFilter} />
          )}
          {colsOpen && (
            <ColumnMenu cols={cols} onChange={saveCols} />
          )}
        </div>

        {/* THE FILTER ROW — one compact dropdown per condition. */}
        {conds.map((c, i) => (
          <FilterRow key={c.key} def={meta?.[c.key]} fieldKey={c.key} value={c.cond}
            onChange={(cond) => setCond(i, cond)} onRemove={() => removeCond(i)} />
        ))}

        {/* A live condition is kept and saved, but it is NOT applied — and saying so is the whole
            difference between an honest scanner and one that quietly returns the wrong set. */}
        {pendingLive.length > 0 && (
          <div style={{ marginTop: 6, fontSize: 10.5, color: C.muted, background: C.surface,
            border: `1px solid ${C.border}`, borderRadius: 5, padding: '5px 8px' }}>
            {pendingLive.length === 1 ? '1 filter is' : `${pendingLive.length} filters are`} waiting on live
            market data and {pendingLive.length === 1 ? 'is' : 'are'} not applied to these results.
            {caps?.label ? ` Current feed: ${caps.label}.` : ''}
          </div>
        )}

        {saved.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 10, color: C.dim }}>Saved:</span>
            {saved.map((s) => (
              <span key={s.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4,
                background: C.surface, border: `1px solid ${C.border}`, borderRadius: 11, padding: '2px 8px' }}>
                <button onClick={() => loadScan(s)}
                  style={{ background: 'none', border: 'none', color: C.green, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>{s.name}</button>
                <button onClick={() => delScan(s.id)}
                  style={{ background: 'none', border: 'none', color: C.dim, cursor: 'pointer', fontSize: 12 }}>×</button>
              </span>
            ))}
          </div>
        )}
      </div>

      <div ref={hostRef} style={{ overflow: 'auto', flex: 1 }}>
        {rows === null ? (
          <div style={{ padding: '20px 16px', textAlign: 'center', color: C.dim, fontSize: 12.5 }}>
            Add filters and run the scan.
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: '20px 16px', textAlign: 'center', color: C.muted, fontSize: 12.5 }}>
            No matches. Widen your filters.
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: C.surface }}>
                {visibleCols.map((col) => (
                  <th key={col.id} onClick={() => sortBy(col)}
                    title={col.sort ? `Sort by ${col.label}` : col.label}
                    style={{
                      padding: '5px 8px', textAlign: col.align || 'right', fontSize: 8.5, color: C.dim,
                      letterSpacing: '0.5px', position: 'sticky', top: 0, background: C.surface,
                      cursor: col.sort ? 'pointer' : 'default', whiteSpace: 'nowrap',
                    }}>
                    {col.label.toUpperCase()}
                    {sort.by === col.sort && <span style={{ color: C.green }}>{sort.dir === 'desc' ? ' ▼' : ' ▲'}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.ticker + i} style={{ borderTop: i ? `1px solid ${C.surface}` : 'none' }}>
                  {visibleCols.map((col) => {
                    if (col.id === 'ticker') {
                      return (
                        <td key={col.id} style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                          <span onClick={() => onPick && onPick(r.ticker)} title="Load in chart"
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                            <TickerLogo symbol={r.ticker} size={15} />
                            <span className="cp-tkr" style={{ color: C.ink, fontWeight: 700 }}>{r.ticker}</span>
                          </span>
                        </td>
                      );
                    }
                    if (col.id === 'company') {
                      return <td key={col.id} style={{ padding: '6px 8px', color: C.muted, maxWidth: col.w,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.company || '—'}</td>;
                    }
                    const v = col.read ? col.read(r) : null;
                    const tone = col.signed
                      ? (v == null ? C.dim : v >= 0 ? C.green : C.red)
                      : C.text;
                    return (
                      <td key={col.id} className="cp-num"
                        style={{ padding: '6px 8px', textAlign: col.align || 'right', color: tone,
                          fontWeight: col.signed ? 600 : 400, whiteSpace: 'nowrap' }}>
                        {col.fmt ? col.fmt(v) : (v ?? '—')}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/**
 * ONE FILTER, ONE DROPDOWN.
 *
 * Any / presets / Custom…, matching the full screener page exactly — the same control a trader
 * already knows, rather than a second dialect of the same idea in a different panel.
 */
function FilterRow({ def, fieldKey, value, onChange, onRemove }) {
  const [custom, setCustom] = useState(false);
  const opts = def?.opts || [];
  const idx = value ? opts.findIndex((o) => JSON.stringify(o.cond) === JSON.stringify(value)) : -1;
  const isCustomValue = !!value && idx === -1;
  const isRange = def?.type === 'range';
  const showInputs = isRange && (custom || isCustomValue);
  const disabled = def && def.available === false;
  const selValue = idx >= 0 ? String(idx) : ((value || custom) ? 'custom' : '');

  const pick = (e) => {
    const v = e.target.value;
    if (v === '') { setCustom(false); onChange(null); }
    else if (v === 'custom') setCustom(true);
    else { setCustom(false); onChange(opts[Number(v)].cond); }
  };

  const field = {
    height: 23, borderRadius: 4, padding: '0 4px', fontSize: 11, fontFamily: "'DM Sans',sans-serif",
    outline: 'none', border: `1px solid ${value ? C.green : C.border}`,
    background: value ? C.greenLight : C.white, color: value ? C.green : C.text,
    fontWeight: value ? 600 : 400, cursor: disabled ? 'not-allowed' : 'pointer',
  };

  return (
    <div style={{ marginTop: 6, opacity: disabled ? 0.55 : 1 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <span title={def?.unavailableReason || def?.label}
          style={{ fontSize: 11, color: def?.pit ? C.green : C.muted, fontWeight: 600,
            minWidth: 104, flexShrink: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {def?.pit ? '◆ ' : ''}{def?.label || fieldKey}
        </span>
        <select value={selValue} onChange={pick} disabled={disabled} style={{ ...field, flex: 1, minWidth: 0 }}>
          <option value="">Any</option>
          {opts.map((o, j) => <option key={j} value={j}>{o.label}</option>)}
          {isRange && <option value="custom">Custom…</option>}
        </select>
        <button onClick={onRemove}
          style={{ background: 'none', border: 'none', color: C.dim, cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: '0 2px' }}>×</button>
      </div>
      {showInputs && (
        <div style={{ display: 'flex', gap: 5, marginTop: 4, marginLeft: 110 }}>
          <input type="number" placeholder="Min" defaultValue={value?.min ?? ''}
            onChange={(e) => onChange({ ...(value || {}), min: e.target.value === '' ? undefined : Number(e.target.value) })}
            style={{ width: 62, height: 22, borderRadius: 4, border: `1px solid ${C.border}`, padding: '0 5px', fontSize: 11 }} />
          <input type="number" placeholder="Max" defaultValue={value?.max ?? ''}
            onChange={(e) => onChange({ ...(value || {}), max: e.target.value === '' ? undefined : Number(e.target.value) })}
            style={{ width: 62, height: 22, borderRadius: 4, border: `1px solid ${C.border}`, padding: '0 5px', fontSize: 11 }} />
          {def?.unit && <span style={{ fontSize: 10, color: C.dim, alignSelf: 'center' }}>{def.unit}</span>}
        </div>
      )}
      {disabled && def?.unavailableReason && (
        <div style={{ fontSize: 9.5, color: C.dim, marginLeft: 110, marginTop: 2 }}>{def.unavailableReason}</div>
      )}
    </div>
  );
}

/** The Add Filter menu: every category, available first, unavailable shown with what it needs. */
function FilterMenu({ byCategory, chosen, onPick }) {
  return (
    <div style={{
      position: 'absolute', top: '110%', left: 0, zIndex: 30, background: C.white,
      border: `1px solid ${C.border}`, borderRadius: 8, boxShadow: '0 6px 18px rgba(0,0,0,0.15)',
      minWidth: 250, maxHeight: 340, overflow: 'auto', padding: '4px 0',
    }}>
      {byCategory.size === 0 ? (
        <div style={{ padding: '10px 14px', fontSize: 12, color: C.dim }}>Loading filters…</div>
      ) : [...byCategory.entries()].map(([cat, list]) => (
        <div key={cat}>
          <div style={{ fontSize: 9, fontWeight: 700, color: C.dim, letterSpacing: 0.6, padding: '6px 12px 2px' }}>
            {cat.toUpperCase()}
          </div>
          {list.map(([k, f]) => {
            const already = chosen.some((x) => x.key === k);
            return (
              <button key={k} onClick={() => onPick(k)} disabled={already}
                title={f.unavailableReason || f.label}
                style={{
                  display: 'flex', width: '100%', gap: 8, textAlign: 'left', padding: '5px 12px',
                  background: 'none', border: 'none', cursor: already ? 'default' : 'pointer',
                  fontSize: 12, fontFamily: "'DM Sans',sans-serif",
                  color: already ? C.hint : (f.available === false ? C.muted : C.ink),
                }}>
                <span style={{ flex: 1 }}>{f.pit ? '◆ ' : ''}{f.label}</span>
                {f.available === false && <span style={{ fontSize: 8.5, color: C.dim }}>SOON</span>}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Column chooser. Order is the order they were picked, which is also the order they render. */
function ColumnMenu({ cols, onChange }) {
  const toggle = (id) => onChange(cols.includes(id) ? cols.filter((x) => x !== id) : [...cols, id]);
  return (
    <div style={{
      position: 'absolute', top: '110%', left: 0, zIndex: 30, background: C.white,
      border: `1px solid ${C.border}`, borderRadius: 8, boxShadow: '0 6px 18px rgba(0,0,0,0.15)',
      minWidth: 190, maxHeight: 320, overflow: 'auto', padding: '4px 0',
    }}>
      <div style={{ fontSize: 9, fontWeight: 700, color: C.dim, letterSpacing: 0.6, padding: '6px 12px 2px' }}>
        COLUMNS
      </div>
      {COLUMNS.map((c) => (
        <button key={c.id} onClick={() => toggle(c.id)} disabled={c.id === 'ticker'}
          style={{
            display: 'flex', width: '100%', gap: 8, textAlign: 'left', padding: '5px 12px',
            background: 'none', border: 'none', cursor: c.id === 'ticker' ? 'default' : 'pointer',
            fontSize: 12, color: C.ink, fontFamily: "'DM Sans',sans-serif",
          }}>
          <span style={{ width: 12, color: C.green }}>{cols.includes(c.id) ? '✓' : ''}</span>
          <span>{c.label}</span>
        </button>
      ))}
    </div>
  );
}
