'use client';
import { Fragment, useEffect, useRef, useState, useCallback } from 'react';
import { useTheme } from '../../lib/cp-shared';
import {
  DEFAULT_TIMEFRAME, timeframe, timeframesByGroup, unavailableReason, isIntraday,
  supportsExtendedHours, barsUrl, normalizeBars, refreshIntervalMs, diffBars, isValidSymbol, initialBarsFor,
  sessionKeyFor,
} from '../../lib/chart/chart-source.mjs';
import { chartOptions, palette, indicatorColor, CHART_ATTRIBUTION, CHART_ATTRIBUTION_HREF } from '../../lib/chart/chart-theme.mjs';

/**
 * ONE DOWNLOAD PER UNDERLYING SERIES, shared across the intervals folded from it.
 *
 * 1W, 1M, 3M and 1Y all request the same thing — the security's full daily history — and differ only
 * in how `normalizeBars` folds it. Without this, walking along the timeframe row would re-download
 * eleven thousand daily candles four times over.
 *
 * Keyed on the URL, so it reuses a payload only when the request is genuinely identical, and never
 * across symbols. Short-lived and capped: this is a tab-local convenience, not a data store, and the
 * live-bar refresh path deliberately bypasses it.
 */
const PAYLOAD_TTL_MS = 5 * 60 * 1000;
const PAYLOAD_MAX = 8;
const payloadCache = new Map();   // url -> { at, json }

