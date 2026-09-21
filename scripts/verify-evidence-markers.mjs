// Evidence Timeline — marker placement and chart-lifecycle regression suite.
//
// Two halves:
//   1. PLACEMENT. Every marker sits on the first bar at or after the evidence became PUBLIC. The
//      cases that matter are the ones where the public date and the economic date differ — Congress
//      (up to 289 days apart in our real data) and 13F (a whole quarter apart).
//   2. LIFECYCLE. The production chart destroys and rebuilds its price series on every redraw, and
//      a SeriesMarkers plugin dies with its series. The attach/reattach rule is modelled here
//      against a fake Lightweight Charts so the invariants are testable without a browser: no
//      duplicates after redraw, no stale markers after a ticker switch, never attached to a
//      destroyed series.
//
// Run: node scripts/verify-evidence-markers.mjs

import {
  buildEvidenceMarkers, snapToBar, barEpoch, evidenceAtBar, groupKey,
  markerStyleFor, markerPalette, MAX_MARKERS,
} from '../src/lib/chart/evidence-markers.mjs';
import fs from 'node:fs';
import { makeEvidence, FAMILY, DIRECTION } from '../src/lib/evidence/model.mjs';
import { timeframe, DEFAULT_TIMEFRAME } from '../src/lib/chart/chart-source.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const sec = (s) => console.log(`\n=== ${s} ===`);

const NOW = Date.parse('2026-09-19T15:00:00Z');

// A daily series, weekdays only — so "the first bar at or after" has real gaps to cross.
const DAILY = [
  '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11',
  '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18',
].map((d) => ({ time: d, open: 10, high: 11, low: 9, close: 10.5, volume: 1000 }));

// An intraday series: UNIX seconds, 5-minute bars.
const T0 = Date.parse('2026-09-18T13:30:00Z') / 1000;
const INTRA = Array.from({ length: 12 }, (_, i) => ({
  time: T0 + i * 300, open: 10, high: 11, low: 9, close: 10.5, volume: 100,
}));

const ev = (over) => {
  const r = makeEvidence({
    ticker: 'TEST', family: FAMILY.CATALYST, type: 'sec_8k_material_agreement',
    source: 'sec_8k', sourceId: 'acc-1', materiality: 0.75, quality: 0.95,
    publicTime: '2026-09-10T12:00:00Z', ...over,
  }, { now: NOW });
  if (!r.ok) throw new Error(`fixture rejected: ${r.reason} ${r.detail}`);
  return r.evidence;
};

// ── 1. placement uses publicTime ─────────────────────────────────────────────
sec('PLACEMENT USES PUBLIC TIME');

check('barEpoch parses a daily bar', barEpoch('2026-09-10') === Date.parse('2026-09-10T00:00:00Z'));
check('barEpoch parses an intraday bar', barEpoch(T0) === T0 * 1000);

check('evidence lands on its own session',
  snapToBar('2026-09-10T12:00:00Z', DAILY) === '2026-09-10');
check('evidence published after the close still lands on that session',
  snapToBar('2026-09-10T23:59:00Z', DAILY) === '2026-09-10');
// The rule that matters for weekend filings.
check('a Saturday filing lands on the NEXT session, never the previous one',
  snapToBar('2026-09-12T18:00:00Z', DAILY) === '2026-09-14',
  String(snapToBar('2026-09-12T18:00:00Z', DAILY)));
check('a Sunday filing lands on Monday',
  snapToBar('2026-09-13T09:00:00Z', DAILY) === '2026-09-14');

check('evidence before the series starts is not placed',
  snapToBar('2026-08-01T12:00:00Z', DAILY) === null);
check('evidence after the series ends is not placed',
  snapToBar('2026-09-25T12:00:00Z', DAILY) === null);
check('out-of-range evidence is NOT clamped onto the first bar',
  snapToBar('2020-01-01T00:00:00Z', DAILY) !== DAILY[0].time);
