'use client';
import { memo, useCallback, useRef, useState } from 'react';
import {
  TOOLS, tool, activeCategories, categoryOfTool,
} from '../../lib/chart/chart-drawings.mjs';
import { palette } from '../../lib/chart/chart-theme.mjs';
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

function DrawingRailBase({
  theme, activeTool, onPick,
  selected, onDelete, count, showDrawings, onToggleShow, onClearAll,
  onOpenManager,
  onUndo, onRedo, canUndo = false, canRedo = false,
  compact = false,
}) {
  const p = palette(theme);
  const [openCat, setOpenCat] = useState(null);
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
  const compactRef = useRef(null);

  const closeCat = useCallback(() => setOpenCat(null), []);
  const closeMenu = useCallback(() => setMenu(false), []);

  // ⚠️ SELECTING A DRAWING NO LONGER OPENS THIS PANEL. It used to, on the reasoning that selection
  // is exactly when colour and width are wanted — which is true, and is why those controls now
  // appear BESIDE the drawing instead of on the far side of the chart from it. See DrawingToolbar.
  // This panel kept one job: the style the NEXT drawing will be made with. One control meaning two
  // different things depending on whether something happened to be selected was the confusion that
  // made the old behaviour worth removing rather than moving.

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
              cursor: 'pointer', borderRadius: 2, transition: 'color 90ms ease',
              color: openCat === cat.id ? p.up : p.text }}>▸</button>
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
    // ⚠️ THE PAINT TRAY AND THE MAGNET USED TO SIT HERE, between this rule and the eye. The list is
    // flat, so removing them closes the gap on its own — and the rule above still separates the
    // drawing TOOLS from the controls that act on drawings already made, which is what it was for.
    //
    // The paint tray set the style for the NEXT drawing: a setting a reader reaches for about once,
    // sitting in the rail looking exactly like the control that restyles what they have selected. Two
    // controls for one concept, the less useful one more prominent and further from its effect.
    // Colour, width and line style all remain, on the toolbar that appears beside a selected drawing.
    //
    // The magnet snapped anchors to candle prices. The snapping code is untouched in DrawingLayer;
    // nothing asks for it now, and CPChart pins it off so a saved magnet:true cannot strand anyone.
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
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', flexShrink: 0, width: RAIL_W }}>
      <div style={{
        width: RAIL_W, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
        padding: '4px 0', borderRight: `1px solid ${p.border}`, height: '100%',
        // The rail can scroll in a short panel; when it runs out, the gesture stays here rather than
        // chaining to the page and dragging the chart out from under the pointer.
        overflowY: 'auto', overflowX: 'visible', overscrollBehavior: 'contain',
      }}>
        {buttons}
      </div>
    </div>
  );
}

export { RAIL_W };

// MEMOISED. The chart re-renders on every crosshair move — that is one setState per pointer move by
// design, to keep the legend live — and without this, DrawingRail re-rendered with it even though
// none of its props had changed. Its callers pass stable callbacks for the same reason.
const DrawingRail = memo(DrawingRailBase);
export default DrawingRail;