async function fetchPayload(url, { fresh = false } = {}) {
  if (!fresh) {
    const hit = payloadCache.get(url);
    if (hit && Date.now() - hit.at < PAYLOAD_TTL_MS) return hit.json;
  }
  const r = await fetch(url);
  const json = await r.json();
  // A failed or empty payload is not worth remembering; caching it would pin the error for a while.
  if (json && !json.error) {
    payloadCache.set(url, { at: Date.now(), json });
    if (payloadCache.size > PAYLOAD_MAX) payloadCache.delete(payloadCache.keys().next().value);
  }
  return json;
}
import { INDICATORS, computeIndicator, indicatorLabel } from '../../lib/chart/chart-indicators.mjs';
import { resolvePaneShares, applyPaneShares, readPaneShares, manualPaneChanges } from '../../lib/chart/chart-panes.mjs';
import {
  loadIndicators, saveIndicators, loadView, saveView, DEFAULT_VIEW,
  loadToolDefaults, saveToolDefaults, rememberToolDefaults,
} from '../../lib/chart/chart-settings.mjs';
import { loadDrawings, saveDrawings } from '../../lib/chart/chart-drawing-store.mjs';
import {
  DEFAULT_STYLE, sanitizeStyle, cloneDrawing, moveDrawing, createDrawing, reorderDrawing,
} from '../../lib/chart/chart-drawings.mjs';
import { emptyHistory, record, undo, redo, canUndo, canRedo } from '../../lib/chart/chart-history.mjs';
import { composeExport, captionFor, exportFilename } from '../../lib/chart/chart-export.mjs';
import {
  resolveTypedTimeframe, shouldOpenQuickTimeframe, isTypingTarget, QUICK_TIMEFRAME_TIMEOUT_MS,
} from '../../lib/chart/chart-quick-timeframe.mjs';
import IndicatorBrowser from './IndicatorBrowser';
import { Dropdown, MenuItem, MenuLabel, Popover, ToolButton, VectorIcon } from './ChartUI';
import SymbolSearch from './SymbolSearch';
import ChartLegend from './ChartLegend';
import DrawingManager from './DrawingManager';
import DrawingSettings from './DrawingSettings';
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
  const [managerOpen, setManagerOpen] = useState(false);
  // The right-click menu's position, in VIEWPORT coordinates, or null when it is closed. The
  // position IS the open state: a context menu without a point has nowhere to be.
  const [menuAt, setMenuAt] = useState(null);
  // The price-scale menu is a SECOND menu at the same cursor: right-clicking the scale asks about
  // the scale, not about the chart, which is what every platform does.
  const [scaleMenuAt, setScaleMenuAt] = useState(null);
  // A note being written, or edited. { points } while new, { id } while editing.
  const [noteDraft, setNoteDraft] = useState(null);
  const [noteText, setNoteText] = useState('');
  // Bumped on Escape, which tells the drawing layer to drop a measurement or a half-placed shape.
  const [clearSignal, setClearSignal] = useState(0);
  /**
   * TYPE-A-TIMEFRAME. `null` when closed; otherwise what has been typed so far plus any refusal to
   * show. The box is the only place raw digits are captured, and it opens only when the keystroke
   * was not already going to a field that wanted it.
   */
  const [quickTf, setQuickTf] = useState(null);
  /**
   * WHAT EACH TOOL WAS LAST USED WITH.
   *
   * Drawing a second trend line should not mean choosing the colour, the width and the extensions
   * again. Read on mount like the rest of the saved state, updated whenever a drawing's settings
   * change, and applied to the next drawing of that type. Keyed by tool, so editing a Fibonacci's
   * levels never changes what a rectangle looks like.
   */
  const [toolDefaults, setToolDefaults] = useState({});
  useEffect(() => { setToolDefaults(loadToolDefaults()); }, []);
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
  /**
   * THE SELECTION IS A LIST, not an id.
   *
   * Shift-clicking adds to it, the object tree can select several, and a drag moves all of them at
   * once. Everything that used to act on "the selected drawing" now acts on the list, which is what
   * makes a bulk action a single change — and therefore a single undo step.
   */
  const [selectedIds, setSelectedIds] = useState([]);
  const [settingsId, setSettingsId] = useState(null);
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
  // What the lower panes were last sized to — { keys, shares } — so a separator drag can be told
  // apart from the sizes the chart itself applied.
  const paneAppliedRef = useRef(null);
  const activeRef = useRef([]);
  const tfRef = useRef(initialTimeframe);
  const volumeOnRef = useRef(true);
  const barsRef = useRef([]);
  /**
   * time -> index, rebuilt whenever the bars are.
   *
   * The crosshair handler needs the PREVIOUS bar's close on every pointer move, and it used to find
   * it by scanning the bar list backwards — five thousand comparisons per mouse move on a five-year
   * daily chart, for one number. Built once per load instead.
   */
  const barIndexRef = useRef(new Map());
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
    setSelectedIds([]);
    setActiveTool(null);
    // THE HISTORY IS PER SYMBOL. Undoing into a stack of another symbol's drawings would paste them
    // onto this chart, so the stack is dropped when the symbol changes rather than carried over.
    historyRef.current = emptyHistory();
    setHistTick((t) => t + 1);
  }, [sym]);

  const drawingsDirty = useRef(false);
  useEffect(() => {
    if (!drawingsDirty.current) return;
    saveDrawings(sym, drawings);
  }, [drawings, sym]);

  /**
   * UNDO / REDO, per chart panel.
   *
   * The stack lives in a ref rather than in state so the undo and redo callbacks never change
   * identity — they are bound to the chart's keydown handler, and a callback that changed on every
   * edit would re-bind the listener on every edit. A counter bumps alongside it purely so the
   * toolbar buttons re-render enabled or disabled.
   *
   * Both refs mirror current state so a callback can read "what is on the chart right now" without
   * being rebuilt when it changes.
   */
  const drawingsRef = useRef([]);
  drawingsRef.current = drawings;
  const viewRef = useRef(view);
  viewRef.current = view;
  const selectedIdsRef = useRef([]);
  selectedIdsRef.current = selectedIds;
  const historyRef = useRef(emptyHistory());
  const [histTick, setHistTick] = useState(0);
  const bumpHistory = useCallback(() => setHistTick((t) => t + 1), []);

  /**
   * Every drawing change goes through here, which is what makes the history complete: create,
   * delete, move, resize, clone, lock, hide and restyle all land in one place.
   *
   * The tag coalesces a gesture — a drag passes one token for its whole duration, so the hundred
   * changes a pointer-move produces collapse into the single undo step a user expects.
   */
  const updateDrawings = useCallback((next, tag = null) => {
    drawingsDirty.current = true;
    const prev = drawingsRef.current;
    const resolved = typeof next === 'function' ? next(prev) : next;
    historyRef.current = record(historyRef.current, prev, tag);
    bumpHistory();
    setDrawings(resolved);
  }, [bumpHistory]);

  /**
   * Move the selected drawing by N screen pixels.
   *
   * Converted to a PRICE delta through the series' own scale, so a pixel means a pixel whatever the
   * chart is showing — and to a TIME delta through the bar list, because a horizontal nudge has to
   * land on a bar exactly as a drag does.
   *
   * Returns false when it could not act, so the key event falls through to whatever else wants it
   * rather than being silently swallowed.
   */
  const nudgeSelected = useCallback((key, steps) => {
    const series = priceRef.current;
    const chart = chartRef.current;
    // EVERY unlocked drawing in the selection moves, by one delta measured from the first — the same
    // rule a group drag follows, so the keyboard and the pointer agree.
    const ids = new Set(selectedIdsRef.current);
    const targets = drawingsRef.current.filter((x) => ids.has(x.id) && !x.locked);
    const target = targets[0];
    if (!series || !chart || !target) return false;

    if (key === 'ArrowUp' || key === 'ArrowDown') {
      // Price per pixel, read off the live scale rather than assumed.
      const mid = series.priceToCoordinate(target.points[0].price);
      if (mid == null) return false;
      const a1 = series.coordinateToPrice(mid);
      const a2 = series.coordinateToPrice(mid - steps);
      if (a1 == null || a2 == null) return false;
      const dPrice = (a2 - a1) * (key === 'ArrowUp' ? 1 : -1);
      updateDrawings((ds) => ds.map((x) => (ids.has(x.id) ? moveDrawing(x, { dPrice }) : x)), null);
      return true;
    }

    // HORIZONTAL NUDGE NEEDS A NUMERIC TIME. Daily bars carry a date string, which cannot take an
    // arithmetic delta — the same limitation a drag has, and moveDrawing refuses it there too.
    const list = barsRef.current;
    if (!list.length || typeof target.points[0].time !== 'number') return false;
    const i = list.findIndex((x) => x.time === target.points[0].time);
    if (i < 0) return false;
    const j = Math.max(0, Math.min(list.length - 1, i + (key === 'ArrowRight' ? steps : -steps)));
    const dTime = list[j].time - list[i].time;
    if (!dTime) return false;
    updateDrawings((ds) => ds.map((x) => (ids.has(x.id) ? moveDrawing(x, { dTime }) : x)), null);
    return true;
  }, [updateDrawings]);

  /**
   * Commit the note being written.
   *
   * An EMPTY note is not created, and clearing an existing one deletes it — a blank label on a chart
   * is an invisible object the user then has to hunt for in the object tree to get rid of.
   */
  const commitNote = useCallback(() => {
    const text = noteText.trim();
    if (noteDraft?.id) {
      if (text) updateDrawings((ds) => ds.map((d) => (d.id === noteDraft.id ? { ...d, text } : d)));
      else updateDrawings((ds) => ds.filter((d) => d.id !== noteDraft.id));
    } else if (noteDraft?.points && text) {
      const made = createDrawing('text', noteDraft.points, drawStyle, drawingsRef.current, { text });
      if (made) { updateDrawings([...drawingsRef.current, made]); setSelectedIds([made.id]); }
    }
    setNoteDraft(null); setNoteText('');
  }, [noteDraft, noteText, drawStyle, updateDrawings]);

  /** Replace the selection, or add to and remove from it when the gesture is additive. */
  const selectDrawing = useCallback((id, additive = false) => {
    setSelectedIds((prev) => {
      if (id == null) return [];
      if (!additive) return [id];
      return prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
    });
  }, []);

  /** Move one drawing through the z-order. The array IS the order, so this is an array move. */
  const reorder = useCallback((id, where) => {
    updateDrawings((ds) => reorderDrawing(ds, id, where));
  }, [updateDrawings]);

  /**
   * A bulk action over the whole selection, applied as ONE change.
   *
   * That is the point: one call to updateDrawings means one history entry, so hiding nine drawings
   * is undone by one Ctrl+Z rather than nine.
   */
  const bulkAction = useCallback((what) => {
    const ids = new Set(selectedIdsRef.current);
    if (!ids.size) return;
    updateDrawings((ds) => {
      if (what === 'delete') return ds.filter((d) => !ids.has(d.id));
      if (what === 'front' || what === 'back') {
        // Applied one at a time in order so the group keeps its internal stacking rather than being
        // reversed by each move landing on top of the last.
        let out = ds;
        const ordered = ds.filter((d) => ids.has(d.id));
        for (const d of (what === 'front' ? ordered : [...ordered].reverse())) {
          out = reorderDrawing(out, d.id, what);
        }
        return out;
      }
      const patch = what === 'hide' ? { visible: false }
        : what === 'show' ? { visible: true }
          : what === 'lock' ? { locked: true }
            : what === 'unlock' ? { locked: false } : null;
      if (!patch) return ds;
      return ds.map((d) => (ids.has(d.id) ? { ...d, ...patch } : d));
    });
    if (what === 'delete') setSelectedIds([]);
  }, [updateDrawings]);

  /**
   * Save the chart as a PNG.
   *
   * Composes the library's own canvas with our drawing overlay and a caption — see chart-export.
   * NOTHING OUTSIDE THE CHART IS CAPTURED: not the Terminal panel's chrome, not other panels, not
   * the rest of the app. That is a privacy property as much as a tidiness one, because an exported
   * image is the thing that gets pasted into a chat.
   */
  const exportPng = useCallback(() => {
    const chart = chartRef.current;
    const host = hostRef.current;
    if (!chart || !host) return;
    let shot = null;
    try { shot = chart.takeScreenshot(); } catch { shot = null; }
    if (!shot) return;
    const overlay = host.parentElement?.querySelector('canvas[data-cp-drawings]') || null;
    const pal = palette(themeRef.current);
    const canvas = composeExport({
      chartCanvas: shot,
      overlayCanvas: overlay,
      width: host.clientWidth,
      height: host.clientHeight,
      caption: captionFor({
        symbol: sym,
        interval: timeframe(tf)?.label ?? tf,
        chartType: chartTypeOf(view.chartType).label,
        delayed: meta?.delayed === true,
      }),
      background: pal.background,
      textColor: pal.textStrong,
      subColor: pal.text,
      attribution: CHART_ATTRIBUTION,
    });
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = exportFilename(sym, timeframe(tf)?.short ?? tf);
      a.click();
      // Revoked on the next turn of the loop: revoking synchronously can beat the download in some
      // browsers and produce an empty file.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }, 'image/png');
  }, [sym, tf, view.chartType, meta]);

  const undoDrawings = useCallback(() => {
    const r = undo(historyRef.current, drawingsRef.current);
    if (!r) return;
    historyRef.current = r.history;
    drawingsDirty.current = true;
    // The selection is dropped: the drawing it pointed at may not exist in the restored state.
    setSelectedIds([]);
    setDrawings(r.state);
    bumpHistory();
  }, [bumpHistory]);

  const redoDrawings = useCallback(() => {
    const r = redo(historyRef.current, drawingsRef.current);
    if (!r) return;
    historyRef.current = r.history;
    drawingsDirty.current = true;
    setSelectedIds([]);
    setDrawings(r.state);
    bumpHistory();
  }, [bumpHistory]);

  // Duplicating goes through cloneDrawing so the id rules stay in the drawing model, and the copy is
  // selected immediately — it sits exactly on the original, so the selection is what tells the user
  // which one their next drag will move.
  const duplicateDrawing = useCallback((id) => {
    setDrawings((ds) => {
      const src = ds.find((d) => d.id === id);
      const copy = src ? cloneDrawing(src, ds) : null;
      if (!copy) return ds;
      drawingsDirty.current = true;
      setSelectedIds([copy.id]);
      return [...ds, copy];
    });
  }, []);

  const viewDirty = useRef(false);
  useEffect(() => {
    if (!viewDirty.current) return;
    saveView(view);
  }, [view]);
  const patchView = useCallback((next) => { viewDirty.current = true; setView((v) => ({ ...v, ...next })); }, []);

  /**
   * STABLE IDENTITIES for the props handed to the memoised children.
   *
   * The crosshair sets state on every pointer move, so this component re-renders constantly; an
   * inline arrow prop would be a new function each time and would defeat the memo on the drawing
   * rail and the drawing layer entirely.
   *
   * DECLARED AFTER patchView, AND THAT ORDERING IS load-bearing. A hook's dependency array is
   * evaluated EAGERLY during render, so listing `patchView` above its own `const` threw
   * "Cannot access 'patchView' before initialization" on the very first render — taking the whole
   * chart, and therefore the whole Terminal, into the error boundary. The callback bodies would have
   * been fine, because those only run later; it is the dependency array that reaches the temporal
   * dead zone.
   */
  const toggleShowDrawings = useCallback(() => patchView({ showDrawings: !viewRef.current.showDrawings }), [patchView]);
  const toggleMagnet = useCallback(() => patchView({ magnet: !viewRef.current.magnet }), [patchView]);
  const openManager = useCallback(() => setManagerOpen(true), []);
  const openSettingsFor = useCallback((id) => setSettingsId(id), []);
  const requestNote = useCallback((points, at) => { setNoteDraft({ points, at }); setNoteText(''); }, []);

  // Style edits apply to the SELECTION when there is one, and otherwise set the style of the next
  // drawing — which is how every charting tool behaves and avoids a separate edit mode.
  const applyStyle = useCallback((patch) => {
    setDrawStyle((prev) => {
      const next = sanitizeStyle({ ...prev, ...patch });
      // A style chosen with a tool armed is that tool's style from now on — the same rule the
      // settings dialog follows, so the two cannot disagree about what "last used" means.
      if (activeTool) {
        setToolDefaults((prevMap) => {
          const map = rememberToolDefaults(prevMap, { type: activeTool, style: next });
          saveToolDefaults(map);
          return map;
        });
      }
      // Restyling applies to EVERY selected drawing, in one change — recolouring six lines is one
      // action and one undo step, not six.
      if (selectedIds.length) {
        const ids = new Set(selectedIds);
        updateDrawings((ds) => ds.map((d) => (ids.has(d.id) ? { ...d, style: next } : d)));
      }
      return next;
    });
  }, [selectedIds, updateDrawings, activeTool]);

  // EVERY path that changes drawings goes through updateDrawings, or it is not in the history.
  // These two used to call setDrawings directly, which meant a delete could not be undone at all.
  const deleteSelected = useCallback(() => {
    if (!selectedIds.length) return;
    const ids = new Set(selectedIds);
    updateDrawings((ds) => ds.filter((d) => !ids.has(d.id)));
    setSelectedIds([]);
  }, [selectedIds, updateDrawings]);

  const clearAllDrawings = useCallback(() => {
    // Through updateDrawings, so "delete all" is one undo away — which is exactly the action a user
    // is most likely to want back.
    updateDrawings([]);
    setSelectedIds([]);
  }, [updateDrawings]);

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

    // THE DATASET IS NOT THE VIEWPORT. A weekly or monthly series carries the security's whole
    // history — two and a half thousand weekly candles for a 1980 issuer — and fitting all of it
    // into the frame renders a grey smear nobody can read. Each interval opens on a useful recent
    // stretch instead, and the rest is there to scroll back through. A series already shorter than
    // that stretch just fits.
    const want = initialBarsFor(tfRef.current);
    if (want && bars.length > want) {
      chart.timeScale().setVisibleLogicalRange({ from: bars.length - want, to: bars.length - 1 });
    } else {
      chart.timeScale().fitContent();
    }
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

    // PANE SIZES SURVIVE A REDRAW. A redraw tears every lower pane down, so a separator the user has
    // dragged since the last one is read NOW, while those panes still exist, and saved as a share of
    // the plot. The rebuilt panes are then sized from shares — see chart-panes.mjs for why pixel
    // heights compounded and made RSI open at half the chart.
    capturePaneDrags();
    for (const s of overlaysRef.current) { try { chart.removeSeries(s); } catch { /* already gone */ } }
    overlaysRef.current = [];
    legendSeriesRef.current = new Map();
    // Drop the extra panes too, highest index first so the remaining indices stay valid.
    const panes = chart.panes();
    for (let i = panes.length - 1; i >= 1; i -= 1) { try { chart.removePane(i); } catch { /* ignore */ } }

    if (!bars.length) { paneAppliedRef.current = null; return; }
    const ctx = { intraday: kindRef.current === 'intraday', sessionKey: sessionKeyFor(tfRef.current) };
    let paneIndex = 0;
    const lowerKeys = [];                                   // one per lower pane, top to bottom
    const legendOut = [];

    for (const entry of activeRef.current) {
      const def = INDICATORS[entry.id];
      if (!def || def.builtin) continue;                    // volume is the chart's own series
      if (entry.visible === false) continue;                // parked, but its settings are kept
      if (def.intradayOnly && !ctx.intraday) continue;      // VWAP on a daily chart is meaningless
      const { plots, guides } = computeIndicator(entry.id, bars, entry.params, ctx);
      if (!plots.length || plots.every((pl) => !pl.data.length)) continue;

      const separate = def.pane === 'separate';
      if (separate) { paneIndex += 1; lowerKeys.push(entry.key || entry.id); }
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
      legendOut.push({
        key: entry.key || entry.id,
        label: indicatorLabel(entry.id, entry.params),
        color: indicatorColor(th, entry.color != null ? entry.color : (def.colors ? Object.values(def.colors)[0] : 0)),
        visible: entry.visible !== false,
      });
    }
    // EVERY lower pane, whatever the study — RSI, MACD, ATR and anything added later go through the
    // same allocation, once the full set is known, because each pane's default depends on how many.
    sizePanes(lowerKeys);
    setIndicatorLegend(legendOut);
  }

  /** The plot's height: the panes' own, once laid out; the host's before the first layout. */
  function plotHeightNow() {
    let sum = 0;
    try { for (const pane of chartRef.current?.panes?.() || []) sum += Number(pane.getHeight()) || 0; } catch { /* optional */ }
    if (sum > 0) return sum;
    return Math.max(0, (hostRef.current?.clientHeight || 0) - 28);
  }

  /** Record any separator the user dragged since panes were last sized, as a saved share. */
  function capturePaneDrags() {
    const chart = chartRef.current;
    if (!chart) return;
    const changed = manualPaneChanges(paneAppliedRef.current, readPaneShares(chart));
    if (!Object.keys(changed).length) return;
    const next = { ...(viewRef.current?.paneShares || {}), ...changed };
    // Written through to the ref at once, so a redraw in this same tick sizes from the drag rather
    // than from a view React has not re-rendered yet.
    viewRef.current = { ...viewRef.current, paneShares: next };
    patchView({ paneShares: next });
    paneAppliedRef.current = { ...paneAppliedRef.current, shares: readPaneShares(chart) };
  }

  /** Size the price pane and the given lower panes: a saved share where there is one, else the default. */
  function sizePanes(keys) {
    const chart = chartRef.current;
    if (!chart) return;
    const shares = resolvePaneShares(keys, viewRef.current?.paneShares, plotHeightNow());
    const written = applyPaneShares(chart, shares);
    paneAppliedRef.current = written ? { keys: [...keys], shares: readPaneShares(chart) } : null;
  }

  // ── create once; never rebuilt on theme or timeframe change (that would lose zoom/pan) ──
  useEffect(() => {
    let disposed = false;
    let chart = null;
    let detachPanes = null;
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
        const idx = barIndexRef.current.get(param.time);
        const prev = (idx > 0) ? bars[idx - 1].close : null;
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

      // PANE SIZES FOLLOW THE USER AND THE PANEL.
      //   A separator drag has no event of its own, so it is read when the pointer is released —
      //   on the window, because a drag can end outside the chart.
      //   An outer resize (a Terminal panel dragged taller or shorter, a window resize) keeps every
      //   share, and the defaults are re-applied so a short plot lifts its lower panes to a readable
      //   height without taking the price pane below its floor. The panel's own resizing is only
      //   observed here, never touched.
      const onRelease = () => capturePaneDrags();
      window.addEventListener('pointerup', onRelease);
      let frame = 0;
      const ro = typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => {
            if (!chartRef.current || !paneAppliedRef.current) return;
            capturePaneDrags();
            sizePanes(paneAppliedRef.current.keys);
          });
        })
        : null;
      if (ro && hostRef.current) ro.observe(hostRef.current);
      detachPanes = () => {
        window.removeEventListener('pointerup', onRelease);
        cancelAnimationFrame(frame);
        if (ro) ro.disconnect();
      };

      if (barsRef.current.length) draw();
    })();
    return () => {
      disposed = true;
      if (detachPanes) detachPanes();
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
      // Inversion is a first-class price-scale option in the library, so it is applied here with the
      // rest rather than being faked by negating the data — which would break every indicator, every
      // drawing anchor and the legend at once.
      invertScale: view.invertScale === true,
    });
  }, [view.logScale, view.autoScale, view.invertScale, chartReady]);

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
      // One definition of "this keystroke belongs to a field", shared with the quick-timeframe gate,
      // and it now covers contenteditable as well as the three form tags.
      if (isTypingTarget(t)) return;
      // A BARE DIGIT OPENS THE TIMEFRAME BOX. Checked before the letter shortcuts so it cannot be
      // shadowed by one, and gated on the target not being a field — typing "5" into the symbol
      // search or an indicator's period must reach that input, not the chart.
      if (shouldOpenQuickTimeframe(e, t)) {
        e.preventDefault();
        setQuickTf({ text: e.key, error: null });
        return;
      }

      const mod = e.ctrlKey || e.metaKey;

      // UNDO / REDO. Bound on the chart element, so this never steals the browser's undo from a
      // text field elsewhere in the app, and two chart panels undo independently.
      if (mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) redoDrawings(); else undoDrawings();
        return;
      }
      if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redoDrawings(); return; }
      if (mod) return;                       // leave every other modified key to the browser

      // NUDGE. Arrow keys move the selected drawing by a pixel, shift by ten — a PIXEL step rather
      // than a price step, because the same nudge then feels identical at every zoom level and on
      // every symbol, whether the price is 3 or 3000.
      if (selectedIds.length && e.key.startsWith('Arrow')) {
        const moved = nudgeSelected(e.key, e.shiftKey ? 10 : 1);
        if (moved) { e.preventDefault(); return; }
      }

      if (e.key === 'Escape') {
        setActiveTool(null); setSelectedIds([]); setClearSignal((n) => n + 1);
        if (fullscreen) setFullscreen(false);
      }
      else if (e.key === 'Delete' || e.key === 'Backspace') { if (selectedIds.length) { e.preventDefault(); deleteSelected(); } }
      else if (e.key === 'r' || e.key === 'R') resetView();
      else if (e.key === 'l' || e.key === 'L') patchView({ logScale: !view.logScale });
      else if (e.key === 'f' || e.key === 'F') setFullscreen((v) => !v);
      else if (e.key === 'c' || e.key === 'C') patchView({ chartType: view.chartType === 'Candles' ? 'Line' : 'Candles' });
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [selectedIds, deleteSelected, resetView, patchView, view.logScale, view.chartType, fullscreen, setQuickTf,
    undoDrawings, redoDrawings, nudgeSelected]);

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
      const json = await fetchPayload(url, { fresh: incremental });
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
      barIndexRef.current = new Map(bars.map((b, i) => [b.time, i]));
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
              {narrow ? 'ƒ' : (
              <>
                <span>ƒ</span><span>Indicators</span>
                {/* The count sits in a FIXED-WIDTH slot. Letting it widen the button shifted every
                    control to its right the moment an indicator was added or removed. */}
                <span style={{ width: 10, textAlign: 'right', opacity: active.length ? 1 : 0 }}>
                  {active.length || ''}
                </span>
              </>
            )}
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
            selected={selectedIds.length > 0} onDelete={deleteSelected}
            count={drawings.length} showDrawings={view.showDrawings}
            onToggleShow={toggleShowDrawings}
            onClearAll={clearAllDrawings}
            magnet={view.magnet === true}
            onToggleMagnet={toggleMagnet}
            onOpenManager={openManager}
            onUndo={undoDrawings} onRedo={redoDrawings}
            canUndo={canUndo(historyRef.current)} canRedo={canRedo(historyRef.current)}
            compact={narrow}
          />
        )}

        <div style={{ position: 'relative', flex: 1, minWidth: 0, minHeight: 0 }}
          // THE CHART GETS ITS OWN CONTEXT MENU. Suppressed only over the chart surface, so the
          // browser's menu still works everywhere else in the app — including on the toolbar, where
          // "copy" and "inspect" are sometimes genuinely wanted.
          onContextMenu={(e) => {
            e.preventDefault();
            // WHICH MENU depends on where the click landed. Inside the right-hand price scale the
            // question is about the scale; over the plot it is about the chart. The scale's width
            // is read from the live chart rather than assumed, because it grows with the price.
            const box = e.currentTarget.getBoundingClientRect();
            let scaleW = 0;
            try { scaleW = chartRef.current?.priceScale('right').width() ?? 0; } catch { scaleW = 0; }
            const onScale = scaleW > 0 && (e.clientX - box.left) > (box.width - scaleW);
            if (onScale) setScaleMenuAt({ x: e.clientX, y: e.clientY });
            else setMenuAt({ x: e.clientX, y: e.clientY });
          }}>
        <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />

        {/* Drawings live on a canvas over the chart, sharing its scales. Mounted once the chart
            instance exists — chartReady is what says so. */}
        {chartReady > 0 && chartRef.current && priceRef.current && (
          <DrawingLayer
            chart={chartRef.current} series={priceRef.current} theme={theme}
            symbol={sym} bars={barsRef.current}
            drawings={drawings} onChange={updateDrawings}
            activeTool={activeTool} onToolUsed={() => setActiveTool(null)}
            selectedIds={selectedIds} onSelect={selectDrawing}
            onOpenSettings={openSettingsFor}
            visible={view.showDrawings} style={drawStyle} magnet={view.magnet === true}
            clearSignal={clearSignal} toolDefaults={toolDefaults}
            onRequestText={requestNote}
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
            // THE STUDIES THEMSELVES ARE UNTOUCHED by this flag — it reaches only the legend rows.
            // The plots, the guides and the separate RSI/MACD panes are built in redrawIndicators,
            // which never reads it.
            indicatorsCollapsed={view.legendCollapsed === true}
            onToggleIndicators={() => patchView({ legendCollapsed: !viewRef.current.legendCollapsed })}
            indicators={indicatorLegend.map((l) => ({ ...l, value: cursor?.values?.[l.key] ?? null }))}
            onToggleIndicator={(key) => setActive((list) => list.map(
              (a) => (a.key === key ? { ...a, visible: a.visible === false } : a)))}
            onSettingsIndicator={(key) => { setFocusIndicator(key); setBrowserOpen(true); }}
            onRemoveIndicator={(key) => setActive((list) => list.filter((a) => a.key !== key))}
          />
        )}

        {/* THE TIMEFRAME BOX. Small, centred over the chart, and gone the moment it is done with —
            it is a keystroke accelerator, not a dialog. */}
        {quickTf && (
          <QuickTimeframe
            theme={theme}
            state={quickTf}
            onChange={setQuickTf}
            onCommit={(id) => { setTf(id); setQuickTf(null); }}
            onClose={() => setQuickTf(null)}
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

      <DrawingManager
        open={managerOpen} onClose={() => setManagerOpen(false)}
        theme={theme} symbol={sym} drawings={drawings} selectedIds={selectedIds}
        onSelect={selectDrawing} onChange={updateDrawings}
        onDuplicate={duplicateDrawing} onClearAll={() => { clearAllDrawings(); setManagerOpen(false); }}
        onSettings={(id) => { setManagerOpen(false); setSettingsId(id); }}
        onReorder={reorder} onBulk={bulkAction}
      />

      {/* ONE SETTINGS DIALOG for whichever drawing is open — what it shows is decided by what that
          TOOL declares it supports, so a new tool needs no change here. */}
      <DrawingSettings
        open={!!settingsId} onClose={() => setSettingsId(null)} theme={theme}
        drawing={drawings.find((d) => d.id === settingsId) || null}
        onChange={(next) => {
          updateDrawings((ds) => ds.map((d) => (d.id === next.id ? next : d)), `settings:${next.id}`);
          // The settings a user just chose become that tool's defaults, so the next one starts here.
          setToolDefaults((prev) => { const map = rememberToolDefaults(prev, next); saveToolDefaults(map); return map; });
        }}
      />

      {/* THE CHART CONTEXT MENU — opens AT THE CURSOR, over the chart, and lists only actions this
          chart actually supports. Built on the same portalled Popover as every other chart menu, so
          it cannot be clipped by the Terminal panel and it dismisses identically. */}
      <Popover theme={theme} open={!!menuAt} point={menuAt} onClose={() => setMenuAt(null)}
        width={212} label="Chart actions">
        <MenuItem theme={theme} role="menuitem" disabled={!canUndo(historyRef.current)}
          onClick={undoDrawings} right="Ctrl+Z">Undo</MenuItem>
        <MenuItem theme={theme} role="menuitem" disabled={!canRedo(historyRef.current)}
          onClick={redoDrawings} right="Ctrl+Y">Redo</MenuItem>
        <MenuItem theme={theme} role="menuitem" onClick={resetView}>Reset view</MenuItem>
        {scrolledBack && (
          <MenuItem theme={theme} role="menuitem"
            onClick={() => { try { chartRef.current?.timeScale().scrollToRealTime(); } catch { /* no-op */ } }}>
            Scroll to latest bar
          </MenuItem>
        )}
        <MenuItem theme={theme} role="menuitem" left="ƒ" onClick={() => setBrowserOpen(true)}
          right={active.length ? String(active.length) : undefined}>Add indicator…</MenuItem>
        <MenuLabel theme={theme}>Scale</MenuLabel>
        <MenuItem theme={theme} role="menuitemcheckbox" active={!!view.logScale} closeOnPick={false}
          onClick={() => patchView({ logScale: !view.logScale })}
          right={view.logScale ? 'Log' : 'Linear'}>Price scale</MenuItem>
        <MenuItem theme={theme} role="menuitemcheckbox" active={!!view.autoScale} closeOnPick={false}
          onClick={() => patchView({ autoScale: !view.autoScale })}
          right={view.autoScale ? 'On' : 'Off'}>Auto scale</MenuItem>
        {canExtend && (
          <MenuItem theme={theme} role="menuitemcheckbox" active={!!view.extended} closeOnPick={false}
            onClick={() => patchView({ extended: !view.extended })}
            right={view.extended ? 'On' : 'Off'}>Extended hours</MenuItem>
        )}
        {selectedIds.length > 0 && (
          <>
            <MenuLabel theme={theme}>
              {selectedIds.length > 1 ? `${selectedIds.length} selected` : 'Selected drawing'}
            </MenuLabel>
            {selectedIds.length === 1 && (
              <MenuItem theme={theme} role="menuitem"
                onClick={() => setSettingsId(selectedIds[0])}>Settings…</MenuItem>
            )}
            <MenuItem theme={theme} role="menuitem" onClick={() => bulkAction('front')}>Bring to front</MenuItem>
            <MenuItem theme={theme} role="menuitem" onClick={() => bulkAction('back')}>Send to back</MenuItem>
            {selectedIds.length === 1 && (
              <>
                <MenuItem theme={theme} role="menuitem"
                  onClick={() => reorder(selectedIds[0], 'forward')}>Bring forward</MenuItem>
                <MenuItem theme={theme} role="menuitem"
                  onClick={() => reorder(selectedIds[0], 'backward')}>Send backward</MenuItem>
              </>
            )}
            <MenuItem theme={theme} role="menuitem" onClick={() => bulkAction('lock')}>Lock</MenuItem>
            <MenuItem theme={theme} role="menuitem" onClick={deleteSelected}>Delete</MenuItem>
          </>
        )}
        <MenuLabel theme={theme}>Drawings</MenuLabel>
        <MenuItem theme={theme} role="menuitemcheckbox" active={view.magnet === true} closeOnPick={false}
          onClick={() => patchView({ magnet: !view.magnet })}
          right={view.magnet ? 'On' : 'Off'}>Magnet</MenuItem>
        <MenuItem theme={theme} role="menuitemcheckbox" active={view.showDrawings !== false} closeOnPick={false}
          onClick={() => patchView({ showDrawings: !view.showDrawings })}
          right={view.showDrawings === false ? 'Hidden' : 'Shown'}>Show drawings</MenuItem>
        <MenuItem theme={theme} role="menuitem" onClick={() => setManagerOpen(true)}
          right={drawings.length ? String(drawings.length) : undefined}>Manage drawings…</MenuItem>
        <MenuLabel theme={theme}>View</MenuLabel>
        <MenuItem theme={theme} role="menuitem" onClick={exportPng}>Save chart image…</MenuItem>
        <MenuItem theme={theme} role="menuitemcheckbox" active={fullscreen} closeOnPick={false}
          onClick={() => setFullscreen((v) => !v)}
          right={fullscreen ? 'On' : 'Off'}>Fullscreen</MenuItem>
      </Popover>

      {/* THE PRICE-SCALE MENU. Right-clicking the right-hand scale asks about the SCALE, which is a
          different question from the one the chart menu answers. Only options Lightweight Charts
          supports directly are here — there is no half-working entry. */}
      <Popover theme={theme} open={!!scaleMenuAt} point={scaleMenuAt} onClose={() => setScaleMenuAt(null)}
        width={196} label="Price scale">
        <MenuLabel theme={theme}>Price scale</MenuLabel>
        <MenuItem theme={theme} role="menuitemcheckbox" active={!!view.autoScale} closeOnPick={false}
          onClick={() => patchView({ autoScale: !view.autoScale })}
          right={view.autoScale ? 'On' : 'Off'}>Auto scale</MenuItem>
        <MenuItem theme={theme} role="menuitemcheckbox" active={!!view.logScale} closeOnPick={false}
          onClick={() => patchView({ logScale: !view.logScale })}
          right={view.logScale ? 'Log' : 'Linear'}>Logarithmic</MenuItem>
        <MenuItem theme={theme} role="menuitemcheckbox" active={!!view.invertScale} closeOnPick={false}
          onClick={() => patchView({ invertScale: !view.invertScale })}
          right={view.invertScale ? 'On' : 'Off'}>Invert scale</MenuItem>
        <MenuItem theme={theme} role="menuitem" onClick={resetView}>Reset scale</MenuItem>
      </Popover>

      {/* THE NOTE EDITOR. A note is placed, then written — an empty label on the chart is an
          invisible object the user would have to hunt for to remove, so nothing is created until
          there is something to show. Anchored at the chart so it cannot be clipped by the panel. */}
      <Popover theme={theme} open={!!noteDraft}
        point={noteDraft?.at || null} anchorRef={noteDraft?.at ? null : rootRef}
        onClose={() => { setNoteDraft(null); setNoteText(''); }}
        width={248} label="Note text">
        <MenuLabel theme={theme}>{noteDraft?.id ? 'Edit note' : 'New note'}</MenuLabel>
        <div style={{ padding: '2px 6px 7px' }}>
          <input
            ref={(el) => { if (el) el.focus(); }}
            value={noteText} onChange={(e) => setNoteText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitNote(); }
            }}
            placeholder="Note…" aria-label="Note text" autoComplete="off"
            style={{ width: '100%', boxSizing: 'border-box', background: 'transparent', color: p.textStrong,
              border: `1px solid ${p.border}`, borderRadius: 5, padding: '7px 9px',
              fontFamily: "'DM Sans',sans-serif", fontSize: 12.5 }} />
          <div style={{ display: 'flex', gap: 6, marginTop: 7 }}>
            <button type="button" onClick={commitNote}
              style={{ flex: 1, background: 'transparent', border: `1px solid ${p.up}`, borderRadius: 4,
                cursor: 'pointer', padding: '4px 0', color: p.textStrong,
                fontFamily: "'DM Sans',sans-serif", fontSize: 11 }}>
              {noteDraft?.id ? 'Save' : 'Add note'}
            </button>
            <button type="button" onClick={() => { setNoteDraft(null); setNoteText(''); }}
              style={{ flex: 1, background: 'transparent', border: `1px solid ${p.border}`, borderRadius: 4,
                cursor: 'pointer', padding: '4px 0', color: p.text,
                fontFamily: "'DM Sans',sans-serif", fontSize: 11 }}>Cancel</button>
          </div>
        </div>
      </Popover>

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

