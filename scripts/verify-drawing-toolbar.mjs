// THE SELECTED-DRAWING TOOLBAR — placement, control sets, and the attached label.
//
// Two things here can be wrong in ways nobody notices until a user is holding the mouse:
//
//   1. THE TOOLBAR ESCAPES THE PLOT. A panel six pixels past the right edge of a Terminal panel is
//      invisible on the machine it was built on and unusable on a laptop. It is decidable from
//      numbers, so it is decided here, for every corner and every plot size.
//   2. A CONTROL APPEARS FOR A DRAWING IT CANNOT ACT ON. A width control on a text note writes a
//      field nothing reads: the user changes it, nothing happens, and they stop trusting the rest
//      of the bar.
//
// Run: node scripts/verify-drawing-toolbar.mjs

import { readFileSync } from 'node:fs';
import {
  CONTROL, controlsFor, hasMore, selectionBox, placeToolbar, fitsInside,
  TOOLBAR_GAP, TOOLBAR_EDGE,
} from '../src/lib/chart/drawing-toolbar.mjs';
import {
  TOOLS, TOOL_IDS, tool, createDrawing, coerceDrawing, cloneDrawing, moveDrawing, LABEL_MAX,
} from '../src/lib/chart/chart-drawings.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);

// ── 1. WHAT EACH DRAWING GETS ────────────────────────────────────────────────
L('⚠️ THE TOOLBAR OFFERS ONLY WHAT THE DRAWING CAN DO');
{
  const has = (type, c) => controlsFor(type).includes(c);

  ok('a trend line gets colour, width, style, label, lock and delete',
    [CONTROL.COLOR, CONTROL.WIDTH, CONTROL.DASH, CONTROL.LABEL, CONTROL.LOCK, CONTROL.DELETE]
      .every((c) => has('trend', c)));
  ok('a horizontal line gets the same set', [CONTROL.COLOR, CONTROL.WIDTH, CONTROL.DASH, CONTROL.LABEL,
    CONTROL.LOCK, CONTROL.DELETE].every((c) => has('horizontal', c)));
  ok('a Fibonacci gets them too', [CONTROL.COLOR, CONTROL.WIDTH, CONTROL.DASH, CONTROL.LOCK,
    CONTROL.DELETE].every((c) => has('fib', c)));

  // ⚠️ THE CASE THE RULE EXISTS FOR. A note draws no line at all — segments() returns nothing — so
  // a width and a dash style would be two controls writing a field the renderer never reads.
  ok('⚠️ a text note is offered NO line width', !has('text', CONTROL.WIDTH));
  ok('⚠️ …and no line style', !has('text', CONTROL.DASH));
  ok('a text note edits its own words instead', has('text', CONTROL.TEXT));
  ok('…and nothing else edits text as a body', TOOL_IDS.filter((t) => controlsFor(t).includes(CONTROL.TEXT)).join() === 'text');

  // ⚠️ A NOTE'S STRING IS THE DRAWING. A second caption on it would be two labels on one object.
  ok('⚠️ a text note is not also offered an attached label', !has('text', CONTROL.LABEL));
  ok('every line-bearing tool can be labelled',
    ['trend', 'ray', 'horizontal', 'vertical', 'rectangle', 'fib'].every((t) => has(t, CONTROL.LABEL)));

  ok('delete is offered on every drawing', TOOL_IDS.filter((t) => !TOOLS[t].transient)
    .every((t) => has(t, CONTROL.DELETE)));
  ok('lock is offered on every drawing', TOOL_IDS.filter((t) => !TOOLS[t].transient)
    .every((t) => has(t, CONTROL.LOCK)));

  // ⚠️ MORE IS FOR SECONDARY SETTINGS, so it appears only where there ARE any.
  ok('a trend line has a More menu — it can be extended', hasMore('trend') && has('trend', CONTROL.MORE));
  ok('a Fibonacci has one — it has levels', hasMore('fib') && has('fib', CONTROL.MORE));
  ok('⚠️ a plain note does not, rather than opening an empty menu',
    !hasMore('text') && !has('text', CONTROL.MORE));
  ok('a vertical line has no secondary settings either', !hasMore('vertical'));

  ok('an unknown type offers nothing at all', controlsFor('not-a-tool').length === 0);
  ok('the bar never repeats a control', TOOL_IDS.every((t) => {
    const cs = controlsFor(t);
    return new Set(cs).size === cs.length;
  }));
  // Small enough to be a toolbar rather than a panel.
  ok('⚠️ no drawing gets more than eight controls, which is the point of a toolbar',
    TOOL_IDS.every((t) => controlsFor(t).length <= 8), String(Math.max(...TOOL_IDS.map((t) => controlsFor(t).length))));
}

