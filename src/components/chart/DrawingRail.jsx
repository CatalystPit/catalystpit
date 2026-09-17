'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  TOOLS, tool, activeCategories, categoryOfTool, LINE_WIDTHS, LINE_DASHES,
} from '../../lib/chart/chart-drawings.mjs';
import { palette, indicatorColors } from '../../lib/chart/chart-theme.mjs';
import { ToolButton, Popover, MenuItem, MenuLabel, VectorIcon } from './ChartUI';

// The vertical drawing rail.
//
// ONE BUTTON PER CATEGORY, NOT PER TOOL. Six tools already crowd a narrow Terminal panel and the
// list will grow; a category button that remembers the last tool picked from it keeps the rail a
// fixed height however many tools exist. The small ▸ opens the category's tools.
//
// IT SITS BESIDE THE CHART, NOT OVER IT — a flex sibling, not an overlay — so the RAIL can never
// cover a candle, a price label or the time axis, which is what a floating palette does in a small
// panel. Its MENUS do overlay the chart, beside the icon that opened them, and are portalled to the
// document so the Terminal panel's `overflow: hidden` cannot clip them. See ChartUI's Popover.
//
// EXTENSIBLE BY CONFIG: categories and their tools come from the registry, so a new drawing tool is
// a registry entry and appears here with its icon and tooltip. Empty categories are declared but not
// rendered, so the roadmap is visible in code without putting a dead button on the chart.

const RAIL_W = 34;