/**
 * The type-a-timeframe box.
 *
 * Autofocused, so the digit that opened it is followed straight into the field and the next
 * keystrokes are ordinary typing rather than more global shortcuts. Enter applies, Escape cancels,
 * Backspace on an empty box closes it, and an abandoned box closes itself — a stray keypress should
 * not leave something sitting on the chart.
 */
function QuickTimeframe({ theme, state, onChange, onCommit, onClose }) {
  const p = palette(theme);
  const timer = useRef(null);

  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(onClose, QUICK_TIMEFRAME_TIMEOUT_MS);
    return () => clearTimeout(timer.current);
  }, [state.text, onClose]);

  const commit = () => {
    const result = resolveTypedTimeframe(state.text);
    // A TIMEFRAME THE FEED CANNOT SERVE IS REFUSED WITH ITS REASON, never applied silently.
    if (!result.ok) { onChange({ ...state, error: result.reason || 'Not a timeframe' }); return; }
    onCommit(result.id);
  };

  return (
    <div style={{
      position: 'absolute', left: '50%', top: 14, transform: 'translateX(-50%)', zIndex: 8,
      background: p.tooltipBg, border: `1px solid ${state.error ? p.down : p.tooltipBorder}`,
      borderRadius: 7, boxShadow: '0 8px 28px rgba(0,0,0,0.24)', padding: '7px 9px',
      display: 'flex', flexDirection: 'column', gap: 3, minWidth: 128,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 9.5, color: p.text, letterSpacing: '0.5px' }}>
          TIMEFRAME
        </span>
        <input
          ref={(el) => { if (el) el.focus(); }}
          value={state.text}
          inputMode="numeric"
          onChange={(e) => onChange({ text: e.target.value.replace(/[^0-9]/g, '').slice(0, 4), error: null })}
          onKeyDown={(e) => {
            // Stopped here so the chart's own shortcuts do not also see these keys.
            e.stopPropagation();
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
            else if (e.key === 'Backspace' && !state.text) { e.preventDefault(); onClose(); }
          }}
          aria-label="Timeframe in minutes"
          style={{
            width: 54, background: 'transparent', color: p.textStrong, border: 'none', outline: 'none',
            fontFamily: "'DM Sans',sans-serif", fontSize: 15, fontWeight: 700, textAlign: 'right',
          }}
        />
        <span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 11, color: p.text }}>min</span>
      </div>
      <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 9.5, color: state.error ? p.down : p.text, opacity: state.error ? 1 : 0.75 }}>
        {state.error || 'Enter to apply · Esc to cancel'}
      </div>
    </div>
  );
}
