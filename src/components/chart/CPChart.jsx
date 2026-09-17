'use client';
import { Fragment, useEffect, useRef, useState, useCallback } from 'react';
import { useTheme } from '../../lib/cp-shared';
import {
  DEFAULT_TIMEFRAME, timeframe, timeframesByGroup, unavailableReason, isIntraday,
  supportsExtendedHours, barsUrl, normalizeBars, refreshIntervalMs, diffBars, isValidSymbol,
  sessionKeyFor,
} from '../../lib/chart/chart-source.mjs';
import { chartOptions, palette, indicatorColor, CHART_ATTRIBUTION, CHART_ATTRIBUTION_HREF } from '../../lib/chart/chart-theme.mjs';
import { INDICATORS, computeIndicator, indicatorLabel } from '../../lib/chart/chart-indicators.mjs';
import { loadIndicators, saveIndicators, loadView, saveView, DEFAULT_VIEW } from '../../lib/chart/chart-settings.mjs';
import { loadDrawings, saveDrawings } from '../../lib/chart/chart-drawing-store.mjs';
import { DEFAULT_STYLE, sanitizeStyle } from '../../lib/chart/chart-drawings.mjs';
import IndicatorBrowser from './IndicatorBrowser';
import { Dropdown, MenuItem, MenuLabel, ToolButton, VectorIcon } from './ChartUI';
import SymbolSearch from './SymbolSearch';
import ChartLegend from './ChartLegend';
import { CHART_TYPES, chartTypeOf } from '../../lib/chart/chart-types.mjs';
import DrawingLayer from './DrawingLayer';
import DrawingRail from './DrawingRail';
import ChartMenu, { viewMenuItems } from './ChartMenu';

// CATALYST PIT PRICE CHART — TradingView Lightweight Charts v5, on our own licensed data.
//
// The chart knows nothing about vendors. It asks chart-source for a URL, hands back the payload for
// normalisation, and draws what it gets; swapping the market-data provider is an edit in that module
// and not in this file. See src/lib/chart/chart-source.mjs.
//
// STRUCTURED FOR WHAT COMES NEXT. Series are created through addOverlay/removeOverlay against a
// registry of pure indicator functions, and Lightweight Charts v5 panes are addressable by index, so
// SMA/EMA/VWAP land on the price pane and RSI/MACD/ATR get their own without this component
// changing shape. Drawing tools attach to the same chart instance through its plugin API.

// US Eastern for every viewer: a market chart is read in market time, not the reader's.
const ET_HHMM = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const ET_FULL = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const businessDayToDate = (t) => (t && typeof t === 'object')
  ? new Date(Date.UTC(t.year, t.month - 1, t.day))
  : (typeof t === 'string' ? new Date(`${t}T00:00:00Z`) : null);
const fmtTime = (time, intraday) => {
  if (intraday && typeof time === 'number') return `${ET_FULL.format(new Date(time * 1000))} ET`;
  const d = businessDayToDate(time);
  return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '';
};

