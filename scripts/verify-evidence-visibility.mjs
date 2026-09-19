// Evidence visibility — regression suite.
//
// The control is DISPLAY STATE ONLY, so the suite's job is mostly to prove what it does NOT do:
// it must not alter placement, grouping, the density cap, the reaction, or cause a refetch, and it
// must not recreate the marker plugin. The lifecycle half is modelled against the same fake
// Lightweight Charts the timeline suite uses, so "one live plugin" stays provable without a browser.
//
// Run: node scripts/verify-evidence-visibility.mjs

import {
  EVIDENCE_FAMILIES, FAMILY_IDS, defaultVisibility, isVisible, filterEvidence,
  visibleFamilyCount, allFamiliesOn, toggleFamily, toggleAll, loadVisibility, saveVisibility,
} from '../src/lib/chart/evidence-visibility.mjs';
import { buildEvidenceMarkers, snapToBar } from '../src/lib/chart/evidence-markers.mjs';
import { makeEvidence, FAMILY, DIRECTION } from '../src/lib/evidence/model.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const sec = (s) => console.log(`\n=== ${s} ===`);

const NOW = Date.parse('2026-09-19T15:00:00Z');
const DAILY = [
  '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11',
  '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18',
].map((d) => ({ time: d, open: 10, high: 11, low: 9, close: 10.5, volume: 1000 }));

const ev = (family, over = {}) => {
  const r = makeEvidence({
    ticker: 'TEST', family, type: `${family}_x`, source: 's', sourceId: `${family}-1`,
    publicTime: '2026-09-15', materiality: 0.7, quality: 0.9, ...over,
  }, { now: NOW });
  if (!r.ok) throw new Error(`fixture rejected: ${r.reason}`);
  return r.evidence;
};
const ALL = [
  ev(FAMILY.CATALYST), ev(FAMILY.INSIDER, { direction: DIRECTION.POSITIVE }),
  ev(FAMILY.INSTITUTION), ev(FAMILY.CONGRESS),
];

// ── 1. the registry ──────────────────────────────────────────────────────────
sec('REGISTRY');

check('the four specified families are offered', FAMILY_IDS.length === 4);
check('SEC 8-K is offered', FAMILY_IDS.includes('catalyst'));
check('Form 4 is offered', FAMILY_IDS.includes('insider'));
check('13F is offered', FAMILY_IDS.includes('institution'));
check('Congress is offered', FAMILY_IDS.includes('congress'));
check('every family has a trader-facing label',
  EVIDENCE_FAMILIES.every((f) => typeof f.label === 'string' && f.label.length > 3));
check('the registry is frozen so a consumer cannot mutate it',
  Object.isFrozen(EVIDENCE_FAMILIES) && EVIDENCE_FAMILIES.every((f) => Object.isFrozen(f)));
check('defaults are everything on', allFamiliesOn(defaultVisibility()));

// ── 2. filtering ─────────────────────────────────────────────────────────────
sec('FILTERING');

check('the default shows every family', filterEvidence(ALL, defaultVisibility()).length === 4);
check('the default returns the SAME array (no churn)',
  filterEvidence(ALL, defaultVisibility()) === ALL);
{
  const v = toggleFamily(defaultVisibility(), 'congress');
  const out = filterEvidence(ALL, v);
  check('hiding one family removes only it', out.length === 3);
  check('the hidden family is gone', !out.some((e) => e.family === 'congress'));
  check('the others are untouched', out.some((e) => e.family === 'catalyst')
    && out.some((e) => e.family === 'insider') && out.some((e) => e.family === 'institution'));
}
{
  let v = defaultVisibility();
  for (const id of ['catalyst', 'insider', 'institution']) v = toggleFamily(v, id);
  check('hiding three leaves one', filterEvidence(ALL, v).length === 1);
  check('the survivor is the untoggled family', filterEvidence(ALL, v)[0].family === 'congress');
}
{
  const off = toggleAll(defaultVisibility());
  check('the master switch hides everything', filterEvidence(ALL, off).length === 0);
  check('the master switch reports zero visible families', visibleFamilyCount(off) === 0);
}
// A family this build does not know must DRAW, not vanish — a newly shipped family would otherwise
// be invisible with no menu row to find it by.
check('an unregistered family is visible by default',
  isVisible(defaultVisibility(), { family: 'earnings' }) === true);