// ── 2. THE BOX THE TOOLBAR FOLLOWS ───────────────────────────────────────────
L('THE SELECTION BOX IS THE PIXELS THE USER CAN SEE');
{
  const item = (handles, segments = []) => ({ handles, segments });

  ok('a two-anchor drawing spans both anchors',
    JSON.stringify(selectionBox([item([{ x: 10, y: 40 }, { x: 90, y: 20 }])]))
      === JSON.stringify({ x: 10, y: 20, w: 80, h: 20 }));

  // ⚠️ SEGMENTS COUNT, NOT ONLY HANDLES. A horizontal line's handle sits at its anchor's own time,
  // which may be scrolled off screen, while the line itself spans the plot. A box built from
  // handles alone would put the toolbar somewhere the line is not.
  const horiz = item([{ x: -400, y: 100 }], [[{ x: 0, y: 100 }, { x: 600, y: 100 }]]);
  const b = selectionBox([horiz]);
  ok('⚠️ a horizontal line off to the left still reports the span on screen', b.x === -400 && b.w === 1000);
  ok('…and a zero-height line has a box all the same', b.h === 0);

  ok('several selected drawings give one box round them all',
    JSON.stringify(selectionBox([item([{ x: 10, y: 10 }]), item([{ x: 50, y: 70 }])]))
      === JSON.stringify({ x: 10, y: 10, w: 40, h: 60 }));
  ok('nothing selected is no box', selectionBox([]) === null && selectionBox(null) === null);
  ok('⚠️ an unprojectable anchor is skipped rather than poisoning the box with NaN',
    JSON.stringify(selectionBox([item([{ x: NaN, y: 5 }, { x: 20, y: 30 }])]))
      === JSON.stringify({ x: 20, y: 30, w: 0, h: 0 }));
  ok('a drawing with no usable point at all yields no box',
    selectionBox([item([{ x: null, y: null }])]) === null);
}

