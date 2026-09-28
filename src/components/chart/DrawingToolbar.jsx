'use client';
import { memo, useEffect, useRef, useState } from 'react';
import { tool, LINE_WIDTHS, LINE_DASHES, LABEL_MAX } from '../../lib/chart/chart-drawings.mjs';
import { palette, indicatorColor } from '../../lib/chart/chart-theme.mjs';
import { Popover, MenuItem, MenuLabel, POPOVER_CHROME } from './ChartUI';
import { CONTROL, controlsFor, placeToolbar } from '../../lib/chart/drawing-toolbar.mjs';
import { sanitizeLabelStyle, LABEL_SIZES } from '../../lib/chart/drawing-label.mjs';
import { ColorPalettePanel, usePaletteMetrics } from './ColorPicker';

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
  // Resolved HERE, in the host, so it is settled long before a palette is opened and the numbers the
  // Popover places against are the same ones the panel lays itself out with.
  const cm = usePaletteMetrics();
  const [open, setOpen] = useState(null);           // 'color' | 'width' | 'dash' | 'label' | 'more'
  const [draft, setDraft] = useState('');
  const refs = {
    color: useRef(null), width: useRef(null), dash: useRef(null),
    label: useRef(null), text: useRef(null), more: useRef(null),
    labelColor: useRef(null),
  };
  // The caption's colour panel is nested inside the caption editor, so it needs an open flag of its
  // own rather than a value of `open` — both are on screen at once.
  const [colorOpen, setColorOpen] = useState(false);
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
  useEffect(() => { setOpen(null); setColorOpen(false); }, [id]);
  // The nested palette cannot outlive the editor it belongs to.
  useEffect(() => { if (open !== CONTROL.LABEL) setColorOpen(false); }, [open]);
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

  /**
   * THE CAPTION EDITOR — text attached to the selected drawing.
   *
   * ⚠️ THE TEXT COMMITS ON ENTER AND ON BLUR, NOT ON EVERY KEYSTROKE. Every write goes through
   * updateDrawings, which is the undo stack: patching per character would make "undo" mean "delete one
   * letter" twenty times over before it got back to the state the user actually wants. The style
   * controls DO apply immediately, because each of them is one deliberate action already.
   *
   * ⚠️ AND IT IS THE SHARED PALETTE FOR COLOUR. The swatch opens ColorPalettePanel in a nested Popover,
   * exactly as the toolbar's own colour square does — same component, same one tap to ninety colours.
   */
  const lstyle = sanitizeLabelStyle(drawing.labelStyle);
  const labelInk = lstyle.color === undefined ? colour : indicatorColor(theme, lstyle.color);
  // ⚠️ SANITIZED ON THE WAY OUT, not left for every reader to do. Returning to the inherited colour
  // means REMOVING the key, and a patch that merely set it to null would leave a null in the live
  // object that the renderer, the toolbar and the store each had to remember to strip.
  const patchLabelStyle = (patch) => onPatch({ labelStyle: sanitizeLabelStyle({ ...lstyle, ...patch }) });
  const commitLabel = () => {
    const next = draft.slice(0, LABEL_MAX);
    if (next !== (drawing.label ?? '')) onPatch({ label: next });
  };

  const Seg = ({ options, value, onPick, label: aria }) => (
    <div role="group" aria-label={aria} style={{ display: 'flex', gap: 2 }}>
      {options.map((o) => (
        <button
          key={o.v} type="button" title={o.title} aria-label={o.title}
          aria-pressed={value === o.v}
          onClick={() => onPick(o.v)}
          style={{
            minWidth: 24, height: 20, padding: '0 4px', cursor: 'pointer', borderRadius: 3,
            boxSizing: 'border-box',
            background: value === o.v ? p.menuActive : 'transparent',
            border: `1px solid ${value === o.v ? p.textStrong : p.border}`,
            color: value === o.v ? p.textStrong : p.text,
            fontFamily: "'DM Sans',sans-serif", fontSize: 10, lineHeight: 1,
          }}
        >{o.icon}</button>
      ))}
    </div>
  );

  const captionEditor = (
    <div style={{ padding: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <input
        autoFocus value={draft} maxLength={LABEL_MAX}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitLabel}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commitLabel(); }
          if (e.key === 'Escape') { e.preventDefault(); close(); }
          // Typing must not reach the chart's own key handlers — Delete would remove the drawing.
          e.stopPropagation();
        }}
        placeholder="Previous Resistance…"
        aria-label="Drawing text"
        style={{
          width: '100%', boxSizing: 'border-box', background: 'transparent', color: p.textStrong,
          border: `1px solid ${p.border}`, borderRadius: 4, padding: '5px 7px',
          fontFamily: "'DM Sans',sans-serif", fontSize: 12,
        }} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {/* Colour — the shared palette, one tap, same as the toolbar's own swatch. */}
        <div ref={refs.labelColor} style={{ display: 'flex' }}>
          <button
            type="button" title="Text color" aria-label="Text color"
            aria-expanded={colorOpen}
            onClick={() => setColorOpen((v) => !v)}
            style={{
              width: 24, height: 20, padding: 0, cursor: 'pointer', borderRadius: 3,
              boxSizing: 'border-box', background: labelInk,
              border: `1px solid ${colorOpen ? p.textStrong : p.border}`,
            }} />
        </div>
        <select
          aria-label="Font size" value={lstyle.size}
          onChange={(e) => patchLabelStyle({ size: Number(e.target.value) })}
          style={{
            height: 20, boxSizing: 'border-box', background: p.background, color: p.textStrong,
            border: `1px solid ${p.border}`, borderRadius: 3, cursor: 'pointer',
            fontFamily: "'DM Sans',sans-serif", fontSize: 10,
          }}
        >
          {LABEL_SIZES.map((sz) => <option key={sz} value={sz}>{sz}px</option>)}
        </select>
        <button
          type="button" title="Bold" aria-label="Bold" aria-pressed={lstyle.bold}
          onClick={() => patchLabelStyle({ bold: !lstyle.bold })}
          style={{
            minWidth: 24, height: 20, padding: 0, cursor: 'pointer', borderRadius: 3,
            boxSizing: 'border-box',
            background: lstyle.bold ? p.menuActive : 'transparent',
            border: `1px solid ${lstyle.bold ? p.textStrong : p.border}`,
            color: lstyle.bold ? p.textStrong : p.text,
            fontFamily: "'DM Sans',sans-serif", fontSize: 11, fontWeight: 700,
          }}>B</button>
        {/* ⚠️ BACK TO INHERITING THE LINE'S COLOUR. Absent means inherit, and without this the only way
            back from an explicit colour would be to guess which swatch matched the line. */}
        {lstyle.color !== undefined ? (
          <button
            type="button" title="Match the line's colour" aria-label="Match line color"
            onClick={() => patchLabelStyle({ color: null })}
            style={{
              height: 20, padding: '0 5px', cursor: 'pointer', borderRadius: 3, boxSizing: 'border-box',
              background: 'transparent', border: `1px solid ${p.border}`, color: p.text,
              fontFamily: "'DM Sans',sans-serif", fontSize: 10,
            }}>Match</button>
        ) : null}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Seg
          aria="Text alignment" value={lstyle.align}
          onPick={(v) => patchLabelStyle({ align: v })}
          options={[
            { v: 'left', icon: '⌐', title: 'Align left' },
            { v: 'center', icon: '≡', title: 'Align centre' },
            { v: 'right', icon: '¬', title: 'Align right' },
          ]}
        />
        <Seg
          aria="Text placement" value={lstyle.place}
          onPick={(v) => patchLabelStyle({ place: v })}
          options={[
            { v: 'above', icon: '↑', title: 'Above the line' },
            { v: 'middle', icon: '–', title: 'On the line' },
            { v: 'below', icon: '↓', title: 'Below the line' },
          ]}
        />
      </div>

      {drawing.label ? (
        <button type="button" aria-label="Remove text"
          onClick={() => { setDraft(''); onPatch({ label: '' }); close(); }}
          style={{
            background: 'transparent', border: `1px solid ${p.border}`, borderRadius: 4,
            cursor: 'pointer', padding: '3px 0', color: p.text,
            fontFamily: "'DM Sans',sans-serif", fontSize: 11,
          }}>Remove text</button>
      ) : null}
    </div>
  );

  /**
   * ⚠️ ONE ORDER, AND IT IS controlsFor's. These used to be pushed in a fixed sequence here, with
   * `controls` used only to ask whether each one belonged — so the list module could reorder all it
   * liked and the toolbar would go on rendering colour, width, style, text. It did exactly that: the
   * caption was moved to sit beside the colour and nothing on screen changed. Two files describing one
   * order is the bug; the renderers are now keyed by control and the order is read, not restated.
   */
  const RENDERERS = {
    [CONTROL.TEXT]: (
      <div key="text" ref={refs.text} style={{ display: 'flex' }}>
        <Btn theme={theme} title="Edit note text" active={open === CONTROL.TEXT}
          onClick={() => toggle(CONTROL.TEXT)} width={30}>
          <span style={{ fontWeight: 700, fontSize: 12 }}>T</span>
        </Btn>
      </div>,
    ),
    [CONTROL.COLOR]: (
      <div key="color" ref={refs.color} style={{ display: 'flex' }}>
        <Btn theme={theme} title="Color" active={open === CONTROL.COLOR} onClick={() => toggle(CONTROL.COLOR)}>
          <span style={{ width: 13, height: 13, borderRadius: 3, background: colour,
            border: `1px solid ${p.border}`, display: 'block' }} />
        </Btn>
      </div>,
    ),
    [CONTROL.WIDTH]: (
      <div key="width" ref={refs.width} style={{ display: 'flex' }}>
        <Btn theme={theme} title="Line width" active={open === CONTROL.WIDTH}
          onClick={() => toggle(CONTROL.WIDTH)} width={30}>
          {drawing.style?.width ?? 2}px
        </Btn>
      </div>,
    ),
    [CONTROL.DASH]: (
      <div key="dash" ref={refs.dash} style={{ display: 'flex' }}>
        <Btn theme={theme} title="Line style" active={open === CONTROL.DASH}
          onClick={() => toggle(CONTROL.DASH)} width={30}>
          <DashSample dash={drawing.style?.dash} colour={p.text} width={20} />
        </Btn>
      </div>,
    ),
    [CONTROL.LABEL]: (
      <div key="label" ref={refs.label} style={{ display: 'flex' }}>
        {/* ⚠️ A "T", AND ALWAYS THE SAME WIDTH. This used to render the caption itself when there was
            one, which made the toolbar's width depend on how much a user had typed — it grew, the
            placement moved, and the buttons after it shifted under the pointer. The text belongs on
            the chart, where it is attached to the line; the button says what it opens and shows that
            there is something to open by lighting up. */}
        <Btn theme={theme} active={open === CONTROL.LABEL || !!drawing.label}
          onClick={() => toggle(CONTROL.LABEL)}
          title={drawing.label ? `Text: ${drawing.label}` : 'Add text to this drawing'}>
          <span style={{ fontWeight: 700, fontSize: 12, lineHeight: 1 }}>T</span>
        </Btn>
      </div>,
    ),
    [CONTROL.LOCK]: (
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
    ),
    [CONTROL.MORE]: (
      <div key="more" ref={refs.more} style={{ display: 'flex' }}>
        <Btn theme={theme} title="More settings" active={open === CONTROL.MORE} onClick={() => toggle(CONTROL.MORE)}>
          <span style={{ letterSpacing: 1, fontSize: 12, lineHeight: '10px' }}>⋯</span>
        </Btn>
      </div>,
    ),
    [CONTROL.DELETE]: (
      <Btn key="del" theme={theme} danger title="Delete drawing (Del)" onClick={onDelete}>
        <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2a1 1 0 001 .8h3.8a1 1 0 001-.8l.6-8.2" strokeLinecap="round" />
        </svg>
      </Btn>,
    ),
  };

  const items = [];
  for (const key of controls) {
    // The delete button is the only one that brings furniture with it.
    if (key === CONTROL.DELETE) {
      items.push(
        <div key="sep" style={{ width: 1, height: 14, background: p.border, margin: '0 1px', flexShrink: 0 }} />,
      );
    }
    const node = RENDERERS[key];
    if (node) items.push(node);
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

      {/**
        * ⚠️ THE PALETTE ITSELF, NOT A CONTROL THAT OPENS ONE. This held a COMPACT ColorPicker — which
        * is a trigger plus its own popover — so one tap on the colour square produced a 128px box
        * containing a single blue swatch and a caret, and the ninety colours needed a SECOND tap on
        * that caret. On a phone the caret is a few pixels wide and the palette was unreachable in
        * practice. Mounting ColorPalettePanel means the swatches ARE the popover's content: select a
        * drawing, tap the square once, pick a colour.
        *
        * ⚠️ AND IT IS THIS Popover RATHER THAN ColorPicker'S OWN PANEL, because ColorPicker positions
        * its panel `position: absolute` inside itself — inside this toolbar, inside the chart's
        * `overflow: hidden` box. A 460px palette hung off a toolbar that floats beside a drawing is
        * clipped by the chart. Popover portals to document.body and is placed against the VIEWPORT,
        * which is the only way the whole palette is reachable from a toolbar sitting near an edge.
        *
        * `height` (rather than a maxHeight) is what keeps it whole: placeFor then chooses a position
        * that fits all ninety swatches instead of capping them into a scroll container. `bottom-center`
        * centres it on the square and the placement clamps it into the window, so on a narrow phone it
        * ends up centred over the chart rather than half off the side.
        */}
      <Popover anchorRef={refs.color} open={open === CONTROL.COLOR} onClose={close} theme={theme}
        placement="bottom-center" width={cm.contentWidth + POPOVER_CHROME} height={cm.contentHeight + POPOVER_CHROME}
        label="Drawing color">
        <ColorPalettePanel
          theme={theme} value={drawing.style?.color}
          onPick={(v) => { onStyle({ color: v }); close(); }}
          onChange={(v) => onStyle({ color: v })}
          metrics={cm}
        />
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
        placement="bottom-start" width={226} label="Drawing text">
        {captionEditor}
      </Popover>

      {/* The caption's colour, from the one shared palette. Nested inside the editor above: the
          popover stack in ChartUI tracks open ORDER, so a click in here does not dismiss its parent
          and Escape peels one layer at a time. */}
      <Popover anchorRef={refs.labelColor} open={open === CONTROL.LABEL && colorOpen}
        onClose={() => setColorOpen(false)} theme={theme}
        placement="bottom-center" width={cm.contentWidth + POPOVER_CHROME}
        height={cm.contentHeight + POPOVER_CHROME} label="Text color">
        <ColorPalettePanel
          theme={theme} value={lstyle.color}
          onPick={(v) => { patchLabelStyle({ color: v }); setColorOpen(false); }}
          onChange={(v) => patchLabelStyle({ color: v })}
          metrics={cm}
        />
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