export default function CPChart({
  symbol,
  initialTimeframe = DEFAULT_TIMEFRAME,
  height = 0,            // floor only; the parent normally supplies the height
  showToolbar = true,
  transparent = false,
  onSymbolResolved = null,
  // WHO OWNS THE SYMBOL. Unset (the Terminal case) the chart owns it: the in-panel search changes
  // this panel and nothing else. Provided (the ticker page) the HOST owns it, because there the
  // symbol is the whole page — a chart quietly showing a different ticker from the headlines and
  // financials around it would be worse than no search at all.
  onSymbolPick = null,
}) {
  const theme = useTheme();
  const [tf, setTf] = useState(initialTimeframe);

  /**
   * THE SYMBOL THIS PANEL IS SHOWING.
   *
   * Local state seeded from the prop, NOT the prop itself, so the in-chart symbol search can put
   * this panel on a different ticker from the rest of the workspace without navigating the app or
   * republishing to the Terminal symbol bus. A selection arriving from OUTSIDE still wins: when the
   * prop changes, link groups and click-to-load behave exactly as they did.
   */
  const [sym, setSym] = useState(symbol);
  useEffect(() => { setSym(symbol); }, [symbol]);

  const [status, setStatus] = useState('loading');   // loading | ready | empty | error
  const [meta, setMeta] = useState(null);
  /**
   * THE LEGEND READOUT. One object, set once per crosshair move rather than three separate
   * setStates — a crosshair fires on every pointer move and three renders per move is three times
   * the work for one visual result.
   *
   * `cursor` is what the pointer is over; `tail` is the last bar, which is what the legend shows
   * when the pointer is off the chart. Both carry the PREVIOUS close, because change and percent
   * are measured against it.
   */
  const [cursor, setCursor] = useState(null);
  const [tail, setTail] = useState(null);
  // True when the user has scrolled back in time, which is when an offer to jump to the latest bar
  // is useful and not before.
  const [scrolledBack, setScrolledBack] = useState(false);
  const [focusIndicator, setFocusIndicator] = useState(null);
  // Saved selections are read once on mount rather than at module scope: localStorage does not exist
  // during server rendering, and reading it in the initial state would make the first client render
  // disagree with the server's.
  const [active, setActive] = useState([]);
  const [indicatorLegend, setIndicatorLegend] = useState([]);

  // View options and drawings, both persisted. Loaded on mount for the same reason the indicators
  // are: localStorage does not exist during server rendering.
  const [view, setView] = useState(DEFAULT_VIEW);
  const [drawings, setDrawings] = useState([]);
  const [activeTool, setActiveTool] = useState(null);
  const [selectedDrawing, setSelectedDrawing] = useState(null);
  const [drawStyle, setDrawStyle] = useState(DEFAULT_STYLE);
  const [fullscreen, setFullscreen] = useState(false);
  const [chartReady, setChartReady] = useState(0);   // bumps when the chart instance exists
  /**
   * RESPONSIVE ON THE CHART'S OWN WIDTH, not the viewport.
   *
   * A Terminal panel is resized independently of the window, so a media query would report "desktop"
   * for a 280px-wide panel. Measuring the element is the only thing that answers the real question:
   * is there room for these controls?
   */
  const [toolbarWidth, setToolbarWidth] = useState(9999);
  // Two thresholds, both measured against the CHART's width rather than the window's. `narrow`
  // shrinks the wordy controls and collapses the drawing rail; `overflowed` is where even those no
  // longer fit, and the lower-priority controls move into the ⋯ menu.
  const narrow = toolbarWidth < 460;
  const overflowed = toolbarWidth < 330;
  const [browserOpen, setBrowserOpen] = useState(false);

  // Derived BEFORE the refs below, which read chartType during their own initialisation.
  const intraday = isIntraday(tf);
  const chartType = view.chartType;
  const extended = view.extended;

  const hostRef = useRef(null);
  const lwcRef = useRef(null);
  const chartRef = useRef(null);
  const priceRef = useRef(null);
  const volumeRef = useRef(null);
  const overlaysRef = useRef([]);            // every indicator series currently on the chart
  // key -> the indicator's FIRST plot, so the legend can read its value under the cursor. Kept in a
  // ref and not in state: it holds live series objects, which are not React data.
  const legendSeriesRef = useRef(new Map());
  const activeRef = useRef([]);
  const tfRef = useRef(initialTimeframe);
  const volumeOnRef = useRef(true);
  const barsRef = useRef([]);
  const kindRef = useRef('daily');
  const themeRef = useRef(theme);
  const typeRef = useRef(chartType);
  themeRef.current = theme;
  typeRef.current = chartType;
  activeRef.current = active;
  tfRef.current = tf;

  const volumeOn = active.some((a) => a.id === 'volume');
  // Assigned AFTER the const it reads: a `const` is hoisted but not initialised, so touching it
  // above its declaration is a TDZ throw, not a stale value.
  volumeOnRef.current = volumeOn;

  // Saved selections, loaded on mount only (see the note on `active` above).
  useEffect(() => { setActive(loadIndicators()); setView(loadView()); }, []);

  // DRAWINGS ARE PER SYMBOL: reloaded whenever the symbol changes, and the selection is dropped
  // because the drawing it referred to belongs to a different chart now.
  useEffect(() => {
    setDrawings(loadDrawings(sym));
    setSelectedDrawing(null);
    setActiveTool(null);
  }, [sym]);

  const drawingsDirty = useRef(false);
  useEffect(() => {
    if (!drawingsDirty.current) return;
    saveDrawings(sym, drawings);
  }, [drawings, sym]);

  const updateDrawings = useCallback((next) => { drawingsDirty.current = true; setDrawings(next); }, []);

  const viewDirty = useRef(false);
  useEffect(() => {
    if (!viewDirty.current) return;
    saveView(view);
  }, [view]);
  const patchView = useCallback((next) => { viewDirty.current = true; setView((v) => ({ ...v, ...next })); }, []);

  // Style edits apply to the SELECTION when there is one, and otherwise set the style of the next
  // drawing — which is how every charting tool behaves and avoids a separate edit mode.
  const applyStyle = useCallback((patch) => {
    setDrawStyle((prev) => {
      const next = sanitizeStyle({ ...prev, ...patch });
      if (selectedDrawing) {
        drawingsDirty.current = true;
        setDrawings((ds) => ds.map((d) => (d.id === selectedDrawing ? { ...d, style: next } : d)));
      }
      return next;
    });
  }, [selectedDrawing]);

  const deleteSelected = useCallback(() => {
    if (!selectedDrawing) return;
    drawingsDirty.current = true;
    setDrawings((ds) => ds.filter((d) => d.id !== selectedDrawing));
    setSelectedDrawing(null);
  }, [selectedDrawing]);

  const clearAllDrawings = useCallback(() => {
    drawingsDirty.current = true;
    setDrawings([]);
    setSelectedDrawing(null);
  }, []);

  // Persist whatever the user lands on. Skips the pre-load empty state so a first paint cannot
  // overwrite a saved set with nothing.
  const persisted = useRef(false);
  useEffect(() => {
    if (!persisted.current) { if (active.length) persisted.current = true; return; }
    saveIndicators(active);
  }, [active]);

  // ── draw the cached bars in the currently selected shape ──
  const draw = useCallback(() => {
    const chart = chartRef.current, lwc = lwcRef.current;
    if (!chart || !lwc) return;
    const bars = barsRef.current;
    const p = palette(themeRef.current);

    if (priceRef.current) { chart.removeSeries(priceRef.current); priceRef.current = null; }
    // FROM THE REGISTRY. Adding Heikin Ashi or Bars later is an entry in chart-types.mjs; this stays.
    const ct = chartTypeOf(typeRef.current);
    priceRef.current = chart.addSeries(lwc[ct.series], {
      ...ct.options(p),
      // The current-price line and its axis label: what the last trade was, without hunting for it.
      priceLineVisible: true, priceLineWidth: 1, priceLineStyle: 2, lastValueVisible: true,
    });
    priceRef.current.setData(bars.map(ct.map));
    // VOLUME, on its own invisible scale pinned to the bottom so it never rescales price.
    // Volume is a toggle in the same menu as everything else; the chart owns the series because it
    // needs its own pinned scale, but the user's choice decides whether it exists.
    const hasVolume = volumeOnRef.current && bars.some((b) => Number(b.volume) > 0);
    if (volumeRef.current) { chart.removeSeries(volumeRef.current); volumeRef.current = null; }
    if (hasVolume) {
      volumeRef.current = chart.addSeries(lwc.HistogramSeries, {
        priceFormat: { type: 'volume' }, priceScaleId: 'cp-volume', priceLineVisible: false, lastValueVisible: false,
      });
      chart.priceScale('cp-volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, borderVisible: false });
      volumeRef.current.setData(bars.map((b) => ({
        time: b.time, value: Number(b.volume) || 0,
        color: b.close >= b.open ? p.volumeUp : p.volumeDown,
      })));
    }
    drawIndicators();
    chart.timeScale().fitContent();
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Draw every active indicator.
   *
   * REBUILT WHOLESALE on each call rather than diffed. An indicator's plot count can change with its
   * settings — Bollinger is three lines, MACD is three plots across two types — so tracking which
   * series belongs to which plot across a settings change is a bookkeeping problem with no upside.
   * Series creation is cheap; the expensive thing is the data, and that is already in memory.
   *
   * Separate-pane indicators get their own Lightweight Charts v5 pane via the paneIndex argument.
   * Panes are allocated in order and torn down together, so removing the middle one cannot leave a
   * hole that the next render draws into.
   */
  function drawIndicators() {
    const chart = chartRef.current, lwc = lwcRef.current;
    if (!chart || !lwc) return;
    const bars = barsRef.current;
    const th = themeRef.current;

    for (const s of overlaysRef.current) { try { chart.removeSeries(s); } catch { /* already gone */ } }
    overlaysRef.current = [];
    legendSeriesRef.current = new Map();
    // Drop the extra panes too, highest index first so the remaining indices stay valid.
    const panes = chart.panes();
    for (let i = panes.length - 1; i >= 1; i -= 1) { try { chart.removePane(i); } catch { /* ignore */ } }

    if (!bars.length) return;
    const ctx = { intraday: kindRef.current === 'intraday', sessionKey: sessionKeyFor(tfRef.current) };
    let paneIndex = 0;
    const legendOut = [];

    for (const entry of activeRef.current) {
      const def = INDICATORS[entry.id];
      if (!def || def.builtin) continue;                    // volume is the chart's own series
      if (entry.visible === false) continue;                // parked, but its settings are kept
      if (def.intradayOnly && !ctx.intraday) continue;      // VWAP on a daily chart is meaningless
      const { plots, guides, scale } = computeIndicator(entry.id, bars, entry.params, ctx);
      if (!plots.length || plots.every((pl) => !pl.data.length)) continue;

      const separate = def.pane === 'separate';
      if (separate) paneIndex += 1;
      const target = separate ? paneIndex : 0;

      let firstSeries = null;
      for (const plot of plots) {
        if (!plot.data.length) continue;
        // The INSTANCE's colour wins. Two EMAs differ only by their settings, so the colour has to
        // belong to the instance rather than to the indicator, or a ribbon would be one flat hue.
        // Multi-plot indicators (Bollinger's three bands) still take their shape from the registry.
        const baseIdx = def.colors?.[plot.key] ?? 0;
        const color = indicatorColor(th, (plots.length === 1 && entry.color != null) ? entry.color : baseIdx);
        const series = plot.type === 'histogram'
          ? chart.addSeries(lwc.HistogramSeries, {
            color, priceLineVisible: false, lastValueVisible: false,
            priceFormat: { type: 'price', precision: 4, minMove: 0.0001 },
          }, target)
          : chart.addSeries(lwc.LineSeries, {
            color, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: separate,
            crosshairMarkerVisible: false,
          }, target);
        // A signed histogram (MACD) reads as up/down, not as one colour.
        series.setData(plot.signed
          ? plot.data.map((d) => ({ ...d, color: d.value >= 0 ? palette(th).volumeUp : palette(th).volumeDown }))
          : plot.data);
        overlaysRef.current.push(series);
        if (!firstSeries) firstSeries = series;
      }
      // The legend shows ONE number per indicator: its primary plot. Bollinger's three bands would
      // be three numbers for one row, and the middle band is the one that answers "where is it".
      if (firstSeries) legendSeriesRef.current.set(entry.key || entry.id, firstSeries);

      // Reference levels — RSI's 30/50/70, MACD's zero. Attached to the pane's first series so they
      // move with it, and drawn flat because that is all they are.
      if (separate && guides?.length && overlaysRef.current.length) {
        const host = overlaysRef.current[overlaysRef.current.length - plots.filter((pl) => pl.data.length).length];
        for (const level of guides) {
          try {
            host.createPriceLine({ price: level, color: palette(th).grid, lineWidth: 1, lineStyle: 2, axisLabelVisible: true });
          } catch { /* a guide is decoration; never fail the chart for one */ }
        }
      }
      if (separate && scale) {
        try { chart.panes()[target]?.setHeight?.(110); } catch { /* optional */ }
      }
      legendOut.push({
        key: entry.key || entry.id,
        label: indicatorLabel(entry.id, entry.params),
        color: indicatorColor(th, entry.color != null ? entry.color : (def.colors ? Object.values(def.colors)[0] : 0)),
        visible: entry.visible !== false,
      });
    }
    setIndicatorLegend(legendOut);
  }

  // ── create once; never rebuilt on theme or timeframe change (that would lose zoom/pan) ──
  useEffect(() => {
    let disposed = false;
    let chart = null;
    (async () => {
      const lwc = await import('lightweight-charts');
      if (disposed || !hostRef.current) return;
      lwcRef.current = lwc;
      chart = lwc.createChart(hostRef.current, {
        autoSize: true,
        ...chartOptions(themeRef.current, { intraday: isIntraday(tf), transparent }),
        localization: {
          timeFormatter: (t) => fmtTime(t, typeof t === 'number'),
        },
        timeScale: {
          ...chartOptions(themeRef.current, { intraday: isIntraday(tf), transparent }).timeScale,
          tickMarkFormatter: (t) => (typeof t === 'number' ? ET_HHMM.format(new Date(t * 1000)) : null),
        },
      });
      chartRef.current = chart;
      setChartReady((n) => n + 1);

      // THE CROSSHAIR FEEDS THE LEGEND, AND NOTHING ELSE.
      //
      // There used to be a floating box following the cursor repeating the time, price and volume.
      // It is gone: the time and price are already on the crosshair's own axis labels, and every
      // other number is in the top-left legend, so the box was a third copy that covered candles and
      // sat where no charting platform puts one.
      chart.subscribeCrosshairMove((param) => {
        const off = !param.point || param.point.x < 0 || param.point.y < 0 || !param.time;
        // OFF THE CHART IS NOT "NO DATA". The legend falls back to the last bar, so the chart always
        // carries its numbers instead of going blank the moment the pointer leaves.
        if (off) { setCursor(null); return; }
        const pv = param.seriesData?.get(priceRef.current);
        const vv = volumeRef.current ? param.seriesData?.get(volumeRef.current) : null;
        if (!pv) { setCursor(null); return; }
        const o = pv.open, h = pv.high, l = pv.low, c = pv.close ?? pv.value;
        // The PREVIOUS bar's close, for the change and percent. Found by time rather than by index
        // because param carries no index, and the bars are already sorted and deduplicated.
        const bars = barsRef.current;
        let prev = null;
        for (let i = bars.length - 1; i >= 0; i -= 1) {
          if (bars[i].time === param.time) { prev = i > 0 ? bars[i - 1].close : null; break; }
        }
        const values = {};
        for (const [key, series] of legendSeriesRef.current) {
          const d = param.seriesData?.get(series);
          const v = d?.value ?? d?.close;
          if (Number.isFinite(v)) values[key] = v;
        }
        setCursor({ bar: { o, h, l, c, v: vv?.value ?? null }, prevClose: prev, values });
      });
      // FOLLOW THE POINTER, DO NOT SNAP TO IT. The library defaults to magnet mode, which jumps the
      // crosshair onto the nearest OHLC; every platform a trader arrives from keeps that off until a
      // drawing tool asks for it. Set from the library's own enum rather than the literal 0.
      try { chart.applyOptions({ crosshair: { mode: lwc.CrosshairMode.Normal } }); } catch { /* optional */ }

      // "You have scrolled back in time" — the condition for offering a jump to the latest bar.
      // Compared against the bar count rather than a time, so it holds on every timeframe.
      chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        const n = barsRef.current.length;
        if (!range || !n) { setScrolledBack(false); return; }
        setScrolledBack(range.to < n - 1.5);
      });

      if (barsRef.current.length) draw();
    })();
    return () => {
      disposed = true;
      if (chart) chart.remove();
      chartRef.current = null; priceRef.current = null; volumeRef.current = null;
      overlaysRef.current = []; lwcRef.current = null;
    };
    // Created once for the life of the component. Symbol, timeframe and theme are applied to the
    // live instance below rather than by recreating it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── price-scale mode: applied to the live chart, never by rebuilding it ──
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !lwcRef.current) return;
    chart.priceScale('right').applyOptions({
      mode: view.logScale ? lwcRef.current.PriceScaleMode.Logarithmic : lwcRef.current.PriceScaleMode.Normal,
      autoScale: view.autoScale,
    });
  }, [view.logScale, view.autoScale, chartReady]);

  /** Fit the data back into the frame and clear any manual scaling the user has done. */
  const resetView = useCallback(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.timeScale().fitContent();
    chart.priceScale('right').applyOptions({ autoScale: true });
    viewDirty.current = true;
    setView((v) => ({ ...v, autoScale: true }));
  }, []);

  /**
   * KEYBOARD SHORTCUTS, scoped to the chart.
   *
   * Bound on the chart's own container rather than the document: a Terminal workspace can hold
   * several charts, and a global listener would act on all of them at once. Typing in an input is
   * always left alone.
   */
  const rootRef = useRef(null);

  // The threshold is where the full toolbar stops fitting, measured rather than guessed: below it
  // the wordy controls collapse into one menu and the rail becomes a single button.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width ?? 0;
      if (w > 0) setToolbarWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return undefined;
    const onKey = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      if (e.key === 'Escape') { setActiveTool(null); setSelectedDrawing(null); if (fullscreen) setFullscreen(false); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { if (selectedDrawing) { e.preventDefault(); deleteSelected(); } }
      else if (e.key === 'r' || e.key === 'R') resetView();
      else if (e.key === 'l' || e.key === 'L') patchView({ logScale: !view.logScale });
      else if (e.key === 'f' || e.key === 'F') setFullscreen((v) => !v);
      else if (e.key === 'c' || e.key === 'C') patchView({ chartType: view.chartType === 'Candles' ? 'Line' : 'Candles' });
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [selectedDrawing, deleteSelected, resetView, patchView, view.logScale, view.chartType, fullscreen]);

  // ── theme: applied to the live chart, then the series are recoloured ──
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.applyOptions(chartOptions(theme, { intraday, transparent }));
    if (barsRef.current.length) draw();
  }, [theme, intraday, transparent, draw]);

  // ── load bars for the current symbol + timeframe ──
  const load = useCallback(async ({ incremental = false } = {}) => {
    if (!isValidSymbol(sym)) { setStatus('error'); return; }
    const url = barsUrl(sym, tf, { session: extended ? 'extended' : 'regular' });
    if (!url) { setStatus('error'); return; }
    if (!incremental) setStatus('loading');
    try {
      const r = await fetch(url);
      const json = await r.json();
      const { bars, meta: m } = normalizeBars(json, tf);
      setMeta(m);
      kindRef.current = m.kind;
      if (!bars.length) {
        barsRef.current = [];
        setStatus(json?.error ? 'error' : 'empty');
        return;
      }
      // INCREMENTAL WHERE POSSIBLE. A full setData() resets the user's zoom and pan, so a refresh
      // that only appends or updates the live bar is applied through update() instead.
      const delta = incremental ? diffBars(barsRef.current, bars) : null;
      barsRef.current = bars;
      // The at-rest readout: the last bar, and the close before it for the change.
      const lastBar = bars[bars.length - 1];
      setTail({
        bar: { o: lastBar.open, h: lastBar.high, l: lastBar.low, c: lastBar.close, v: lastBar.volume },
        prevClose: bars.length > 1 ? bars[bars.length - 2].close : null,
      });
      if (delta && priceRef.current) {
        for (const b of delta) {
          priceRef.current.update(chartTypeOf(typeRef.current).map(b));
          if (volumeRef.current && Number(b.volume) > 0) {
            const p = palette(themeRef.current);
            volumeRef.current.update({ time: b.time, value: Number(b.volume), color: b.close >= b.open ? p.volumeUp : p.volumeDown });
          }
        }
      } else {
        chartRef.current?.applyOptions({ timeScale: { timeVisible: m.kind === 'intraday' } });
        draw();
      }
      setStatus('ready');
      if (onSymbolResolved) onSymbolResolved(sym);
    } catch {
      setStatus('error');
    }
  }, [sym, tf, extended, draw, onSymbolResolved]);

  useEffect(() => { load(); }, [load]);

  // The indicator set, its settings, or the theme changed: recompute and redraw. Bars are already in
  // memory, so this never refetches.
  useEffect(() => {
    if (!chartRef.current || !barsRef.current.length) return;
    draw();
  }, [active, theme, draw]);

  // ── polling refresh. There is no stream to subscribe to; see REALTIME in chart-source.mjs ──
  useEffect(() => {
    const ms = refreshIntervalMs(tf);
    if (!ms) return undefined;
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;   // no work in a background tab
      load({ incremental: true });
    }, ms);
    return () => clearInterval(id);
  }, [tf, load]);

  const p = palette(theme);
  const canExtend = supportsExtendedHours(tf);
  const btn = (label, active, onClick, key) => (
    <button key={key ?? label} onClick={onClick} type="button"
      style={{
        background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px 9px', borderRadius: 4,
        fontFamily: "'DM Sans',sans-serif", fontSize: 12, whiteSpace: 'nowrap', flexShrink: 0,
        color: active ? p.textStrong : p.text, fontWeight: active ? 700 : 400,
        borderBottom: active ? `2px solid ${p.up}` : '2px solid transparent',
      }}>{label}</button>
  );

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      style={{
        display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, outline: 'none',
        // FULLSCREEN IS A FIXED OVERLAY, not the browser Fullscreen API. That API takes the whole
        // tab, which is wrong inside a Terminal workspace where the chart is one panel among
        // several, and some browsers refuse it without a user gesture. A positioned overlay keeps
        // the rest of the app addressable and behaves identically in both hosts.
        ...(fullscreen ? {
          position: 'fixed', inset: 0, zIndex: 200, background: p.background, padding: 12,
        } : null),
      }}>
      {/* TOP TOOLBAR — chart-level controls only. Drawing tools live on the left rail; the
          indicator controls live behind the Indicators button rather than spilling across here. */}
      {showToolbar && (
        // SYMBOL → TIMEFRAME → CHART TYPE → INDICATORS, hard left, then the view controls pushed
        // right. That is the order a trader's hand already knows, and it is why the symbol is the
        // first control rather than a label in the panel's title bar: the thing you change most
        // often should be the thing nearest where you are looking.
        //
        // NOWRAP, NEVER TWO ROWS. A second toolbar row steals chart height, which is the one thing
        // a panel has least of. When the panel is too narrow, lower-priority controls move into the
        // ⋯ menu instead — symbol, timeframe and chart type always survive.
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '0 2px 6px',
          flexWrap: 'nowrap', minWidth: 0, flexShrink: 0 }}>
          <SymbolSearch theme={theme} symbol={sym} onPick={onSymbolPick || setSym}
            width={narrow ? 64 : 84} />

          <div style={{ width: 1, height: 16, background: p.border, margin: '0 4px', flexShrink: 0 }} />

          {/* TIMEFRAME → CHART TYPE → INDICATORS → the rest, in that order.

              ONE COMPACT CONTROL, AT EVERY WIDTH, showing the selected interval. The row of nine
              buttons it replaces could not survive the registry growing to twenty intervals — it
              already consumed the whole toolbar at panel widths a user actually drags to, and
              minutes and hours would have made that three rows. The short label ("15m", "YTD") is
              the selection; the full name is in the menu, where it is being read.

              Grouped from the registry, so a new interval appears under its own heading with no
              change here, and the menu scrolls rather than overflowing (Popover caps its height
              against the window). */}
          <Dropdown theme={theme} width={210} menuLabel="Timeframe"
            title={`Timeframe — ${timeframe(tf)?.label ?? tf}`}
            label={timeframe(tf)?.short ?? tf} buttonWidth={44}>
            {timeframesByGroup().map((g) => (
              <Fragment key={g.id}>
                <MenuLabel theme={theme}>{g.label}</MenuLabel>
                {g.items.map((t) => {
                  // An interval the current provider cannot serve is shown but NOT selectable, with
                  // the reason on hover. Hiding it would misrepresent the product; enabling it would
                  // mean drawing candles we do not have.
                  const why = unavailableReason(t.id);
                  return (
                    <MenuItem key={t.id} theme={theme} active={t.id === tf} disabled={!!why}
                      title={why || undefined} onClick={() => setTf(t.id)}
                      right={why ? 'n/a' : undefined}>{t.label}</MenuItem>
                  );
                })}
              </Fragment>
            ))}
          </Dropdown>

          {/* ONE chart-type control, rendered from the registry — adding Heikin Ashi later puts it
              in this menu with no toolbar change, and nothing unsupported is ever listed.

              ICON ONLY, AT EVERY WIDTH. The selected type is shown by its icon, never by its name:
              a permanent "Candlestick" in the toolbar spends horizontal room on something the user
              picked and can already see in the chart, and it would grow again with every longer name
              added later. The name belongs in the menu, where it is read; the tooltip carries the
              purpose on hover.

              The menu itself is a portalled popover anchored under this icon (ChartUI's Popover), so
              it overlays the chart and is clipped by the window rather than by the Terminal panel. */}
          <Dropdown theme={theme} width={180} menuLabel="Chart type"
            title={`Chart type — ${chartTypeOf(chartType).label}`}
            label={<VectorIcon shapes={chartTypeOf(chartType).shapes} glyph={chartTypeOf(chartType).glyph} />}>
            {CHART_TYPES.map((t) => (
              <MenuItem key={t.id} theme={theme} active={t.id === chartType}
                onClick={() => patchView({ chartType: t.id })}
                left={<VectorIcon shapes={t.shapes} glyph={t.glyph} />}>{t.label}</MenuItem>
            ))}
          </Dropdown>

          {/* The prominent Indicators button. Everything about indicators lives behind it. */}
          {!overflowed && (
            <ToolButton theme={theme} width={narrow ? 30 : 92} title="Indicators"
              active={browserOpen || active.length > 0} onClick={() => setBrowserOpen(true)}>
              {narrow ? 'ƒ' : <><span>ƒ</span><span>Indicators{active.length ? ` ${active.length}` : ''}</span></>}
            </ToolButton>
          )}

          {/* Everything from here is pushed to the right-hand end of the same toolbar. */}
          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
            {overflowed
              // THE OVERFLOW MENU, not a second row. Indicators leads it because it is the first
              // thing dropped and the first thing wanted back. The view rows are the SAME rows the
              // settings menu renders — shared, not copied, so the two cannot drift apart.
              ? (
                <Dropdown theme={theme} title="More chart controls" menuLabel="More chart controls"
                  align="right" width={198} label="⋯">
                  <MenuItem theme={theme} role="menuitem" left="ƒ"
                    active={active.length > 0} onClick={() => setBrowserOpen(true)}
                    right={active.length ? String(active.length) : undefined}>Indicators</MenuItem>
                  <MenuItem theme={theme} role="menuitemcheckbox" active={fullscreen}
                    closeOnPick={false} onClick={() => setFullscreen((v) => !v)}
                    right={fullscreen ? 'On' : 'Off'}>Fullscreen</MenuItem>
                  {viewMenuItems({ theme, view, canExtend, onPatch: patchView, onReset: resetView })}
                </Dropdown>
              )
              : (
                <>
                  <ChartMenu theme={theme} view={view} canExtend={canExtend}
                    onPatch={patchView} onReset={resetView} />
                  {btn(fullscreen ? '⤢' : '⛶', fullscreen, () => setFullscreen((v) => !v), 'full')}
                </>
              )}
          </span>
        </div>
      )}

      {/* THE RAIL IS A SIBLING OF THE CHART, NOT AN OVERLAY. Sitting beside it means it can never
          cover a candle, a price label or the time axis — which is exactly what a floating palette
          does in a small Terminal panel. The chart takes the remaining width and autosizes. */}
      <div style={{ display: 'flex', flex: 1, minHeight: height || 0, gap: 0 }}>
        {showToolbar && (
          <DrawingRail
            theme={theme} activeTool={activeTool} onPick={setActiveTool}
            style={drawStyle} onStyle={applyStyle}
            selected={selectedDrawing} onDelete={deleteSelected}
            count={drawings.length} showDrawings={view.showDrawings}
            onToggleShow={() => patchView({ showDrawings: !view.showDrawings })}
            onClearAll={clearAllDrawings}
            compact={narrow}
          />
        )}

        <div style={{ position: 'relative', flex: 1, minWidth: 0, minHeight: 0 }}>
        <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />

        {/* Drawings live on a canvas over the chart, sharing its scales. Mounted once the chart
            instance exists — chartReady is what says so. */}
        {chartReady > 0 && chartRef.current && priceRef.current && (
          <DrawingLayer
            chart={chartRef.current} series={priceRef.current} theme={theme}
            symbol={sym} bars={barsRef.current}
            drawings={drawings} onChange={updateDrawings}
            activeTool={activeTool} onToolUsed={() => setActiveTool(null)}
            selectedId={selectedDrawing} onSelect={setSelectedDrawing}
            visible={view.showDrawings} style={drawStyle}
          />
        )}

        {/* THE LEGEND. Symbol, interval, O/H/L/C, change and every indicator's value, always
            populated — from the crosshair when the pointer is on the chart, from the last bar when
            it is not. See ChartLegend. */}
        {status === 'ready' && (cursor || tail) && (
          <ChartLegend
            theme={theme} symbol={sym}
            intervalLabel={timeframe(tf)?.short ?? tf}
            chartTypeLabel={chartTypeOf(chartType).label}
            delayed={meta?.delayed === true}
            bar={(cursor || tail).bar} prevClose={(cursor || tail).prevClose}
            compact={narrow}
            indicators={indicatorLegend.map((l) => ({ ...l, value: cursor?.values?.[l.key] ?? null }))}
            onToggleIndicator={(key) => setActive((list) => list.map(
              (a) => (a.key === key ? { ...a, visible: a.visible === false } : a)))}
            onSettingsIndicator={(key) => { setFocusIndicator(key); setBrowserOpen(true); }}
            onRemoveIndicator={(key) => setActive((list) => list.filter((a) => a.key !== key))}
          />
        )}

        {/* SCROLL TO THE LATEST BAR. Appears only once the user has scrolled away from it, sits
            clear of the time axis, and is the one control on the chart surface itself. */}
        {status === 'ready' && scrolledBack && (
          <button type="button" title="Scroll to the most recent bar"
            aria-label="Scroll to the most recent bar"
            onClick={() => { try { chartRef.current?.timeScale().scrollToRealTime(); } catch { /* no-op */ } }}
            style={{
              position: 'absolute', right: 58, bottom: 26, zIndex: 6, width: 22, height: 22,
              display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
              borderRadius: '50%', cursor: 'pointer', fontSize: 11, lineHeight: 1,
              background: p.tooltipBg, border: `1px solid ${p.tooltipBorder}`, color: p.text,
              boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
            }}>›</button>
        )}

        {status === 'loading' && (
          <div style={{ position: 'absolute', inset: 0, borderRadius: 6, background: p.background, opacity: 0.85,
            animation: 'cp-pulse 1.5s ease-in-out infinite' }} />
        )}
        {status === 'empty' && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: p.text, fontSize: 13, fontStyle: 'italic' }}>No price history for this range</div>
        )}
        {status === 'error' && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', gap: 8,
            alignItems: 'center', justifyContent: 'center', color: p.text, fontSize: 13 }}>
            <span style={{ fontStyle: 'italic' }}>Chart data unavailable</span>
            <button type="button" onClick={() => load()} style={{ cursor: 'pointer', background: 'transparent',
              border: `1px solid ${p.border}`, borderRadius: 4, padding: '3px 10px', color: p.text, fontSize: 11 }}>Retry</button>
          </div>
        )}

      </div>

      </div>{/* rail + chart row */}

      <IndicatorBrowser
        open={browserOpen} onClose={() => { setBrowserOpen(false); setFocusIndicator(null); }}
        focusKey={focusIndicator}
        theme={theme} intraday={intraday} active={active} onChange={setActive}
      />

      {/* Apache-2.0 attribution — required, and asserted by scripts/verify-chart.mjs */}
      <div style={{ paddingTop: 6, fontFamily: "'DM Sans',sans-serif", fontSize: 10, color: p.text, letterSpacing: '0.3px' }}>
        {meta?.delayed === true ? '15-min delayed · ' : ''}
        {extended && canExtend ? 'Extended hours · ' : ''}
        <a href={CHART_ATTRIBUTION_HREF} target="_blank" rel="noopener noreferrer"
          style={{ color: 'inherit', textDecoration: 'none' }}>{CHART_ATTRIBUTION}</a>
      </div>
    </div>
  );
}
