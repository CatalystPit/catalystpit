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
// ⚠️ WHAT THIS BOARD IS, IN ONE PLACE: end-of-day for everyone on 1W/1M/1Y and for unentitled
// readers on 1D; on 1D for an entitled reader it is a SHARED 15-MINUTE SNAPSHOT of a licensed
// real-time source — not a live ticker, and not a delayed feed. The freshness strip states which
// one is on screen on every render, along with the sessions the percentages are measured between
// and the instant the snapshot was captured. A reader comparing this against another source needs
// those more than anything else on the page.

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

// ⚠️ ALWAYS ET, NEVER THE VIEWER'S CLOCK. "Last updated 11:45 AM" means nothing to someone in
// London unless it says which market clock it is on, and the whole board is measured against a US
// session. Rendered from the snapshot's own ISO stamp, so it cannot drift from the prices.
const etTime = (iso) => {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return `${new Date(t).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })} ET`;
};

// Why a tile has no percentage. Stated plainly; never shown as 0%.
const REASON_COPY = {
  [NO_RETURN.NO_HISTORY]: 'Not listed this far back, so this window has no starting price.',
  [NO_RETURN.NO_PRICE]: 'No usable closing price for this security.',
  [NO_RETURN.SERIES_BREAK]: 'Price history breaks across this window, so a return would mislead.',
  // The rest of the board is measuring today; this symbol had no price in the snapshot, so the
  // only return available for it is the previous session's — a different period, not a smaller move.
  [NO_RETURN.NO_LIVE_PRICE]: 'No current price in this snapshot, so today’s move can’t be measured.',
};

// Matches the server snapshot's TTL: asking faster returns the same snapshot, asking slower
// leaves it on screen past its life.
// ⚠️ THE CLIENT POLL IS NOT THE REFRESH RATE. The snapshot is rebuilt server-side at most once
// every 15 minutes and shared by everyone; this only decides how soon a viewer SEES a new one. A
// poll costs a KV read, never a Tiingo batch, so 60s picks up a new snapshot promptly without
// upstream cost — and a viewer polling faster could not cause a rebuild even if they tried.
const HEATMAP_POLL_MS = 60000;