export default function DrawingRail({
  theme, activeTool, onPick, style, onStyle,
  selected, onDelete, count, showDrawings, onToggleShow, onClearAll,
  magnet = false, onToggleMagnet, onOpenManager,
  onUndo, onRedo, canUndo = false, canRedo = false,
  compact = false,
}) {
  const p = palette(theme);
  const swatches = indicatorColors(theme);
  const [openCat, setOpenCat] = useState(null);
  const [stylePanel, setStylePanel] = useState(false);
  const [menu, setMenu] = useState(false);
  // What each category last placed, so its button repeats that choice on a single click.
  const [lastOf, setLastOf] = useState({});

  // One stable ref object per category, created on demand. The FLYOUT ANCHORS TO THE WHOLE BUTTON
  // GROUP (icon + ▸) rather than to the icon alone, so clicking ▸ counts as clicking the trigger and
  // toggles the menu instead of being treated as an outside click that closes and reopens it.
  const catRefs = useRef({});
  const refFor = (id) => {
    if (!catRefs.current[id]) catRefs.current[id] = { current: null };
    return catRefs.current[id];
  };
  const styleRef = useRef(null);
  const compactRef = useRef(null);

  const closeCat = useCallback(() => setOpenCat(null), []);
  const closeStyle = useCallback(() => setStylePanel(false), []);
  const closeMenu = useCallback(() => setMenu(false), []);

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
    const tools = cat.tools.filter((t) => TOOLS[t]);
    const ref = refFor(cat.id);
    return (
      <div key={cat.id} ref={ref} style={{ position: 'relative', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
        <ToolButton theme={theme} active={isActive} title={`${cat.label} — ${def?.label ?? ''}`}
          onClick={() => pickTool(cat.id, shown)}>
          <VectorIcon shapes={def?.shapes ?? cat.shapes} glyph={def?.icon ?? cat.icon} />
        </ToolButton>
        {tools.length > 1 && (
          <button type="button" title={`${cat.label} tools`} aria-label={`${cat.label} tools`}
            aria-haspopup="menu" aria-expanded={openCat === cat.id}
            onClick={() => setOpenCat(openCat === cat.id ? null : cat.id)}
            style={{ position: 'absolute', right: -1, bottom: -1, width: 10, height: 10, padding: 0,
              lineHeight: '8px', fontSize: 7, background: 'transparent', border: 'none',
              cursor: 'pointer', color: p.text }}>▸</button>
        )}
        {/* BESIDE THE ICON, over the chart — the rail's equivalent of the toolbar dropdown. */}
        <Popover anchorRef={ref} open={openCat === cat.id} onClose={closeCat} theme={theme}
          placement="right-start" gap={6} width={182} label={`${cat.label} tools`}>
          <MenuLabel theme={theme}>{cat.label}</MenuLabel>
          {tools.map((t) => (
            <MenuItem key={t} theme={theme} active={activeTool === t}
              onClick={() => pickTool(cat.id, t)}
              left={<VectorIcon shapes={TOOLS[t].shapes} glyph={TOOLS[t].icon} />}>
              {TOOLS[t].label}
            </MenuItem>
          ))}
        </Popover>
      </div>
    );
  };

  const divider = (key) => (
    <div key={key} style={{ width: 18, height: 1, background: p.border, margin: '3px auto', flexShrink: 0 }} />
  );

  const buttons = [
    <ToolButton key="select" theme={theme} active={!activeTool} onClick={() => onPick(null)}
      title="Select / edit (Esc)">↖</ToolButton>,
    // UNDO / REDO sit with the drawing tools because that is what the history covers — this is a
    // drawing history, not an application one, and putting them in the chart toolbar would imply
    // they undo a timeframe or an indicator too.
    <ToolButton key="undo" theme={theme} onClick={onUndo} disabled={!canUndo}
      title="Undo (Ctrl+Z)">↶</ToolButton>,
    <ToolButton key="redo" theme={theme} onClick={onRedo} disabled={!canRedo}
      title="Redo (Ctrl+Y)">↷</ToolButton>,
    divider('d1'),
    ...cats.map(categoryButton),
    divider('d2'),
    <div key="style" ref={styleRef} style={{ display: 'flex', flexShrink: 0 }}>
      <ToolButton theme={theme} active={stylePanel} expanded={stylePanel}
        onClick={() => setStylePanel((v) => !v)} title="Colour, width and line style">🎨</ToolButton>
    </div>,
    // MAGNET. Snapping is a DRAWING behaviour: with it on, an anchor lands exactly on a candle's
    // open, high, low or close. The crosshair is untouched either way.
    <ToolButton key="magnet" theme={theme} active={magnet} onClick={onToggleMagnet}
      title={magnet ? 'Magnet on — anchors snap to candle prices' : 'Magnet off — anchors follow the pointer'}>🧲</ToolButton>,
    <ToolButton key="vis" theme={theme} active={!showDrawings} onClick={onToggleShow}
      title={showDrawings ? 'Hide all drawings' : 'Show all drawings'}>{showDrawings ? '👁' : '◦'}</ToolButton>,
    // The object tree. Always present, because "I cannot find the drawing" is exactly the case where
    // a count of zero is not the question being asked.
    <ToolButton key="tree" theme={theme} onClick={onOpenManager}
      title={count ? `Drawings on this symbol (${count})` : 'Drawings on this symbol'}>☰</ToolButton>,
    ...(selected ? [
      <ToolButton key="del" theme={theme} onClick={onDelete} title="Delete selected (Del)" danger>✕</ToolButton>,
    ] : []),
    // "Delete all" moved into the object tree, beside the list of what would be deleted — a button
    // that silently wipes every drawing is safer next to the thing it wipes.
  ];

  // The style panel is a flyout beside its own icon, on the same model as the category menus.
  //
  // Selecting a drawing opens it, and in the collapsed rail that can happen while the menu holding
  // the 🎨 button is shut — so there is no 🎨 to anchor to. It falls back to the rail's own button,
  // which is always mounted, instead of trying to hang off an element that does not exist.
  const styleAnchor = compact && !menu ? compactRef : styleRef;
  const stylePopover = (
    <Popover anchorRef={styleAnchor} open={stylePanel} onClose={closeStyle} theme={theme}
      placement="right-start" gap={6} width={186} label="Drawing style">
      <MenuLabel theme={theme}>{selected ? 'Selected drawing' : 'New drawings'}</MenuLabel>
      <div style={{ padding: '2px 6px 6px' }}>
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
    </Popover>
  );

  // COMPACT: in a narrow panel a 34px rail is a large share of the chart, so it collapses to one
  // button that opens the same controls. Deliberately not a squeezed rail, which would leave neither
  // the rail nor the chart usable. The category flyouts still open from inside it — they are
  // separate portals, which is exactly why Popover tracks nesting by open order.
  if (compact) {
    return (
      <div style={{ position: 'relative', flexShrink: 0 }}>
        <div ref={compactRef} style={{ display: 'flex' }}>
          <ToolButton theme={theme} active={!!activeTool || menu} expanded={menu}
            onClick={() => setMenu((v) => !v)} title="Drawing tools">✎</ToolButton>
        </div>
        <Popover anchorRef={compactRef} open={menu} onClose={closeMenu} theme={theme}
          placement="bottom-start" width={42} label="Drawing tools">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'center' }}>
            {buttons}
          </div>
        </Popover>
        {stylePopover}
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', flexShrink: 0, width: RAIL_W }}>
      <div style={{
        width: RAIL_W, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
        padding: '4px 0', borderRight: `1px solid ${p.border}`, height: '100%',
        overflowY: 'auto', overflowX: 'visible',
      }}>
        {buttons}
      </div>
      {stylePopover}
    </div>
  );
}

export { RAIL_W };