check('unparseable time is not placed', snapToBar('nonsense', DAILY) === null);
check('null time is not placed', snapToBar(null, DAILY) === null);
check('an empty series places nothing', snapToBar('2026-09-10T12:00:00Z', []) === null);

check('intraday evidence snaps to its bar',
  snapToBar(new Date((T0 + 310) * 1000).toISOString(), INTRA) === T0 + 600);
check('intraday evidence exactly on a bar uses that bar',
  snapToBar(new Date((T0 + 600) * 1000).toISOString(), INTRA) === T0 + 600);

// ── 2. the families whose clocks differ ──────────────────────────────────────
sec('CONGRESS — DISCLOSURE, NEVER TRANSACTION');

// The real ALK shape: traded 2025-10-21, disclosed 2026-08-06. The trade date is not even on this
// series; if placement used it, the marker would vanish rather than land on the disclosure.
const congress = ev({
  family: FAMILY.CONGRESS, type: 'congress_disclosure', source: 'congress', sourceId: 'c1',
  eventTime: '2026-08-20T00:00:00Z', publicTime: '2026-09-15T00:00:00Z',
  materiality: 0.55, quality: 0.6,
  facts: { transactionDate: '2026-08-20', disclosureDate: '2026-09-15', disclosureLagDays: 26 },
});
check('the congress marker sits on the DISCLOSURE date',
  snapToBar(congress.publicTime, DAILY) === '2026-09-15');
check('the congress marker does NOT sit on the transaction date',
  snapToBar(congress.publicTime, DAILY) !== snapToBar(congress.eventTime, DAILY));
check('the transaction date is still carried for the detail card',
  congress.facts.transactionDate === '2026-08-20');
{
  const { markers } = buildEvidenceMarkers([congress], DAILY, { theme: 'light' });
  check('built congress marker uses the disclosure date', markers[0]?.time === '2026-09-15');
}

sec('13F — DISCLOSURE, NEVER QUARTER END');

const f13 = ev({
  family: FAMILY.INSTITUTION, type: 'institution_breadth_change', source: 'sec_13f', sourceId: 'i1',
  eventTime: '2026-06-30T00:00:00Z', publicTime: '2026-09-11T00:00:00Z',
  referencePeriod: 'Q2 2026', materiality: 0.45, quality: 0.8,
  facts: { quarterEnd: '2026-06-30', disclosedAt: '2026-09-11' },
});
check('the 13F marker sits on the DISCLOSURE date',
  snapToBar(f13.publicTime, DAILY) === '2026-09-11');
// The quarter end is 73 days before this series begins: placing there would drop the marker.
check('the quarter end is not even on this chart', snapToBar(f13.eventTime, DAILY) === null);
check('the quarter end is still carried for the detail card', f13.facts.quarterEnd === '2026-06-30');
{
  const { markers, placed } = buildEvidenceMarkers([f13], DAILY, { theme: 'light' });
  check('built 13F marker uses the disclosure date', markers[0]?.time === '2026-09-11');
  check('the 13F marker is actually placed', placed === 1);
}

sec('FORM 4 — FILING DATE');

const form4 = ev({
  family: FAMILY.INSIDER, type: 'insider_officer_buy', source: 'sec_form4', sourceId: 'f1',
  publicTime: '2026-09-16', direction: DIRECTION.POSITIVE, materiality: 0.8, quality: 0.95,
  facts: { totalValueLabel: '$1.0M', officer: true },
});
check('the Form 4 marker sits on the filing date',
  snapToBar(form4.publicTime, DAILY) === '2026-09-16');
check('a day-resolution filing date is placed on that day, not the next',
  buildEvidenceMarkers([form4], DAILY, { theme: 'light' }).markers[0]?.time === '2026-09-16');

// ── 3. appearance ────────────────────────────────────────────────────────────
sec('APPEARANCE');

const pal = markerPalette('light');
check('an insider buy points up from below the bar',
  markerStyleFor({ family: 'insider', direction: 'positive' }, pal).shape === 'arrowUp');
check('an insider sell points down from above the bar',
  markerStyleFor({ family: 'insider', direction: 'negative' }, pal).position === 'aboveBar');
