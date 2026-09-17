'use client';
import { useState } from 'react';
import { palette } from '../../lib/chart/chart-theme.mjs';
import { VectorIcon } from './ChartUI';

// THE CHART LEGEND — the readout in the chart's top-left corner.
//
// This is the single most-read thing on a chart, and the part that most decides whether a platform
// feels familiar. Three bands, in the order every trading platform puts them:
//
//   1. IDENTITY   symbol · interval · chart type, and a delayed-feed badge when the feed is delayed
//   2. PRICE      O H L C with the change and percent, coloured by direction
//   3. INDICATORS one row each, with its value AT THE CURSOR and its own hide/settings/remove
//
// IT IS ALWAYS POPULATED. Before this, the O/H/L/C line existed only while the pointer was over the
// chart, so at rest — which is most of the time — the chart showed no numbers at all and the reader
// had to hunt the right-hand axis for the last price. When the crosshair is off the chart the legend
// falls back to the LAST BAR, which is what the chart is actually showing.
//
// POINTER-TRANSPARENT EXCEPT WHERE IT IS NOT. The whole block sits over the canvas, so it is
// pointerEvents:none by default and only the indicator rows opt back in — otherwise the legend would
// eat the drags and clicks that pan the chart underneath it.
//
// THE INDICATOR BAND COLLAPSES. Seven studies is seven rows across the candles, and the top-left is
// the busiest part of a chart. Collapsed, the whole band becomes one control that still says how
// many studies are running, so nothing is hidden from the reader — only folded away.
//
// IT COLLAPSES THE LABELS, NOT THE STUDIES. The plots, the bands and the separate RSI/MACD panes are
// untouched; this is decluttering, and a control that quietly stopped calculating an indicator would
// be a different and much worse feature.

const fmtPrice = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—');
const fmtVol = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
};

// Drawn from primitives like every other icon on the chart: it inherits currentColor, so it needs no
// theme plumbing, and it stays crisp where a glyph would sit on the font's own baseline.
const CHEVRON_DOWN = [['polyline', { points: '4,6.5 8,10.5 12,6.5' }]];
const CHEVRON_RIGHT = [['polyline', { points: '6.5,4 10.5,8 6.5,12' }]];

/**
 * The collapse control: a chevron and the number of studies running.
 *
 * It is the only thing left of the band when collapsed, which is why it carries the count — a bare
 * chevron would leave the reader with no idea whether anything was folded away behind it.
 */
function LegendToggle({ theme, collapsed, count, onClick }) {
  const pal = palette(theme);
  const [hover, setHover] = useState(false);
  // KEYBOARD FOCUS ONLY. A ring on every mouse click is noise; :focus-visible is the browser's own
  // judgement of when the ring is wanted, and inline styles cannot express it, so it is read here.
  const [focusRing, setFocusRing] = useState(false);
  const title = collapsed
    ? `Show ${count} indicator${count === 1 ? '' : 's'}`
    : `Hide ${count} indicator${count === 1 ? '' : 's'} from the legend`;
  return (
    <button type="button" title={title} aria-label={title} aria-expanded={!collapsed}
      onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      onFocus={(e) => setFocusRing(!!e.currentTarget.matches?.(':focus-visible'))}
      onBlur={() => setFocusRing(false)}
      data-cp-legend-toggle=""
      style={{
        pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: 2,
        width: 'fit-content', padding: '0 5px 0 2px', height: 17, boxSizing: 'border-box',
        // A CHIP, NOT FLOATING TEXT. It is the only way back to the rows once they are folded away,
        // so it is equally findable in both states — no resting fade — and carries its own faint
        // background and outline from the theme, which is what makes it read on the dark canvas.
        background: hover ? pal.controlBgHover : pal.controlBg,
        border: `1px solid ${hover ? pal.controlBorderHover : pal.controlBorder}`,
        borderRadius: 4, cursor: 'pointer',
        color: pal.textStrong,
        font: 'inherit', fontVariantNumeric: 'tabular-nums',
        outline: focusRing ? `2px solid ${pal.up}` : 'none', outlineOffset: 1,
        transition: 'background 90ms ease, border-color 90ms ease',
      }}>
      <VectorIcon shapes={collapsed ? CHEVRON_RIGHT : CHEVRON_DOWN} size={11} />
      <b style={{ fontWeight: 600 }}>{count}</b>
    </button>
  );
}

/** A miniature legend-row button. Only visible while the row is hovered, like every charting app. */
function RowButton({ theme, title, onClick, children, danger, show }) {
  const p = palette(theme);
  const [hover, setHover] = useState(false);
  return (
    <button type="button" title={title} aria-label={title} onClick={onClick}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        // Kept in the layout at all times and only faded, so the row does not reflow — and the
        // numbers beside it do not jump sideways — when the pointer arrives.
        opacity: show ? 1 : 0, transition: 'opacity 90ms ease',
        pointerEvents: show ? 'auto' : 'none',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 15, height: 15, padding: 0, flexShrink: 0,
        background: hover ? p.menuHover : 'transparent', border: 'none', borderRadius: 3,
        cursor: 'pointer', color: danger ? p.down : p.text, fontSize: 10, lineHeight: 1,
      }}>{children}</button>
  );
}

