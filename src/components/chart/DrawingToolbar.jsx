'use client';
import { TOOLS, LINE_WIDTHS, LINE_DASHES } from '../../lib/chart/chart-drawings.mjs';
import { palette, indicatorColors, indicatorColor } from '../../lib/chart/chart-theme.mjs';

// The drawing toolbar. Renders from the TOOLS registry, so a new tool appears here automatically.
//
// Style applies to the NEXT drawing placed, and to the current selection if there is one — which is
// how every charting tool behaves and saves a separate "edit" mode for changing a colour.

export default function DrawingToolbar({
  theme, activeTool, onPick, style, onStyle,
  selected, onDelete, count, showDrawings, onToggleShow, onClearAll,
}) {
  const p = palette(theme);
  const swatches = indicatorColors(theme);

  const btn = (label, active, onClick, title, extra = {}) => (
    <button key={title || label} type="button" onClick={onClick} title={title}
      style={{
        background: active ? p.grid : 'transparent',
        border: `1px solid ${active ? p.up : p.border}`,
        borderRadius: 4, cursor: 'pointer', padding: '2px 7px', minWidth: 26,
        fontFamily: "'DM Sans',sans-serif", fontSize: 12, lineHeight: 1.5,
        color: active ? p.textStrong : p.text, ...extra,
      }}>{label}</button>
  );

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap',
      padding: '4px 2px', borderBottom: `1px solid ${p.border}` }}>

      {Object.values(TOOLS).map((t) => btn(t.icon, activeTool === t.id,
        () => onPick(activeTool === t.id ? null : t.id), t.label))}

      <div style={{ width: 1, height: 16, background: p.border, margin: '0 4px' }} />

      {/* Colour, width and dash — applied to the selection if one exists, else to the next drawing. */}
      <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
        {swatches.map((c, i) => (
          <button key={c} type="button" title={`Colour ${i + 1}`} onClick={() => onStyle({ color: i })}
            style={{ width: 13, height: 13, borderRadius: 3, cursor: 'pointer', background: c,
              border: style.color === i ? `2px solid ${p.textStrong}` : `1px solid ${p.border}` }} />
        ))}
      </div>

      <select value={style.width} onChange={(e) => onStyle({ width: Number(e.target.value) })}
        title="Line width" aria-label="Line width"
        style={{ background: 'transparent', color: p.text, border: `1px solid ${p.border}`,
          borderRadius: 4, fontSize: 11, padding: '2px 4px', fontFamily: "'DM Sans',sans-serif" }}>
        {LINE_WIDTHS.map((w) => <option key={w} value={w}>{w}px</option>)}
      </select>

      <select value={style.dash} onChange={(e) => onStyle({ dash: e.target.value })}
        title="Line style" aria-label="Line style"
        style={{ background: 'transparent', color: p.text, border: `1px solid ${p.border}`,
          borderRadius: 4, fontSize: 11, padding: '2px 4px', fontFamily: "'DM Sans',sans-serif" }}>
        {LINE_DASHES.map((d) => <option key={d} value={d}>{d}</option>)}
      </select>

      <div style={{ width: 1, height: 16, background: p.border, margin: '0 4px' }} />

      {btn(showDrawings ? '👁' : '◦', showDrawings, onToggleShow,
        showDrawings ? 'Hide drawings' : 'Show drawings')}
      {selected && btn('Delete', false, onDelete, 'Delete selected (Del)', { color: p.down })}
      {count > 0 && btn(`Clear ${count}`, false, onClearAll, 'Clear all drawings on this symbol')}

      {activeTool && (
        <span style={{ marginLeft: 'auto', fontFamily: "'DM Sans',sans-serif", fontSize: 10, color: p.text }}>
          {TOOLS[activeTool].label} — click to place, Esc to cancel
        </span>
      )}
    </div>
  );
}
