'use client';
import { useEffect, useRef, useState } from 'react';
import {
  INDICATORS, availableIndicators, defaultParams, defaultParamsForNew, sanitizeParams,
  indicatorLabel, isMultiInstance, MAX_INSTANCES_PER_INDICATOR, nextInstanceKey,
} from '../../lib/chart/chart-indicators.mjs';
import { palette, indicatorColor, indicatorColors } from '../../lib/chart/chart-theme.mjs';

// Add, remove and configure indicators.
//
// Renders entirely from the registry — there is no per-indicator markup here, so a new entry in
// INDICATORS appears with its settings fields and needs no change to this file. Params are declared
// as data (type, min, max) for exactly that reason.
//
// TWO SHAPES OF ROW, because there are two kinds of indicator. A single-instance one (RSI, MACD,
// Volume) is a checkbox. A multi-instance one (SMA, EMA) is a list of instances with an Add button,
// each instance owning its own length, colour and visibility.

export default function IndicatorMenu({ theme, intraday, active, onChange }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);      // instance key whose settings are expanded
  const rootRef = useRef(null);
  const p = palette(theme);
  const swatches = indicatorColors(theme);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) { setOpen(false); setEditing(null); } };
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); setEditing(null); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const list = availableIndicators({ intraday });
  const instancesOf = (id) => active.filter((a) => a.id === id);

  const addInstance = (id) => {
    const inst = {
      key: nextInstanceKey(id, active),
      id,
      params: defaultParamsForNew(id, active),
      // A new instance takes the next unused palette slot so two EMAs are never the same colour.
      color: nextColorIndex(active),
      visible: true,
    };
    onChange([...active, inst]);
    if (INDICATORS[id].params.length) setEditing(inst.key);
  };
  const nextColorIndex = (items) => {
    const used = new Set(items.map((i) => i.color).filter((c) => c != null));
    for (let i = 0; i < swatches.length; i += 1) if (!used.has(i)) return i;
    return items.length % swatches.length;
  };
  const removeInstance = (key) => onChange(active.filter((a) => a.key !== key));
  const patch = (key, next) => onChange(active.map((a) => (a.key === key ? { ...a, ...next } : a)));
  const setParam = (inst, k, v) =>
    patch(inst.key, { params: sanitizeParams(inst.id, { ...inst.params, [k]: v }) });

  const toggleSingle = (id) => {
    const existing = instancesOf(id);
    if (existing.length) removeInstance(existing[0].key);
    else onChange([...active, { key: nextInstanceKey(id, active), id, params: defaultParams(id), color: null, visible: true }]);
  };

  const colourOf = (inst) => indicatorColor(theme, inst.color ?? (INDICATORS[inst.id]?.colors ? Object.values(INDICATORS[inst.id].colors)[0] : 0));

  const settingsRow = (inst) => (
    <div style={{ padding: '2px 8px 8px 24px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      {INDICATORS[inst.id].params.map((prm) => (
        <label key={prm.key} style={{ display: 'flex', alignItems: 'center', gap: 6,
          fontFamily: "'DM Sans',sans-serif", fontSize: 11, color: p.text }}>
          <span style={{ flex: 1 }}>{prm.label}</span>
          <input
            type="number" min={prm.min} max={prm.max} step={prm.step || 1}
            value={inst.params?.[prm.key] ?? prm.default}
            onChange={(e) => setParam(inst, prm.key, e.target.value)}
            style={{ width: 66, background: 'transparent', color: p.textStrong,
              border: `1px solid ${p.border}`, borderRadius: 3, padding: '2px 5px',
              fontFamily: "'DM Sans',sans-serif", fontSize: 11 }} />
        </label>
      ))}
      {/* Colour is chosen as a palette SLOT, not a hex value, so the choice survives a theme switch
          and stays readable on both surfaces. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ flex: 1, fontFamily: "'DM Sans',sans-serif", fontSize: 11, color: p.text }}>Colour</span>
        <div style={{ display: 'flex', gap: 3 }}>
          {swatches.map((c, i) => (
            <button key={c} type="button" title={`Colour ${i + 1}`} onClick={() => patch(inst.key, { color: i })}
              style={{ width: 14, height: 14, borderRadius: 3, cursor: 'pointer', background: c,
                border: (inst.color ?? -1) === i ? `2px solid ${p.textStrong}` : `1px solid ${p.border}` }} />
          ))}
        </div>
      </div>
    </div>
  );

  return (
    <div ref={rootRef} style={{ position: 'relative', flexShrink: 0 }}>
      <button type="button" onClick={() => setOpen((v) => !v)}
        style={{ background: 'transparent', border: `1px solid ${p.border}`, borderRadius: 4, cursor: 'pointer',
          padding: '3px 9px', fontFamily: "'DM Sans',sans-serif", fontSize: 11, color: p.text, whiteSpace: 'nowrap' }}>
        Indicators{active.length ? ` (${active.length})` : ''}
      </button>

      {open && (
        <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 20, width: 268,
          background: p.tooltipBg, border: `1px solid ${p.tooltipBorder}`, borderRadius: 6,
          boxShadow: '0 8px 28px rgba(0,0,0,0.20)', padding: 6, maxHeight: 400, overflowY: 'auto' }}>

          {list.map((def) => {
            const insts = instancesOf(def.id);
            const multi = isMultiInstance(def.id);

            if (!multi) {
              const inst = insts[0];
              const on = !!inst;
              return (
                <div key={def.id} style={{ marginBottom: 2 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '5px 7px' }}>
                    <input type="checkbox" checked={on} onChange={() => toggleSingle(def.id)}
                      style={{ cursor: 'pointer', accentColor: p.up, margin: 0 }} />
                    <button type="button" onClick={() => toggleSingle(def.id)}
                      style={{ flex: 1, textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer',
                        padding: 0, fontFamily: "'DM Sans',sans-serif", fontSize: 12,
                        color: on ? p.textStrong : p.text, fontWeight: on ? 600 : 400 }}>
                      {on ? indicatorLabel(def.id, inst.params) : def.label}
                    </button>
                    {def.pane === 'separate' && (
                      <span style={{ fontSize: 8, letterSpacing: '0.5px', color: p.text, opacity: 0.7 }}>PANE</span>
                    )}
                    {on && def.params.length > 0 && (
                      <button type="button" title="Settings"
                        onClick={() => setEditing(editing === inst.key ? null : inst.key)}
                        style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: '0 2px',
                          color: p.text, fontSize: 12, lineHeight: 1 }}>⚙</button>
                    )}
                  </div>
                  {on && editing === inst.key && settingsRow(inst)}
                </div>
              );
            }

            // MULTI-INSTANCE: a header with Add, then one row per instance.
            const full = insts.length >= MAX_INSTANCES_PER_INDICATOR;
            return (
              <div key={def.id} style={{ marginBottom: 4, borderTop: `1px solid ${p.border}`, paddingTop: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 7px' }}>
                  <span style={{ flex: 1, fontFamily: "'DM Sans',sans-serif", fontSize: 12,
                    color: p.textStrong, fontWeight: 600 }}>{def.label}</span>
                  <button type="button" onClick={() => addInstance(def.id)} disabled={full}
                    title={full ? `Maximum ${MAX_INSTANCES_PER_INDICATOR}` : `Add a ${def.label}`}
                    style={{ background: 'transparent', border: `1px solid ${p.border}`, borderRadius: 3,
                      cursor: full ? 'not-allowed' : 'pointer', opacity: full ? 0.4 : 1, padding: '1px 7px',
                      fontFamily: "'DM Sans',sans-serif", fontSize: 11, color: p.text }}>+ Add</button>
                </div>

                {insts.length === 0 && (
                  <div style={{ padding: '0 7px 4px 7px', fontFamily: "'DM Sans',sans-serif",
                    fontSize: 10, color: p.text, opacity: 0.7 }}>
                    Any length — 9, 21, 50, 200, whatever you use.
                  </div>
                )}

                {insts.map((inst) => (
                  <div key={inst.key}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 7px' }}>
                      {/* Visibility, so a line can be parked without losing its settings. */}
                      <button type="button" onClick={() => patch(inst.key, { visible: !inst.visible })}
                        title={inst.visible ? 'Hide' : 'Show'}
                        style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0,
                          fontSize: 11, lineHeight: 1, color: p.text, opacity: inst.visible ? 1 : 0.45 }}>
                        {inst.visible ? '👁' : '◦'}
                      </button>
                      <span style={{ width: 9, height: 9, borderRadius: 2, flexShrink: 0,
                        background: colourOf(inst), opacity: inst.visible ? 1 : 0.4 }} />
                      <span style={{ flex: 1, fontFamily: "'DM Sans',sans-serif", fontSize: 11,
                        color: inst.visible ? p.textStrong : p.text, opacity: inst.visible ? 1 : 0.6 }}>
                        {def.label}
                      </span>
                      {/* The length is typed directly on the row — the whole point of the feature —
                          rather than hidden behind the settings toggle. */}
                      <input
                        type="number" min={1} max={1000} step={1}
                        aria-label={`${def.label} length`}
                        value={inst.params?.length ?? 20}
                        onChange={(e) => setParam(inst, 'length', e.target.value)}
                        style={{ width: 58, background: 'transparent', color: p.textStrong,
                          border: `1px solid ${p.border}`, borderRadius: 3, padding: '2px 5px',
                          fontFamily: "'DM Sans',sans-serif", fontSize: 11 }} />
                      <button type="button" title="Colour"
                        onClick={() => setEditing(editing === inst.key ? null : inst.key)}
                        style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: '0 1px',
                          color: p.text, fontSize: 11, lineHeight: 1 }}>⚙</button>
                      <button type="button" title="Remove" onClick={() => removeInstance(inst.key)}
                        style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: '0 1px',
                          color: p.text, fontSize: 13, lineHeight: 1 }}>×</button>
                    </div>
                    {editing === inst.key && settingsRow(inst)}
                  </div>
                ))}
              </div>
            );
          })}

          {/* Said plainly rather than by omission: VWAP is absent on a daily chart because a daily
              bar spans the whole session, not because the feature is missing. */}
          {!intraday && INDICATORS.vwap && (
            <div style={{ padding: '6px 7px 2px', fontFamily: "'DM Sans',sans-serif", fontSize: 10,
              color: p.text, opacity: 0.75, borderTop: `1px solid ${p.border}`, marginTop: 4 }}>
              VWAP needs intraday bars — switch to 1D or 5D.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
