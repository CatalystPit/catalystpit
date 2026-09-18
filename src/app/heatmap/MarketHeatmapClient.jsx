'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { C, BrandStyles, TopNav, Footer, TickerLogo } from '../../lib/cp-shared';
import HeatmapCanvas from '../../components/heatmap/HeatmapCanvas';
import InfoTip from '../../components/InfoTip';
import { useTickerHover, TickerHoverPreview } from '../../components/TickerHoverChart';
import { TIMEFRAMES, DEFAULT_TIMEFRAME, TIMEFRAME_LABEL, NO_RETURN } from '../../lib/heatmap/heatmap-window.mjs';
import { scaleFor } from '../../lib/heatmap/heatmap-layout.mjs';
import {
  UNIVERSES, DEFAULT_UNIVERSE, ALL_SECTORS, SECTOR_OTHER, sectorOptions, filterBySector,
  topMovers, mostActive,
} from '../../lib/heatmap/heatmap-universe.mjs';

// THE MARKET HEATMAP PAGE.
//
// Tiles are sized by MARKET CAP and coloured by RETURN OVER THE SELECTED WINDOW. Those are two
// different quantities and keeping them distinct is the grammar of a heatmap: size is how much of
// the market a name represents, colour is how it moved.
//
// 1D / 1W / 1M / 1Y here are PERFORMANCE WINDOWS, not candle intervals — see heatmap-window.mjs for
// the boundary rules. The leaders lists follow the SAME window as the board, because "Top Gainers"
// beside a 1Y heatmap that silently ranked daily movers would be quietly wrong.
//
// ⚠️ The board is END-OF-DAY until the licensed provider lands. The freshness strip says so, on
// every render, with the exact sessions the percentages are measured between — a reader comparing
// this against a live source needs that more than anything else on the page.

const pctText = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`);
const capText = (v) => {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  return `$${Math.round(v).toLocaleString()}`;
};
const volText = (v) => {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return String(Math.round(v));
};
const priceText = (v) => (v == null || !Number.isFinite(v) ? '—' : `$${Number(v).toFixed(2)}`);
const longDay = (s) => (s ? new Date(`${s}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }) : '—');

// Why a tile has no percentage. Stated plainly; never shown as 0%.
const REASON_COPY = {
  [NO_RETURN.NO_HISTORY]: 'Not listed this far back, so this window has no starting price.',
  [NO_RETURN.NO_PRICE]: 'No usable closing price for this security.',
  [NO_RETURN.SERIES_BREAK]: 'Price history breaks across this window, so a return would mislead.',
};

const FRESHNESS_COPY = {
  eod: { label: 'End of day', tone: 'muted', text: 'Completed-session data. Not live or intraday.' },
  delayed: { label: 'Delayed', tone: 'muted', text: 'Licensed delayed market data.' },
  realtime: { label: 'Live', tone: 'green', text: 'Real-time market data.' },
};