const FRESHNESS_COPY = {
  eod: { label: 'End of day', tone: 'muted', text: 'Completed-session data. Not live or intraday.' },
  delayed: { label: 'Delayed', tone: 'muted', text: 'Licensed delayed market data.' },
  // ⚠️ NOT "LIVE", AND NOT "DELAYED" EITHER — both would be wrong in different directions. The
  // board is a periodic SNAPSHOT of a licensed real-time source: the prices were current at the
  // moment of capture, and the board is rebuilt at most every 15 minutes so the upstream cost
  // stays flat however many people are watching. "Live" promises a ticking board this does not
  // provide; "15-minute delayed" describes a delayed FEED, which is not what we consume.
  realtime: { label: 'Updated every 15 min', tone: 'green', text: 'Periodic snapshots of our licensed real-time market data.' },
  // The provider missed a refresh and the board fell back to the last prices we genuinely had.
  // Serving those is the right call; serving them under the line above would not be.
  stale: { label: 'Snapshot delayed', tone: 'muted', text: 'The latest refresh has not landed — showing the last snapshot we captured.' },
  // ⚠️ THE BELL HAS RUNG AND THE BOARD HAS STOPPED. Continuing to show "Updated every 15 min" at
  // 9pm would promise refreshes that are deliberately not happening, which is the whole reason
  // overnight traffic costs nothing. Two closed states, because they are genuinely different:
  // `frozen` is the session's last snapshot, `closed` is the official settled close.
  frozen: { label: 'Market closed', tone: 'muted', text: 'Frozen at the final snapshot of the session. Official closing data pending.' },
  closed: { label: 'Market closed', tone: 'muted', text: 'Final session data.' },
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

  // ⚠️ THE BOARD A PRO READER NEEDS IS AT A DIFFERENT URL, AND THIS IS WHY.
  //
  // Free and Pro used to request the identical path, so the first anonymous response populated the
  // CDN with `public, s-maxage=300` and every entitled request afterwards was answered by the edge
  // — never reaching the server, never running auth(), always EOD. Adding `rt=1` for an entitled
  // reader puts the two audiences in different cache keys. It authorises nothing: the server
  // resolves the session itself and hands a Free caller the EOD board regardless.
  const [entitled, setEntitled] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch('/api/me/plan', { cache: 'no-store' });
        const j = r.ok ? await r.json() : null;
        if (alive) setEntitled(j?.tier === 'pro' || j?.tier === 'elite');
      } catch { if (alive) setEntitled(false); }
    })();
    return () => { alive = false; };
  }, []);

  const load = useCallback(async (tf, uni, rt) => {
    setStatus('loading');
    try {
      const q = `timeframe=${encodeURIComponent(tf)}&universe=${encodeURIComponent(uni)}${rt ? '&rt=1' : ''}`;
      const r = await fetch(`/api/heatmap/performance?${q}`, rt ? { cache: 'no-store' } : undefined);
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
  //
  // ⚠️ EXCEPT FOR AN ENTITLED READER, WHOSE FIRST PAINT IS WRONG. The SSR board is a statically
  // cached EOD page — correct and fast for everyone else, and stale by definition for someone who
  // is paying for live prices. So the moment entitlement resolves, the real board is fetched.
  const [first, setFirst] = useState(true);
  useEffect(() => {
    if (first && !entitled) { setFirst(false); return; }
    setFirst(false);
    load(timeframe, universe, entitled);
  }, [timeframe, universe, entitled]);   // eslint-disable-line react-hooks/exhaustive-deps

  // ⚠️ A SERVER SNAPSHOT THAT REFRESHES EVERY 15s IS WORTH NOTHING IF THE BROWSER NEVER ASKS AGAIN.
  // This component fetched exactly once, so even a correct payload would have frozen on screen.
  // Only the intraday window polls: 1W/1M/1Y are historical and would be re-fetching a constant.
  //
  // ⚠️ AND IT STOPS WHEN THE MARKET DOES. The board is frozen after the bell, so polling it
  // overnight would re-fetch a constant — pointless for the reader and, at scale, a standing load
  // on the route for no possible change. The server is the authority on whether the session is
  // open (`data.session.phase`); the browser never runs a market clock of its own. When the next
  // session begins, the server's answer changes on the reader's next visit or refresh and polling
  // resumes on its own.
  const sessionOpen = data?.session ? data.session.phase === 'regular' && !data.session.frozen : true;
  useEffect(() => {
    if (!entitled || timeframe !== '1D' || !sessionOpen) return undefined;
    const id = setInterval(() => {
      // A hidden tab is not watching the market; the visibility handler catches it up on return.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      load(timeframe, universe, true);
    }, HEATMAP_POLL_MS);
    const onVis = () => { if (document.visibilityState === 'visible') load(timeframe, universe, true); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, [entitled, timeframe, universe, sessionOpen, load]);

  const allRows = data?.rows || [];
  const sectors = useMemo(() => sectorOptions(allRows), [allRows]);
  const rows = useMemo(() => filterBySector(allRows, sector), [allRows, sector]);
  const gainers = useMemo(() => topMovers(rows, { direction: 'up', limit: 10 }), [rows]);
  const losers = useMemo(() => topMovers(rows, { direction: 'down', limit: 10 }), [rows]);
  const active = useMemo(() => mostActive(rows, { limit: 10 }), [rows]);

  // ⚠️ THE STRIP IS DRIVEN BY THE SERVER'S SESSION STATE, NOT BY A CLOCK IN THE BROWSER. A viewer
  // in Singapore, a viewer with a skewed system clock and a viewer in New York must all be told
  // the same thing about a market none of their machines know the hours of.
  //
  // A frozen board is still realtime-SOURCED, so `freshness` stays 'realtime' — but the reader
  // must not be told it is updating. Order matters: closed beats stale beats live.
  const fresh = (() => {
    const s = data?.session;
    if (s?.frozen) return FRESHNESS_COPY.frozen;
    if (s?.phase === 'closed' && data?.freshness === 'eod') return FRESHNESS_COPY.closed;
    if (data?.freshness === 'realtime' && data?.snapshotStale) return FRESHNESS_COPY.stale;
    return FRESHNESS_COPY[data?.freshness] || null;
  })();
  // "Last updated" belongs to a board that is still being updated. A frozen one states its session
  // date instead — "Final session data for <date>" — because the capture time of its last snapshot
  // is not what the reader is asking.
  const updatedAt = (data?.freshness === 'realtime' && !data?.session?.frozen)
    ? etTime(data?.snapshotAt) : null;
  const finalFor = (fresh === FRESHNESS_COPY.frozen || fresh === FRESHNESS_COPY.closed)
    ? longDay(data?.session?.sessionDate || data?.asOf) : null;
  // ⚠️ DESCRIBE THE BOARD THAT IS ON SCREEN, NOT THE BUTTON THAT WAS LAST PRESSED.
  //
  // `timeframe` is the SELECTED window and changes the instant a chip is clicked; `data` is the
  // window that has actually loaded. Between the two — one network round trip — every label driven
  // by `timeframe` describes a board that is not there yet, so switching to 1D rendered "Top
  // gainers · 1D" above the previous window's rows and coloured them on the 1D scale. A reader
  // glancing at that sees week-long moves presented as today's.
  //
  // Everything that makes a claim about the numbers therefore reads the PAYLOAD's timeframe. The
  // chips keep using the selected one, because those describe intent rather than data.
  const shownTimeframe = data?.timeframe || timeframe;
  const scale = scaleFor(shownTimeframe);
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
            {/* ⚠️ THE ACTUAL CAPTURE TIME, NOT A CADENCE RESTATED. "Updated every 15 min" is a
                promise about the schedule; this is the fact about THIS board, read from the
                snapshot stamp the server sent. If a refresh is missed, the label above changes and
                this time visibly stops advancing — which is exactly what should happen. */}
            {updatedAt && (
              <span style={{ color: C.dim }}>
                · Last updated <strong style={{ color: C.ink, fontWeight: 600 }}>{updatedAt}</strong>
              </span>
            )}
            {finalFor && (
              <span style={{ color: C.dim }}>
                · Final session data for <strong style={{ color: C.ink, fontWeight: 600 }}>{finalFor}</strong>
              </span>
            )}
            <span style={{ color: C.dim }}>
              {/* ⚠️ A LIVE BOARD DOES NOT END AT A CLOSE, AND SAYING SO WAS THE VISIBLE HALF OF A
                  REAL ARITHMETIC BUG. While the numerator was live the strip still read "from the
                  Sep 18 close to the Sep 21 close" — which was accurate about the calculation and
                  wrong about the product, because the calculation itself was measuring the wrong
                  pair of sessions. Both ends now come from the data: `baselineDate` is whatever
                  the rows were actually measured from, so this sentence cannot drift from the
                  number beside it. Nothing here is hardcoded. */}
              {shownTimeframe} return measured from the <strong style={{ color: C.ink, fontWeight: 600 }}>{longDay(data?.baselineDate)}</strong> close
              {/* ⚠️ "LATEST MARKET SNAPSHOT", NOT "CURRENT MARKET PRICE". The numerator is a price
                  captured at a known instant, not a continuously updating one, and the previous
                  wording promised a board that ticks. The strip already names the instant. */}
              {data?.freshness !== 'realtime'
                ? <> to the <strong style={{ color: C.ink, fontWeight: 600 }}>{longDay(data?.asOf)}</strong> close.</>
                : data?.session?.frozen
                  ? <> to that session&rsquo;s <strong style={{ color: C.ink, fontWeight: 600 }}>final snapshot</strong>.</>
                  : <> to the <strong style={{ color: C.ink, fontWeight: 600 }}>latest market snapshot</strong>.</>}
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
          <LeaderList title={`Top gainers · ${shownTimeframe}`} items={gainers}
            help={{ title: 'Top Gainers', body: `The largest positive returns over the selected window (${TIMEFRAME_LABEL[timeframe]}), within the securities currently on the board.` }} />
          <LeaderList title={`Top losers · ${shownTimeframe}`} items={losers}
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
