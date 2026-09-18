// DOES IT ACTUALLY RENDER?
//
//   node scripts/verify-render.mjs
//
// Every other suite in this repo asserts things ABOUT the source. None of them ever rendered a
// component, and that gap let a chart regression reach production: a hook dependency array listed a
// `const` declared forty lines further down, React evaluated that array eagerly on the first render,
// and the whole Terminal went into the error boundary. The build compiled it happily — a temporal
// dead zone is valid JavaScript — and 931 chart assertions passed, because not one of them rendered
// anything.
//
// So this script does the one thing they did not: it bundles each major client component and renders
// it. A component that throws at module evaluation or on first render fails here instead of in front
// of a trader.
//
// It also runs a cheap static check for the specific defect above, because the error message a
// forward reference produces is much less obvious than the rule it breaks.

import { build } from 'esbuild';
import { renderToString } from 'react-dom/server';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
// INSIDE the project on purpose: react is left external so the component shares one React instance
// with the renderer, and node only resolves a bare 'react' specifier from inside the package tree.
const TMP = path.join(ROOT, "node_modules", ".cache", "cp-render");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

// Next's own runtime hooks are not what is under test; stubbed so the component's code is.
const STUB = path.join(TMP, 'next-stub.mjs');
fs.writeFileSync(STUB, `
export const useRouter = () => ({ push() {}, replace() {}, refresh() {}, prefetch() {}, back() {} });
export const usePathname = () => '/';
export const useSearchParams = () => new URLSearchParams();
export const useSelectedLayoutSegments = () => [];
export const useSelectedLayoutSegment = () => null;
export const useParams = () => ({});
export const redirect = () => {};
export const permanentRedirect = () => {};
export const notFound = () => {};
export const RedirectType = { push: 'push', replace: 'replace' };
export default {};
`);

// Clerk ships CommonJS, which esbuild cannot turn into an ESM bundle without a dynamic require of
// React at runtime. Auth is not what is under test — every page-level component reaches it only
// through cp-shared's nav — so it is stubbed for the same reason Next's router is.
const CLERK_STUB = path.join(TMP, 'clerk-stub.mjs');
fs.writeFileSync(CLERK_STUB, `
export const SignedIn = () => null;
export const SignedOut = ({ children }) => children ?? null;
export const UserButton = () => null;
export const useAuth = () => ({ isLoaded: true, isSignedIn: false, userId: null });
export const useUser = () => ({ isLoaded: true, isSignedIn: false, user: null });
export const ClerkProvider = ({ children }) => children ?? null;
export default {};
`);

