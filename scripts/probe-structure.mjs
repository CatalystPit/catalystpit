// Market Structure — real-ticker validation.
//
// Prints actual calculated price zones so they can be compared against a chart by eye. Read-only.
//
// Run: node --env-file=.env.local --import ./scripts/real-db-register.mjs scripts/probe-structure.mjs [TICKERS...]

import { tickerStructure } from '../src/lib/structure/structure-data.js';

const TICKERS = process.argv.slice(2).length ? process.argv.slice(2)
  : ['MSFT', 'AAPL', 'NVDA', 'ALK', 'AMRZ', 'AMD'];

const L = (s = '') => console.log(s);
const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);
const range = (z) => (z ? `${money(z.low)}–${money(z.high)}` : '—');
const dist = (z) => (z ? `${z.distancePct >= 0 ? '' : ''}${z.distancePct.toFixed(2)}%` : '—');

function zoneLine(label, z, { indent = '    ' } = {}) {
  if (!z) { L(`${indent}${label.padEnd(22)} —`); return; }
  L(`${indent}${label.padEnd(22)} ${range(z).padEnd(19)} ${dist(z).padStart(7)} away   [${z.timeframes.join('+')}]`
    + (z.major ? '  MAJOR' : ''));
  for (const r of z.reasons.slice(0, 4)) L(`${indent}${''.padEnd(22)}   · ${r}`);
  if (z.major) for (const c of z.majorCriteria) L(`${indent}${''.padEnd(22)}   ✦ ${c}`);
}

for (const ticker of TICKERS) {
  const t0 = Date.now();
  let s;
  try { s = await tickerStructure(ticker); }
  catch (e) { L(`\n${ticker}: ERROR ${e.message}`); continue; }
  const ms = Date.now() - t0;

  L('');
  L('█'.repeat(96));
  if (!s.available) { L(`${ticker}  UNAVAILABLE — ${s.reason}`); continue; }
  L(`${ticker}   current ${money(s.currentPrice)} (${s.priceDate})   daily ATR ${money(s.dailyAtr)}`
    + `   zone unit ${money(s.zoneUnit)}   ${s.bars} daily bars   ${ms}ms`);
  L('█'.repeat(96));

  for (const tf of ['monthly', 'weekly', 'daily']) {
    const t = s[tf];
    L('');
    if (!t.available) { L(`  ${t.label.padEnd(8)} unavailable — ${t.reason}`); continue; }
    L(`  ${t.label.padEnd(8)} trend: ${String(t.trend).toUpperCase().padEnd(12)} (${t.bars} bars, ATR ${money(t.atr)})`);
    for (const r of t.trendReasons.slice(0, 2)) L(`           · ${r}`);
    if (t.trendAsOfPivot) L(`           anchored on the pivot of ${t.trendAsOfPivot} — ${t.barsSincePivot} bars since; price ${t.priceSincePivotPct >= 0 ? '+' : ''}${t.priceSincePivotPct}% since then`);
    const mas = t.movingAverages.filter((m) => m.available)
      .map((m) => `${m.label} ${money(m.value)} ${m.slope?.direction ?? ''}`).join('   ');
    if (mas) L(`           MAs: ${mas}`);
    const missing = t.movingAverages.filter((m) => !m.available).map((m) => m.label);
    if (missing.length) L(`           unavailable: ${missing.join(', ')}`);
    if (t.maStructure?.state && t.maStructure.state !== 'unavailable') {
      L(`           MA structure: ${t.maStructure.state}`);
    }
    zoneLine('nearest support', t.support.nearest);
    zoneLine('nearest resistance', t.resistance.nearest);
    if (t.currentBar) L(`           (current ${tf} bar forming: ${t.currentBar.date}, ${t.currentBar.sessions ?? 1} sessions — excluded from structure)`);
  }

  const m = s.multiTimeframe;
  L('');
  L(`  MULTI-TIMEFRAME   alignment: ${m.alignment.state.toUpperCase()}`);
  for (const r of m.alignment.reasons) L(`           · ${r}`);
  if (m.conflicts?.length) for (const c of m.conflicts) L(`           ⚠ ${c}`);

  L('');
  L('  ── ACTIONABLE ZONES (all timeframes clustered together) ──');
  zoneLine('NEAREST SUPPORT', m.support.nearest);
  if (!m.support.majorIsNearest) zoneLine('MAJOR SUPPORT', m.support.major);
  else L(`    ${'MAJOR SUPPORT'.padEnd(22)} (same zone as nearest)`);
  zoneLine('NEAREST RESISTANCE', m.resistance.nearest);
  if (!m.resistance.majorIsNearest) zoneLine('MAJOR RESISTANCE', m.resistance.major);
  else L(`    ${'MAJOR RESISTANCE'.padEnd(22)} (same zone as nearest)`);

  if (m.support.relationship) L(`\n    price vs support:    ${m.support.relationship.state.toUpperCase()} — ${m.support.relationship.detail}`);
  if (m.resistance.relationship) L(`    price vs resistance: ${m.resistance.relationship.state.toUpperCase()} — ${m.resistance.relationship.detail}`);

  const conf = m.support.confluence.concat(m.resistance.confluence);
  if (conf.length) {
    L('\n    multi-timeframe confluence zones:');
    for (const z of conf.slice(0, 4)) {
      L(`      ${z.side.padEnd(10)} ${range(z).padEnd(19)} ${dist(z).padStart(7)} away  [${z.timeframes.join('+')}]  ${z.touches} touches`);
    }
  }
}

L('');