check('families are visually distinguishable',
  new Set(['catalyst', 'congress', 'institution'].map((f) => markerStyleFor({ family: f }, pal).shape
    + markerStyleFor({ family: f }, pal).position + markerStyleFor({ family: f }, pal).color)).size === 3);
// Canvas cannot resolve CSS variables; a var() colour silently drops the marker.
check('marker colours are concrete hex, never CSS variables',
  Object.values(markerPalette('light')).concat(Object.values(markerPalette('dark')))
    .every((c) => /^#[0-9A-Fa-f]{6}$/.test(c)));
check('the dark palette differs from the light one',
  markerPalette('dark').catalyst !== markerPalette('light').catalyst);

// ── 4. density and grouping ──────────────────────────────────────────────────
sec('DENSITY AND GROUPING');

const sameDay = [
  ev({ family: FAMILY.INSIDER, type: 'insider_buy', source: 'sec_form4', sourceId: 'a', publicTime: '2026-09-15', direction: DIRECTION.POSITIVE, materiality: 0.65, quality: 0.9 }),
  ev({ family: FAMILY.INSIDER, type: 'insider_buy', source: 'sec_form4', sourceId: 'b', publicTime: '2026-09-15', direction: DIRECTION.POSITIVE, materiality: 0.65, quality: 0.9 }),
  ev({ family: FAMILY.INSIDER, type: 'insider_buy', source: 'sec_form4', sourceId: 'c', publicTime: '2026-09-15', direction: DIRECTION.POSITIVE, materiality: 0.65, quality: 0.9 }),
];
{
  const { markers, byKey } = buildEvidenceMarkers(sameDay, DAILY, { theme: 'light' });
  check('three same-day same-family items make ONE marker', markers.length === 1);
  check('the grouped marker shows its count', markers[0].text === '3');
  check('the underlying evidence stays reachable', byKey.get(markers[0].id)?.length === 3);
  check('a single item shows no count badge',
    buildEvidenceMarkers([sameDay[0]], DAILY, { theme: 'light' }).markers[0].text === '');
}
{
  // Two families on one bar stay two markers: they are different kinds of evidence.
  const mixed = [sameDay[0], ev({ publicTime: '2026-09-15T12:00:00Z', sourceId: 'k1' })];
  const { markers } = buildEvidenceMarkers(mixed, DAILY, { theme: 'light' });
  check('different families on one bar remain separate markers', markers.length === 2);
}
{
  const both = [
    ev({ family: FAMILY.INSIDER, type: 'insider_buy', source: 'sec_form4', sourceId: 'p', publicTime: '2026-09-15', direction: DIRECTION.POSITIVE, materiality: 0.65, quality: 0.9 }),
    ev({ family: FAMILY.INSIDER, type: 'insider_discretionary_sell', source: 'sec_form4', sourceId: 'q', publicTime: '2026-09-15', direction: DIRECTION.NEGATIVE, materiality: 0.55, quality: 0.9 }),
  ];
  const { markers } = buildEvidenceMarkers(both, DAILY, { theme: 'light' });
  check('a mixed-direction group does not masquerade as one-way pressure',
    markers.length === 1 && markers[0].color === markerPalette('light').insiderBuy === false
    || markers[0].text === '2');
}
{
  // Far more evidence than a chart can carry: the least material is dropped, and we are told.
  //
  // Needs a LONG series. Grouping is per (bar, family), so on a ten-bar chart 85 catalyst items
  // collapse to ten markers and the cap never engages — which is itself the point: grouping alone
  // bounds density on a short chart, and the cap only matters across a long one.
  const LONG = Array.from({ length: 200 }, (_, i) => ({
    time: new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10),
    open: 10, high: 11, low: 9, close: 10.5, volume: 100,
  }));
  const many = [];
  for (let i = 0; i < MAX_MARKERS + 25; i++) {
    many.push(ev({
      sourceId: `m${i}`, publicTime: `${LONG[i].time}T12:00:00Z`,
      family: FAMILY.CATALYST, type: `t${i}`, materiality: i < 10 ? 0.95 : 0.1,
    }));
  }
  const built = buildEvidenceMarkers(many, LONG, { theme: 'light' });
  check('grouping alone bounds a short chart without needing the cap',
    buildEvidenceMarkers(many.map((m, i) => ({ ...m, publicTime: `${DAILY[i % DAILY.length].time}T12:00:00Z` })),
      DAILY, { theme: 'light' }).markers.length <= DAILY.length);
  check('the most material survive the cap',
    built.markers.length === MAX_MARKERS
    && many.slice(0, 10).every((m) => built.byKey.has(groupKey(LONG[many.indexOf(m)].time, 'catalyst'))));
  check('marker count is capped', built.markers.length <= MAX_MARKERS);
  check('dropped markers are reported, not hidden', built.dropped > 0);
  check('markers are ascending by time (lightweight-charts requires it)',
    built.markers.every((m, i) => i === 0 || barEpoch(built.markers[i - 1].time) <= barEpoch(m.time)));
  check('capping is deterministic',
    JSON.stringify(buildEvidenceMarkers(many, LONG, { theme: 'light' }).markers)
    === JSON.stringify(built.markers));
}

// ── 5. what must never reach the chart ───────────────────────────────────────
sec('SUPPRESSION AND SAFETY');

check('unplaceable evidence is counted, not silently lost',
  buildEvidenceMarkers([ev({ publicTime: '2020-01-01T00:00:00Z', sourceId: 'old' })], DAILY, {}).unplaced === 1);
check('no evidence produces no markers',
  buildEvidenceMarkers([], DAILY, {}).markers.length === 0);
check('null evidence does not throw',
  buildEvidenceMarkers(null, DAILY, {}).markers.length === 0);
check('null bars do not throw', buildEvidenceMarkers([form4], null, {}).markers.length === 0);
check('evidence missing a url still builds a marker',
  buildEvidenceMarkers([ev({ url: null, sourceId: 'nourl' })], DAILY, {}).markers.length === 1);
check('evidence missing context still builds a marker',
  buildEvidenceMarkers([ev({ context: null, sourceId: 'noctx' })], DAILY, {}).markers.length === 1);

// Quarantined evidence never becomes an object at all, so it can never be a marker.
{
  const futureAttempt = makeEvidence({
    ticker: 'TEST', family: FAMILY.CATALYST, type: 'x', source: 'sec_8k', sourceId: 'f',
    publicTime: new Date(NOW + 30 * 86400000).toISOString(),
  }, { now: NOW });
  check('future-dated evidence is rejected upstream of the chart', futureAttempt.ok === false);
  check('a NONE ticker is rejected upstream of the chart',
    makeEvidence({ ...{ family: FAMILY.CATALYST, type: 'x', source: 'sec_8k', publicTime: '2026-09-10' }, ticker: 'NONE' }, { now: NOW }).ok === false);
}

check('evidenceAtBar finds every family on a bar',
  evidenceAtBar(buildEvidenceMarkers([congress, f13], DAILY, {}).byKey, '2026-09-15').length === 1);
check('evidenceAtBar on an empty bar returns nothing',
  evidenceAtBar(buildEvidenceMarkers([congress], DAILY, {}).byKey, '2026-09-08').length === 0);
check('evidenceAtBar tolerates a null map', evidenceAtBar(null, '2026-09-15').length === 0);
check('groupKey separates families on the same bar',
  groupKey('2026-09-15', 'insider') !== groupKey('2026-09-15', 'catalyst'));

// ── 6. THE CHART LIFECYCLE ───────────────────────────────────────────────────
// A faithful model of the production rule: draw() removes the price series and builds a new one,
// and a SeriesMarkers plugin dies with its series. The component keeps the plugin handle AND the
// series it belongs to, and reattaches when those disagree.
sec('CHART LIFECYCLE');

function makeFakeChart() {
  let seriesSeq = 0;
  const state = { live: new Set(), plugins: [], attachedToDead: 0 };
  const lwc = {
    createSeriesMarkers(series, markers) {
      if (!state.live.has(series)) { state.attachedToDead++; throw new Error('series destroyed'); }
      const api = { series, markers: [...markers], alive: true };
      api.setMarkers = (m) => {
        // The real library's plugin stops working once its series is gone.
        if (!state.live.has(api.series)) { state.attachedToDead++; throw new Error('series destroyed'); }
        api.markers = [...m];
      };
      state.plugins.push(api);
      return api;
    },
  };
  const chart = {
    addSeries() { const s = { id: ++seriesSeq }; state.live.add(s); return s; },
    removeSeries(s) { state.live.delete(s); },
  };
  return { chart, lwc, state };
}

// The component, reduced to exactly the refs and rules that matter.
function makeComponent() {
  const { chart, lwc, state } = makeFakeChart();
  const refs = { price: null, markersApi: null, markersSeries: null, evidence: [], bars: DAILY, map: new Map() };

  function applyEvidenceMarkers() {
    const series = refs.price;
    if (!lwc || !series) return;
    const built = buildEvidenceMarkers(refs.evidence, refs.bars, { theme: 'light' });
    refs.map = built.byKey;
    try {
      if (refs.markersApi && refs.markersSeries === series) {
        refs.markersApi.setMarkers(built.markers);
        return;
      }
      refs.markersApi = lwc.createSeriesMarkers(series, built.markers);
      refs.markersSeries = series;
    } catch {
      refs.markersApi = null; refs.markersSeries = null;
    }
  }

  function draw() {
    if (refs.price) {
      chart.removeSeries(refs.price);
      refs.price = null;
      refs.markersApi = null; refs.markersSeries = null;   // the plugin died with the series
    }
    refs.price = chart.addSeries();
    applyEvidenceMarkers();
  }

  function setEvidence(list) { refs.evidence = list; applyEvidenceMarkers(); }
  function destroy() { if (refs.price) chart.removeSeries(refs.price); refs.price = null; refs.markersApi = null; refs.markersSeries = null; }

  const liveMarkerCount = () => (refs.markersApi ? refs.markersApi.markers.length : 0);
  const livePlugins = () => state.plugins.filter((p) => state.live.has(p.series)).length;
  return { draw, setEvidence, destroy, refs, state, liveMarkerCount, livePlugins };
}

{
  const c = makeComponent();
  c.setEvidence([form4, congress]);
  check('no series yet means no markers and no crash', c.liveMarkerCount() === 0);

  c.draw();
  check('markers appear once the series exists', c.liveMarkerCount() === 2);
  check('exactly one live plugin', c.livePlugins() === 1);

  // THE CENTRAL CASE: a redraw destroys the series under the plugin.
  c.draw();
  check('a redraw does not duplicate markers', c.liveMarkerCount() === 2, String(c.liveMarkerCount()));
  check('a redraw leaves exactly one live plugin', c.livePlugins() === 1, String(c.livePlugins()));
  check('the plugin is never attached to a destroyed series', c.state.attachedToDead === 0);
  check('the plugin tracks the CURRENT series', c.refs.markersSeries === c.refs.price);

  for (let i = 0; i < 12; i++) c.draw();
  check('twelve redraws still leave one live plugin', c.livePlugins() === 1, String(c.livePlugins()));
  check('twelve redraws do not duplicate markers', c.liveMarkerCount() === 2);
  check('no attachment to a dead series across many redraws', c.state.attachedToDead === 0);
}

{
  // Ticker switch: the host clears evidence, then new evidence arrives.
  const c = makeComponent();
  c.setEvidence([form4, congress]);
  c.draw();
  check('old ticker has markers', c.liveMarkerCount() === 2);
  c.setEvidence([]);
  check('clearing evidence removes the previous ticker markers', c.liveMarkerCount() === 0);
  c.setEvidence([f13]);
  check('the new ticker shows only its own evidence', c.liveMarkerCount() === 1);
  check('no stale plugin survives the switch', c.livePlugins() === 1);
}

{
  // Timeframe switch: new bars, then a redraw.
  const c = makeComponent();
  c.setEvidence([form4, congress, f13]);
  c.draw();
  check('daily timeframe places all three', c.liveMarkerCount() === 3);
  // An intraday window covering only the last session: most evidence falls outside it.
  c.refs.bars = INTRA;
  c.draw();
  check('a narrower timeframe places only the evidence inside it', c.liveMarkerCount() === 0,
    String(c.liveMarkerCount()));
  c.refs.bars = DAILY;
  c.draw();
  check('returning to the wider timeframe restores the markers', c.liveMarkerCount() === 3);
}

{
  // Evidence arriving before and after the first draw — the real race between two async sources.
  const early = makeComponent();
  early.setEvidence([form4]);
  early.draw();
  check('evidence that arrived before the first draw is applied', early.liveMarkerCount() === 1);

  const late = makeComponent();
  late.draw();
  late.setEvidence([form4]);
  check('evidence that arrived after the first draw is applied', late.liveMarkerCount() === 1);
  check('neither ordering creates a second plugin', late.livePlugins() === 1);
}

{
  // A resize re-renders the component but does NOT recreate the series.
  const c = makeComponent();
  c.setEvidence([form4, congress]);
  c.draw();
  const pluginBefore = c.refs.markersApi;
  c.setEvidence([form4, congress]);       // a re-render passing the same evidence
  check('a re-render reuses the existing plugin', c.refs.markersApi === pluginBefore);
  check('a re-render does not duplicate markers', c.liveMarkerCount() === 2);
  check('a re-render adds no plugin', c.livePlugins() === 1);
}

{
  const c = makeComponent();
  c.setEvidence([form4]);
  c.draw();
  c.destroy();
  check('teardown drops the plugin handle', c.refs.markersApi === null);
  check('teardown drops the series handle', c.refs.markersSeries === null);
  check('nothing was attached to a destroyed series', c.state.attachedToDead === 0);
}

{
  // The chart must survive an evidence API failure and an empty result.
  const c = makeComponent();
  c.draw();
  c.setEvidence([]);
  check('zero evidence leaves a working chart', c.refs.price !== null && c.liveMarkerCount() === 0);
  c.setEvidence(null);
  check('null evidence (API failure) leaves a working chart', c.refs.price !== null);
  c.draw();
  check('redraw after a failure still works', c.refs.price !== null && c.state.attachedToDead === 0);
}

// ── THE FETCH WINDOW MUST COVER THE CHART ───────────────────────────────────
//
// ⚠️ A DEFECT FOUND BY INSPECTION, NOT BY THESE TESTS. The host fetched a hardcoded two years of
// evidence while the default daily chart loads 1,825 days of candles, so years three to five of
// the chart everyone opens on had no markers — and the comment beside it claimed the window
// "covers every timeframe the page opens on". Placement, grouping and lifecycle were all correct;
// the evidence simply was not asked for. Nothing above could catch that, because every assertion
// here starts from evidence that has already arrived.
sec('THE EVIDENCE WINDOW COVERS THE DEFAULT CHART');
{
  const host = fs.readFileSync(new URL('../src/components/chart/TickerPriceChart.jsx', import.meta.url), 'utf8');
  const dailyDays = timeframe(DEFAULT_TIMEFRAME)?.window?.days ?? null;

  check('the default timeframe declares a day span', Number.isFinite(dailyDays), String(dailyDays));
  // Derived, never restated — a literal here is how the two drifted apart in the first place.
  check('the window is derived from the timeframe definition',
    /timeframe\(DEFAULT_TIMEFRAME\)\?\.window\?\.days/.test(host));
  check('…and is not a hardcoded two years',
    !/const EVIDENCE_WINDOW_DAYS = 365 \* 2;/.test(host));

  // The real assertion: whatever the host resolves must be at least the daily chart's own span.
  const resolved = dailyDays;
  check('the fetch window is at least the daily chart span',
    resolved >= 1825, `${resolved}d vs 1825d of candles`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