export default function MarketHeatmapClient({ initial }) {
  const router = useRouter();
  const [timeframe, setTimeframe] = useState(DEFAULT_TIMEFRAME);
  const [universe, setUniverse] = useState(DEFAULT_UNIVERSE);
  const [sector, setSector] = useState(ALL_SECTORS);
  const [data, setData] = useState(initial || null);
  const [status, setStatus] = useState('ready');
  const { hover, bind: bindHover } = useTickerHover();
  // How much of the requested universe the board could actually draw, reported by the canvas.
  const [coverage, setCoverage] = useState({ total: 0, drawn: 0, hidden: 0 });

  const load = useCallback(async (tf, uni) => {
    setStatus('loading');
    try {
      const r = await fetch(`/api/heatmap/performance?timeframe=${encodeURIComponent(tf)}&universe=${encodeURIComponent(uni)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData(await r.json());
      setStatus('ready');
    } catch {
      // The previous board stays on screen and the state is named: an empty heatmap and a failed
      // request look identical and mean opposite things.
      setStatus('error');
    }
  }, []);

  // The server rendered the opening board; the first effect must not refetch it.
  const [first, setFirst] = useState(true);
  useEffect(() => {
    if (first) { setFirst(false); return; }
    load(timeframe, universe);
  }, [timeframe, universe]);   // eslint-disable-line react-hooks/exhaustive-deps

  const allRows = data?.rows || [];
  const sectors = useMemo(() => sectorOptions(allRows), [allRows]);
  const rows = useMemo(() => filterBySector(allRows, sector), [allRows, sector]);
  const gainers = useMemo(() => topMovers(rows, { direction: 'up', limit: 10 }), [rows]);
  const losers = useMemo(() => topMovers(rows, { direction: 'down', limit: 10 }), [rows]);
  const active = useMemo(() => mostActive(rows, { limit: 10 }), [rows]);

  const fresh = FRESHNESS_COPY[data?.freshness] || null;
  const scale = scaleFor(timeframe);
  const go = (t) => router.push(`/ticker/${encodeURIComponent(t)}`);

  const chip = (on) => ({
    fontFamily: "'DM Sans',sans-serif", fontSize: 12.5, fontWeight: on ? 700 : 500,
    color: on ? '#fff' : C.muted, background: on ? C.green : C.white,
    border: `1px solid ${on ? C.green : C.border}`, borderRadius: 6, padding: '5px 12px', cursor: 'pointer',
  });
  const field = {
    fontFamily: "'DM Sans',sans-serif", fontSize: 12.5, color: C.ink, background: C.white,
    border: `1px solid ${C.border}`, borderRadius: 6, padding: '6px 9px',
  };

  // The hover card. Positioned to flip and clamp so it survives the top row of tiles and the right
  // edge of the board — the same rule the ticker preview uses.
  const renderTooltip = (row, rect) => {
    const W = 248, H = 168;
    let left = rect.right + 10;
    if (left + W > window.innerWidth - 8) left = Math.max(8, rect.left - W - 10);
    let top = rect.top;
    if (top + H > window.innerHeight - 8) top = window.innerHeight - H - 8;
    if (top < 8) top = 8;
    const line = (k, v) => (
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 11.5, marginTop: 3 }}>
        <span style={{ color: C.dim }}>{k}</span><span style={{ color: C.ink, fontWeight: 600 }}>{v}</span>
      </div>
    );
    return (
      <div style={{ position: 'fixed', top, left, width: W, zIndex: 120, pointerEvents: 'none',
        background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 12px',
        boxShadow: '0 8px 28px rgba(0,0,0,0.18)', fontFamily: "'DM Sans',sans-serif" }}>
        <div className="cp-tkr" style={{ fontSize: 13, fontWeight: 800, color: C.ink }}>{row.ticker}</div>
        {row.company && (
          <div style={{ fontSize: 11, color: C.muted, marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.company}</div>
        )}
        <div style={{ borderTop: `1px solid ${C.surface}`, marginTop: 7, paddingTop: 5 }}>
          {line(`${timeframe} return`, row.pct == null ? '—' : pctText(row.pct))}
          {line('Price', priceText(row.price))}
          {line('Market cap', capText(row.marketCap))}
          {line('Sector', row.sector || SECTOR_OTHER)}
        </div>
        {row.pct == null && row.reason && (
          <div style={{ fontSize: 10.5, color: C.dim, marginTop: 6, lineHeight: 1.4 }}>{REASON_COPY[row.reason] || 'No return available.'}</div>
        )}
      </div>
    );
  };

  const LeaderList = ({ title, items, help, metric = 'pct', note }) => (
    <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', fontSize: 10, fontWeight: 700, letterSpacing: '0.04em',
        color: C.dim, textTransform: 'uppercase', marginBottom: 6 }}>
        {title}{help && <InfoTip title={help.title} body={help.body} label={help.title} />}
      </div>
      {note && <div style={{ fontSize: 10, color: C.dim, marginBottom: 6 }}>{note}</div>}
      {items.length === 0
        ? <div style={{ fontSize: 11.5, color: C.dim, padding: '6px 0' }}>Nothing to rank for this window.</div>
        : items.map((r) => (
          <div key={r.ticker} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '3px 0' }}>
            <a href={`/ticker/${encodeURIComponent(r.ticker)}`} {...bindHover(r.ticker)}
              style={{ display: 'flex', alignItems: 'center', gap: 6, textDecoration: 'none', flex: '1 1 auto', minWidth: 0 }}>
              <TickerLogo symbol={r.ticker} size={16} />
              <span className="cp-tkr" style={{ fontSize: 12, fontWeight: 700, color: C.ink }}>{r.ticker}</span>
              <span style={{ fontSize: 11, color: C.dim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.company || ''}</span>
            </a>
            <span className="cp-num" style={{ fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap',
              color: metric === 'volume' ? C.muted : (r.pct > 0 ? C.green : r.pct < 0 ? C.red : C.muted) }}>
              {metric === 'volume' ? volText(r.volume) : pctText(r.pct)}
            </span>
          </div>
        ))}
    </div>
  );

  return (
    <div style={{ fontFamily: "'DM Sans',sans-serif", background: C.bg, color: C.text, minHeight: '100vh' }}>
      <BrandStyles />
      <TopNav active="Heatmap" />

      <div style={{ maxWidth: 1480, margin: '0 auto', padding: '18px 20px 40px' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: C.ink, margin: '0 0 2px' }}>Market Heatmap</h1>
        <div style={{ fontSize: 13, color: C.muted, margin: '0 0 12px' }}>
          Tiles sized by market capitalisation, coloured by return over the selected window.
        </div>

        {/* ── CONTROLS ── */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 10 }}>
          <div style={{ display: 'flex', gap: 5 }}>
            {TIMEFRAMES.map((t) => (
              <button key={t} onClick={() => setTimeframe(t)} style={chip(timeframe === t)}
                aria-pressed={timeframe === t} title={`Return over ${TIMEFRAME_LABEL[t]}`}>{t}</button>
            ))}
          </div>
          <select value={universe} onChange={(e) => setUniverse(e.target.value)} style={field} aria-label="Universe">
            {UNIVERSES.map((u) => (
              <option key={u.id} value={u.id} disabled={!u.available}>
                {u.label}{u.available ? '' : ' — needs licensed index data'}
              </option>
            ))}
          </select>
          <select value={sector} onChange={(e) => setSector(e.target.value)} style={field} aria-label="Sector">
            <option value={ALL_SECTORS}>All sectors</option>
            {sectors.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          {status === 'loading' && <span style={{ fontSize: 11.5, color: C.dim }}>Loading…</span>}
          {status === 'error' && <span style={{ fontSize: 11.5, color: C.red }}>Couldn’t refresh — showing the last board.</span>}
        </div>

        {/* ── FRESHNESS. Exactly what data this is, and the two sessions it is measured between. ── */}
        {fresh && (
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 11.5,
            color: C.muted, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8,
            padding: '7px 11px', marginBottom: 10 }}>
            <span style={{ fontWeight: 700, color: fresh.tone === 'green' ? C.green : C.ink,
              border: `1px solid ${C.border}`, borderRadius: 4, padding: '1px 6px', fontSize: 10,
              textTransform: 'uppercase', letterSpacing: '0.04em' }}>{fresh.label}</span>
            <span>{fresh.text}</span>
            <span style={{ color: C.dim }}>
              {timeframe} return measured from the <strong style={{ color: C.ink, fontWeight: 600 }}>{longDay(data?.baselineDate)}</strong> close
              to the <strong style={{ color: C.ink, fontWeight: 600 }}>{longDay(data?.asOf)}</strong> close.
            </span>
            {data?.counts && (
              <span style={{ color: C.dim }}>
                · {data.counts.measured} of {data.counts.rows} securities measurable
              </span>
            )}
          </div>
        )}

        {/* ── THE BOARD. Full width and the dominant element on the page: this is what the page is
               for, and the leadership cards read as its summary rather than as its equal. The height
               is a viewport-relative band with a floor and a ceiling, so a wide desktop gets a strong
               landscape treemap without the page becoming a single tall screen of colour. ── */}
        <div className="cp-hm-board" style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
          <HeatmapCanvas rows={data ? rows : null} onPick={go} scale={scale} renderTooltip={renderTooltip}
            onCoverage={setCoverage} emptyLabel="No securities match this filter."
            // THE MAP SIZES ITSELF. A fixed clamp knew nothing about how many sectors were on the
            // board, so Top 500 crushed its thinnest sector into 7.7px and clipped the header off the
            // bottom. It now takes the height its own geometry needs and the page scrolls.
            autoHeight minHeight={480} maxHeight={2200} />
        </div>

        {/* What did not fit. A board that quietly drops the bottom of its universe is lying by
            omission; one that says how many and what to do about it is not. */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'baseline',
          fontSize: 11, color: C.dim, margin: '7px 2px 12px', lineHeight: 1.6 }}>
          <span>
            Showing <strong style={{ color: C.muted, fontWeight: 600 }}>{coverage.drawn.toLocaleString()}</strong> of{' '}
            {coverage.total.toLocaleString()} securities
            {sector !== ALL_SECTORS ? ` in ${sector}` : ''}.
          </span>
          {coverage.hidden > 0 && (
            <span>
              {coverage.hidden.toLocaleString()} are too small to draw at this size — choose a sector, or a smaller universe, to see them.
            </span>
          )}
          <span>Colour saturates at ±{scale}% for {timeframe}.</span>
        </div>

        {/* ── LEADERSHIP. Three equal cards across the full width; wrapping at medium widths and
               stacking on a phone. ── */}
        <div className="cp-hm-cards">
          <LeaderList title={`Top gainers · ${timeframe}`} items={gainers}
            help={{ title: 'Top Gainers', body: `The largest positive returns over the selected window (${TIMEFRAME_LABEL[timeframe]}), within the securities currently on the board.` }} />
          <LeaderList title={`Top losers · ${timeframe}`} items={losers}
            help={{ title: 'Top Losers', body: `The largest negative returns over the selected window (${TIMEFRAME_LABEL[timeframe]}), within the securities currently on the board.` }} />
          {/* Most Active is a SESSION measure, so it is labelled with its session rather than with the
              selected window — "Most active 1M" would claim something we are not measuring. Omitted
              entirely when no row carries a real volume, rather than shown empty. */}
          {active.length > 0 && (
            <LeaderList title="Most active" items={active} metric="volume"
              note={`Share volume · ${longDay(data?.asOf)} session · end of day`}
              help={{ title: 'Most Active', body: 'Share volume for the most recent completed trading session. This is a session measure, so it does NOT follow the selected return window. When a licensed live feed is connected this can become intraday volume.' }} />
          )}
        </div>

        <div style={{ fontSize: 11, color: C.dim, marginTop: 12, lineHeight: 1.6 }}>
          Securities with no reliable sector are grouped under “{SECTOR_OTHER}” and are never assigned a guessed one. A tile with no
          percentage had no honest starting price for this window — hover it for the reason. Funds, warrants and units are excluded:
          a fund holds securities already on this board. Not investment advice.
        </div>
      </div>

      <TickerHoverPreview hover={hover} />
      <Footer />
      <style>{`
        /* THE BOARD HAS NO FIXED HEIGHT. It was clamp(460px, 62vh, 760px), which is a number that
           knows nothing about how many sectors are on the board — so at Top 500 the thinnest sector
           got 7.7px, its 13px header painted 5.3px past the bottom edge, and the container's
           overflow:hidden cut it off. The canvas now measures its width, derives the height its own
           treemap needs, and sets it; the page scrolls, which is far better than crushing a sector. */
        .cp-hm-board { min-height: 0; }
        /* Three equal leadership cards across the full width. */
        .cp-hm-cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; align-items: start; }
        /* Medium widths: two across, the third wraps beneath. */
        @media (max-width: 1100px) { .cp-hm-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
        /* Phones: stacked cards. The board still sizes itself — a narrow screen needs MORE height,
           not less, because the same sectors have less width to spread across. */
        @media (max-width: 720px) { .cp-hm-cards { grid-template-columns: 1fr; } }
      `}</style>
    </div>
  );
}
