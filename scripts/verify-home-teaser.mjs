// ⚠️ THE HOMEPAGE TEASER, RENDERED IN ALL THREE AUTH STATES.
//
//   node scripts/verify-home-teaser.mjs
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────────
//
// HomeTeaserGate returned its children unconditionally, so every visitor — signed in or not — was
// shown three hardcoded placeholder rows blurred at 4px. Both call sites had been passing the props
// for both states all along and nothing read any of them, which is exactly the kind of defect that
// no source-reading assertion catches: the component was valid, the build was green, and the props
// were right there in the JSX.
//
// So this RENDERS it, three times, against three different Clerk stubs. The signed-in case is the
// one that matters most and the one a browser cannot easily check — there are no test credentials —
// and it is the case that was broken.

import { build } from 'esbuild';
import { renderToString } from 'react-dom/server';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
// INSIDE the project on purpose: react stays external so the component shares one React instance
// with the renderer, and node only resolves a bare 'react' specifier from inside the package tree.
const TMP = path.join(ROOT, 'node_modules', '.cache', 'cp-teaser');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

let pass = 0, fail = 0;
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${d ? ` — ${d}` : ''}`); }
};
const L = (s) => console.log(`\n${s}`);

const NEXT_STUB = path.join(TMP, 'next-stub.mjs');
fs.writeFileSync(NEXT_STUB, `
export const useRouter = () => ({ push() {}, replace() {}, refresh() {}, prefetch() {}, back() {} });
export const usePathname = () => '/';
export const useSearchParams = () => new URLSearchParams();
export const useParams = () => ({});
export const redirect = () => {};
export const notFound = () => {};
export default {};
`);

/** A Clerk stub for one specific auth state. */
function clerkStub(name, { isLoaded, isSignedIn }) {
  const p = path.join(TMP, `clerk-${name}.mjs`);
  fs.writeFileSync(p, `
