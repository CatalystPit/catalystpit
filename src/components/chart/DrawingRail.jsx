'use client';
import { useEffect, useRef, useState } from 'react';
import { TOOLS, LINE_WIDTHS, LINE_DASHES } from '../../lib/chart/chart-drawings.mjs';
import { palette, indicatorColors } from '../../lib/chart/chart-theme.mjs';

// The vertical drawing rail, down the left edge of the chart.
//
// IT SITS BESIDE THE CHART, NOT OVER IT. The rail is a flex sibling of the chart box rather than an
// absolutely-positioned overlay, so it can never cover a candle, a price label or the time axis —
// which is the failure mode of a floating palette in a small Terminal panel. The chart simply gets
// the remaining width and autosizes into it.
//
// STYLE SETTINGS ARE A POPOVER, not another row. Colour, width and dash appear next to the rail when
// a tool is armed or a drawing is selected, and take no layout space when they are not needed.
//
// EXTENSIBLE BY CONSTRUCTION: every button comes from the TOOLS registry, so a new drawing tool
// appears here with its icon and tooltip and needs no change to this file.

const RAIL_W = 34;

export default function DrawingRail({
  theme, activeTool, onPick, style, onStyle,
  selected, onDelete, count, showDrawings, onToggleShow, onClearAll,
  compact = false,
}) {
  const p = palette(theme);
  const swatches = indicatorColors(theme);
  const [stylePanel, setStylePanel] = useState(false);
  const [menu, setMenu] = useState(false);          // compact mode: the whole rail as a popover
  const rootRef = useRef(null);

  // A popover that cannot be dismissed is worse than no popover.
  useEffect(() => {
    if (!stylePanel && !menu) return undefined;
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) { setStylePanel(false); setMenu(false); } };
    const onKey = (e) => { if (e.key === 'Escape') { setStylePanel(false); setMenu(false); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [stylePanel, menu]);

  const iconBtn = (content, active, onClick, title, extra = {}) => (
    <button key={title} type="button" onClick={onClick} title={title} aria-label={title}
      aria-pressed={active || undefined}
      style={{
        width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: active ? p.grid : 'transparent',
        border: `1px solid ${active ? p.up : 'transparent'}`,
        borderRadius: 4, cursor: 'pointer', padding: 0, flexShrink: 0,
        fontFamily: "'DM Sans',sans-serif", fontSize: 13, lineHeight: 1,
        color: active ? p.textStrong : p.text, ...extra,
      }}>{content}</button>
  );

  const divider = (key) => (
    <div key={key} style={{ width: 18, height: 1, background: p.border, margin: '3px auto', flexShrink: 0 }} />
  );

  // ↖ is the select/edit mode: no tool armed, click a drawing to grab it.
  const toolButtons = [
    iconBtn('↖', !activeTool, () => onPick(null), 'Select / edit (Esc)'),
    divider('d1'),
    ...Object.values(TOOLS).map((t) =>
      iconBtn(t.icon, activeTool === t.id, () => onPick(activeTool === t.id ? null : t.id), t.label)),
    divider('d2'),
    iconBtn('🎨', stylePanel, () => setStylePanel((v) => !v), 'Line colour, width and style'),
    iconBtn(showDrawings ? '👁' : '◦', !showDrawings, onToggleShow,
      showDrawings ? 'Hide all drawings' : 'Show all drawings'),
    ...(selected ? [iconBtn('✕', false, onDelete, 'Delete selected (Del)', { color: p.down })] : []),
    ...(count > 0 ? [iconBtn('🗑', false, onClearAll, `Clear all ${count} drawings on this symbol`)] : []),
  ];

  const stylePanelBody = (
    <div style={{
      position: 'absolute', left: compact ? 0 : RAIL_W + 2, top: compact ? 32 : 0, zIndex: 30, width: 168,
      background: p.tooltipBg, border: `1px solid ${p.tooltipBorder}`, borderRadius: 6,
      boxShadow: '0 8px 28px rgba(0,0,0,0.22)', padding: 8,
    }}>
      <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 10, color: p.text, marginBottom: 6 }}>
        {selected ? 'Selected drawing' : 'New drawings'}
      </div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' }}>
        {swatches.map((c, i) => (
          <button key={c} type="button" title={`Colour ${i + 1}`} onClick={() => onStyle({ color: i })}
            style={{ width: 16, height: 16, borderRadius: 3, cursor: 'pointer', background: c,
              border: style.color === i ? `2px solid ${p.textStrong}` : `1px solid ${p.border}` }} />
        ))}
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6,
        fontFamily: "'DM Sans',sans-serif", fontSize: 11, color: p.text }}>
        <span style={{ flex: 1 }}>Width</span>
        <select value={style.width} onChange={(e) => onStyle({ width: Number(e.target.value) })}
          style={{ background: 'transparent', color: p.textStrong, border: `1px solid ${p.border}`,
            borderRadius: 3, fontSize: 11, padding: '2px 4px' }}>
          {LINE_WIDTHS.map((w) => <option key={w} value={w}>{w}px</option>)}
        </select>
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6,
        fontFamily: "'DM Sans',sans-serif", fontSize: 11, color: p.text }}>
        <span style={{ flex: 1 }}>Style</span>
        <select value={style.dash} onChange={(e) => onStyle({ dash: e.target.value })}
          style={{ background: 'transparent', color: p.textStrong, border: `1px solid ${p.border}`,
            borderRadius: 3, fontSize: 11, padding: '2px 4px' }}>
          {LINE_DASHES.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
      </label>
    </div>
  );

  // COMPACT: below roughly a phone width, or in a narrow Terminal panel, a 34px rail is a third of
  // the chart. It collapses to one button that opens the same tools as a popover — deliberately not
  // a squeezed version of the full rail, which would leave neither usable.
  if (compact) {
    return (
      <div ref={rootRef} style={{ position: 'relative', flexShrink: 0 }}>
        <button type="button" onClick={() => setMenu((v) => !v)} title="Drawing tools"
          style={{ width: 26, height: 26, background: activeTool ? p.grid : 'transparent',
            border: `1px solid ${activeTool ? p.up : p.border}`, borderRadius: 4, cursor: 'pointer',
            color: p.text, fontSize: 13, lineHeight: 1, padding: 0 }}>✎</button>
        {menu && (
          <div style={{ position: 'absolute', left: 0, top: 30, zIndex: 30,
            background: p.tooltipBg, border: `1px solid ${p.tooltipBorder}`, borderRadius: 6,
            boxShadow: '0 8px 28px rgba(0,0,0,0.22)', padding: 5,
            display: 'flex', flexDirection: 'column', gap: 2 }}>
            {toolButtons}
          </div>
        )}
        {stylePanel && stylePanelBody}
      </div>
    );
  }

  return (
    <div ref={rootRef} style={{ position: 'relative', flexShrink: 0, width: RAIL_W }}>
      <div style={{
        width: RAIL_W, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
        padding: '4px 0', borderRight: `1px solid ${p.border}`, height: '100%',
        overflowY: 'auto', overflowX: 'hidden',
      }}>
        {toolButtons}
      </div>
      {stylePanel && stylePanelBody}
    </div>
  );
}

export { RAIL_W };
