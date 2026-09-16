'use client';
import { useEffect, useRef, useState } from 'react';
import {
  TOOLS, tool, activeCategories, categoryOfTool, LINE_WIDTHS, LINE_DASHES,
} from '../../lib/chart/chart-drawings.mjs';
import { palette, indicatorColors } from '../../lib/chart/chart-theme.mjs';
import { ToolButton, useDismiss } from './ChartUI';

// The vertical drawing rail.
//
// ONE BUTTON PER CATEGORY, NOT PER TOOL. Six tools already crowd a narrow Terminal panel and the
// list will grow; a category button that remembers the last tool picked from it keeps the rail a
// fixed height however many tools exist. The small ▸ opens the category's tools.
//
// IT SITS BESIDE THE CHART, NOT OVER IT — a flex sibling, not an overlay — so it can never cover a
// candle, a price label or the time axis, which is what a floating palette does in a small panel.
//
// EXTENSIBLE BY CONFIG: categories and their tools come from the registry, so a new drawing tool is
// a registry entry and appears here with its icon and tooltip. Empty categories are declared but not
// rendered, so the roadmap is visible in code without putting a dead button on the chart.

const RAIL_W = 34;

export default function DrawingRail({
  theme, activeTool, onPick, style, onStyle,
  selected, onDelete, count, showDrawings, onToggleShow, onClearAll,
  compact = false,
}) {
  const p = palette(theme);
  const swatches = indicatorColors(theme);
  const [openCat, setOpenCat] = useState(null);
  const [stylePanel, setStylePanel] = useState(false);
  const [menu, setMenu] = useState(false);
  // What each category last placed, so its button repeats that choice on a single click.
  const [lastOf, setLastOf] = useState({});
  const rootRef = useRef(null);

  const closeAll = () => { setOpenCat(null); setStylePanel(false); setMenu(false); };
  useEffect(() => {
    if (!openCat && !stylePanel && !menu) return undefined;
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) closeAll(); };
    const onKey = (e) => { if (e.key === 'Escape') closeAll(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [openCat, stylePanel, menu]);

  // CONTEXTUAL SETTINGS: selecting a drawing or arming a tool is exactly when colour, width and
  // style are wanted, so the panel appears then instead of occupying a permanent row.
  useEffect(() => { if (selected) setStylePanel(true); }, [selected]);

  const cats = activeCategories();

  const pickTool = (catId, toolId) => {
    setLastOf((m) => ({ ...m, [catId]: toolId }));
    onPick(activeTool === toolId ? null : toolId);
    setOpenCat(null);
  };

  const categoryButton = (cat) => {
    const chosen = lastOf[cat.id] || cat.tools.find((t) => TOOLS[t]);
    const isActive = !!activeTool && categoryOfTool(activeTool)?.id === cat.id;
    const shown = isActive ? activeTool : chosen;
    const def = tool(shown);
    return (
      <div key={cat.id} style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
        <ToolButton theme={theme} active={isActive} title={`${cat.label} — ${def?.label ?? ''}`}
          onClick={() => pickTool(cat.id, shown)}>{def?.icon ?? cat.icon}</ToolButton>
        {cat.tools.filter((t) => TOOLS[t]).length > 1 && (
          <button type="button" title={`${cat.label} tools`} aria-label={`${cat.label} tools`}
            onClick={() => setOpenCat(openCat === cat.id ? null : cat.id)}
            style={{ position: 'absolute', right: -1, bottom: -1, width: 10, height: 10, padding: 0,
              lineHeight: '8px', fontSize: 7, background: 'transparent', border: 'none',
              cursor: 'pointer', color: p.text }}>▸</button>
        )}
        {openCat === cat.id && (
          <div style={{ position: 'absolute', left: compact ? 30 : RAIL_W, top: 0, zIndex: 30, width: 168,
            background: p.tooltipBg, border: `1px solid ${p.tooltipBorder}`, borderRadius: 6,
            boxShadow: '0 8px 28px rgba(0,0,0,0.22)', padding: 4 }}>
            <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 10, color: p.text,
              padding: '2px 6px 4px', letterSpacing: '0.5px' }}>{cat.label.toUpperCase()}</div>
            {cat.tools.filter((t) => TOOLS[t]).map((t) => (
              <button key={t} type="button" onClick={() => pickTool(cat.id, t)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                  background: activeTool === t ? p.grid : 'transparent', border: 'none', borderRadius: 4,
                  cursor: 'pointer', padding: '5px 7px', fontFamily: "'DM Sans',sans-serif",
                  fontSize: 12, color: activeTool === t ? p.textStrong : p.text }}>
                <span style={{ width: 14, textAlign: 'center' }}>{TOOLS[t].icon}</span>
                <span>{TOOLS[t].label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  const divider = (key) => (
    <div key={key} style={{ width: 18, height: 1, background: p.border, margin: '3px auto', flexShrink: 0 }} />
  );

  const buttons = [
    <ToolButton key="select" theme={theme} active={!activeTool} onClick={() => onPick(null)}
      title="Select / edit (Esc)">↖</ToolButton>,
    divider('d1'),
    ...cats.map(categoryButton),
    divider('d2'),
    <ToolButton key="style" theme={theme} active={stylePanel} onClick={() => setStylePanel((v) => !v)}
      title="Colour, width and line style">🎨</ToolButton>,
    <ToolButton key="vis" theme={theme} active={!showDrawings} onClick={onToggleShow}
      title={showDrawings ? 'Hide all drawings' : 'Show all drawings'}>{showDrawings ? '👁' : '◦'}</ToolButton>,
    ...(selected ? [
      <ToolButton key="del" theme={theme} onClick={onDelete} title="Delete selected (Del)" danger>✕</ToolButton>,
    ] : []),
    ...(count > 0 ? [
      <ToolButton key="clear" theme={theme} onClick={onClearAll}
        title={`Clear all ${count} drawings on this symbol`}>🗑</ToolButton>,
    ] : []),
  ];

  const stylePanelBody = (
    <div style={{
      position: 'absolute', left: compact ? 0 : RAIL_W + 2, top: compact ? 32 : 0, zIndex: 30, width: 170,
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
          aria-label="Line width"
          style={{ background: 'transparent', color: p.textStrong, border: `1px solid ${p.border}`,
            borderRadius: 3, fontSize: 11, padding: '2px 4px' }}>
          {LINE_WIDTHS.map((w) => <option key={w} value={w}>{w}px</option>)}
        </select>
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6,
        fontFamily: "'DM Sans',sans-serif", fontSize: 11, color: p.text }}>
        <span style={{ flex: 1 }}>Style</span>
        <select value={style.dash} onChange={(e) => onStyle({ dash: e.target.value })}
          aria-label="Line style"
          style={{ background: 'transparent', color: p.textStrong, border: `1px solid ${p.border}`,
            borderRadius: 3, fontSize: 11, padding: '2px 4px' }}>
          {LINE_DASHES.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
      </label>
      {selected && (
        <button type="button" onClick={onDelete}
          style={{ marginTop: 8, width: '100%', background: 'transparent', border: `1px solid ${p.border}`,
            borderRadius: 4, cursor: 'pointer', padding: '3px 0', color: p.down,
            fontFamily: "'DM Sans',sans-serif", fontSize: 11 }}>Delete drawing</button>
      )}
    </div>
  );

  // COMPACT: in a narrow panel a 34px rail is a large share of the chart, so it collapses to one
  // button that opens the same controls. Deliberately not a squeezed rail, which would leave
  // neither the rail nor the chart usable.
  if (compact) {
    return (
      <div ref={rootRef} style={{ position: 'relative', flexShrink: 0 }}>
        <ToolButton theme={theme} active={!!activeTool || menu} onClick={() => setMenu((v) => !v)}
          title="Drawing tools">✎</ToolButton>
        {menu && (
          <div style={{ position: 'absolute', left: 0, top: 30, zIndex: 30,
            background: p.tooltipBg, border: `1px solid ${p.tooltipBorder}`, borderRadius: 6,
            boxShadow: '0 8px 28px rgba(0,0,0,0.22)', padding: 5,
            display: 'flex', flexDirection: 'column', gap: 2 }}>
            {buttons}
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
        overflowY: 'auto', overflowX: 'visible',
      }}>
        {buttons}
      </div>
      {stylePanel && stylePanelBody}
    </div>
  );
}

export { RAIL_W };
