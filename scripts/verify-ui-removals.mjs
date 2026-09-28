// CONTROLS WE TOOK AWAY, AND THE THINGS THAT HAD TO SURVIVE THEM.
//
//   node scripts/verify-ui-removals.mjs
//
// ⚠️ A REMOVAL IS TWO CLAIMS, AND THE SECOND IS THE ONE THAT BREAKS. "It is gone" is easy to assert and
// easy to satisfy by deleting too much. What needs the test is everything that had to stay: the panel
// definitions saved layouts are validated against, the news surfaces that share a component with a
// retired panel, the refresh control that lived beside a removed card. So each section here is paired —
// what went, and what must still be there.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
/** Source with comments stripped, so an assertion cannot match its own explanation. */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

// ── 1. the Terminal's Add Panel menu ───────────────────────────────────────────────────────────
console.log('\n1. the Terminal\'s Add Panel menu');

{
  const term = read('src/app/terminal/TerminalClient.jsx');
  const src = code(term);

  // The registry, parsed from the source rather than restated here.
  const block = /const PANELS = \[([\s\S]*?)\n\];/.exec(src);
  ok('the panel registry was found', !!block);
  const entries = [...block[1].matchAll(/\{\s*id:\s*'([a-z]+)',\s*title:\s*'([^']+)'[\s\S]*?\}/g)]
    .map((m) => ({ id: m[1], title: m[2], addable: !/addable:\s*false/.test(m[0]) }));
  ok('every entry parsed', entries.length >= 15, `${entries.length}`);

  const RETIRED = ['why', 'tickernews', 'feed'];
  for (const id of RETIRED) {
    const e = entries.find((x) => x.id === id);
    ok(`⚠️ "${e ? e.title : id}" is no longer offered`, !!e && e.addable === false);
    // ⚠️ AND ITS DEFINITION STAYS. The ids are in people's saved layouts and in station presets, both
    // of which are validated against this registry — deleting the entry would turn a saved panel into
    // an unknown id and silently drop it, which is corrupting a layout rather than cleaning a menu.
    ok(`...but its definition is still in the registry, for saved layouts`, !!e && !!e.title);
  }

  // Exactly the intended menu, on a default layout.
  const DEFAULT_VISIBLE = /const DEFAULT_VISIBLE = \[([^\]]+)\]/.exec(src);
  ok('the default layout was found', !!DEFAULT_VISIBLE);
  const visible = [...DEFAULT_VISIBLE[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  const offered = entries.filter((e) => e.addable && !visible.includes(e.id)).map((e) => e.title);
  const WANT = ['Custom Scanner', 'Movers', 'Alerts', 'Heat Map', 'Earnings'];
  ok('⚠️ the Add Panel menu is exactly what it should be on a default layout',
    offered.join(' | ') === WANT.join(' | '), offered.join(' | '));
  // The two the brief also lists are offered as soon as they are closed — they start open by default.
  ok('⚠️ ...and News Wire and The Pit are offered once closed',
    entries.find((e) => e.id === 'newswire')?.addable === true
    && entries.find((e) => e.id === 'chat')?.addable === true
    && visible.includes('newswire') && visible.includes('chat'));

  // ⚠️ ONE FILTER, IN THE ONE PLACE THE MENU IS BUILT. A retired panel that is still reachable from a
  // preset is not retired.
  ok('⚠️ the menu filters on the flag', /d\.addable !== false && !visible\.includes\(d\.id\)/.test(src));
  ok('⚠️ ...and a station preset cannot resurrect one either',
    /PANEL_BY_ID\[id\] && PANEL_BY_ID\[id\]\.addable !== false/.test(src));

  // ── LEGACY SAVED LAYOUTS ──
  // A layout saved before the retirement can still name these ids. It must load, not crash.
  ok('⚠️ a saved layout is filtered against the registry, so an unknown id is dropped, not rendered',
    /vis\.filter\(\(id\) => PANEL_BY_ID\[id\]\)/.test(src));
  ok('...and a retired id still resolves in the registry, so an open one keeps rendering',
    RETIRED.every((id) => entries.some((e) => e.id === id)));

  // ── WHAT MUST NOT HAVE MOVED ──
  // ⚠️ THE RETIREMENT IS OF A TERMINAL PANEL, NOT OF THE NEWS. These are separate surfaces that do not
  // go through this registry, and the brief named each of them.
  ok('⚠️ News Wire is untouched', entries.some((e) => e.id === 'newswire' && e.addable));
  ok('⚠️ Pit Wire is untouched', entries.some((e) => e.id === 'pitwire' && e.addable));
  // ⚠️ CATALYST CONVERGENCE IS GONE, AND GONE MEANS DELETED. It showed the Pit Consensus board a
  // second time, so it was removed rather than retired: an `addable: false` entry would have kept it
  // alive in every saved layout that still names it. PANEL_BY_ID is the validation gate, so an
  // unknown id is discarded and the rest of the layout loads untouched.
  ok('⚠️ Catalyst Convergence is not in the registry at all',
    !entries.some((e) => e.id === 'convergence'), JSON.stringify(entries.filter((e) => e.id === 'convergence')));
  ok('⚠️ ...and nothing in the Terminal still renders it',
    !/ConvergenceBody|CONV_SRC/.test(src));
  ok('⚠️ ...while the consensus data it read is untouched',
    fs.existsSync(path.join(ROOT, 'src/app/api/consensus-board/route.js'))
    && fs.existsSync(path.join(ROOT, 'src/lib/consensus/board.mjs')));
  ok('⚠️ the ticker page\'s own news component still exists',
    fs.existsSync(path.join(ROOT, 'src/components/terminal/TickerNews.jsx')));
  ok('⚠️ ...and the standalone news panel component was not deleted',
    fs.existsSync(path.join(ROOT, 'src/components/terminal/NewsPanel.jsx')));
}

// ── 2. the Insider Trades header ───────────────────────────────────────────────────────────────
console.log('\n2. the Insider Trades header');

{
  const src = code(read('src/app/insiders/InsidersClient.jsx'));
  const header = src.slice(src.indexOf('Insider Trades</h1>'), src.indexOf('DISCOVERY'));
  ok('the page header was located', header.length > 100);

  ok('⚠️ the BUYS counter card is gone', !/>BUYS</.test(header));
  ok('⚠️ the SELLS counter card is gone', !/>SELLS</.test(header));
  // ⚠️ AND THE STATE BEHIND THEM WENT WITH THEM. A count still computed on every render, feeding
  // nothing, is the residue that makes the next reader think it is still shown somewhere.
  ok('⚠️ ...and the counts they were computed from are gone too',
    !/const buys\s*=/.test(src) && !/const sells\s*=/.test(src));
  ok('⚠️ ...with nothing put in their place',
    !/greenLight[\s\S]{0,200}>BUYS</.test(header));

  // What had to stay, and where.
  ok('⚠️ the Updated timestamp is still there', /Updated \{timeStr\} ET/.test(header));
  ok('⚠️ ...and the refresh control with it', /onClick=\{refresh\}/.test(header));
  ok('⚠️ ...aligned to the right of the header',
    /justifyContent:"space-between"/.test(header) || /marginLeft:"auto"/.test(header));
  ok('⚠️ ...and the responsive wrapping is preserved', /flexWrap:"wrap"/.test(header));

  // ⚠️ THE MEASUREMENTS BELOW THE HEADER ARE A DIFFERENT THING AND STAY. The removed cards counted
  // rows on the current page; Market Pulse answers the market-wide question over a stated window,
  // which is why one could go without leaving a gap in what the page tells you.
  ok('⚠️ Insider Market Pulse is untouched', /<MarketPulse data=\{pulse\}/.test(src));
  ok('⚠️ the heatmap and its controls are untouched',
    /<Heatmap data=\{heatmap\}/.test(src) && /onMode=\{setHeatMode\}/.test(src));
  ok('⚠️ Notable Activity is untouched', /<NotableActivity data=\{notable\}/.test(src));
  // The buy/sell language the page is ABOUT is not what was removed.
  ok('⚠️ the buying and selling categories still exist',
    /INSIDER BUYING/.test(src) && /INSIDER SELLING/.test(src) && /CLUSTER BUYS/.test(src));
}

// ── 3. the chart's left rail ───────────────────────────────────────────────────────────────────
console.log('\n3. the chart\'s left rail');

{
  const rail = code(read('src/components/chart/DrawingRail.jsx'));
  const bar = code(read('src/components/chart/DrawingToolbar.jsx'));
  const chart = code(read('src/components/chart/CPChart.jsx'));

  ok('⚠️ the paint tray is gone from the rail', !/🎨/.test(rail) && !/stylePanel/.test(rail));
  ok('⚠️ the magnet button is gone from the rail', !/🧲/.test(rail) && !/onToggleMagnet/.test(rail));
  ok('⚠️ ...and the magnet item is gone from the chart menu too', !/>Magnet</.test(chart));

  // ⚠️ NO GAP WHERE THEY WERE. The rail renders a flat list, so a removed button closes up on its own —
  // what would leave a hole is a divider left stranded with nothing on the far side of it.
  const list = /const buttons = \[([\s\S]*?)\n  \];/.exec(rail);
  ok('the button list was found', !!list);
  ok('⚠️ no divider is left with nothing after it',
    !/divider\('d\d'\),\s*\n\s*\];/.test(list[0]), 'a trailing rule is the gap a removal leaves');

  // ── WHAT MOVED, NOT WHAT VANISHED ──
  ok('⚠️ colour is still reachable, on the selected-drawing toolbar', /CONTROL\.COLOR/.test(bar));
  ok('⚠️ line width too', /CONTROL\.WIDTH/.test(bar));
  ok('⚠️ line style too', /CONTROL\.DASH/.test(bar));
  ok('⚠️ ...along with text, lock and delete',
    /CONTROL\.LABEL/.test(bar) && /CONTROL\.LOCK/.test(bar) && /CONTROL\.DELETE/.test(bar));

  // ⚠️ THE SNAPPING INTERNALS ARE NOT DELETED, they are simply never asked for. Ripping out shared
  // chart internals to remove a button is how an unrelated drawing path breaks.
  const layer = code(read('src/components/chart/DrawingLayer.jsx'));
  ok('⚠️ the snapping code is still present and still correct',
    /stateRef\.current\.magnet/.test(layer));
  ok('⚠️ ...and the one consumer is handed OFF, so a saved magnet:true cannot strand anyone',
    /magnet=\{false\}/.test(chart) && !/magnet=\{view\.magnet/.test(chart));

  // The tools themselves are untouched.
  const tools = read('src/lib/chart/chart-drawings.mjs');
  for (const t of ['horizontal', 'trend', 'ray', 'vertical', 'rectangle', 'fib', 'text']) {
    ok(`the ${t} tool is untouched`, new RegExp(`\\b${t}: \\{`).test(tools) || new RegExp(`id: '${t}'`).test(tools));
  }
}

// ── A SAVED LAYOUT NAMING A REMOVED PANEL STILL LOADS ────────────────────────
//
// ⚠️ THE ONE RISK IN DELETING A REGISTRY ENTRY. Someone's stored workspace still says 'convergence',
// and the requirement is that they get their other panels, not a blank or broken one. Every place a
// stored id is trusted must filter through PANEL_BY_ID, which is what makes an unknown id a discard
// rather than a crash.
{
  const src = fs.readFileSync(path.join(ROOT, 'src/app/terminal/TerminalClient.jsx'), 'utf8');
  ok('⚠️ a saved visible-panel list is filtered against the registry',
    /setVisible\(Array\.isArray\(vis\) && vis\.length \? vis\.filter\(\(id\) => PANEL_BY_ID\[id\]\) : DEFAULT_VISIBLE\)/.test(src));
  ok('⚠️ ...and so is a saved station', /\.filter\(\(id\) => PANEL_BY_ID\[id\]\)/.test(src));
  ok('⚠️ ...and the renderer skips an id it does not know',
    /const def = PANEL_BY_ID\[id\]; if \(!def\) return null;/.test(src));
  // Against CODE: the note explaining the removal names the id, as any honest note would.
  ok('⚠️ ...and a station preset cannot name it either',
    !/'convergence'/.test(code(src)) && !/visible: \[[^\]]*convergence/.test(code(src)));
  ok('the default layout no longer positions it', !/^\s*convergence:\s*\{/m.test(src));
  ok('the colour map no longer lists it', !/convergence: '(green|blue|orange|red)'/.test(src));

  // The panels that share the Terminal with it are untouched.
  for (const id of ['pitscan', 'chart', 'watchlist', 'pitwire']) {
    ok(`${id} is still in the registry`, new RegExp(`id: '${id}'`).test(src));
  }
}

// ── THE EVIDENCE PANEL IS GONE TOO ───────────────────────────────────────────
//
// ⚠️ IT DUPLICATED PIT CONSENSUS. It read /api/consensus and reproduced the same per-family evidence
// the ticker page already shows, so it was removed for the same reason Convergence was — and
// deleted rather than retired for the same reason as well: PANEL_BY_ID is the validation gate, so an
// id nobody defines is discarded from a saved layout and the rest of the workspace loads normally.
//
// ⚠️ AND NOTHING UNDER IT MOVED. /api/consensus, the engine, the Pit Consensus page and the chart's
// evidence markers are untouched — the panel was one consumer, never the source.
{
  const term = fs.readFileSync(path.join(ROOT, 'src/app/terminal/TerminalClient.jsx'), 'utf8');
  ok('⚠️ the Evidence panel component is deleted',
    !fs.existsSync(path.join(ROOT, 'src/components/terminal/EvidencePanel.jsx')));
  ok('⚠️ ...and the bus that fed it, which now has no publisher and no listener',
    !fs.existsSync(path.join(ROOT, 'src/lib/terminalEvidenceBus.js')));
  ok('⚠️ the Terminal registry no longer defines it', !/id: 'evidence'/.test(term));
  ok('⚠️ ...nor positions it, nor colours it',
    !/^\s*evidence:\s*\{/m.test(term) && !/evidence: '(green|blue|orange|red)'/.test(term));
  ok('⚠️ ...and nothing imports the panel or the bus',
    !/EvidencePanel/.test(term) && !/terminalEvidenceBus/.test(term));

  // ⚠️ NO DEAD CONTROLS. Three places used to open the panel. Two were already anchors with a real
  // href, so they simply navigate now; the third was a div that would have become a click doing
  // nothing, and it opens the ticker page in a new tab instead.
  const scan = fs.readFileSync(path.join(ROOT, 'src/components/scan/ScanBoardRows.jsx'), 'utf8');
  ok('⚠️ Pit Scan\'s Evidence control is a plain link, not a dead button',
    /<a href=\{href\}/.test(scan) && !/inspectEvidence/.test(scan));
  ok('...and it still points somewhere real', /evidenceUrl \|\| /.test(scan));
  const shared = fs.readFileSync(path.join(ROOT, 'src/lib/cp-shared.jsx'), 'utf8');
  ok('⚠️ the bell\'s evidence alert navigates instead of being intercepted',
    !/inspectEvidence/.test(shared) && /href=\{`\/ticker\//.test(shared));
  ok('⚠️ the watchlist change line opens the ticker page rather than nothing',
    /window\.open\(`\/ticker\/\$\{encodeURIComponent\(sym\)\}`, '_blank'/.test(term));

  // ⚠️ THE DATA IS NOT THE PANEL.
  ok('⚠️ /api/consensus is untouched', fs.existsSync(path.join(ROOT, 'src/app/api/consensus/route.js')));
  ok('⚠️ the consensus engine is untouched', fs.existsSync(path.join(ROOT, 'src/lib/consensus/synthesis.mjs')));
  ok('⚠️ the Pit Consensus board endpoint is untouched',
    fs.existsSync(path.join(ROOT, 'src/app/api/consensus-board/route.js')));
  ok('⚠️ the chart\'s evidence markers are untouched',
    fs.existsSync(path.join(ROOT, 'src/lib/chart/use-ticker-evidence.js')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