// ── 3. WHERE IT GOES ─────────────────────────────────────────────────────────
L('⚠️ THE TOOLBAR IS ALWAYS INSIDE THE PLOT');
{
  const SIZE = { w: 220, h: 28 };
  const PLOT = { w: 800, h: 400 };

  const mid = placeToolbar({ x: 300, y: 200, w: 100, h: 60 }, SIZE, PLOT);
  ok('a drawing in open space gets its toolbar above it', mid.placement === 'above');
  ok('…clear of the drawing by the gap', mid.top + SIZE.h <= 200 - TOOLBAR_GAP + 0.001);
  ok('…and centred on it', Math.abs(mid.left + SIZE.w / 2 - 350) < 0.001);

  // ⚠️ THE CASE THE BRIEF NAMES: near the top, the toolbar goes underneath.
  const top = placeToolbar({ x: 300, y: 2, w: 100, h: 20 }, SIZE, PLOT);
  ok('⚠️ a drawing at the top of the chart gets its toolbar BELOW it', top.placement === 'below');
  ok('…below the drawing, not over it', top.top >= 22 + TOOLBAR_GAP - 0.001);

  const bottom = placeToolbar({ x: 300, y: 370, w: 100, h: 25 }, SIZE, PLOT);
  ok('⚠️ a drawing at the bottom gets its toolbar ABOVE it', bottom.placement === 'above');

  // ⚠️ THE PROPERTY THAT MATTERS, swept rather than sampled: wherever the drawing is and whatever
  // the panel size, the toolbar is on screen. This is the assertion a hand-placed toolbar fails.
  let outside = 0, overlaps = 0, worst = '';
  for (const pw of [220, 320, 480, 800, 1400]) {
    for (const ph of [140, 220, 400, 900]) {
      for (const x of [-50, 0, 5, pw / 2, pw - 10, pw + 40]) {
        for (const y of [-30, 0, 4, ph / 2, ph - 8, ph + 20]) {
          for (const bw of [0, 30, pw]) {
            for (const bh of [0, 25, ph]) {
              const plot = { w: pw, h: ph };
              const box = { x, y, w: bw, h: bh };
              const size = { w: Math.min(220, pw), h: 28 };
              const pos = placeToolbar(box, size, plot);
              if (!Number.isFinite(pos.left) || !Number.isFinite(pos.top)) { outside++; worst = 'NaN'; continue; }
              if (!fitsInside(pos, plot)) { outside++; worst = JSON.stringify({ plot, box, pos }); }
              // Overlap is allowed ONLY when the drawing leaves no room on either side of it.
              const clearAbove = box.y - TOOLBAR_GAP - size.h >= TOOLBAR_EDGE;
              const clearBelow = box.y + box.h + TOOLBAR_GAP + size.h <= ph - TOOLBAR_EDGE;
              const covers = pos.top < box.y + box.h && pos.top + size.h > box.y;
              if (covers && (clearAbove || clearBelow)) { overlaps++; worst = JSON.stringify({ plot, box, pos }); }
            }
          }
        }
      }
    }
  }
  ok('⚠️ across 1,080 plot sizes and drawing positions, it never renders outside the plot',
    outside === 0, `${outside} escapes, e.g. ${worst}`);
  ok('⚠️ …and never covers the drawing when either side had room',
    overlaps === 0, `${overlaps} overlaps, e.g. ${worst}`);

  // A drawing that fills the plot: overlap is unavoidable, so it goes to the top rather than
  // off-screen. The one case where covering is the right answer.
  const full = placeToolbar({ x: 0, y: 0, w: 800, h: 400 }, SIZE, PLOT);
  ok('a drawing filling the plot still places the toolbar on screen', fitsInside(full, PLOT));
  ok('…at the top, which is the least of the evils', full.top === TOOLBAR_EDGE);

  // Horizontal clamping.
  const far = placeToolbar({ x: 790, y: 200, w: 10, h: 0 }, SIZE, PLOT);
  ok('⚠️ a drawing at the right edge does not push the toolbar off it',
    far.left + SIZE.w <= PLOT.w - TOOLBAR_EDGE + 0.001);
  const near = placeToolbar({ x: -30, y: 200, w: 10, h: 0 }, SIZE, PLOT);
  ok('⚠️ nor does one off the left edge', near.left >= TOOLBAR_EDGE - 0.001);

  // A panel narrower than the toolbar: it still starts on screen.
  const tiny = placeToolbar({ x: 10, y: 50, w: 20, h: 10 }, { w: 220, h: 28 }, { w: 160, h: 120 });
  ok('a panel narrower than the toolbar still anchors it at the edge, not off it',
    tiny.left === TOOLBAR_EDGE && tiny.top >= 0);
}

