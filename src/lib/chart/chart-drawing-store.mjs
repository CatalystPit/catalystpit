// Drawings, saved PER SYMBOL.
//
// A trend line on NVDA means nothing on AAPL, so the store is keyed by symbol and the chart loads
// and saves as the symbol changes. Same storage as the rest of the chart's state: localStorage under
// a `cp_` key, per device, matching the Terminal's layout convention.
//
// BOUNDED ON PURPOSE. localStorage is a few megabytes for the whole origin, shared with the Terminal
// layout and everything else, and a chart is an easy place to accumulate hundreds of forgotten
// shapes. So there is a cap per symbol and a cap on how many symbols are remembered, with the least
// recently touched symbol evicted first.

import { coerceDrawing } from './chart-drawings.mjs';

const KEY = 'cp_chart_drawings';
const VERSION = 1;

export const MAX_PER_SYMBOL = 120;
export const MAX_SYMBOLS = 40;

const isBrowser = () => typeof window !== 'undefined' && !!window.localStorage;
const norm = (s) => String(s || '').toUpperCase().trim();

function readAll() {
  if (!isBrowser()) return { v: VERSION, symbols: {}, order: [] };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(KEY) || 'null');
    if (!parsed || parsed.v !== VERSION || typeof parsed.symbols !== 'object' || parsed.symbols === null) {
      return { v: VERSION, symbols: {}, order: [] };
    }
    return { v: VERSION, symbols: parsed.symbols, order: Array.isArray(parsed.order) ? parsed.order : [] };
  } catch {
    return { v: VERSION, symbols: {}, order: [] };
  }
}

function writeAll(state) {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Most likely the quota. Drop the oldest half and try once more rather than silently losing the
    // drawing the user just made.
    try {
      const keep = state.order.slice(-Math.ceil(state.order.length / 2));
      const symbols = {};
      for (const s of keep) if (state.symbols[s]) symbols[s] = state.symbols[s];
      window.localStorage.setItem(KEY, JSON.stringify({ v: VERSION, symbols, order: keep }));
    } catch { /* give up quietly; a lost drawing must not break the chart */ }
  }
}

/** Every drawing saved for one symbol, validated against the live tool registry. */
export function loadDrawings(symbol) {
  const sym = norm(symbol);
  if (!sym) return [];
  const all = readAll();
  const raw = Array.isArray(all.symbols[sym]) ? all.symbols[sym] : [];
  const out = [];
  for (const d of raw) {
    const c = coerceDrawing(d, out);
    if (c) out.push(c);
  }
  return out.slice(0, MAX_PER_SYMBOL);
}

/** Replace the saved set for one symbol. An empty list removes the symbol rather than storing [].  */
export function saveDrawings(symbol, drawings) {
  const sym = norm(symbol);
  if (!sym || !isBrowser()) return;
  const all = readAll();
  const clean = [];
  for (const d of Array.isArray(drawings) ? drawings : []) {
    const c = coerceDrawing(d, clean);
    if (c) clean.push(c);
    if (clean.length >= MAX_PER_SYMBOL) break;
  }
  all.order = all.order.filter((s) => s !== sym);
  if (clean.length) {
    all.symbols[sym] = clean;
    all.order.push(sym);
  } else {
    delete all.symbols[sym];
  }
  // Evict the least recently touched symbols once the ledger is full.
  while (all.order.length > MAX_SYMBOLS) {
    const drop = all.order.shift();
    delete all.symbols[drop];
  }
  writeAll(all);
}

/** Forget one symbol's drawings — what "clear all" persists. */
export function clearDrawings(symbol) { saveDrawings(symbol, []); }

export const DRAWINGS_STORAGE_KEY = KEY;
export const DRAWINGS_STORAGE_VERSION = VERSION;
