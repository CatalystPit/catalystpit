'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  INDICATORS, INDICATOR_CATEGORIES, searchIndicators, indicatorMeta,
  defaultParams, defaultParamsForNew, sanitizeParams, indicatorLabel,
  isMultiInstance, MAX_INSTANCES_PER_INDICATOR, nextInstanceKey,
} from '../../lib/chart/chart-indicators.mjs';
import { palette, indicatorColor, indicatorColors } from '../../lib/chart/chart-theme.mjs';
import { Modal, ToolButton } from './ChartUI';

// The indicator browser.
//
// Two panes: a searchable catalogue of what can be added, and the list of what IS added with its
// settings. Both render entirely from the registry and its metadata, so adding fifty more indicators
// is fifty registry entries — this file does not change, and neither does the search.
//
// A click in the catalogue adds immediately rather than opening a configuration step first: the
// defaults are the conventional ones, and the settings are one row away in the added list.

export default function IndicatorBrowser({ open, onClose, theme, intraday, active, onChange }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [expanded, setExpanded] = useState(null);
  const inputRef = useRef(null);
  const p = palette(theme);
  const swatches = indicatorColors(theme);

  // Focus the search box on open: the first thing a keyboard user wants is to type a name.
  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 0); }, [open]);
  useEffect(() => { if (!open) { setQuery(''); setExpanded(null); } }, [open]);

  const results = useMemo(
    () => searchIndicators(query, { intraday, category }),
    [query, intraday, category],
  );

  const countOf = (id) => active.filter((a) => a.id === id).length;
  const nextColorIndex = () => {
    const used = new Set(active.map((i) => i.color).filter((c) => c != null));
    for (let i = 0; i < swatches.length; i += 1) if (!used.has(i)) return i;
    return active.length % swatches.length;
  };

  const add = (id) => {
    const def = INDICATORS[id];
    if (!def) return;
    const n = countOf(id);
    const cap = isMultiInstance(id) ? MAX_INSTANCES_PER_INDICATOR : 1;
    if (n >= cap) return;
    const inst = {
      key: nextInstanceKey(id, active),
      id,
      params: defaultParamsForNew(id, active),
      color: nextColorIndex(),
      visible: true,
    };
    onChange([...active, inst]);
    if (def.params.length) setExpanded(inst.key);
  };
  const remove = (key) => onChange(active.filter((a) => a.key !== key));
  const patch = (key, next) => onChange(active.map((a) => (a.key === key ? { ...a, ...next } : a)));
  const setParam = (inst, k, v) => patch(inst.key, { params: sanitizeParams(inst.id, { ...inst.params, [k]: v }) });

  const catalogueRow = (def) => {
    const n = countOf(def.id);
    const cap = isMultiInstance(def.id) ? MAX_INSTANCES_PER_INDICATOR : 1;
    const full = n >= cap;
    return (
      <button key={def.id} type="button" onClick={() => add(def.id)} disabled={full}
        title={full ? `Maximum ${cap}` : `Add ${def.label}`}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
          background: 'transparent', border: 'none', borderRadius: 4,
          cursor: full ? 'not-allowed' : 'pointer', opacity: full ? 0.45 : 1, padding: '7px 9px',
          fontFamily: "'DM Sans',sans-serif", fontSize: 12, color: p.text,
        }}>
        <span style={{ width: 9, height: 9, borderRadius: 2, flexShrink: 0,
          background: indicatorColor(theme, def.colors ? Object.values(def.colors)[0] : 0) }} />
        <span style={{ flex: 1, color: p.textStrong }}>{def.label}</span>
        {isMultiInstance(def.id) && (
          <span style={{ fontSize: 9, letterSpacing: '0.4px', opacity: 0.75 }}>MULTI</span>
        )}
        {def.pane === 'separate' && (
          <span style={{ fontSize: 9, letterSpacing: '0.4px', opacity: 0.75 }}>PANE</span>
        )}
        {n > 0 && <span style={{ fontSize: 10, color: p.up, fontWeight: 600 }}>{n} added</span>}
      </button>
    );
  };

  const settingsFor = (inst) => (
    <div style={{ padding: '4px 10px 10px 28px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      {INDICATORS[inst.id].params.map((prm) => (
        <label key={prm.key} style={{ display: 'flex', alignItems: 'center', gap: 6,
          fontFamily: "'DM Sans',sans-serif", fontSize: 11, color: p.text }}>
          <span style={{ flex: 1 }}>{prm.label}</span>
          {/* A free number input, not a preset list: any period the user types, within the declared
              range. This is what keeps custom SMA/EMA lengths working. */}
          <input type="number" min={prm.min} max={prm.max} step={prm.step || 1}
            aria-label={`${INDICATORS[inst.id].label} ${prm.label}`}
            value={inst.params?.[prm.key] ?? prm.default}
            onChange={(e) => setParam(inst, prm.key, e.target.value)}
            style={{ width: 70, background: 'transparent', color: p.textStrong,
              border: `1px solid ${p.border}`, borderRadius: 3, padding: '2px 5px',
              fontFamily: "'DM Sans',sans-serif", fontSize: 11 }} />
        </label>
      ))}
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
      <button type="button" onClick={() => patch(inst.key, { params: defaultParams(inst.id) })}
        style={{ alignSelf: 'flex-start', background: 'transparent', border: `1px solid ${p.border}`,
          borderRadius: 3, cursor: 'pointer', padding: '1px 7px',
          fontFamily: "'DM Sans',sans-serif", fontSize: 10, color: p.text }}>Reset settings</button>
    </div>
  );

  return (
    <Modal theme={theme} open={open} onClose={onClose} title="Indicators" width={520}>
      <div style={{ padding: 10 }}>
        <input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Search indicators…" aria-label="Search indicators"
          style={{ width: '100%', boxSizing: 'border-box', background: 'transparent', color: p.textStrong,
            border: `1px solid ${p.border}`, borderRadius: 5, padding: '7px 9px',
            fontFamily: "'DM Sans',sans-serif", fontSize: 12, marginBottom: 8 }} />

        <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginBottom: 8 }}>
          {INDICATOR_CATEGORIES.map((c) => (
            <button key={c.id} type="button" onClick={() => setCategory(c.id)}
              style={{ background: category === c.id ? p.grid : 'transparent',
                border: `1px solid ${category === c.id ? p.up : p.border}`, borderRadius: 999,
                cursor: 'pointer', padding: '2px 10px', fontFamily: "'DM Sans',sans-serif",
                fontSize: 11, color: category === c.id ? p.textStrong : p.text }}>{c.label}</button>
          ))}
        </div>

        <div style={{ border: `1px solid ${p.border}`, borderRadius: 6, overflow: 'hidden', marginBottom: 12 }}>
          {results.length === 0 && (
            <div style={{ padding: '14px 10px', fontFamily: "'DM Sans',sans-serif", fontSize: 12,
              color: p.text, opacity: 0.8 }}>
              No indicator matches “{query}”.
              {!intraday && ' VWAP is intraday only — switch to 1D or 5D.'}
            </div>
          )}
          {results.map(catalogueRow)}
        </div>

        <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 11, color: p.text,
          textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 4 }}>
          On this chart ({active.length})
        </div>

        {active.length === 0 && (
          <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 12, color: p.text, opacity: 0.75,
            padding: '6px 2px' }}>Nothing added yet — pick one above.</div>
        )}

        {active.map((inst) => {
          const def = INDICATORS[inst.id];
          if (!def) return null;
          const hiddenByTimeframe = def.intradayOnly && !intraday;
          return (
            <div key={inst.key} style={{ borderTop: `1px solid ${p.border}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 2px' }}>
                <ToolButton theme={theme} onClick={() => patch(inst.key, { visible: inst.visible === false })}
                  title={inst.visible === false ? 'Show' : 'Hide'}>
                  {inst.visible === false ? '◦' : '👁'}
                </ToolButton>
                <span style={{ width: 9, height: 9, borderRadius: 2, flexShrink: 0,
                  background: indicatorColor(theme, inst.color ?? (def.colors ? Object.values(def.colors)[0] : 0)),
                  opacity: inst.visible === false ? 0.4 : 1 }} />
                <span style={{ flex: 1, fontFamily: "'DM Sans',sans-serif", fontSize: 12,
                  color: inst.visible === false ? p.text : p.textStrong }}>
                  {indicatorLabel(inst.id, inst.params)}
                  {hiddenByTimeframe && (
                    <span style={{ marginLeft: 6, fontSize: 10, opacity: 0.75 }}>needs intraday</span>
                  )}
                </span>
                {def.params.length > 0 && (
                  <ToolButton theme={theme} active={expanded === inst.key} title="Settings"
                    onClick={() => setExpanded(expanded === inst.key ? null : inst.key)}>⚙</ToolButton>
                )}
                <ToolButton theme={theme} onClick={() => remove(inst.key)} title="Remove" danger>✕</ToolButton>
              </div>
              {expanded === inst.key && settingsFor(inst)}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
