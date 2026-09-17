'use client';
import { TOOLS, tool } from '../../lib/chart/chart-drawings.mjs';
import { palette, indicatorColor } from '../../lib/chart/chart-theme.mjs';
import { Modal, ToolButton, VectorIcon } from './ChartUI';

// THE OBJECT TREE — every drawing on this symbol, in one list.
//
// WHY IT EXISTS: drawings were reachable only by finding them on the chart and clicking them, which
// fails exactly when it matters. A level drawn on a part of the chart you have since scrolled away
// from, or one hidden underneath three others, or one drawn in a colour that disappears against the
// candles, could not be selected, unhidden or deleted at all without hunting for it. A list solves
// all three at once.
//
// SELECTING A ROW SELECTS THE DRAWING on the chart, so the contextual style panel and the delete key
// work on it exactly as if it had been clicked.
//
// It shows only what a drawing actually knows: its tool, its anchors and its state. There is no
// naming or grouping, because the model has neither and inventing one here would be a second source
// of truth that the persistence layer could not round-trip.

/** A drawing's anchors, short enough to read at a glance and precise enough to tell two apart. */
function summarize(d) {
  const pts = d.points || [];
  if (!pts.length) return '';
  const price = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—');
  // A horizontal line is a price; a vertical line is a time; everything else is a span of prices.
  if (d.type === 'horizontal') return price(pts[0].price);
  if (d.type === 'vertical') return typeof pts[0].time === 'string' ? pts[0].time : '';
  if (pts.length >= 2) return `${price(pts[0].price)} → ${price(pts[pts.length - 1].price)}`;
  return price(pts[0].price);
}

export default function DrawingManager({
  open, onClose, theme, symbol, drawings, selectedId,
  onSelect, onChange, onDuplicate, onClearAll,
}) {
  const p = palette(theme);

  const patch = (id, next) => onChange(drawings.map((d) => (d.id === id ? { ...d, ...next } : d)));
  const remove = (id) => onChange(drawings.filter((d) => d.id !== id));

  // Newest first: the thing you just drew is the thing you are most likely looking for.
  const rows = [...drawings].reverse();

  return (
    <Modal theme={theme} open={open} onClose={onClose} width={440}
      title={`Drawings on ${symbol}${drawings.length ? ` (${drawings.length})` : ''}`}>
      <div style={{ padding: 10 }}>
        {rows.length === 0 && (
          <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 12, color: p.text, opacity: 0.8,
            padding: '10px 2px' }}>
            Nothing drawn on {symbol} yet — pick a tool from the rail on the left.
          </div>
        )}

        {rows.map((d) => {
          const def = tool(d.type) || {};
          const on = d.visible !== false;
          const isSel = d.id === selectedId;
          return (
            <div key={d.id}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '6px 7px', borderRadius: 5,
                background: isSel ? p.menuActive : 'transparent',
                borderLeft: `2.5px solid ${isSel ? p.up : 'transparent'}`,
              }}>
              {/* The row itself selects — the same selection a click on the chart makes. */}
              <button type="button" onClick={() => onSelect(d.id)}
                title={`Select this ${def.label || d.type}`}
                style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0,
                  background: 'transparent', border: 'none', cursor: 'pointer', padding: 0,
                  textAlign: 'left', fontFamily: "'DM Sans',sans-serif", opacity: on ? 1 : 0.5 }}>
                <span style={{ display: 'flex', color: indicatorColor(theme, d.style?.color ?? 0), flexShrink: 0 }}>
                  <VectorIcon shapes={def.shapes} glyph={def.icon} />
                </span>
                <span style={{ fontSize: 12, color: isSel ? p.textStrong : p.text, whiteSpace: 'nowrap' }}>
                  {def.label || d.type}
                </span>
                <span style={{ fontSize: 11, color: p.text, opacity: 0.75, overflow: 'hidden',
                  textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summarize(d)}</span>
              </button>

              <ToolButton theme={theme} title={on ? 'Hide' : 'Show'}
                onClick={() => patch(d.id, { visible: !on })}>{on ? '👁' : '◦'}</ToolButton>
              {/* LOCK is enforced in moveDrawing, not just here, so there is no path around it. */}
              <ToolButton theme={theme} active={!!d.locked} title={d.locked ? 'Unlock' : 'Lock in place'}
                onClick={() => patch(d.id, { locked: !d.locked })}>{d.locked ? '🔒' : '🔓'}</ToolButton>
              {/* Duplication is cloneDrawing's job, in the drawing model — the manager asks for it
                  rather than assembling a copy itself, or the id rules would live in two places. */}
              <ToolButton theme={theme} title="Duplicate"
                onClick={() => onDuplicate?.(d.id)}>⧉</ToolButton>
              <ToolButton theme={theme} title="Delete" danger onClick={() => remove(d.id)}>✕</ToolButton>
            </div>
          );
        })}

        {rows.length > 0 && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10,
            borderTop: `1px solid ${p.border}`, paddingTop: 9 }}>
            <button type="button" onClick={onClearAll}
              style={{ background: 'transparent', border: `1px solid ${p.border}`, borderRadius: 4,
                cursor: 'pointer', padding: '3px 10px', color: p.down,
                fontFamily: "'DM Sans',sans-serif", fontSize: 11 }}>
              Delete all {drawings.length} on {symbol}
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