/** The client components a broken render would take a whole page down with. */
const TARGETS = [
  { file: 'src/components/chart/CPChart.jsx', props: { symbol: 'SPY', initialTimeframe: '1D', transparent: true } },
  { file: 'src/components/chart/TickerPriceChart.jsx', props: { symbol: 'SPY' } },
  { file: 'src/components/scan/PitScanPanel.jsx', props: { onPick: () => {} } },
  { file: 'src/components/scan/CustomScannerPanel.jsx', props: { onPick: () => {} } },
  // The column-help tooltip, and the two pages that mount it. The Dividend Calendar renders eight of
  // them inside sortable headers; the Insiders page had its own copy until they were merged, and a
  // shared component that throws would now take BOTH pages down rather than one.
  { file: 'src/components/InfoTip.jsx', props: { title: 'Dividend Yield', body: 'An explanation.', label: 'Dividend Yield' } },
  // The hover preview reads window.innerWidth to flip itself on-screen, so its SSR contract is that
  // it renders NOTHING until something has been hovered. That is asserted, not assumed: a version
  // that touched the window during render would throw here rather than on a reader's first paint.
  { file: 'src/components/TickerHoverChart.jsx', export: 'TickerHoverPreview', props: { hover: null }, expectEmpty: true },
  {
    file: 'src/app/dividends/DividendsClient.jsx',
    props: {
      enabled: true,
      display: 'prelaunch',
      initial: {
        enabled: true, mode: 'ex', from: '2026-09-14', to: '2026-09-20', total: 1,
        events: [{
          ticker: 'UTF', company: 'COHEN & STEERS INFRASTRUCTURE FUND INC', sector: null,
          marketCap: 2.4e9, exDividendDate: '2026-09-18', paymentDate: '2026-09-30',
          recordDate: '2026-09-18', declarationDate: '2026-09-01', cashAmount: 0.155,
          currency: 'USD', dividendType: 'regular', frequency: 12, annualizedAmount: 1.86,
          yieldPct: 7.42,
        }],
        asOf: '2026-09-18T16:19:12.258Z', source: 'scheduled-ingest',
      },
    },
    // THE EIGHT COLUMN TOOLTIPS, asserted against the real markup rather than the source.
    assert: (html, check) => {
      const triggers = [...html.matchAll(/aria-label="What does ([^"]+) mean\?"/g)].map((m) => m[1]);
      check('every data column header carries an info trigger', triggers.length === 8, `got ${triggers.length}`);
      check('and they are the eight documented ones',
        [...triggers].sort().join('|') === [
          'Declaration Date', 'Dividend Amount', 'Dividend Frequency', 'Dividend Yield',
          'Ex-Dividend Date', 'Market Capitalization', 'Payment Date', 'Record Date',
        ].join('|'), triggers.join(', '));
      // Symbol and Company must NOT have one — the clutter this design deliberately avoids.
      check('Symbol and Company have no info trigger',
        !/What does Symbol mean/.test(html) && !/What does Company mean/.test(html));
      // Closed by default: a tooltip that renders its panel on the server would flash eight boxes
      // over the table on first paint.
      check('no tooltip panel is open on first paint', !/role="tooltip"/.test(html));
      // Real <button>s in the tab order, reporting their state — not spans with a hover handler,
      // which is what made the original version unreachable by keyboard.
      check('the triggers are real buttons, closed, in the tab order',
        (html.match(/<button type="button" aria-label="What does [^"]+ mean\?" aria-expanded="false"/g) || []).length === 8);
      // Themed from design tokens, so dark mode needs no second stylesheet and cannot drift.
      check('the trigger is themed from design tokens, not hard-coded colours',
        /aria-label="What does Dividend Yield mean\?"[^>]*var\(--cp-border/.test(html));
      // The trigger sits INSIDE the sortable header, so the header still sorts and the icon does not
      // replace it.
      check('the headers are still sortable', (html.match(/title="Sort"/g) || []).length >= 8);
    },
  },
  // The other page that mounts the shared tooltip. It was not covered before, which is precisely why
  // merging its private copy into a shared component needed it to be.
  { file: 'src/app/insiders/InsidersClient.jsx', props: {} },
];

console.log('rendering the components a failure would take a page down with\n');

for (const target of TARGETS) {
  const out = path.join(TMP, `${path.basename(target.file, '.jsx')}.mjs`);
  let built = true;
  try {
    await build({
      entryPoints: [path.join(ROOT, target.file)],
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile: out,
      jsx: 'automatic',
      loader: { '.js': 'jsx' },
      // React stays external so hooks share one instance with the renderer below.
      external: ['react', 'react-dom', 'react/jsx-runtime', 'server-only'],
      alias: { 'next/navigation': STUB, 'next/link': STUB, 'next/image': STUB, '@clerk/nextjs': CLERK_STUB },
      logLevel: 'silent',
      absWorkingDir: ROOT,
    });
  } catch (e) {
    built = false;
    ok(`${target.file} bundles`, false, e.message.split('\n')[0]);
  }
  if (!built) continue;
  ok(`${target.file} bundles`, true);

  let mod = null;
  try {
    mod = await import(pathToFileURL(out).href);
  } catch (e) {
    ok(`${target.file} evaluates`, false, e.message);
    continue;
  }
  ok(`${target.file} evaluates`, true);
  // Most targets are a default export; a named one (the hover preview) says which.
  const Component = target.export ? mod[target.export] : mod.default;
  ok(`${target.file} exports a component`, typeof Component === 'function');
  if (typeof Component !== 'function') continue;

  // THE ASSERTION THAT MATTERS. A temporal-dead-zone reference, a missing import, a null deref on
  // first render — all of them surface here and nowhere else in this repo's tests.
  try {
    const html = renderToString(React.createElement(Component, target.props));
    ok(`${target.file} renders`,
      typeof html === 'string' && (target.expectEmpty ? html.length === 0 : html.length > 0));
    // A target may also assert things about the markup it produced — which is the only way to check
    // what a component actually rendered rather than what its source appears to say.
    if (target.assert) target.assert(html, ok);
  } catch (e) {
    ok(`${target.file} renders`, false, `${e.name}: ${e.message}`);
  }
}

// ── the static check for the exact defect ────────────────────────────────────
// A hook's dependency array is evaluated EAGERLY during render, so it may not name a `const`
// declared later in the same function. The callback body may — it runs afterwards — which is what
// makes this easy to write and hard to spot.
console.log('\nchecking hook dependency arrays for forward references');
{
  const files = [
    'src/components/chart/CPChart.jsx',
    'src/components/chart/DrawingLayer.jsx',
    'src/components/chart/DrawingRail.jsx',
    'src/components/chart/ChartUI.jsx',
    'src/components/scan/PitScanPanel.jsx',
    'src/components/scan/CustomScannerPanel.jsx',
  ];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');

    // SCOPED PER FUNCTION. A name that is a parameter of one component and a const of another is not
    // a forward reference; checking the whole file at once reports those as offenders, and a check
    // that cries wolf stops being believed.
    const starts = [...src.matchAll(/^(?:export default )?function\s+\w+/gm)].map((m) => m.index);
    const blocks = starts.map((start, i) => src.slice(start, starts[i + 1] ?? src.length));

    const offenders = [];
    for (const body of blocks) {
      const declaredAt = new Map();
      for (const m of body.matchAll(/^\s*const\s+([A-Za-z_$][\w$]*)\s*=/gm)) {
        if (!declaredAt.has(m[1])) declaredAt.set(m[1], m.index);
      }
      for (const m of body.matchAll(/\b(?:useCallback|useMemo|useEffect|useLayoutEffect)\s*\(/g)) {
        const at = m.index;
        const dep = body.slice(at, at + 2000).match(/\}?\s*,\s*\[([^\]]*)\]\s*\)/);
        if (!dep) continue;
        for (const raw of dep[1].split(',')) {
          const name = raw.trim().split('.')[0];
          if (!name || !declaredAt.has(name)) continue;
          if (declaredAt.get(name) > at) offenders.push(name);
        }
      }
    }
    ok(`${rel} has no forward reference in a hook dependency array`,
      offenders.length === 0, [...new Set(offenders)].join(', '));
  }
}

