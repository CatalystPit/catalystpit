'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { palette } from '../../lib/chart/chart-theme.mjs';
import { isValidSymbol } from '../../lib/chart/chart-source.mjs';
import { ToolButton, Popover } from './ChartUI';

// THE SYMBOL CONTROL — the first thing in the chart toolbar, and the one a trader reaches for most.
//
// NO SECOND SECURITY DATABASE. It searches /api/symbol-search, which is the one the Terminal header
// and the watchlist already use: SEC's company_tickers.json merged with our own resolved ticker
// universe, because SEC's file has no ETFs (SPY, VOO and VTI file under the fund registrant, not as
// tickers). Building a second list here would guarantee the two disagree.
//
// IT CHANGES THIS CHART, AND NOTHING ELSE. Picking a symbol does not navigate, does not touch the
// router, and does not publish to the Terminal symbol bus — so a chart panel can sit on a different
// symbol from the rest of the workspace, which is the point of having it in the panel. Selections
// arriving FROM the bus still win (see CPChart), so link groups and click-to-load are unchanged.
//
// The results list only shows what the endpoint actually returns — ticker and name. There is no
// exchange or security type in that payload, so none is displayed rather than guessed at.

const MAX_ROWS = 8;

/**
 * @param {{text:string,n:number}|null} [props.seed]  TYPE-TO-SEARCH. When `n` increases the popover
 *   opens with `text` already in the box, so the keystroke that triggered it is not swallowed. A
 *   COUNTER rather than a bare string, because typing the same first letter twice in a row has to
 *   re-open the search and "N" === "N" would not.
 */
export default function SymbolSearch({ theme, symbol, onPick, width = 96, seed = null }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [hi, setHi] = useState(0);
  const [busy, setBusy] = useState(false);
  const anchorRef = useRef(null);
  const inputRef = useRef(null);
  const reqRef = useRef(0);
  const p = palette(theme);

  const close = useCallback(() => setOpen(false), []);

  // TYPE-TO-SEARCH. Opening and seeding in the same tick is deliberate: the reset effect below
  // only fires when `open` goes FALSE, so the query set here is not cleared by it, and the input's
  // callback ref focuses the field the moment the popover mounts — which is what lets the rest of
  // the ticker flow straight into the box without the user noticing a handover.
  const seedN = seed?.n ?? 0;
  useEffect(() => {
    if (!seedN) return;
    setOpen(true);
    setQ(seed?.text || '');
    setHi(0);
  }, [seedN]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Reset on every open: the last search's results are not an answer to this one.
  useEffect(() => {
    if (!open) { setQ(''); setResults([]); setHi(0); setBusy(false); }
  }, [open]);

  // DEBOUNCED, AND STALE RESPONSES ARE DROPPED. Typing "AAPL" fires four searches and they can land
  // out of order; without the sequence check the list can settle on the answer to "AAP".
  useEffect(() => {
    if (!open) return undefined;
    const term = q.trim();
    if (!term) { setResults([]); setBusy(false); return undefined; }
    setBusy(true);
    const mine = ++reqRef.current;
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/symbol-search?q=${encodeURIComponent(term)}`, { cache: 'no-store' });
        const j = r.ok ? await r.json() : null;
        if (mine !== reqRef.current) return;
        setResults(Array.isArray(j?.results) ? j.results.slice(0, MAX_ROWS) : []);
        setHi(0);
      } catch {
        if (mine === reqRef.current) setResults([]);
      } finally {
        if (mine === reqRef.current) setBusy(false);
      }
    }, 140);
    return () => clearTimeout(t);
  }, [q, open]);

  const pick = (sym) => {
    const up = String(sym || '').toUpperCase().trim();
    if (!isValidSymbol(up)) return;
    onPick(up);
    setOpen(false);
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((i) => Math.min(i + 1, results.length - 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setHi((i) => Math.max(i - 1, 0)); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      // The highlighted match, or a symbol typed in full — "MSFT" then Enter should not need the
      // list to have caught up first.
      pick(results[hi]?.ticker || q);
    }
    // Escape is left to the Popover, which owns dismissal for every menu on the chart.
  };

  const row = (r, i) => (
    <button key={r.ticker} type="button" role="option" aria-selected={i === hi}
      onMouseEnter={() => setHi(i)} onClick={() => pick(r.ticker)}
      style={{
        display: 'flex', alignItems: 'baseline', gap: 8, width: '100%', textAlign: 'left',
        background: i === hi ? p.menuHover : 'transparent', border: 'none', borderRadius: 5,
        cursor: 'pointer', padding: '7px 9px', fontFamily: "'DM Sans',sans-serif",
      }}>
      <span style={{ fontSize: 12.5, fontWeight: 700, color: p.textStrong, flexShrink: 0 }}>{r.ticker}</span>
      <span style={{ fontSize: 11, color: p.text, overflow: 'hidden', textOverflow: 'ellipsis',
        whiteSpace: 'nowrap' }}>{r.name || ''}</span>
    </button>
  );

  return (
    <>
      <ToolButton anchorRef={anchorRef} theme={theme} active={open} expanded={open}
        onClick={() => setOpen((v) => !v)} width={width}
        title={`Symbol — ${symbol}. Click to search.`}>
        <span style={{ fontWeight: 700, fontSize: 12.5, color: p.textStrong, overflow: 'hidden',
          textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{symbol}</span>
        <span style={{ fontSize: 8, opacity: 0.7, marginLeft: 'auto' }}>▾</span>
      </ToolButton>

      <Popover anchorRef={anchorRef} open={open} onClose={close} theme={theme}
        width={292} placement="bottom-start" label="Symbol search">
        <input
          // A callback ref, not an effect: the popover only mounts once it has been placed, so this
          // runs exactly when the input first exists and the field is ready to type into.
          ref={(el) => { inputRef.current = el; if (el) el.focus(); }}
          value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKeyDown}
          placeholder="Symbol or company…" aria-label="Search symbol"
          autoComplete="off" spellCheck={false}
          style={{ width: '100%', boxSizing: 'border-box', background: 'transparent', color: p.textStrong,
            border: `1px solid ${p.border}`, borderRadius: 5, padding: '7px 9px',
            fontFamily: "'DM Sans',sans-serif", fontSize: 12.5, marginBottom: 4 }} />

        <div role="listbox" aria-label="Matching symbols">
          {results.map(row)}
        </div>

        {!results.length && (
          <div style={{ padding: '8px 9px', fontFamily: "'DM Sans',sans-serif", fontSize: 11.5,
            color: p.text, opacity: 0.85 }}>
            {!q.trim() ? 'Type a ticker or company name.'
              : busy ? 'Searching…'
                : isValidSymbol(q.trim().toUpperCase())
                  // The list is not the only way in: a valid symbol the endpoint does not know
                  // (a fresh listing, say) can still be charted, and the chart reports honestly if
                  // no data comes back.
                  ? `No match — press Enter to chart ${q.trim().toUpperCase()} anyway.`
                  : `No symbol matches “${q.trim()}”.`}
          </div>
        )}
      </Popover>
    </>
  );
}