check('an unregistered family survives the filter',
  filterEvidence([...ALL, { family: 'earnings', evidenceId: 'e1' }], defaultVisibility()).length === 5);
check('the master switch still hides unregistered families',
  filterEvidence([{ family: 'earnings' }], toggleAll(defaultVisibility())).length === 0);
check('evidence with no family at all is visible', isVisible(defaultVisibility(), {}) === true);
check('null evidence list does not throw', filterEvidence(null, defaultVisibility()).length === 0);
check('null visibility shows everything', filterEvidence(ALL, null).length === 4);

// ── 3. toggle semantics ──────────────────────────────────────────────────────
sec('TOGGLE SEMANTICS');

{
  const v = toggleFamily(defaultVisibility(), 'insider');
  check('toggling off sets the family false', v.families.insider === false);
  check('toggling twice restores it', toggleFamily(v, 'insider').families.insider === true);
  check('toggling one family leaves the others alone',
    v.families.catalyst === true && v.families.congress === true);
}
{
  // Turning a family on while the master is off must also turn the master on, or the click looks
  // broken.
  const off = toggleAll(defaultVisibility());
  const back = toggleFamily(off, 'insider');
  check('enabling a family re-enables the master', back.enabled === true);
  check('and that family is visible', isVisible(back, { family: 'insider' }));
  // "Show me this one" — not "show everything again".
  check('enabling one family from all-off shows only that family',
    filterEvidence(ALL, back).length === 1 && filterEvidence(ALL, back)[0].family === 'insider');
  check('the other families stay hidden',
    !isVisible(back, { family: 'congress' }) && !isVisible(back, { family: 'catalyst' }));
  // And the row the menu draws must agree with what the filter does, at every step.
  check('the menu row state matches the filter for every family',
    FAMILY_IDS.every((f) => {
      const shown = !!back.enabled && back.families?.[f] !== false;
      return shown === isVisible(back, { family: f });
    }));
}
{
  // "All evidence" from a partially-on state turns everything ON rather than off — a master that
  // switched off would destroy the selection on a mis-click.
  let v = toggleFamily(defaultVisibility(), 'congress');
  v = toggleAll(v);
  check('All evidence restores every family from a partial state', allFamiliesOn(v));
  const allOff = toggleAll(v);
  check('All evidence from fully-on turns the master off', allOff.enabled === false);
  const backOn = toggleAll(allOff);
  check('All evidence from off turns it back on', backOn.enabled === true);
}
check('toggles are pure — the input is not mutated', (() => {
  const v = defaultVisibility();
  const before = JSON.stringify(v);
  toggleFamily(v, 'insider'); toggleAll(v);
  return JSON.stringify(v) === before;
})());
check('visibleFamilyCount counts what is on',
  visibleFamilyCount(toggleFamily(defaultVisibility(), 'insider')) === 3);

// ── 4. persistence ───────────────────────────────────────────────────────────
sec('PERSISTENCE');

{
  // A minimal localStorage stand-in, so the defensive read path is exercised without a browser.
  const store = new Map();
  globalThis.window = { localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
  } };

  const v = toggleFamily(defaultVisibility(), 'congress');
  saveVisibility(v);
  check('a saved preference round-trips', loadVisibility().families.congress === false);
  check('untouched families come back on', loadVisibility().families.insider === true);
  saveVisibility(toggleAll(defaultVisibility()));
  check('the master switch round-trips', loadVisibility().enabled === false);

  store.set('cp_chart_evidence', '{ not json');
  check('corrupt storage falls back to the default', allFamiliesOn(loadVisibility()));
  store.set('cp_chart_evidence', JSON.stringify({ enabled: 'yes', families: { insider: 'no' } }));
  check('wrong-typed values are ignored, not coerced', allFamiliesOn(loadVisibility()));
  // A falsy non-boolean must be IGNORED, not read as "off". Coercing it would let a stray 0 in
  // storage silently disable every marker with no way to tell why.
  store.set('cp_chart_evidence', JSON.stringify({ enabled: 0, families: { insider: 0 } }));
  check('a falsy non-boolean master is ignored, not coerced to off',
    loadVisibility().enabled === true, JSON.stringify(loadVisibility()));
  check('a falsy non-boolean family is ignored, not coerced to off',
    loadVisibility().families.insider === true);
  store.set('cp_chart_evidence', JSON.stringify({ enabled: true, families: { ghost: false, insider: false } }));
  const loaded = loadVisibility();
  check('an unknown stored family is dropped', loaded.families.ghost === undefined);
  check('a known stored family is honoured', loaded.families.insider === false);
  store.set('cp_chart_evidence', JSON.stringify({ enabled: true, families: null }));
  check('a null families block falls back to the default', allFamiliesOn(loadVisibility()));

  // A storage that throws (private mode, quota) must not break anything.
  globalThis.window = { localStorage: {
    getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); },
  } };
  check('a throwing read falls back to the default', allFamiliesOn(loadVisibility()));
  check('a throwing write does not propagate', (() => {
    try { saveVisibility(defaultVisibility()); return true; } catch { return false; }
  })());
  delete globalThis.window;
  check('with no window at all the default is returned', allFamiliesOn(loadVisibility()));
}

