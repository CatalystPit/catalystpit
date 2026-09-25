'use client';
import { memo, useEffect, useRef, useState } from 'react';
import { tool, LINE_WIDTHS, LINE_DASHES, LABEL_MAX } from '../../lib/chart/chart-drawings.mjs';
import { palette, indicatorColors, indicatorColor } from '../../lib/chart/chart-theme.mjs';
import { Popover, MenuItem, MenuLabel } from './ChartUI';
import { CONTROL, controlsFor, placeToolbar } from '../../lib/chart/drawing-toolbar.mjs';

// THE FLOATING TOOLBAR FOR A SELECTED DRAWING.
//
// ── ⚠️ WHAT THIS REPLACES, AND WHY ──────────────────────────────────────────
//
// Selecting a drawing used to force open the rail's style flyout — a panel headed "Selected
// drawing" carrying the full palette, two dropdowns and a Delete button. Three problems, all of
// them structural rather than cosmetic. It appeared on the far side of the chart from the thing it
// was editing, so changing a colour meant crossing the whole panel and back. It showed every colour
// at once, permanently, which is most of the panel's width spent on a choice made once. And it was
// the same panel that sets the style for the NEXT drawing, so one control meant two different
// things depending on whether something happened to be selected.
//
// This appears beside the drawing, holds one button per concern, and opens its choices only when
// asked. It is a familiar interaction — every professional charting tool works this way — built in
// our own terminal's language: forest borders, the chart palette, 22px controls, no artwork lifted
// from anywhere.
//
// ── ⚠️ CLICKS HERE ARE NOT CHART CLICKS ─────────────────────────────────────
//
// The drawing canvas sits underneath and treats a pointerdown that misses a drawing as "deselect".
// A toolbar button is a miss. So every pointer event is stopped at the container: without that, the
// first click on any control would deselect the drawing the control was about to edit, and the
// toolbar would vanish mid-gesture. stopPropagation on the container covers the buttons AND the
// popovers' triggers in one place rather than each control remembering to do it.
//
// ── ⚠️ IT IS POSITIONED, NOT PLACED BY HAND ─────────────────────────────────
//
// Where it goes is placeToolbar() in lib/chart/drawing-toolbar.mjs — pure, and asserted for every
// corner of the plot. The rule it implements: above the drawing, below it when the drawing is near
// the top, and inside the plot always.

const BTN = 22;

/** A small line sample, so a dash style is chosen by looking rather than by reading a word. */
function DashSample({ dash, colour, width = 34 }) {
  const pattern = dash === 'dashed' ? '6 4' : dash === 'dotted' ? '1.5 3.5' : '';
  return (
    <svg width={width} height="8" viewBox={`0 0 ${width} 8`} aria-hidden="true" style={{ display: 'block' }}>
      <line x1="1" y1="4" x2={width - 1} y2="4" stroke={colour} strokeWidth="2"
        strokeDasharray={pattern || undefined} strokeLinecap="round" />
    </svg>
  );
}

function Btn({ theme, title, onClick, active, danger, children, anchorRef, width }) {
  const p = palette(theme);
  const [hover, setHover] = useState(false);
  return (
    <button
      ref={anchorRef} type="button" title={title} aria-label={title} onClick={onClick}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        height: BTN, minWidth: width || BTN, padding: width ? '0 5px' : 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3,
        background: active ? p.menuActive : (hover ? p.menuHover : 'transparent'),
        border: 'none', borderRadius: 4, cursor: 'pointer',
        color: danger ? p.down : (active ? p.textStrong : p.text),
        fontFamily: "'DM Sans',sans-serif", fontSize: 10.5, lineHeight: 1,
        transition: 'background 90ms ease, color 90ms ease',
      }}
    >{children}</button>
  );
}

