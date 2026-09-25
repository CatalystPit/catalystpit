// THE TERMINAL'S EVIDENCE INSPECTOR — one panel, re-pointed, and never the wrong ticker.
//
// Three things can go wrong here, and two of them are silent:
//
//   1. A CLICK COSTS THE WORKSPACE. Evidence navigating away is the behaviour being replaced; the
//      failure mode of the replacement is that it still navigates somewhere it should not, or stops
//      navigating on the public page where navigation is the only thing that can happen.
//   2. EVERY CLICK OPENS ANOTHER PANEL. A trader scanning twenty rows ends up with twenty panels.
//   3. ONE TICKER'S EVIDENCE IS SHOWN UNDER ANOTHER'S NAME. CDT then JAGX two seconds apart leaves
//      both requests in flight, and they resolve in whatever order the network decides.
//
// Run: node scripts/verify-terminal-evidence.mjs

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const code = (src) => src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

const bus = read('../src/lib/terminalEvidenceBus.js');
const panel = read('../src/components/terminal/EvidencePanel.jsx');
const rows = read('../src/components/scan/ScanBoardRows.jsx');
const term = read('../src/app/terminal/TerminalClient.jsx');

L('⚠️ THE CHANNEL IS ITS OWN, NOT THE SYMBOL BUS');
{
  // ⚠️ THE CHEAP MOVE WOULD HAVE BEEN TO REUSE selectTerminalSymbol, WHICH ALREADY REACHES EVERY
  // PANEL. It means "the workspace is now looking at NVDA" — the chart follows it. Inspecting a
  // scan row's evidence must not drag the chart off whatever the trader was studying.
  ok('there is a dedicated inspect channel', /export function inspectEvidence/.test(bus));
  ok('…with its own subscription', /export function onEvidenceRequest/.test(bus));
  // Stripped of comments first: the note explaining why this is not the symbol bus necessarily
  // names it, and a check that cannot tell prose from code fails on its own explanation.
  ok('⚠️ it is NOT the symbol bus', !/selectTerminalSymbol/.test(code(bus)));
  ok('⚠️ and the evidence panel does not read the workspace symbol',
    !/selectedSymbol/.test(panel) && /symbol={evidenceSym}/.test(term));
  ok('the workspace symbol still drives the chart', /<ChartBody symbol={selectedSymbol} \/>/.test(term));
  // Window-anchored, for the same reason the symbol bus is.
  ok('the channel is shared across bundles', /window\.__cpEvidenceBus/.test(bus));
  ok('a bad subscriber cannot stop the others', /try \{ fn\(s\); \} catch/.test(bus));
  ok('the ticker is normalised once, at the source', /toUpperCase\(\)\.trim\(\)/.test(bus));
}