export const SignedIn = () => null;
export const SignedOut = ({ children }) => children ?? null;
export const UserButton = () => null;
export const useAuth = () => ({ isLoaded: ${isLoaded}, isSignedIn: ${isSignedIn}, userId: ${isSignedIn ? "'user_test'" : 'null'} });
export const useUser = () => ({ isLoaded: ${isLoaded}, isSignedIn: ${isSignedIn}, user: null });
export const useClerk = () => ({ signOut: async () => {}, openUserProfile: () => {} });
export const ClerkProvider = ({ children }) => children ?? null;
export default {};
`);
  return p;
}

async function renderGate(name, state, props) {
  const out = path.join(TMP, `teaser-${name}.mjs`);
  await build({
    entryPoints: [path.join(ROOT, 'src/components/CatalystPit.jsx')],
    bundle: true, format: 'esm', platform: 'node', outfile: out,
    jsx: 'automatic', loader: { '.js': 'jsx' },
    external: ['react', 'react-dom', 'react/jsx-runtime', 'server-only'],
    alias: {
      'next/navigation': NEXT_STUB, 'next/link': NEXT_STUB, 'next/image': NEXT_STUB,
      '@clerk/nextjs': clerkStub(name, state),
    },
    logLevel: 'silent', absWorkingDir: ROOT,
  });
  const mod = await import(pathToFileURL(out).href);
  const Gate = mod.HomeTeaserGate;
  if (typeof Gate !== 'function') throw new Error('HomeTeaserGate is not exported');
  // The children are the blurred placeholder rows the real call sites pass.
  const blurred = React.createElement('div', { style: { filter: 'blur(4px)' } }, '████');
  return renderToString(React.createElement(Gate, props, blurred));
}

const PROPS = {
  anonTitle: 'Sign in to explore all insider trades',
  anonSub: 'Free account · SEC Form 4 filings',
  proTitle: 'More insider research',
  proSub: 'Full Form 4 history, filters and pagination',
  href: '/insiders', proCta: 'Open Insiders',
};

// ── 1. LOADING ───────────────────────────────────────────────────────────────
L('⚠️ 1 — while authentication is loading, neither state is guessed');
{
  const html = await renderGate('loading', { isLoaded: false, isSignedIn: false }, PROPS);
  ok('⚠️ renders nothing at all', html === '', JSON.stringify(html.slice(0, 120)));
  // Both wrong guesses are worse than a blank strip for a frame: defaulting to signed-out flashes a
  // sign-in pitch at a member, and defaulting to signed-in shows an anonymous visitor the member
  // view and then takes it away.
  ok('…so no blur is shown before the answer', !/blur\(/.test(html));
  ok('…and no sign-in prompt is shown before the answer', !/Sign In to See More/.test(html));
}

// ── 2. SIGNED OUT ────────────────────────────────────────────────────────────
L('⚠️ 2 — a signed-out visitor gets the blurred teaser and a visible prompt');
{
  const html = await renderGate('anon', { isLoaded: true, isSignedIn: false }, PROPS);
  ok('⚠️ the blurred rows are still shown', /blur\(4px\)/.test(html));
  ok('⚠️ the button says "Sign In to See More"', /Sign In to See More/.test(html));
  ok('⚠️ …and it points at /sign-in', /href="\/sign-in\?/.test(html));
  // ⚠️ AND IT COMES BACK TO THIS SECTION'S OWN PAGE. The whole reason each call site passes a
  // different href: returning everyone to the homepage after sign-in would drop them exactly where
  // they already were, having asked them to authenticate for nothing.
  ok('⚠️ …and returns them to the matching research page',
    /redirect_url=%2Finsiders/.test(html), html.match(/href="[^"]*sign-in[^"]*"/)?.[0]);
  ok('the anonymous copy is used, not the member copy',
    html.includes('Sign in to explore all insider trades') && !html.includes('More insider research'));
  // ⚠️ THE PROMPT MUST SIT OVER THE BLUR, and the containing block is what decides that.
  //
  // The first version of this assertion checked only that SOME element was position:absolute and
  // that the blur appeared earlier in the markup. Mutation testing killed it: removing
  // position:relative from the wrapper left both of those true while the absolutely-positioned
  // prompt escaped to the nearest positioned ancestor — centred over something else entirely, or
  // over the viewport. "Centered over the blurred section" is a claim about the containing block,
  // so it is now asserted on the containing block.
  const wrapper = html.slice(0, html.indexOf('blur(4px)'));
  ok('⚠️ the blur sits inside a positioned container',
    /position:relative/.test(wrapper), wrapper.slice(-160));
  ok('⚠️ …and the prompt is absolutely positioned within it, covering it',
    /position:absolute/.test(html) && /inset:0/.test(html)
    && html.indexOf('blur(4px)') < html.indexOf('Sign In to See More'));
  ok('…and the scrim cannot swallow the click it exists to make readable',
    /pointer-events:none/.test(html));
}

// ── 3. SIGNED IN ─────────────────────────────────────────────────────────────
L('⚠️ 3 — a signed-in member never sees a placeholder');
{
  const html = await renderGate('member', { isLoaded: true, isSignedIn: true }, PROPS);
  // ⚠️ THE DEFECT, ASSERTED DIRECTLY. This is what was shipping to every signed-in member.
  ok('⚠️ NO blurred rows', !/blur\(/.test(html), html.slice(0, 200));
  ok('⚠️ no placeholder block characters', !/█/.test(html));
  ok('⚠️ no sign-in prompt for somebody already signed in', !/Sign In to See More/.test(html));
  ok('⚠️ …and no link to /sign-in at all', !/\/sign-in/.test(html));
  ok('⚠️ a link to the full research page is offered instead',
    /href="\/insiders"/.test(html));
  ok('…using the member copy', html.includes('More insider research'));
  ok('…and the call to action names the destination', html.includes('Open Insiders'));
}

// ── 4. THE SAME GUARANTEES FOR THE POLITICIAN SECTION ────────────────────────
L('⚠️ 4 — the politician section is the same component, so it cannot drift');
{
  const POL = {
    anonTitle: 'Sign in to explore all politician trades',
    anonSub: 'Free account · STOCK Act disclosures',
    proTitle: 'More congressional disclosures',
    proSub: 'Full STOCK Act history, by member and by ticker',
    href: '/politicians', proCta: 'Open Politicians',
  };
  const anon = await renderGate('anon-pol', { isLoaded: true, isSignedIn: false }, POL);
  ok('⚠️ signed out returns to /politicians, not /insiders',
    /redirect_url=%2Fpoliticians/.test(anon));
  const member = await renderGate('member-pol', { isLoaded: true, isSignedIn: true }, POL);
  ok('⚠️ signed in sees no blur here either', !/blur\(/.test(member));
  ok('…and is linked to /politicians', /href="\/politicians"/.test(member));
}

// ── 5. IT IS AUTH, NOT ENTITLEMENT ───────────────────────────────────────────
L('⚠️ 5 — the decision is authentication, never paid status');
{
  // ⚠️ THIS IS A SIGN-UP PROMPT, NOT A PAYWALL. Research is free and stays free, so routing
  // this through entitlement would quietly convert a homepage presentation choice into a second
  // research paywall — and would show the blur to a free registered member, who is signed in.
  // ⚠️ LINE ENDINGS NORMALISED FIRST, AND THE SCOPE VERIFIED BEFORE IT IS TRUSTED.
  //
  // The first version sliced on '\n}\n' against a CRLF file, so indexOf returned -1, slice(0, -1)
  // kept everything to the end of the file, and this section was quietly asserting about 900 lines
  // instead of twenty. Mutation testing caught it: swapping useAuth for useProEntitlement inside the
  // gate SURVIVED, because the wider text still satisfied every pattern. A mis-scoped assertion is
  // the most expensive kind — it is green, it is specific, and it is about the wrong code.
  const src = fs.readFileSync(path.join(ROOT, 'src/components/CatalystPit.jsx'), 'utf8')
    .replace(/\r\n/g, '\n');
  const start = src.indexOf('export function HomeTeaserGate');
  const end = src.indexOf('\n}\n', start);
  ok('the gate’s source was located, so the checks below are scoped to it',
    start >= 0 && end > start && end - start < 6000, `start=${start} end=${end}`);
  const fn = src.slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('⚠️ the gate reads Clerk auth state', /useAuth\(\)/.test(fn));
  ok('⚠️ …and never consults entitlement or a plan',
    !/useProEntitlement/.test(fn) && !/\bpro\b/.test(fn) && !/api\/me\/plan/.test(fn)
    && !/tier/.test(fn), fn.slice(0, 200));
  ok('⚠️ …and renders nothing before isLoaded resolves', /if \(!isLoaded\) return null;/.test(fn));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