function DrawingToolbarBase({
  theme, drawing, extraCount = 0, box, plot,
  onStyle, onPatch, onDelete, onOpenSettings,
}) {
  const p = palette(theme);
  const swatches = indicatorColors(theme);
  const [open, setOpen] = useState(null);           // 'color' | 'width' | 'dash' | 'label' | 'more'
  const [draft, setDraft] = useState('');
  const refs = {
    color: useRef(null), width: useRef(null), dash: useRef(null),
    label: useRef(null), text: useRef(null), more: useRef(null),
  };
  const barRef = useRef(null);
  const [size, setSize] = useState({ w: 220, h: BTN + 8 });

  // The toolbar's own width decides where it can sit, so it is measured rather than guessed — a
  // guessed width is how a toolbar ends up one control past the edge of a narrow panel.
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    if (w && h && (w !== size.w || h !== size.h)) setSize({ w, h });
  });

  // A new selection starts closed, and the label draft belongs to the drawing it was opened for.
  const id = drawing?.id ?? null;
  useEffect(() => { setOpen(null); }, [id]);
  useEffect(() => {
    if (open === CONTROL.LABEL) setDraft(drawing?.label ?? '');
    if (open === CONTROL.TEXT) setDraft(drawing?.text ?? '');
  }, [open, id]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (!drawing || !box) return null;
  const def = tool(drawing.type);
  if (!def) return null;

  const controls = controlsFor(drawing.type);
  const pos = placeToolbar(box, size, plot);
  const colour = indicatorColor(theme, drawing.style?.color);
  const close = () => setOpen(null);
  const toggle = (k) => setOpen((v) => (v === k ? null : k));

  const commitText = (field) => {
    const value = field === CONTROL.LABEL ? draft.slice(0, LABEL_MAX) : draft;
    onPatch(field === CONTROL.LABEL ? { label: value } : { text: value });
    close();
  };

  const textField = (field) => (
    <div style={{ padding: 6 }}>
      <input
        autoFocus value={draft} maxLength={field === CONTROL.LABEL ? LABEL_MAX : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commitText(field); }
          if (e.key === 'Escape') { e.preventDefault(); close(); }
        }}
        placeholder={field === CONTROL.LABEL ? 'Resistance, PM High…' : 'Note…'}
        aria-label={field === CONTROL.LABEL ? 'Attached label' : 'Note text'}
        style={{
          width: '100%', boxSizing: 'border-box', background: 'transparent', color: p.textStrong,
          border: `1px solid ${p.border}`, borderRadius: 4, padding: '5px 7px',
          fontFamily: "'DM Sans',sans-serif", fontSize: 12,
        }} />
      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        <button type="button" onClick={() => commitText(field)}
          style={{ flex: 1, background: p.menuActive, border: `1px solid ${p.border}`, borderRadius: 4,
            cursor: 'pointer', padding: '3px 0', color: p.textStrong,
            fontFamily: "'DM Sans',sans-serif", fontSize: 11 }}>Apply</button>
        {(field === CONTROL.LABEL ? drawing.label : drawing.text) ? (
          <button type="button" onClick={() => { setDraft(''); onPatch(field === CONTROL.LABEL ? { label: '' } : { text: '' }); close(); }}
            style={{ background: 'transparent', border: `1px solid ${p.border}`, borderRadius: 4,
              cursor: 'pointer', padding: '3px 9px', color: p.text,
              fontFamily: "'DM Sans',sans-serif", fontSize: 11 }}>Clear</button>
        ) : null}
      </div>
    </div>
  );

  const items = [];

  if (controls.includes(CONTROL.TEXT)) {
    items.push(
      <div key="text" ref={refs.text} style={{ display: 'flex' }}>
        <Btn theme={theme} title="Edit note text" active={open === CONTROL.TEXT}
          onClick={() => toggle(CONTROL.TEXT)} width={30}>
          <span style={{ fontWeight: 700, fontSize: 12 }}>T</span>
        </Btn>
      </div>,
    );
  }

  if (controls.includes(CONTROL.COLOR)) {
    items.push(
      <div key="color" ref={refs.color} style={{ display: 'flex' }}>
        <Btn theme={theme} title="Colour" active={open === CONTROL.COLOR} onClick={() => toggle(CONTROL.COLOR)}>
          <span style={{ width: 13, height: 13, borderRadius: 3, background: colour,
            border: `1px solid ${p.border}`, display: 'block' }} />
        </Btn>
      </div>,
    );
  }

  if (controls.includes(CONTROL.WIDTH)) {
    items.push(
      <div key="width" ref={refs.width} style={{ display: 'flex' }}>
        <Btn theme={theme} title="Line width" active={open === CONTROL.WIDTH}
          onClick={() => toggle(CONTROL.WIDTH)} width={30}>
          {drawing.style?.width ?? 2}px
        </Btn>
      </div>,
    );
  }

  if (controls.includes(CONTROL.DASH)) {
    items.push(
      <div key="dash" ref={refs.dash} style={{ display: 'flex' }}>
        <Btn theme={theme} title="Line style" active={open === CONTROL.DASH}
          onClick={() => toggle(CONTROL.DASH)} width={30}>
          <DashSample dash={drawing.style?.dash} colour={p.text} width={20} />
        </Btn>
      </div>,
    );
  }

  if (controls.includes(CONTROL.LABEL)) {
    items.push(
      <div key="label" ref={refs.label} style={{ display: 'flex' }}>
        <Btn theme={theme} active={open === CONTROL.LABEL} onClick={() => toggle(CONTROL.LABEL)}
          title={drawing.label ? `Label: ${drawing.label}` : 'Add a label — Resistance, PM High…'}
          width={drawing.label ? undefined : BTN}>
          {drawing.label
            ? <span style={{ maxWidth: 74, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{drawing.label}</span>
            : <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M2.5 4h11M2.5 8h7M2.5 12h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
              </svg>}
        </Btn>
      </div>,
    );
  }

  if (controls.includes(CONTROL.LOCK)) {
    items.push(
      <Btn key="lock" theme={theme} active={drawing.locked === true}
        title={drawing.locked ? 'Locked — click to unlock' : 'Lock so it cannot be dragged'}
        onClick={() => onPatch({ locked: !drawing.locked })}>
        {drawing.locked
          ? <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 015 0v2" />
            </svg>
          : <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 015 0" />
            </svg>}
      </Btn>,
    );
  }

  if (controls.includes(CONTROL.MORE)) {
    items.push(
      <div key="more" ref={refs.more} style={{ display: 'flex' }}>
        <Btn theme={theme} title="More settings" active={open === CONTROL.MORE} onClick={() => toggle(CONTROL.MORE)}>
          <span style={{ letterSpacing: 1, fontSize: 12, lineHeight: '10px' }}>⋯</span>
        </Btn>
      </div>,
    );
  }

  if (controls.includes(CONTROL.DELETE)) {
    items.push(
      <div key="sep" style={{ width: 1, height: 14, background: p.border, margin: '0 1px', flexShrink: 0 }} />,
      <Btn key="del" theme={theme} danger title="Delete drawing (Del)" onClick={onDelete}>
        <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2a1 1 0 001 .8h3.8a1 1 0 001-.8l.6-8.2" strokeLinecap="round" />
        </svg>
      </Btn>,
    );
  }

  return (
    <div
      ref={barRef}
      // ⚠️ EVERY POINTER EVENT STOPS HERE. See the note at the top: the canvas below reads a
      // pointerdown that hits no drawing as "deselect", and a toolbar button is such a miss.
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      // The chart's own context menu is suppressed over the plot; over the toolbar the browser's is
      // harmless and occasionally wanted.
      onContextMenu={(e) => e.stopPropagation()}
      role="toolbar"
      aria-label={`${def.label} options`}
      style={{
        position: 'absolute', left: pos.left, top: pos.top, zIndex: 6,
        display: 'flex', alignItems: 'center', gap: 1,
        padding: '3px 4px', borderRadius: 6,
        background: p.tooltipBg, border: `1px solid ${p.border}`,
        boxShadow: '0 4px 14px rgba(0,0,0,0.28)',
        // ⚠️ THE WIDTH THE PLACEMENT ASSUMED, not a second cap computed here. See placeToolbar:
        // one box, one number, or the two disagree in exactly the narrow panels that need them to
        // agree.
        maxWidth: pos.width || undefined,
      }}
    >
      {extraCount > 0 && (
        <span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 9.5, color: p.text,
          padding: '0 4px', whiteSpace: 'nowrap' }}>+{extraCount}</span>
      )}
      {items}

      <Popover anchorRef={refs.color} open={open === CONTROL.COLOR} onClose={close} theme={theme}
        placement="bottom-start" width={128} label="Drawing colour">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: 6 }}>
          {swatches.map((c, i) => (
            <button key={c} type="button" title={`Colour ${i + 1}`}
              onClick={() => { onStyle({ color: i }); close(); }}
              style={{ width: 18, height: 18, borderRadius: 3, cursor: 'pointer', background: c,
                border: drawing.style?.color === i ? `2px solid ${p.textStrong}` : `1px solid ${p.border}` }} />
          ))}
        </div>
      </Popover>

      <Popover anchorRef={refs.width} open={open === CONTROL.WIDTH} onClose={close} theme={theme}
        placement="bottom-start" width={104} label="Line width">
        {LINE_WIDTHS.map((w) => (
          <MenuItem key={w} theme={theme} active={drawing.style?.width === w}
            onClick={() => { onStyle({ width: w }); close(); }}
            left={<DashSample dash="solid" colour={colour} width={22} />}>{w}px</MenuItem>
        ))}
      </Popover>

      <Popover anchorRef={refs.dash} open={open === CONTROL.DASH} onClose={close} theme={theme}
        placement="bottom-start" width={126} label="Line style">
        {LINE_DASHES.map((d) => (
          <MenuItem key={d} theme={theme} active={drawing.style?.dash === d}
            onClick={() => { onStyle({ dash: d }); close(); }}
            left={<DashSample dash={d} colour={colour} width={26} />}>
            {d[0].toUpperCase() + d.slice(1)}
          </MenuItem>
        ))}
      </Popover>

      <Popover anchorRef={refs.label} open={open === CONTROL.LABEL} onClose={close} theme={theme}
        placement="bottom-start" width={186} label="Attached label">
        {textField(CONTROL.LABEL)}
      </Popover>

      <Popover anchorRef={refs.text} open={open === CONTROL.TEXT} onClose={close} theme={theme}
        placement="bottom-start" width={186} label="Note text">
        {textField(CONTROL.TEXT)}
      </Popover>

      {/* ⚠️ SECONDARY SETTINGS ONLY. Anything a trader reaches for on most drawings belongs on the
          bar itself; this is for what they reach for occasionally, and for the full dialog when a
          tool has more than a menu can hold — a Fibonacci's level list being the case in point. */}
      <Popover anchorRef={refs.more} open={open === CONTROL.MORE} onClose={close} theme={theme}
        placement="bottom-end" width={196} label="More drawing settings">
        {def.extendable && (
          <>
            <MenuLabel theme={theme}>Extend</MenuLabel>
            <MenuItem theme={theme} active={drawing.extendLeft === true}
              onClick={() => onPatch({ extendLeft: !drawing.extendLeft })}>Extend left</MenuItem>
            <MenuItem theme={theme} active={drawing.extendRight === true}
              onClick={() => onPatch({ extendRight: !drawing.extendRight })}>Extend right</MenuItem>
          </>
        )}
        {(def.editableLevels || def.fill) && (
          <>
            <MenuLabel theme={theme}>{def.editableLevels ? 'Levels' : 'Fill'}</MenuLabel>
            {def.editableLevels && (
              <MenuItem theme={theme} active={drawing.fill === true}
                onClick={() => onPatch({ fill: !drawing.fill })}>Shade between levels</MenuItem>
            )}
            {def.editableLevels && (
              <MenuItem theme={theme} onClick={() => { close(); onOpenSettings(drawing.id); }}>
                Edit levels…
              </MenuItem>
            )}
          </>
        )}
        <MenuLabel theme={theme}>Drawing</MenuLabel>
        <MenuItem theme={theme} active={drawing.visible === false}
          onClick={() => onPatch({ visible: drawing.visible === false })}>
          {drawing.visible === false ? 'Hidden — show' : 'Hide'}
        </MenuItem>
        <MenuItem theme={theme} onClick={() => { close(); onOpenSettings(drawing.id); }}>All settings…</MenuItem>
      </Popover>
    </div>
  );
}

// MEMOISED for the same reason the rail is: the chart re-renders on every crosshair move, and this
// sits inside it.
const DrawingToolbar = memo(DrawingToolbarBase);
export default DrawingToolbar;
