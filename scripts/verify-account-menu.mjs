// THE ACCOUNT MENU IS OURS; THE SECURITY IS STILL CLERK'S.
//
//   node --experimental-loader ./scripts/jsx-loader.mjs scripts/verify-account-menu.mjs [--mutate=m]
//
// ⚠️ THE ONE THAT MATTERS: the tier badge must come from the SERVER. publicMetadata is readable and
// editable in the browser, so a badge derived from the client session would be a cosmetic lie — and
// if anything downstream ever trusted it, a bypass.
//
// Mutations:  --mutate=clienttier   the badge reads the client session instead of /api/me/plan
//             --mutate=userbutton   Clerk's prebuilt dropdown is mounted again

const L = (s='') => console.log(s);
const MUT = (process.argv.find(a=>a.startsWith('--mutate'))||'').split('=')[1] || '';
const mut = (m) => MUT === m || MUT === 'all';
let pass=0, fail=0;
const ok=(n,c,d='')=>{ if(c){pass++;L(`  ok   ${n}`);} else {fail++;L(`  FAIL ${n}${d?' — '+d:''}`);} };
const fs = await import('node:fs/promises');
const read = (p) => fs.readFile(new URL(p, import.meta.url), 'utf8');

const raw = (p) => read(p);
// ⚠️ STRIP COMMENTS BEFORE ASSERTING. Three assertions here failed against correct code because
// they matched the comment EXPLAINING the thing they forbid — "publicMetadata is editable in
// devtools", "we do not reimplement password and MFA", "carrying Secured by Clerk". A test that
// reads prose as implementation reports its own sloppiness as a defect in the code.
const strip = (t) => t
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const menuSrc = await raw('../src/components/AccountMenu.jsx');
const navSrc  = await raw('../src/lib/cp-shared.jsx');
const menu = strip(menuSrc);
const nav  = strip(navSrc);

L('=== ⚠️ ENTITLEMENT IS SERVER-RESOLVED, NEVER CLIENT-READ ===');
ok('⚠️ the tier comes from /api/me/plan',
  mut('clienttier') ? false : /fetch\('\/api\/me\/plan'/.test(menu));
ok('⚠️ the badge never reads publicMetadata in the browser',
  mut('clienttier') ? false : !/publicMetadata/.test(menu),
  'publicMetadata is editable in devtools; a badge from it would be a lie at best');
ok('…and no tier is inferred from the session object',
  !/user\.(plan|tier|subscription)/.test(menu));
ok('the menu decides presentation only, not access',
  !/entitl|paywall|gate/i.test(menu.replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'')));

L('\n=== ⚠️ CLERK STILL DOES THE SECURITY WORK ===');
ok('sign-out is Clerk’s', /useClerk\(\)/.test(menu) && /signOut\(/.test(menu));
ok('identity is Clerk’s', /useUser\(\)/.test(menu));
ok('⚠️ no password field is implemented here', !/password|passwd|mfa|otp/i.test(menu));
ok('⚠️ no session or token handling here', !/getToken|sessionToken|jwt/i.test(menu));
ok('account security routes to Clerk’s hosted profile', /href="\/account"/.test(menu));

L('\n=== ⚠️ THE PREBUILT DROPDOWN IS GONE, WITHOUT CSS HACKS ===');
ok('⚠️ UserButton is not mounted', mut('userbutton') ? false : !/<UserButton/.test(nav));
ok('…and is not imported', !/UserButton/.test(nav));
ok('⚠️ no CSS hides Clerk DOM',
  !/cl-internal|cl-userButton|\.cl-|Secured by Clerk/i.test(nav + menu),
  'hiding vendor DOM by selector is brittle and breaks on their next release');
ok('the native menu is mounted in its place', /<AccountMenu\/>/.test(nav));
ok('SignedIn/SignedOut gating is unchanged', /<SignedIn>/.test(navSrc) && /<SignedOut>/.test(navSrc));

L('\n=== DESTINATIONS EXIST ===');
const exists = async (p) => !!(await fs.stat(new URL(p, import.meta.url)).catch(() => null));
for (const [label, dir] of [['Account','../src/app/account'],['Watchlist','../src/app/watchlist'],['Settings','../src/app/settings']]) {
  ok(`${label} route exists`, await exists(dir));
}
ok('⚠️ no Alerts entry, because no /alerts page exists',
  !/>Alerts</.test(menu) && !(await exists('../src/app/alerts')));
ok('Billing uses the real Stripe portal', /\/api\/stripe\/portal/.test(menu) && await exists('../src/app/api/stripe/portal'));
ok('⚠️ Pro is never shown an upgrade CTA', /isPro\s*\?\s*<Item onClick=\{portal\}/.test(menu));
ok('…and Free is never shown Billing', /:\s*<Item onClick=\{\(\) => \{ close\(\); startCheckout\(\); \}\}/.test(menu));
ok('neither is shown before the tier is known', /tier !== null && \(isPro/.test(menu));

L('\n=== INTERACTION AND A11Y ===');
ok('click toggles', /onClick=\{\(\) => setOpen\(\(v\) => !v\)\}/.test(menu));
ok('Escape closes and returns focus', /e\.key === 'Escape'/.test(menu) && /btnRef\.current\?\.focus\(\)/.test(menu));
ok('⚠️ outside dismissal uses pointerdown, so touch navigation is not cut off',
  /addEventListener\('pointerdown'/.test(menu));
ok('it is a real <button>, so Enter and Space work natively', /<button ref=\{btnRef\} type="button"/.test(menu));
ok('aria-haspopup and aria-expanded are present', /aria-haspopup="menu"/.test(menu) && /aria-expanded=\{open\}/.test(menu));
ok('the panel is announced as a menu', /role="menu"/.test(menu) && /role="menuitem"/.test(menu));
ok('z-index clears the header', /zIndex: 200/.test(menu));
ok('listeners are removed on close', /removeEventListener\('keydown'/.test(menu) && /removeEventListener\('pointerdown'/.test(menu));

L('\n=== THEMING USES THE DESIGN SYSTEM ===');
ok('⚠️ every colour is a C token — no literal hex', !/#[0-9A-Fa-f]{6}/.test(menu.replace(/rgba\([^)]*\)/g,'')));
ok('…so dark mode follows the existing vars', /import \{ C, startCheckout \}/.test(menu));
ok('no imported hook is used unimported',
  (() => { const im=new Set((menu.match(/import \{([^}]+)\} from 'react'/)||[,''])[1].split(',').map(x=>x.trim()));
    const used = [...menuSrc.matchAll(/\b(use[A-Z]\w+)\s*\(/g)].map((m) => m[1]);
    return used.filter((h) => ['useState','useEffect','useRef','useCallback','useMemo'].includes(h) && !im.has(h)).length === 0; })());

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