// ── 4. THE ATTACHED LABEL ────────────────────────────────────────────────────
L('⚠️ A LABEL BELONGS TO THE DRAWING, NOT BESIDE IT');
{
  // ⚠️ WHY NOT A TEXT NOTE PLACED NEARBY. That is the cheap version, and it produces two objects to
  // select, move, restyle and delete — which drift apart the first time the line is dragged. The
  // label is a field, so there is nothing to leave behind.
  const line = createDrawing('trend', [{ time: 1, price: 10 }, { time: 5, price: 20 }], {}, [], { label: 'Resistance' });
  ok('a line is created carrying its label', line.label === 'Resistance');

  const moved = moveDrawing(line, { dTime: 3, dPrice: 4 });
  ok('⚠️ moving the drawing keeps the label on it', moved.label === 'Resistance');
  ok('…and the anchors really did move', moved.points[0].price === 14);
  ok('a clone carries the label too', cloneDrawing(line).label === 'Resistance');

  ok('a stored label survives a round trip',
    coerceDrawing({ type: 'horizontal', points: [{ time: 1, price: 2 }], label: 'PM High' }).label === 'PM High');
  // ⚠️ EVERY DRAWING MADE BEFORE LABELS EXISTED comes back through coerceDrawing. An absent label
  // must read as "no label yet", not as undefined reaching a renderer and an input field.
  ok('⚠️ a drawing stored before labels existed gets an empty one, not undefined',
    coerceDrawing({ type: 'trend', points: [{ time: 1, price: 2 }, { time: 2, price: 3 }] }).label === '');
  ok('rubbish in the stored label is dropped',
    coerceDrawing({ type: 'trend', points: [{ time: 1, price: 2 }, { time: 2, price: 3 }], label: { evil: 1 } }).label === '');
  ok('⚠️ a label is capped, because it is painted beside a line in a 300px panel',
    coerceDrawing({ type: 'trend', points: [{ time: 1, price: 2 }, { time: 2, price: 3 }], label: 'x'.repeat(400) })
      .label.length === LABEL_MAX);
  ok('⚠️ a text note carries no label field at all, having its own words',
    !('label' in coerceDrawing({ type: 'text', points: [{ time: 1, price: 2 }], text: 'hi' })));
  ok('the cap is a tag length, not a paragraph', LABEL_MAX > 0 && LABEL_MAX <= 40);
}

