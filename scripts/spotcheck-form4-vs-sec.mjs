// TASK 14, CHECK 14 — compare stored rows against the SEC Form 4 document itself.
//
//   node --env-file=.env.local scripts/spotcheck-form4-vs-sec.mjs [--n 12]
//
// ⚠️ A RANDOM CROSS-SECTION, NOT FIXTURES. Rows are drawn at random across transaction codes, so this
// exercises the parser rather than a handful of known-good examples. For each row it fetches the
// filing's ownership XML and compares the transaction the row claims against the matching <transaction>
// block: code, date, shares, price and the derivative flag.
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const UA = { 'User-Agent': 'CatalystPit contact@catalystpit.com' };
const N = Number((/--n\s+(\d+)/.exec(process.argv.join(' ')) || [])[1] || 12);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; } else { fail++; console.error(`    FAIL ${n}${d ? ' — ' + d : ''}`); } };

// A spread of codes: open-market both ways, grant, exercise, withholding, gift, conversion.
const rows = await sql`
  SELECT * FROM (
    SELECT DISTINCT ON (transaction_code, ticker) id, ticker, executive, title, transaction_code code,
           action, transaction_date::text tx, filing_date::text filed, shares, price_per_share px,
           total_value val, security_title, coalesce(is_derivative,false) deriv, accession, issuer_cik
      FROM insider_trades
     WHERE superseded_by IS NULL AND shares > 0
       AND transaction_code IN ('P','S','A','M','F','G','C')
     ORDER BY transaction_code, ticker, random()) t
  ORDER BY random() LIMIT ${N}`;

const num = (s) => { const v = Number(String(s ?? '').replace(/,/g, '')); return Number.isFinite(v) ? v : null; };
const fld = (b, n) => {
  const m = b.match(new RegExp(`<(?:\\w+:)?${n}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${n}>`, 'i'));
  if (!m) return null;
  const v = m[1].replace(/<!\[CDATA\[|\]\]>/g, '');
  const inner = v.match(/<(?:\w+:)?value>([\s\S]*?)<\/(?:\w+:)?value>/i);
  return (inner ? inner[1] : v).trim();
};

console.log(`comparing ${rows.length} stored rows against their SEC documents\n`);
for (const r of rows) {
  const cik = String(r.issuer_cik || '').replace(/^0+/, '');
  const bare = r.accession.replace(/-/g, '');
  let txt = null;
  for (let i = 0; i < 3 && !txt; i++) {
    try {
      const res = await fetch(`https://www.sec.gov/Archives/edgar/data/${cik}/${bare}/${r.accession}.txt`, { headers: UA });
      if (res.ok) txt = await res.text();
    } catch { /* retry */ }
    if (!txt) await sleep(600 * (i + 1));
  }
  console.log(`${r.ticker} ${r.code} ${r.tx} ${r.executive} · ${r.accession}`);
  if (!txt) { console.log('    (document unreachable — skipped)'); continue; }

  // Every transaction block in the filing, from both tables.
  const blocks = [...txt.matchAll(/<(?:\w+:)?(?:non)?[Dd]erivativeTransaction>[\s\S]*?<\/(?:\w+:)?(?:non)?[Dd]erivativeTransaction>/g)]
    .map((m) => m[0]);
  const deriv = blocks.map((b) => /<(?:\w+:)?derivativeTransaction>/i.test(b));
  // Match on the shape the row claims, not on position — filings reorder freely.
  const idx = blocks.findIndex((b, i) => fld(b, 'transactionCode') === r.code
    && fld(b, 'transactionDate') === r.tx
    && Math.abs((num(fld(b, 'transactionShares')) ?? -1) - Number(r.shares)) < 0.01
    && deriv[i] === r.deriv);
  ok('the filing contains the transaction as stored', idx >= 0,
    idx >= 0 ? '' : `${blocks.length} blocks; codes ${blocks.map((b) => fld(b, 'transactionCode')).join(',')}`);
  if (idx < 0) continue;
  const b = blocks[idx];
  const secPx = num(fld(b, 'transactionPricePerShare'));
  const secSh = num(fld(b, 'transactionShares'));
  ok('shares match the document', Math.abs(secSh - Number(r.shares)) < 0.01, `${secSh} vs ${r.shares}`);
  // A blank price in the document must be stored as 0, never invented.
  if (secPx === null) ok('an unpriced transaction stores no price', Number(r.px) === 0, `stored ${r.px}`);
  else ok('price matches the document', Math.abs(secPx - Number(r.px)) < 0.011, `${secPx} vs ${r.px}`);
  ok('⚠️ value is shares x price, not a second multiplication',
    Math.abs(Number(r.val) - Number(r.shares) * Number(r.px)) < Math.max(1, 0.01 * Number(r.val)),
    `${r.val} vs ${Number(r.shares) * Number(r.px)}`);
  // ⚠️ ONLY P AND S ARE OPEN-MARKET. Everything else must not read as ordinary buying or selling.
  ok('⚠️ direction is claimed only for an open-market code',
    (r.code === 'P' && r.action === 'BUY') || (r.code === 'S' && r.action === 'SELL')
    || (!['P', 'S'].includes(r.code) && r.action === 'OTHER'),
    `${r.code} -> ${r.action}`);
  ok('the derivative flag matches which table it came from', deriv[idx] === r.deriv);
  const secTitle = fld(b, 'securityTitle');
  ok('security title matches', !secTitle || !r.security_title || secTitle.toLowerCase() === String(r.security_title).toLowerCase(),
    `${secTitle} vs ${r.security_title}`);
  await sleep(150);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
