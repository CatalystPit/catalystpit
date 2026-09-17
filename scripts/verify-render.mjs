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

/** The client components a broken render would take a whole page down with. */
const TARGETS = [
  { file: 'src/components/chart/CPChart.jsx', props: { symbol: 'SPY', initialTimeframe: '1D', transparent: true } },
  { file: 'src/components/chart/TickerPriceChart.jsx', props: { symbol: 'SPY' } },
  { file: 'src/components/scan/PitScanPanel.jsx', props: { onPick: () => {} } },
  { file: 'src/components/scan/CustomScannerPanel.jsx', props: { onPick: () => {} } },
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
      alias: { 'next/navigation': STUB, 'next/link': STUB, 'next/image': STUB },
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
  ok(`${target.file} exports a component`, typeof mod.default === 'function');
  if (typeof mod.default !== 'function') continue;

  // THE ASSERTION THAT MATTERS. A temporal-dead-zone reference, a missing import, a null deref on
  // first render — all of them surface here and nowhere else in this repo's tests.
  try {
    const html = renderToString(React.createElement(mod.default, target.props));
    ok(`${target.file} renders`, typeof html === 'string' && html.length > 0);
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

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