// ── 5. THE OLD PANEL IS GONE, AND THE CLICKS ARE ISOLATED ───────────────────
L('⚠️ ONE SYSTEM, NOT TWO');
{
  const rail = readFileSync(new URL('../src/components/chart/DrawingRail.jsx', import.meta.url), 'utf8');
  const bar = readFileSync(new URL('../src/components/chart/DrawingToolbar.jsx', import.meta.url), 'utf8');
  const chart = readFileSync(new URL('../src/components/chart/CPChart.jsx', import.meta.url), 'utf8');
  const layer = readFileSync(new URL('../src/components/chart/DrawingLayer.jsx', import.meta.url), 'utf8');
  const code = (src) => src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  // ⚠️ BOTH SYSTEMS MUST NOT SURVIVE. Leaving the old panel in place would give two routes to the
  // same setting, which drift, and two answers to "where do I change the colour".
  ok('⚠️ the rail no longer has a "Selected drawing" panel', !code(rail).includes('Selected drawing'));
  ok('⚠️ …nor a Delete drawing button of its own', !code(rail).includes('Delete drawing'));
  ok('⚠️ …and selecting a drawing no longer forces it open',
    !/useEffect\(\(\) => \{ if \(selected\) setStylePanel/.test(rail));
  ok('the rail keeps the style panel for NEW drawings, which is its remaining job',
    code(rail).includes('New drawings'));

  // ⚠️ THE CLICK-THROUGH BUG THIS PREVENTS. The canvas underneath reads a pointerdown that hits no
  // drawing as "deselect". A toolbar button is such a miss, so the very first click on any control
  // would deselect the drawing it was about to edit and take the toolbar with it.
  ok('⚠️ pointer events are stopped at the toolbar container', bar.includes('onPointerDown={(e) => e.stopPropagation()}'));
  ok('…mouse down too, for the drag path', bar.includes('onMouseDown={(e) => e.stopPropagation()}'));
  ok('…and click, so a control never reads as a chart click', bar.includes('onClick={(e) => e.stopPropagation()}'));
  ok('…and the double-click that opens the settings dialog', bar.includes('onDoubleClick={(e) => e.stopPropagation()}'));

  ok('the toolbar takes its position from the shared placement, not from inline arithmetic',
    bar.includes('placeToolbar(box, size, plot)') && !/top:\s*box\./.test(bar));
  ok('⚠️ it is rendered inside the chart\'s own relative box, so its coordinates are the canvas\'s',
    /<DrawingToolbar[\s\S]{0,400}box=\{selBox\.box\} plot=\{selBox\.plot\}/.test(chart));
  ok('it is hidden when nothing is selected', /\{selBox && selectedIds\.length > 0 && \(/.test(chart));

  // ⚠️ ONE SELECTION MODEL. A toolbar that kept its own idea of what was selected would disagree
  // with the canvas the moment either changed.
  ok('⚠️ the toolbar holds no selection state of its own',
    !/useState\([^)]*\)\s*;\s*\/\/\s*selected/i.test(bar) && !bar.includes('setSelectedIds'));
  ok('the drawing it edits comes from the chart\'s own selectedIds',
    chart.includes('drawings.find((d) => d.id === selectedIds[0])'));

  // Edits go through the history like every other change.
  //
  // ⚠️ READ THE BODY, NOT THE NEIGHBOURHOOD. The first version of this matched updateDrawings
  // anywhere within 320 characters of the declaration — which includes the dependency array — so
  // swapping the call itself for setDrawings left the assertion passing over a change that made
  // every lock and every label permanent. The body is sliced out and both halves are checked: the
  // right call present, and the wrong one absent.
  const patchBody = (chart.match(/const patchSelected = useCallback\(\(patch\) => \{([\s\S]*?)\n  \}, \[/) || [])[1] || '';
  ok('⚠️ a lock, a label or a hide is undoable, because it goes through updateDrawings',
    patchBody.includes('updateDrawings((ds)'), patchBody.slice(0, 90));
  ok('⚠️ …and it does NOT write drawings directly, which would not be undoable',
    patchBody.length > 0 && !patchBody.includes('setDrawings('));
  ok('deleting from the toolbar reuses the chart\'s existing delete', chart.includes('onDelete={deleteSelected}'));
  ok('restyling from the toolbar reuses the chart\'s existing style path', chart.includes('onStyle={applyStyle}'));

  // The layer reports the box; it does not render the toolbar, and the toolbar does not project.
  ok('⚠️ the box comes from the paint pass, so the toolbar tracks the pixels actually drawn',
    layer.includes('onSelectionBoxRef.current(box ? { box, plot:'));
  // ⚠️ THE LOOP AND THE BOX MUST READ THE SAME ARRAY. Projecting a second time for the box would
  // let the toolbar sit a frame behind the strokes — a bar lagging its own drawing through a drag,
  // which reads as broken rather than as slow.
  ok('…from the same projection the strokes came from',
    layer.includes('const projected = project();') && layer.includes('for (const d of projected)'));
  ok('⚠️ …and the paint pass does not quietly project a second time',
    !layer.includes('for (const d of project())') && (layer.match(/= project\(\)/g) || []).length === 1);
  ok('⚠️ …and only when it changes, or the chart would re-render on every crosshair move',
    layer.includes("if (key !== stateRef.current.boxKey)"));
  ok('the toolbar never touches the chart or its scales',
    !bar.includes('priceToCoordinate') && !bar.includes('timeScale'));
}


L('⚠️ A DELETED DRAWING LEAVES NOTHING BEHIND');
{
  // ⚠️ THE ORPHAN-ARTIFACT CLASS, ASSERTED AS AN INVARIANT RATHER THAN PER TOOL.
  //
  // A Fibonacci is the tool where an orphan would be most visible — seven levels, seven price
  // labels, seven percentage labels — but nothing about the cleanup is fib-specific, and a fix that
  // was would leave the next tool exposed. What actually makes an orphan impossible is that EVERY
  // visual is painted from the drawing list into one canvas that is fully cleared each frame, so a
  // drawing that is not in the list cannot paint. There is no per-drawing renderer to leak, no
  // price line, no series and no primitive.
  const layer = readFileSync(new URL('../src/components/chart/DrawingLayer.jsx', import.meta.url), 'utf8');
  const chart = readFileSync(new URL('../src/components/chart/CPChart.jsx', import.meta.url), 'utf8');

  ok('⚠️ every frame starts by clearing the whole canvas', /ctx\.clearRect\(0, 0, w, h\);/.test(layer));
  ok('…before anything is drawn', layer.indexOf('ctx.clearRect(0, 0, w, h);') < layer.indexOf('for (const d of projected)'));
  ok('⚠️ and a repaint follows any change to the drawing list',
    /useEffect\(\(\) => \{ paint\(\); \}, \[drawings, selectedIds/.test(layer));
  // ⚠️ NO DRAWING OWNS A CHART OBJECT. A price line or a series created per level would survive the
  // list it came from, which is exactly how an orphaned Fibonacci would happen.
  ok('⚠️ no drawing creates a price line', !/createPriceLine/.test(layer));
  ok('⚠️ nor a series of its own', !/addLineSeries|addSeries/.test(layer));
  ok('⚠️ nor a chart primitive', !/attachPrimitive/.test(layer));
  ok('the fib levels are painted from the drawing, not from remembered state',
    /fibLevels\(d\.source\.points, d\.source\.levels\)/.test(layer));

  // Deletion is one path, through the history, and it drops the selection with it.
  ok('⚠️ there is one delete, and it goes through the shared update',
    /const deleteSelected = useCallback\(\(\) => \{[\s\S]{0,260}updateDrawings\(\(ds\) => ds\.filter/.test(chart));
  ok('…and the selection goes with it, so no handle outlives its drawing',
    /updateDrawings\(\(ds\) => ds\.filter\(\(d\) => !ids\.has\(d\.id\)\)\);\s*\n\s*setSelectedIds\(\[\]\);/.test(chart));
  // ⚠️ TWO ENTRY POINTS, BOTH CORRECT. The toolbar/Delete-key path and the bulk action both delete,
  // and both go through updateDrawings. Demanding a single filter expression asserted a coincidence
  // of implementation rather than the rule, and failed on a second CORRECT caller. The rule is that
  // no delete writes the list directly — a write that bypassed updateDrawings would skip the
  // history AND, being outside the state the layer paints from, could leave a drawing on screen.
  ok('⚠️ no delete writes the drawing list directly, so none can skip the repaint',
    !/setDrawings\(\(ds\) => ds\.filter/.test(chart)
    && (chart.match(/updateDrawings\(\(ds\)/g) || []).length >= 2);

  // ⚠️ AND A SYMBOL CHANGE REPLACES THE LIST RATHER THAN MERGING INTO IT — the other way a drawing
  // could appear on a chart it does not belong to.
  ok('⚠️ a symbol change reloads the list for that symbol',
    /setDrawings\(loadDrawings\(sym\)\);/.test(chart));
  ok('…and drops the selection, which referred to another chart\'s drawing',
    /setDrawings\(loadDrawings\(sym\)\);\s*\n\s*setSelectedIds\(\[\]\);/.test(chart));
  ok('…and the undo stack, so undo cannot paste another symbol\'s drawings back',
    /historyRef\.current = emptyHistory\(\);/.test(chart));
}

L('⚠️ THE TOOLBAR MEASURES WHAT IT WILL RENDER');
{
  // ⚠️ A FLAT THRESHOLD MEASURED THE WRONG THING. 460px was chosen when the toolbar carried
  // Indicators and Evidence; News was added and Evidence is only rendered when the host supplies
  // evidence — which the Terminal's chart does not. So the toolbar was being measured against 86px
  // it would never spend, and collapsed its word labels to bare glyphs at widths where all three
  // would have fitted.
  const chart = readFileSync(new URL('../src/components/chart/CPChart.jsx', import.meta.url), 'utf8');
  ok('⚠️ the threshold is derived from the controls that will exist',
    /const narrow = toolbarWidth < labelledCost;/.test(chart));
  ok('…and a control that is not rendered reserves no room',
    /\(hasEvidence \? ACTION_W\.evidence : 0\)/.test(chart));
  ok('…News is counted, having been added after the constant was chosen', /ACTION_W\.news/.test(chart));
  ok('⚠️ the flat 460 is gone', !/toolbarWidth < 460/.test(chart));
  ok('it is still measured on the chart, not the window', /toolbarWidth/.test(chart) && !/window\.innerWidth < /.test(chart));
  ok('the overflow threshold is unchanged, and still the last resort', /const overflowed = toolbarWidth < 330;/.test(chart));
  ok('⚠️ Evidence is still gated on there being evidence to control',
    /\{!overflowed && hasEvidence && \(/.test(chart));
}



L('⚠️ THE TERMINAL IS AN EVIDENCE HOST, AND ITS CHART IS STILL A RENDERER');
{
  const term = readFileSync(new URL('../src/app/terminal/TerminalClient.jsx', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../src/components/chart/TickerPriceChart.jsx', import.meta.url), 'utf8');
  const hook = readFileSync(new URL('../src/lib/chart/use-ticker-evidence.js', import.meta.url), 'utf8');
  const chart = readFileSync(new URL('../src/components/chart/CPChart.jsx', import.meta.url), 'utf8');

  // ⚠️ THE WIRING GAP THIS CLOSES. The Terminal renders the same CPChart the ticker page does, but
  // passed it no evidence — so hasEvidence was false and the Evidence control was gated off at
  // EVERY width, which read as a responsive bug.
  ok('⚠️ the Terminal chart is given evidence', /<CPChart symbol={symbol} initialTimeframe="5m" transparent evidence={evidence} \/>/.test(term));
  ok('…from the shared hook', /const evidence = useTickerEvidence\(symbol\);/.test(term));
  ok('⚠️ and the ticker page uses the SAME hook, not a second copy',
    /const evidence = useTickerEvidence\(symbol\);/.test(page));
  ok('…having given up its own fetch', !/fetch\(`\/api\/evidence/.test(page));
  ok('there is one evidence fetch for charts', (hook.match(/fetch\(`\/api\/evidence/g) || []).length === 1);
  // ⚠️ THE CHART STILL DOES NOT FETCH. That is what keeps it a renderer and keeps the timeline and
  // What Changed two consumers of one API rather than two askers.
  ok('⚠️ the chart itself still fetches no evidence', !/api\/evidence/.test(chart));
  ok('…and takes it as a prop', /evidence = null,/.test(chart));

  // ⚠️ AAPL's FILINGS MUST NEVER RENDER ON MSTR.
  // ⚠️ ORDER, NOT PROXIMITY. The first version allowed 200 characters between the two and failed on
  // the explanatory comments that sit between them — a false alarm about correct code. What matters
  // is only that the clear happens first.
  ok('⚠️ evidence is cleared before the request goes out, not when it lands',
    hook.indexOf('setEvidence(cached || null);') > 0
    && hook.indexOf('setEvidence(cached || null);') < hook.indexOf('fetch(`/api/evidence'));
  ok('⚠️ a superseded response is discarded', /if \(ctrl\.signal\.aborted \|\| id !== reqRef\.current\) return;/.test(hook));
  ok('…and the previous request is aborted', /return \(\) => ctrl\.abort\(\);/.test(hook));
  ok('a cache hit is that symbol\'s own evidence, so it may show at once', /const cached = cacheGet\(sym\);/.test(hook));

  // ⚠️ CANDLES MUST NOT WAIT FOR EVIDENCE.
  ok('⚠️ a failure resolves to "no evidence", never to an error',
    /\.catch\(\(\) => \{ if \(id === reqRef\.current && !ctrl\.signal\.aborted\) setEvidence\(cached \|\| \[\]\); \}\);/.test(hook));
  ok('⚠️ evidence never appears in the bar-loading dependencies',
    /\}, \[sym, tf, extended, draw, onSymbolResolved\]\);/.test(chart));
  ok('…and arriving evidence only updates markers', /\}, \[evidence, chartReady\]\);/.test(chart));

  // Bounded, for a tab left open all day.
  ok('the cache is bounded', /while \(cache\.size > MAX_CACHED\)/.test(hook));
  ok('…and expires', /now - hit\.at > TTL_MS/.test(hook));
  ok('a read counts as a use', /cache\.delete\(sym\); cache\.set\(sym, hit\);/.test(hook));

  // With evidence supplied, the Terminal's toolbar now reserves room for the control it will render.
  ok('⚠️ the Evidence control is still gated on there being evidence to control',
    /\{!overflowed && hasEvidence && \(/.test(chart));
  ok('…and the width rule counts it only when it will be rendered',
    /\(hasEvidence \? ACTION_W\.evidence : 0\)/.test(chart));
}

L('⚠️ IF A FIBONACCI IS ON SCREEN, A FIBONACCI IS IN STATE');
{
  // ── THE INVARIANT THAT SETTLES "ORPHAN OR PERSISTED DRAWING" ──────────────
  //
  // Rendered levels can only come from the drawing list, so visible Fibonacci levels are PROOF that
  // a fib drawing exists for the active symbol — not proof of a leaked renderer. The chain, each
  // link asserted below: the layer paints only what project() returns; project() reads only
  // stateRef.current.drawings; that is assigned only from the `drawings` prop; the chart sets that
  // only from loadDrawings(sym) or through updateDrawings. There is no fourth way for a level to
  // reach the canvas.
  const layer = readFileSync(new URL('../src/components/chart/DrawingLayer.jsx', import.meta.url), 'utf8');
  const chart = readFileSync(new URL('../src/components/chart/CPChart.jsx', import.meta.url), 'utf8');
  const store = readFileSync(new URL('../src/lib/chart/chart-drawing-store.mjs', import.meta.url), 'utf8');

  ok('the paint loop draws only what was projected', /for \(const d of projected\)/.test(layer));
  ok('⚠️ and projection reads only the current drawing list',
    /projectDrawings\(stateRef\.current\.drawings, view, sc, tool\)/.test(layer));
  ok('⚠️ which is assigned only from the prop', /s\.drawings = drawings;/.test(layer));
  ok('…and nothing else writes it', (layer.match(/s\.drawings = |stateRef\.current\.drawings = /g) || []).length === 1);
  // ⚠️ EVERY CALL SITE, NOT ANY ONE OF THEM. The lines and the percentage labels are computed
  // separately, and asserting that SOME call reads the drawing left the other free to read
  // anything — a mutant that broke only the line colours passed. Both must come from d.source, or
  // the labels could describe levels the lines do not draw.
  const fibCalls = layer.match(/fibLevels\([^)]*\)/g) || [];
  ok('⚠️ the fib levels come from that drawing\'s own anchors and levels',
    fibCalls.length >= 2 && fibCalls.every((c) => c === 'fibLevels(d.source.points, d.source.levels)'),
    fibCalls.join(' | '));
  ok('…so a level cannot outlive the drawing that produced it',
    !/createPriceLine/.test(layer) && !/attachPrimitive/.test(layer) && !/addSeries/.test(layer));

  // The persisted side: a delete must reach storage, or a reload brings it back.
  ok('⚠️ every change to the list is persisted', /saveDrawings/.test(chart));
  ok('…keyed by symbol', /export function loadDrawings\(symbol\)/.test(store) || /loadDrawings = \(symbol\)/.test(store));
  ok('⚠️ a symbol change reloads from storage rather than merging',
    /setDrawings\(loadDrawings\(sym\)\);/.test(chart));
  ok('…and a delete goes through the same path that persists', /updateDrawings\(\(ds\) => ds\.filter/.test(chart));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