L('⚠️ ONE PANEL, RE-POINTED — NOT ONE PER CLICK');
{
  ok('the Terminal subscribes to the channel', /onEvidenceRequest\(\(sym\) =>/.test(term));
  ok('…points the inspector at the new ticker', /setEvidenceSym\(sym\)/.test(term));
  ok('…opens the panel', /addPanel\('evidence'\)/.test(term));
  ok('…and raises it', /bringToFront\('evidence'\)/.test(term));
  // ⚠️ IDEMPOTENT BY CONSTRUCTION. addPanel returns early when the id is already visible, so a
  // second click cannot add a second panel — there is one id and the layout is keyed by it.
  ok('⚠️ opening is idempotent: addPanel refuses a panel that is already visible',
    /const addPanel = \(id\) => \{ if \(visibleRef\.current\.includes\(id\)\) return;/.test(term));
  ok('the panel is a registered Terminal panel, with one id',
    (term.match(/id: 'evidence'/g) || []).length === 1);
  ok('…it has a default position, so it does not open at 0,0', /evidence:\s*\{ x:/.test(term));
  ok('…and it can be added deliberately too, or a user could not get it back after closing',
    /\{ id: 'evidence',\s*title: 'Evidence'/.test(term));
  // ⚠️ ADDING AN ID TO `visible` LEAVES EVERY OTHER PANEL'S ELEMENT AND KEY ALONE. That is what
  // keeps Pit Scan from remounting — losing its tab, its scroll and its already-fetched boards.
  ok('⚠️ panels are keyed by id, so opening one cannot remount another',
    /<div key={id} onPointerDownCapture/.test(term));
}

L('⚠️ THE PUBLIC PAGE STILL NAVIGATES');
{
  // The same row renders on /scan, where there is no workspace to open a panel in.
  ok('the row asks whether an inspector exists', /evidenceInspectorAvailable\(\)/.test(rows));
  ok('⚠️ …and navigates when there is none', /if \(!evidenceInspectorAvailable\(\)\) return;/.test(rows));
  ok('the availability answer is the live subscriber count, not a flag someone sets',
    /return !!b && b\.subs\.size > 0;/.test(bus));
  ok('⚠️ it is an anchor, so middle-click and open-in-new-tab still work',
    /<a href={href}/.test(rows) && /Evidence<\/a>/.test(rows));
  ok('…and a modified click is left to the browser',
    /if \(e\.metaKey \|\| e\.ctrlKey \|\| e\.shiftKey \|\| e\.button !== 0\) return;/.test(rows));
  ok('⚠️ the default is only prevented when the inspector will actually handle it',
    /e\.preventDefault\(\);\s*\n\s*inspectEvidence\(ticker\)/.test(rows));
  // ⚠️ ALERT BECAME A COMPONENT AND IS STILL THERE. It is now the shared AlertToggle, which
  // subscribes the ticker to Evidence Alerts instead of creating a news rule; Chart and Watch are
  // unchanged. The point of this assertion — that wiring Evidence into the inspector did not
  // disturb the row's other actions — is unchanged, so it follows the control rather than failing.
  ok('the other three row actions are untouched',
    /Chart<\/a>/.test(rows) && />Watch<\/button>/.test(rows) && /<AlertToggle symbol=\{r\.ticker\}/.test(rows));
}

L('⚠️ ANOTHER CONSUMER OF THE CANONICAL ENGINE, NOT ANOTHER ENGINE');
{
  ok('the panel reads the canonical consensus endpoint', /\/api\/consensus\?ticker=/.test(panel));
  // ⚠️ IT MUST AGREE WITH THE TICKER PAGE, which can only be guaranteed by reading the same thing
  // and reproducing it rather than re-deriving anything from it.
  ok('⚠️ it holds no thresholds of its own',
    !/threshold|>= 0\.\d|materiality >|confidence >/i.test(code(panel)));
  ok('⚠️ it computes no state — the engine\'s own word is printed', /shown\.state/.test(panel) && /f\.state \|\|/.test(panel));
  ok('…and the family reasons are reproduced, not summarised', /reasons\.slice\(0, 3\)/.test(panel));
  ok('it does not rebuild or recompute anything',
    !/buildScanBoardPayload|rebuildBoard|scoreTicker|computeConsensus/.test(panel));
  ok('sources are linked for verification', /sec\.gov/.test(panel) && /f\.refs/.test(panel));
  ok('every evidence family the engine reports can appear',
    ['insiders', 'institutions', 'congress', 'catalysts'].every((k) => panel.includes(k)));
  ok('⚠️ leaving the Terminal stays an explicit choice', /Open full ticker/.test(panel));
  ok('…and it is the only navigation in the panel',
    (panel.match(/href=/g) || []).length === (panel.match(/href={`\/ticker\//g) || []).length + (panel.match(/href={`https:\/\/www\.sec\.gov/g) || []).length);
}

L('⚠️ NEVER ONE TICKER\'S EVIDENCE UNDER ANOTHER\'S NAME');
{
  // Two guards, and the second is the one that covers the RENDER rather than the fetch.
  ok('⚠️ a superseded request cannot land', /gen !== reqRef\.current/.test(panel));
  ok('⚠️ and the payload is only painted when it names the ticker asked for',
    /String\(data\.ticker \|\| ''\)\.toUpperCase\(\) === sym \? data : null/.test(panel));
  ok('a miss clears the panel rather than leaving the previous ticker on screen',
    /\} else \{ setData\(null\); setState\('loading'\); \}/.test(panel));
  ok('every request is on a clock', /AbortSignal\.timeout\(/.test(panel));
  ok('a failure with nothing behind it is stated, not left loading', /state === 'error'/.test(panel));
  ok('…and it does not claim there is no evidence', /not a statement that there is none/.test(panel));
}

L('THE CACHE IS BOUNDED, AND KEYED BY TICKER');
{
  ok('it is keyed by symbol, so a hit is by definition the right ticker', /cacheGet\(sym\)/.test(panel));
  ok('⚠️ it is bounded', /while \(cache\.size > MAX_CACHED\)/.test(panel));
  ok('…small enough to be a rotation', /const MAX_CACHED = \d\d?;/.test(panel));
  ok('…and it expires', /now - hit\.at > TTL_MS/.test(panel));
  ok('a read counts as a use, so the ticker kept returning to survives eviction',
    /cache\.delete\(sym\); cache\.set\(sym, hit\);/.test(panel));
  // ⚠️ THE CACHE REMOVES THE BLANK, NOT THE REFRESH.
  ok('⚠️ a cache hit still refreshes', !/if \(cached\) \{[\s\S]{0,200}return;/.test(panel));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