// ── 5. the timeline guarantees are untouched ─────────────────────────────────
sec('TIMELINE GUARANTEES PRESERVED');

{
  const visible = filterEvidence(ALL, toggleFamily(defaultVisibility(), 'congress'));
  const filtered = buildEvidenceMarkers(visible, DAILY, { theme: 'light' });
  const unfiltered = buildEvidenceMarkers(ALL, DAILY, { theme: 'light' });
  check('hiding a family removes exactly one marker',
    unfiltered.markers.length - filtered.markers.length === 1);
  // PLACEMENT IS UNCHANGED. Every surviving marker sits on the same bar it did before.
  const before = new Map(unfiltered.markers.map((m) => [m.id, m.time]));
  check('placement of the remaining markers is identical',
    filtered.markers.every((m) => before.get(m.id) === m.time));
  check('markers still use publicTime',
    filtered.markers.every((m) => m.time === snapToBar('2026-09-15', DAILY)));
  check('the detail lookup only contains visible evidence',
    ![...filtered.byKey.values()].flat().some((e) => e.family === 'congress'));
}
{
  // Same-bar same-family grouping is unaffected by which OTHER families are hidden.
  const many = [
    ev(FAMILY.INSIDER, { sourceId: 'a', direction: DIRECTION.POSITIVE }),
    ev(FAMILY.INSIDER, { sourceId: 'b', direction: DIRECTION.POSITIVE }),
    ev(FAMILY.CONGRESS, { sourceId: 'c' }),
  ];
  const all = buildEvidenceMarkers(many, DAILY, {});
  const hid = buildEvidenceMarkers(filterEvidence(many, toggleFamily(defaultVisibility(), 'congress')), DAILY, {});
  check('grouping still collapses same-bar same-family', hid.markers.length === 1);
  check('the group still carries its count', hid.markers[0].text === '2');
  check('hiding another family did not change the group', all.markers.find((m) => m.id === hid.markers[0].id).text === '2');
}
{
  // The reaction rides on the evidence object and is neither computed nor stripped here.
  const withReaction = ev(FAMILY.INSIDER, { direction: DIRECTION.POSITIVE });
  withReaction.reaction = { hasAny: true, anchorDate: '2026-09-12', horizons: { 1: { return: 2.5 } } };
  const out = filterEvidence([withReaction], defaultVisibility());
  check('the reaction survives filtering untouched', out[0].reaction.horizons[1].return === 2.5);
  // Identity must hold on the path where filtering ACTUALLY runs, not just the unchanged-array
  // shortcut — a clone would break the marker map's ability to match evidence by reference.
  const filteredPath = filterEvidence([withReaction, ev(FAMILY.CONGRESS, { sourceId: 'z' })],
    toggleFamily(defaultVisibility(), 'congress'));
  check('filtering does not clone or rewrite the evidence object',
    filteredPath.length === 1 && filteredPath[0] === withReaction);
  check('the reaction is intact on the filtered path',
    filteredPath[0].reaction.horizons[1].return === 2.5);
}

// ── 6. lifecycle: one plugin, no recreation, no refetch ──────────────────────
sec('LIFECYCLE');