// ── can a menu row actually be clicked? ──────────────────────────────────────
// Rendering to a string proves a component does not throw; it cannot prove a menu WORKS. A popover
// that registered itself in the dismissal stack from an effect keyed on `open` ran that effect before
// its panel existed, so a mousedown on its own row counted as an outside click and shut the menu
// before the row's click landed. Every chart menu was affected, and it surfaced as "Ray, Horizontal
// Line and Vertical Line do nothing" — the three tools that can only be picked from the Lines flyout.
//
// So this MOUNTS the real rail with react-dom/client over a deliberately tiny DOM and delivers the
// gesture the way a browser does: mousedown, let React flush, then click — and, as a browser does,
// no click at all if the row was removed in between.
console.log('\nmounting the drawing rail and picking tools from its flyout');
{
  class FakeNode {
    constructor(nodeType, name, doc) {
      this.nodeType = nodeType; this.nodeName = name; this.tagName = name; this.ownerDocument = doc;
      this.childNodes = []; this.parentNode = null; this.style = {}; this.attributes = {};
      this.listeners = []; this.namespaceURI = 'http://www.w3.org/1999/xhtml'; this._text = '';
    }
    get firstChild() { return this.childNodes[0] || null; }
    get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
    get nextSibling() {
      const p = this.parentNode; if (!p) return null;
      return p.childNodes[p.childNodes.indexOf(this) + 1] || null;
    }
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
    insertBefore(c, ref) {
      if (!ref) return this.appendChild(c);
      if (c.parentNode) c.parentNode.removeChild(c);
      c.parentNode = this; this.childNodes.splice(this.childNodes.indexOf(ref), 0, c); return c;
    }
    removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
    contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
    closest(sel) {
      const attr = sel.replace(/^\[|\]$/g, '');
      for (let x = this; x && x.nodeType === 1; x = x.parentNode) if (attr in x.attributes) return x;
      return null;
    }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    removeAttribute(k) { delete this.attributes[k]; }
    getAttribute(k) { return this.attributes[k] ?? null; }
    hasAttribute(k) { return k in this.attributes; }
    addEventListener(type, fn) { this.listeners.push({ type, fn }); }
    removeEventListener(type, fn) { this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn)); }
    getBoundingClientRect() { return { top: 40, bottom: 66, left: 0, right: 34, width: 34, height: 26 }; }
    set textContent(v) { this.childNodes = []; this._text = String(v); }
    get textContent() { return this._text + this.childNodes.map((c) => c.textContent ?? c.nodeValue ?? '').join(''); }
  }
  const doc = new FakeNode(9, '#document', null);
  doc.createElement = (t) => new FakeNode(1, t.toUpperCase(), doc);
  doc.createTextNode = (t) => { const n = new FakeNode(3, '#text', doc); n.nodeValue = t; return n; };
  doc.createElementNS = (ns, t) => { const n = new FakeNode(1, t, doc); n.namespaceURI = ns; return n; };
  doc.documentElement = doc.createElement('html');
  doc.body = doc.createElement('body');
  doc.appendChild(doc.documentElement);
  doc.documentElement.appendChild(doc.body);
  const win = {
    document: doc, event: undefined, innerWidth: 1400, innerHeight: 900, devicePixelRatio: 1,
    addEventListener() {}, removeEventListener() {}, getComputedStyle: () => ({}),
    HTMLIFrameElement: function HTMLIFrameElement() {}, HTMLElement: FakeNode,
  };
  doc.defaultView = win;
  globalThis.window = win;
  globalThis.document = doc;
  globalThis.HTMLIFrameElement = win.HTMLIFrameElement;

  const all = (node, pred, acc = []) => {
    if (pred(node)) acc.push(node);
    for (const c of node.childNodes) all(c, pred, acc);
    return acc;
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  // Bubble from the target to the document, as the browser would, with window.event set so React
  // assigns the same (discrete) priority a real pointer gesture gets.
  const dispatch = (type, target) => {
    const ev = {
      type, target, srcElement: target, bubbles: true, cancelable: true, defaultPrevented: false,
      button: 0, buttons: 1, detail: 1, timeStamp: Date.now(), isTrusted: true,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() {},
    };
    win.event = ev;
    const path = [];
    for (let x = target; x; x = x.parentNode) path.push(x);
    for (const node of path) for (const l of [...node.listeners]) if (l.type === type) l.fn(ev);
    win.event = undefined;
  };
  const press = async (target) => {
    dispatch('mousedown', target);
    await tick();
    // A row that was unmounted by its own mousedown never receives the click.
    if (doc.contains(target)) dispatch('click', target);
    await tick();
  };

  const railOut = path.join(TMP, 'DrawingRail.client.mjs');
  let DrawingRail = null;
  let ReactDOMClient = null;
  try {
    await build({
      entryPoints: [path.join(ROOT, 'src/components/chart/DrawingRail.jsx')],
      bundle: true, format: 'esm', platform: 'node', outfile: railOut, jsx: 'automatic',
      external: ['react', 'react-dom', 'react/jsx-runtime'], logLevel: 'silent', absWorkingDir: ROOT,
    });
    DrawingRail = (await import(pathToFileURL(railOut).href)).default;
    ReactDOMClient = await import('react-dom/client');
  } catch (e) {
    ok('the drawing rail mounts in a DOM', false, `${e.name}: ${e.message}`);
  }

  if (DrawingRail && ReactDOMClient) {
    const picks = [];
    const noop = () => {};
    const container = doc.createElement('div');
    doc.body.appendChild(container);
    let mountError = null;
    // React reports a render error through this hook rather than by throwing out of render(), so
    // without it a rail that crashed on mount would read as one that mounted.
    const root = ReactDOMClient.createRoot(container, { onUncaughtError: (e) => { mountError = mountError || e; } });
    try {
      root.render(React.createElement(DrawingRail, {
        theme: 'dark', activeTool: null, onPick: (t) => picks.push(t),
        style: { color: 0, width: 2, dash: 'solid' }, onStyle: noop, selected: false, onDelete: noop,
        count: 0, showDrawings: true, onToggleShow: noop, onClearAll: noop, onToggleMagnet: noop,
        onOpenManager: noop, onUndo: noop, onRedo: noop,
      }));
      await tick(); await tick();
    } catch (e) { mountError = e; }
    ok('the drawing rail mounts in a DOM', !mountError && container.childNodes.length > 0, mountError ? `${mountError.name}: ${mountError.message}` : '');

    const flyoutArrow = () => all(doc, (n) => n.attributes?.['aria-label'] === 'Lines tools' && n.nodeName === 'BUTTON')[0] || null;
    const openMenu = () => all(doc.body, (n) => n.attributes?.role === 'menu' && n.attributes?.['aria-label'] === 'Lines tools')[0] || null;
    const rowFor = (label) => all(doc.body, (n) => n.nodeName === 'BUTTON' && n.attributes?.role === 'menuitemradio'
      && n.textContent.includes(label))[0] || null;

    for (const [label, id] of [['Ray', 'ray'], ['Horizontal line', 'horizontal'], ['Vertical line', 'vertical'], ['Trend line', 'trend']]) {
      picks.length = 0;
      const arrow = flyoutArrow();
      if (arrow) await press(arrow);
      ok(`the Lines flyout opens (for ${label})`, !!openMenu());
      const row = rowFor(label);
      ok(`the Lines flyout lists ${label}`, !!row);
      if (row) await press(row);
      ok(`picking ${label} from the Lines flyout arms '${id}'`, picks.length === 1 && picks[0] === id,
        `onPick received ${JSON.stringify(picks)}`);
      ok(`the Lines flyout closes after picking ${label}`, !openMenu());
    }

    // THE OTHER HALF OF DISMISSAL. A fix that simply never closed would pass everything above; an
    // outside mousedown must still shut the menu.
    const arrow = flyoutArrow();
    if (arrow) await press(arrow);
    const wasOpen = !!openMenu();
    const outside = doc.createElement('div');
    doc.body.appendChild(outside);
    dispatch('mousedown', outside);
    await tick();
    ok('an outside mousedown still closes the Lines flyout', wasOpen && !openMenu(),
      `open before: ${wasOpen}, open after: ${!!openMenu()}`);

    try { root.unmount(); } catch { /* the fake DOM is disposable */ }
  }
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.HTMLIFrameElement;
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