export default function ChartLegend({
  theme, symbol, intervalLabel, chartTypeLabel, delayed, bar, prevClose,
  indicators = [], onToggleIndicator, onSettingsIndicator, onRemoveIndicator,
  compact = false, indicatorsCollapsed = false, onToggleIndicators,
}) {
  const p = palette(theme);
  const [hoveredRow, setHoveredRow] = useState(null);

  const close = bar?.c;
  const change = (Number.isFinite(close) && Number.isFinite(prevClose)) ? close - prevClose : null;
  const pct = (change != null && prevClose) ? (change / prevClose) * 100 : null;
  // Direction comes from the change against the previous close, not from open-vs-close: that is the
  // number a reader compares against, and it is what the percent beside it is measuring.
  const dir = change == null ? null : change >= 0 ? p.up : p.down;
  const vol = fmtVol(bar?.v);

  const cell = (k, v, color) => (
    <span style={{ whiteSpace: 'nowrap' }}>
      <span style={{ opacity: 0.75 }}>{k}</span>{' '}
      <b style={{ color: color || p.textStrong, fontWeight: 600 }}>{v}</b>
    </span>
  );

  return (
    <div style={{
      position: 'absolute', left: 8, top: 6, zIndex: 4, pointerEvents: 'none',
      display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 'calc(100% - 16px)',
      fontFamily: "'DM Sans',sans-serif", fontSize: 10.5, color: p.text, lineHeight: 1.35,
      // TABULAR FIGURES. These numbers change on every pointer move, and proportional digits make
      // the whole row shuffle sideways as they do — a 1 is far narrower than a 0 in this face.
      fontVariantNumeric: 'tabular-nums',
    }}>
      {/* 1. IDENTITY */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
        <span className="cp-tkr" style={{ fontSize: 12.5, fontWeight: 700, color: p.textStrong }}>{symbol}</span>
        <span style={{ opacity: 0.85 }}>{intervalLabel}</span>
        {!compact && chartTypeLabel && <span style={{ opacity: 0.6 }}>{chartTypeLabel}</span>}
        {/* An honest badge, not decoration: the feed IS 15 minutes behind and the reader must know. */}
        {delayed && (
          <span style={{ fontSize: 8.5, letterSpacing: '0.4px', padding: '1px 4px', borderRadius: 3,
            border: `1px solid ${p.border}`, opacity: 0.9 }}>DELAYED</span>
        )}
      </div>

      {/* 2. PRICE */}
      {bar && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap' }}>
          {/* Line and area charts carry only a close, so O/H/L are omitted rather than faked. */}
          {Number.isFinite(bar.o) && cell('O', fmtPrice(bar.o))}
          {Number.isFinite(bar.h) && cell('H', fmtPrice(bar.h))}
          {Number.isFinite(bar.l) && cell('L', fmtPrice(bar.l))}
          {Number.isFinite(close) && cell('C', fmtPrice(close), dir || p.textStrong)}
          {change != null && (
            <span style={{ color: dir, fontWeight: 600, whiteSpace: 'nowrap' }}>
              {change >= 0 ? '+' : '−'}{Math.abs(change).toFixed(2)}
              {pct != null && ` (${change >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(2)}%)`}
            </span>
          )}
          {!compact && vol && cell('V', vol)}
        </div>
      )}

      {/* 3. INDICATORS — one row each, with the value under the cursor and its own controls, followed
          by a collapse control that folds the whole band away without touching the studies. */}
      {!indicatorsCollapsed && indicators.map((ind) => {
        const on = ind.visible !== false;
        const show = hoveredRow === ind.key;
        return (
          <div key={ind.key}
            onMouseEnter={() => setHoveredRow(ind.key)} onMouseLeave={() => setHoveredRow(null)}
            style={{
              display: 'flex', alignItems: 'center', gap: 5, width: 'fit-content',
              // The rows are the only part of the legend that accepts the pointer; everything else
              // stays transparent so panning still works where the legend overlaps the candles.
              pointerEvents: 'auto', borderRadius: 3, padding: '0 3px 0 0',
              background: show ? p.tooltipBg : 'transparent', opacity: on ? 1 : 0.5,
            }}>
            <span style={{ width: 7, height: 7, borderRadius: 2, flexShrink: 0, background: ind.color }} />
            <span style={{ color: p.text, whiteSpace: 'nowrap' }}>{ind.label}</span>
            {ind.value != null && (
              <b style={{ color: ind.color, fontWeight: 600, whiteSpace: 'nowrap' }}>{fmtPrice(ind.value)}</b>
            )}
            <RowButton theme={theme} show={show} title={on ? 'Hide' : 'Show'}
              onClick={() => onToggleIndicator?.(ind.key)}>{on ? '👁' : '◦'}</RowButton>
            <RowButton theme={theme} show={show} title="Settings"
              onClick={() => onSettingsIndicator?.(ind.key)}>⚙</RowButton>
            <RowButton theme={theme} show={show} title="Remove" danger
              onClick={() => onRemoveIndicator?.(ind.key)}>✕</RowButton>
          </div>
        );
      })}
      {/* UNDER THE LAST ROW, not above the first: the studies read first and the control closes the
          band. Collapsed, the rows are gone and it sits directly under the price row — the same
          place in the same stack, so it is always where the band was. */}
      {indicators.length > 0 && (
        <LegendToggle theme={theme} collapsed={indicatorsCollapsed}
          count={indicators.length} onClick={() => onToggleIndicators?.()} />
      )}
    </div>
  );
}