function makeComponent() {
  let seq = 0;
  const live = new Set();
  const plugins = [];
  let attachedToDead = 0, fetches = 0;
  const lwc = {
    createSeriesMarkers(series, markers) {
      if (!live.has(series)) { attachedToDead++; throw new Error('dead'); }
      const api = { series, markers: [...markers] };
      api.setMarkers = (m) => {
        if (!live.has(api.series)) { attachedToDead++; throw new Error('dead'); }
        api.markers = [...m];
      };
      plugins.push(api);
      return api;
    },
  };
  const chart = {
    addSeries() { const s = { id: ++seq }; live.add(s); return s; },
    removeSeries(s) { live.delete(s); },
  };
  const refs = { price: null, api: null, apiSeries: null, evidence: ALL, vis: defaultVisibility() };

  // The production rule, reduced: filter, then build, then attach-or-update.
  function apply() {
    if (!refs.price) return;
    const built = buildEvidenceMarkers(filterEvidence(refs.evidence, refs.vis), DAILY, {});
    try {
      if (refs.api && refs.apiSeries === refs.price) { refs.api.setMarkers(built.markers); return; }
      refs.api = lwc.createSeriesMarkers(refs.price, built.markers);
      refs.apiSeries = refs.price;
    } catch { refs.api = null; refs.apiSeries = null; }
  }
  function draw() {
    if (refs.price) { chart.removeSeries(refs.price); refs.price = null; refs.api = null; refs.apiSeries = null; }
    refs.price = chart.addSeries();
    apply();
  }
  // A visibility change calls apply() ONLY. If it ever called this, that would be a refetch.
  function setVis(v) { refs.vis = v; apply(); }
  function fetchEvidence() { fetches++; }
  return {
    draw, setVis, apply, refs,
    markerCount: () => (refs.api ? refs.api.markers.length : 0),
    livePlugins: () => plugins.filter((p) => live.has(p.series)).length,
    totalPlugins: () => plugins.length,
    deadAttaches: () => attachedToDead,
    fetches: () => fetches,
  };
}

{
  const c = makeComponent();
  c.draw();
  check('all four families draw initially', c.markerCount() === 4);
  const pluginBefore = c.refs.api;
  const createdBefore = c.totalPlugins();

  c.setVis(toggleFamily(c.refs.vis, 'congress'));
  check('hiding a family updates the markers', c.markerCount() === 3);
  check('the SAME plugin instance is reused', c.refs.api === pluginBefore);
  check('no new plugin was created', c.totalPlugins() === createdBefore);
  check('still exactly one live plugin', c.livePlugins() === 1);
  check('nothing was fetched', c.fetches() === 0);

  c.setVis(toggleAll(c.refs.vis));
  check('All evidence restores every marker', c.markerCount() === 4);
  c.setVis(toggleAll(c.refs.vis));
  check('the master switch clears the markers', c.markerCount() === 0);
  check('clearing does not destroy the plugin', c.refs.api === pluginBefore);
  check('still no fetch after five toggles', c.fetches() === 0);

  // Toggling many times must not accumulate plugins.
  for (let i = 0; i < 20; i++) c.setVis(toggleFamily(c.refs.vis, FAMILY_IDS[i % 4]));
  check('twenty toggles create no extra plugins', c.totalPlugins() === createdBefore);
  check('twenty toggles never touch a dead series', c.deadAttaches() === 0);
}
{
  // Visibility must SURVIVE a redraw — the series is rebuilt, the preference is not.
  const c = makeComponent();
  c.draw();
  c.setVis(toggleFamily(c.refs.vis, 'insider'));
  check('a family is hidden before the redraw', c.markerCount() === 3);
  c.draw();
  check('the hidden family stays hidden after a redraw', c.markerCount() === 3);
  check('a redraw still leaves one live plugin', c.livePlugins() === 1);
  check('a redraw never attaches to a dead series', c.deadAttaches() === 0);
  // Ticker switch: the host clears evidence; the preference must persist.
  c.refs.evidence = []; c.apply();
  check('clearing evidence empties the chart', c.markerCount() === 0);
  c.refs.evidence = ALL; c.apply();
  check('the preference still applies to the new ticker evidence', c.markerCount() === 3);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
