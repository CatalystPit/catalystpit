import { attach, newTab } from './cdp.mjs';
const BASE = 'https://www.catalystpit.com';
const tab = await newTab();
const p = await attach(tab);
await p.viewport(1440, 900, false);

console.log('NEWS — anonymous preview limit and the email gate');
await p.goto(`${BASE}/news`, { settleMs: 1800 });
console.log('  ', JSON.stringify(await p.eval(`(() => {
  const t = (document.body.innerText || '').replace(/\\s+/g, ' ');
  return {
    textLen: t.length,
    emailGate: /email|newsletter|subscribe|sign up|free account/i.test(t),
    gateCopy: (t.match(/[^.]{0,90}(unlock|sign up|free account|email)[^.]{0,90}\\./i) || [])[0] || null,
    articleLinks: [...document.querySelectorAll('a')].filter((a) => /\\/news\\/|article|story/i.test(a.getAttribute('href') || '')).length,
    inputs: [...document.querySelectorAll('input')].map((i) => i.type + ':' + (i.placeholder || '').slice(0, 30)),
  };
})()`)));

console.log('\nINSIDERS / POLITICIANS / INSTITUTIONS — anonymous row caps as RENDERED');
for (const [path, label] of [['/insiders', 'Insiders'], ['/politicians', 'Politicians'], ['/institutions', 'Institutions']]) {
  await p.goto(BASE + path, { settleMs: 1800 });
  const r = await p.eval(`(() => {
    const t = (document.body.innerText || '').replace(/\\s+/g, ' ');
    const rows = Math.max(
      ...[...document.querySelectorAll('table')].map((tb) => tb.querySelectorAll('tbody tr').length),
      0);
    return {
      tableRows: rows,
      // The locked/upsell language a reader would see under a capped list.
      locked: /(\\d[\\d,]*)\\s*(more|locked|hidden|additional)/i.exec(t)?.[0] || null,
      upsell: /(Start Free|Sign up|Unlock|Create a free account)/i.exec(t)?.[0] || null,
      textLen: t.length,
    };
  })()`);
  console.log(`   ${label.padEnd(13)} renderedRows=${r.tableRows} locked="${r.locked}" cta="${r.upsell}" text=${r.textLen}`);
}

console.log('\nWATCHLIST — anonymous');
await p.goto(`${BASE}/watchlist`, { settleMs: 1500 });
console.log('  ', JSON.stringify(await p.eval(`(() => {
  const t = (document.body.innerText || '').replace(/\\s+/g, ' ');
  return { textLen: t.length, text: t.slice(0, 220),
    hasSignIn: /sign in|log in|start free/i.test(t) };
})()`)));

p.close();
