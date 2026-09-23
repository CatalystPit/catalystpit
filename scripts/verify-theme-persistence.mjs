// THE SELECTED THEME SURVIVES ARRIVING ON ANY PAGE.
//
//   node --experimental-loader ./scripts/jsx-loader.mjs scripts/verify-theme-persistence.mjs [--mutate=m]
//
// ⚠️ THE BUG: navigating to /dividends in dark mode landed on a light page, and it stayed light
// until the toggle was clicked. The pre-paint script sets data-theme on <html>, which the server
// never rendered — a hydration mismatch on the root element, which React may reconcile away. The
// script only runs on a document load, so nothing restores it afterwards.
//
// Mutations:  --mutate=nosuppress  <html> loses suppressHydrationWarning
//             --mutate=domonly     the toggle reads the DOM instead of restoring from storage

const L=(s='')=>console.log(s);
const MUT=(process.argv.find(a=>a.startsWith('--mutate'))||'').split('=')[1]||'';
const mut=(m)=>MUT===m||MUT==='all';
let pass=0,fail=0;
const ok=(n,c,d='')=>{if(c){pass++;L(`  ok   ${n}`);}else{fail++;L(`  FAIL ${n}${d?' — '+d:''}`);}};
const fs=await import('node:fs/promises');
const read=(p)=>fs.readFile(new URL(p,import.meta.url),'utf8');

const layout = await read('../src/app/layout.jsx');
const shared = await read('../src/lib/cp-shared.jsx');

L('=== ⚠️ THE PRE-PAINT ATTRIBUTE MUST SURVIVE HYDRATION ===');
ok('⚠️ <html> carries suppressHydrationWarning',
  mut('nosuppress') ? false : /<html lang="en" suppressHydrationWarning>/.test(layout),
  'without it React may reconcile away the data-theme the pre-paint script set');
ok('the pre-paint script still runs in <head>',
  /localStorage\.getItem\('cp_theme'\)==='dark'/.test(layout) && layout.indexOf('cp_theme') < layout.indexOf('</head>'));
ok('…and it only ever ADDS dark, never removes', !/removeAttribute\('data-theme'\)/.test(layout));

L('\n=== ⚠️ THE TOGGLE REPAIRS THE THEME, IT DOES NOT ONLY REFLECT IT ===');
const mount = shared.slice(shared.indexOf('export function ThemeToggle'), shared.indexOf('export const Dot'));
ok('⚠️ mount restores the SAVED theme rather than trusting the DOM',
  mut('domonly') ? false : /localStorage\.getItem\("cp_theme"\)/.test(mount),
  'reading the DOM alone cannot recover a preference the DOM lost');
ok('…dark is re-applied when storage says dark and the DOM disagrees',
  /saved === "dark" && document\.documentElement\.dataset\.theme !== "dark"/.test(mount));
ok('…light is honoured too, not just dark',
  /saved === "light" && document\.documentElement\.dataset\.theme === "dark"/.test(mount));
ok('storage being unavailable does not throw', /catch \{ \/\* storage unavailable/.test(mount));

L('\n=== ⚠️ ONE THEME SYSTEM, NOT A PAGE-SPECIFIC ONE ===');
ok('the key is unchanged', (shared.match(/cp_theme/g)||[]).length >= 2 && /cp_theme/.test(layout));
ok('the attribute is unchanged', /dataset\.theme = "dark"/.test(shared));
ok('⚠️ no page defines its own theme state',
  !/cp_theme|dataset\.theme\s*=/.test(await read('../src/app/dividends/DividendsClient.jsx')),
  'Dividends must use the shared system, not gain one of its own');
ok('…and Dividends still renders the shared BrandStyles',
  /<BrandStyles \/>/.test(await read('../src/app/dividends/DividendsClient.jsx')));
ok('the toggle remains the only writer of cp_theme',
  (shared.match(/localStorage\.setItem\("cp_theme"/g)||[]).length === 1);

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
