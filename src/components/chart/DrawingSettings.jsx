'use client';
import { useEffect, useState } from 'react';
import { tool, LINE_WIDTHS, LINE_DASHES, sanitizeFibLevels, DEFAULT_FIB_LEVELS } from '../../lib/chart/chart-drawings.mjs';
import { palette, indicatorColors } from '../../lib/chart/chart-theme.mjs';
import { Modal, ToolButton } from './ChartUI';

// ONE SETTINGS DIALOG FOR EVERY DRAWING.
//
// Opened by double-clicking a drawing, or from its row in the object tree — the two gestures a user
// arriving from another charting platform will try. What it shows is decided by what the TOOL
// declares it supports, so a new tool that declares `extendable` gets the extension controls with no
// change here, and a tool that declares nothing gets only the appearance section.
//
// NOTHING IN HERE IS DECORATIVE. Every control writes a field the renderer actually reads: the
// extension flags change which segment the tool returns, the level list is what fibLevels draws, and
// the style is what the canvas strokes. There is no setting that looks like it does something and
// does not.

const pct = (r) => `${(r * 100).toFixed(1)}%`;

export default function DrawingSettings({ open, onClose, theme, drawing, onChange }) {
  const p = palette(theme);
  const swatches = indicatorColors(theme);
  const [newLevel, setNewLevel] = useState('');
  useEffect(() => { if (!open) setNewLevel(''); }, [open]);

  if (!drawing) return null;
  const def = tool(drawing.type) || {};
  const patch = (next) => onChange({ ...drawing, ...next });
  const levels = def.editableLevels ? sanitizeFibLevels(drawing.levels) : [];

  const setLevel = (i, next) => patch({
    levels: levels.map((l, k) => {
      if (k !== i) return l;
      const merged = { ...l, ...next };
      // An explicit undefined MEANS "drop this field" — a level with color: undefined would survive
      // a merge and then be sanitised away inconsistently.
      for (const key of Object.keys(next)) if (next[key] === undefined) delete merged[key];
      return merged;
    }),
  });
  const removeLevel = (i) => patch({ levels: levels.filter((_, k) => k !== i) });
  const addLevel = () => {
    const r = Number(newLevel);
    if (!Number.isFinite(r)) return;
    // sanitizeFibLevels sorts and de-duplicates, so adding one that already exists is a no-op rather
    // than a second line hiding under the first.
    patch({ levels: sanitizeFibLevels([...levels, { ratio: r, visible: true }]) });
    setNewLevel('');
  };

  const section = (title, children) => (
    <div style={{ borderTop: `1px solid ${p.border}`, padding: '9px 0 4px' }}>
      <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 9.5, color: p.text,
        letterSpacing: '0.6px', marginBottom: 7 }}>{title.toUpperCase()}</div>
      {children}
    </div>
  );

  const row = (label, control) => (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7,
      fontFamily: "'DM Sans',sans-serif", fontSize: 11.5, color: p.text }}>
      <span style={{ flex: 1 }}>{label}</span>
      {control}
    </label>
  );

  const toggle = (on, onClick, label) => (
    <button type="button" onClick={onClick} aria-pressed={on}
      style={{ background: on ? p.menuActive : 'transparent', cursor: 'pointer', borderRadius: 4,
        border: `1px solid ${on ? p.up : p.border}`, padding: '2px 10px', minWidth: 54,
        fontFamily: "'DM Sans',sans-serif", fontSize: 11, color: on ? p.textStrong : p.text }}>{label}</button>
  );

  const select = (value, onSelect, options, aria) => (
    <select value={value} onChange={(e) => onSelect(e.target.value)} aria-label={aria}
      style={{ background: 'transparent', color: p.textStrong, border: `1px solid ${p.border}`,
        borderRadius: 3, fontSize: 11, padding: '2px 4px' }}>
      {options}
    </select>
  );

  return (
    <Modal theme={theme} open={open} onClose={onClose} width={400} title={def.label || 'Drawing'}>
      <div style={{ padding: '4px 12px 12px' }}>

        {/* A NOTE IS ITS WORDS, so it is edited first — nothing else about it matters as much. */}
        {def.hasText && section('Text', (
          <input value={drawing.text || ''} onChange={(e) => patch({ text: e.target.value })}
            placeholder="Note…" aria-label="Note text" autoComplete="off"
            style={{ width: '100%', boxSizing: 'border-box', background: 'transparent', color: p.textStrong,
              border: `1px solid ${p.border}`, borderRadius: 5, padding: '6px 8px',
              fontFamily: "'DM Sans',sans-serif", fontSize: 12 }} />
        ))}

        {/* EXTENSION. These write flags the tool's own segments() reads, so turning one on genuinely
            lengthens the line to the edge of the view rather than restyling it. */}
        {def.extendable && section('Extend', (
          <>
            {row('Extend left', toggle(drawing.extendLeft === true,
              () => patch({ extendLeft: !drawing.extendLeft }), drawing.extendLeft ? 'On' : 'Off'))}
            {row('Extend right', toggle(drawing.extendRight === true,
              () => patch({ extendRight: !drawing.extendRight }), drawing.extendRight ? 'On' : 'Off'))}
            <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 10.5, color: p.text, opacity: 0.8 }}>
              Extending both ends makes the line infinite. Hold Shift while drawing to snap to 45°.
            </div>
          </>
        ))}

        {def.editableLevels && section(`Levels (${levels.length})`, (
          <>
            {levels.map((l, i) => (
              <div key={`${l.ratio}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
                <ToolButton theme={theme} title={l.visible !== false ? 'Hide level' : 'Show level'}
                  onClick={() => setLevel(i, { visible: l.visible === false })}>
                  {l.visible !== false ? '👁' : '◦'}
                </ToolButton>
                {/* The RATIO is what is stored; the percentage beside it is the same number in the
                    units the tool is spoken about in. */}
                <input type="number" step="0.001" value={l.ratio}
                  aria-label={`Level ${i + 1} ratio`}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v)) setLevel(i, { ratio: v });
                  }}
                  style={{ width: 82, background: 'transparent', color: p.textStrong,
                    border: `1px solid ${p.border}`, borderRadius: 3, padding: '2px 5px',
                    fontFamily: "'DM Sans',sans-serif", fontSize: 11.5 }} />
                <span style={{ flex: 1, fontFamily: "'DM Sans',sans-serif", fontSize: 11,
                  color: p.text, opacity: 0.85 }}>{pct(l.ratio)}</span>
                {/* PER-LEVEL COLOUR, and a way back to none. Cycling through the palette and then
                    returning to "same as the drawing" keeps one control for both, and keeps the
                    default a single clean hue rather than a rainbow nobody asked for. */}
                <button type="button"
                  title={l.color == null ? 'Give this level its own colour' : 'Next colour (cycles back to default)'}
                  onClick={() => {
                    const nextIdx = l.color == null ? 0 : l.color + 1;
                    setLevel(i, { color: nextIdx >= swatches.length ? undefined : nextIdx });
                  }}
                  style={{ width: 16, height: 16, borderRadius: 3, cursor: 'pointer', flexShrink: 0,
                    background: l.color == null ? 'transparent' : swatches[l.color % swatches.length],
                    border: `1px solid ${l.color == null ? p.border : p.textStrong}` }} />
                <ToolButton theme={theme} title="Remove level" danger
                  onClick={() => removeLevel(i)}>✕</ToolButton>
              </div>
            ))}
            {/* OPTIONAL BANDS, off by default. A filled Fibonacci over candles is the fastest way
                to make a chart unreadable, so the clean set of lines is what you get unless you ask
                for more; when on, alternating bands are shaded at a very low alpha. */}
            {row('Shade between levels', toggle(drawing.fill === true,
              () => patch({ fill: !drawing.fill }), drawing.fill ? 'On' : 'Off'))}
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <input type="number" step="0.001" value={newLevel} placeholder="0.618"
                aria-label="New level ratio"
                onChange={(e) => setNewLevel(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addLevel(); } }}
                style={{ width: 82, background: 'transparent', color: p.textStrong,
                  border: `1px solid ${p.border}`, borderRadius: 3, padding: '3px 5px',
                  fontFamily: "'DM Sans',sans-serif", fontSize: 11.5 }} />
              <button type="button" onClick={addLevel}
                style={{ background: 'transparent', border: `1px solid ${p.border}`, borderRadius: 4,
                  cursor: 'pointer', padding: '3px 10px', color: p.text,
                  fontFamily: "'DM Sans',sans-serif", fontSize: 11 }}>Add level</button>
              <button type="button" onClick={() => patch({ levels: DEFAULT_FIB_LEVELS.map((l) => ({ ...l })) })}
                style={{ marginLeft: 'auto', background: 'transparent', border: `1px solid ${p.border}`,
                  borderRadius: 4, cursor: 'pointer', padding: '3px 10px', color: p.text,
                  fontFamily: "'DM Sans',sans-serif", fontSize: 11 }}>Reset</button>
            </div>
          </>
        ))}

        {section('Appearance', (
          <>
            <div style={{ display: 'flex', gap: 4, marginBottom: 9, flexWrap: 'wrap' }}>
              {swatches.map((c, i) => (
                <button key={c} type="button" title={`Colour ${i + 1}`}
                  onClick={() => patch({ style: { ...drawing.style, color: i } })}
                  style={{ width: 18, height: 18, borderRadius: 3, cursor: 'pointer', background: c,
                    border: drawing.style?.color === i ? `2px solid ${p.textStrong}` : `1px solid ${p.border}` }} />
              ))}
            </div>
            {row('Width', select(drawing.style?.width,
              (v) => patch({ style: { ...drawing.style, width: Number(v) } }),
              LINE_WIDTHS.map((w) => <option key={w} value={w}>{w}px</option>), 'Line width'))}
            {row('Style', select(drawing.style?.dash,
              (v) => patch({ style: { ...drawing.style, dash: v } }),
              LINE_DASHES.map((d) => <option key={d} value={d}>{d}</option>), 'Line style'))}
            {row('Visible', toggle(drawing.visible !== false,
              () => patch({ visible: drawing.visible === false }), drawing.visible === false ? 'Hidden' : 'Shown'))}
            {row('Locked', toggle(drawing.locked === true,
              () => patch({ locked: !drawing.locked }), drawing.locked ? 'Locked' : 'Unlocked'))}
          </>
        ))}
      </div>
    </Modal>
  );
}
