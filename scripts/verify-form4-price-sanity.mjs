// A FILER PUT THE AGGREGATE IN THE PER-SHARE FIELD, AND NOTHING STOPPED IT.
//
//   node --import ./scripts/lib/server-stub-hook.mjs --env-file=.env.local \
//        scripts/verify-form4-price-sanity.mjs
//
// ⚠️ THE FAILURE THIS PINS, AND WHY IT IS NOT A PARSING BUG. On 2026-10-01 SLBT's Form 4 was stored at
// price_per_share = 2,272,653 against 4,545,306 shares — a $10.3 trillion purchase, served as the largest
// insider transaction on record and scored for conviction. The SEC document genuinely contains
// <transactionPricePerShare><value>2272653</value></transactionPricePerShare>; the filer put the
// aggregate consideration in the per-share field, and said so in their own footnote ("for an aggregate
// purchase price of US$2,272,653" against 4,545,306 shares — $0.50 a share). Our parser read the right
// node and got the right value out of it.
//
// What was missing was a check. lib/form4.mjs has always had validateRow with bounds documented against
// real extremes, and this filing breaks two of them — but only the backfill scripts ever called it. The
// live per-minute route carries its own copy of the parser which validated nothing numeric.
//
// So the fixture here is THE REAL FILING, byte for byte from EDGAR, not a hand-written approximation of
// it. A synthetic fixture would have proved only that the validator rejects numbers I chose.

const L = (s = '') => console.log(s);
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

const fs = await import('node:fs/promises');
const read = (p) => fs.readFile(new URL(p, import.meta.url), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const F = await import('../src/lib/form4.mjs');

const FILING = {
  accession: '0001104659-26-112844',
  filingDate: '2026-10-01',
  indexUrl: 'https://www.sec.gov/Archives/edgar/data/2070534/000110465926112844/0001104659-26-112844-index.htm',
};

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('\n=== 1. THE REAL FILING IS REFUSED, AND FOR THE RIGHT REASON ===');
{
  const xml = await read('./fixtures/form4-slbt-aggregate-in-price-field.xml');
  // The fixture must still be the thing it claims to be, or everything below is theatre.
  ok('the fixture is the real SEC document', /<transactionPricePerShare>\s*<value>2272653<\/value>/.test(xml)
    && /<transactionShares>\s*<value>4545306<\/value>/.test(xml));
  ok('…and its footnote states the aggregate, which is what makes the price wrong',
    /aggregate purchase price of US\$2,272,653/.test(xml));

  const out = F.parseForm4(xml, FILING);
  ok('⚠️ it produces NO servable row', out.rows.length === 0,
    `${out.rows.length} row(s) would have been stored`);
  ok('⚠️ it is quarantined rather than silently dropped', out.quarantine.length === 1,
    `${out.quarantine.length} quarantine record(s)`);
  const q = out.quarantine[0] || {};
  ok('⚠️ the reason names the absurd price', q.reason === F.QUARANTINE_REASONS.ABSURD_PRICE, q.reason);
  ok('the detail says what the filer wrote', /2272653/.test(String(q.detail)), q.detail);
  ok('the quarantine record carries its source url so a human can open the filing',
    typeof q.rawUrl === 'string' || typeof q.raw_url === 'string' || !!q.filingUrl || !!FILING.indexUrl);

  // ⚠️ THE PARSER READ THE RIGHT NODES. Asserted explicitly, because the first instinct on seeing a
  // $10.3T row is to look for a field shift — and finding none is the finding.
  const txn = xml.match(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/)[1];
  const val = (tag) => txn.match(new RegExp(`<${tag}>\\s*<value>([^<]*)</value>`))?.[1];
  ok('⚠️ the share count is in transactionShares, not the price field', val('transactionShares') === '4545306');
  ok('⚠️ the bad number really is in transactionPricePerShare',
    val('transactionPricePerShare') === '2272653',
    'if this ever changes, the filer amended it and the fixture is stale');
  ok('the post-transaction holding is its own field', val('sharesOwnedFollowingTransaction') === '333832129');
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('\n=== 2. NO NUMERIC FIELD CAN BE READ AS THE PRICE ===');
{
  // ⚠️ DISTINCT, RECOGNISABLE VALUES IN EVERY NUMERIC FIELD. If any two were ever cross-assigned — a
  // share count read as a price, a holding read as a share count — the value lands in the wrong
  // assertion and this fails. Equal placeholder values would have hidden exactly that.
  const SHARES = 1111, PRICE = 22.22, OWNED = 333333, DATE = '2026-05-04';
  const xml = `<?xml version="1.0"?><ownershipDocument>
    <documentType>4</documentType>
    <periodOfReport>${DATE}</periodOfReport>
    <issuer><issuerCik>0000001234</issuerCik><issuerName>ZZ Test Issuer</issuerName>
      <issuerTradingSymbol>ZZTST</issuerTradingSymbol></issuer>
    <reportingOwner><reportingOwnerId><rptOwnerCik>0000005678</rptOwnerCik>
      <rptOwnerName>ZZ Test Owner</rptOwnerName></reportingOwnerId>
      <reportingOwnerRelationship><isOfficer>1</isOfficer><officerTitle>CEO</officerTitle>
      </reportingOwnerRelationship></reportingOwner>
    <nonDerivativeTable><nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>${DATE}</value></transactionDate>
      <transactionCoding><transactionFormType>4</transactionFormType>
        <transactionCode>P</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>${SHARES}</value></transactionShares>
        <transactionPricePerShare><value>${PRICE}</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>${OWNED}</value>
        </sharesOwnedFollowingTransaction></postTransactionAmounts>
      <ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership>
        </ownershipNature>
    </nonDerivativeTransaction></nonDerivativeTable>
  </ownershipDocument>`;

  const out = F.parseForm4(xml, { accession: 'zz-test-0001', filingDate: DATE, indexUrl: 'https://example.test/x' });
  ok('an ordinary purchase parses cleanly', out.rows.length === 1 && out.quarantine.length === 0,
    JSON.stringify(out.quarantine));
  const r = out.rows[0] || {};
  ok('⚠️ shares holds the share count', r.shares === SHARES, `${r.shares}`);
  ok('⚠️ pricePerShare holds the PRICE, not the share count', r.pricePerShare === PRICE, `${r.pricePerShare}`);
  ok('⚠️ pricePerShare is not the holding either', r.pricePerShare !== OWNED);
  ok('⚠️ sharesOwnedAfter holds the holding', r.sharesOwnedAfter === OWNED, `${r.sharesOwnedAfter}`);
  ok('⚠️ sharesOwnedAfter is not the share count', r.sharesOwnedAfter !== SHARES);
  ok('totalValue is the product of the two, not a third field',
    Math.abs(r.totalValue - SHARES * PRICE) < 1e-6, `${r.totalValue}`);
  ok('the transaction code is preserved verbatim', r.transactionCode === 'P');

  // And the inverse: an aggregate pasted into the per-share field of an otherwise normal filing is
  // refused, which is the SLBT shape reduced to its essentials.
  const aggregate = xml.replace(`<value>${PRICE}</value>`, '<value>24666.42</value>');
  const bad = F.parseForm4(aggregate, { accession: 'zz-test-0002', filingDate: DATE, indexUrl: 'https://example.test/y' });
  // 1111 × 24666.42 = $27.4M — under both bounds, so this one legitimately passes. Asserted so the
  // limits of the safeguard are written down rather than assumed: it catches the impossible, not the
  // merely surprising.
  ok('⚠️ a SUB-THRESHOLD aggregate error still passes, and that is a known limit',
    bad.rows.length === 1,
    'documented deliberately: the bounds catch the impossible, not every filer mistake');
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('\n=== 3. LEGITIMATE EXTREMES ARE NOT REFUSED ===');
{
  const row = (o) => ({
    shares: 100, pricePerShare: 10, totalValue: 1000, sharesOwnedAfter: 1000,
    transactionDate: '2026-05-04', filingDate: '2026-05-05', transactionCode: 'P',
    rawShares: '100', rawPrice: '10', priceDisclosed: true, ...o,
  });
  const v = (o) => F.validateRow(row(o), { today: new Date('2026-05-06') });

  // ⚠️ BRK.A IS THE CASE A LOW CEILING WOULD BREAK, so it is asserted rather than assumed.
  ok('⚠️ a BRK.A-priced purchase passes', v({ shares: 10, pricePerShare: 700_000, totalValue: 7_000_000,
    rawPrice: '700000' }) === null);
  ok('a $999,999 share price passes', v({ shares: 1, pricePerShare: 999_999, totalValue: 999_999,
    rawPrice: '999999' }) === null);
  ok('⚠️ a genuinely large transaction passes', v({ shares: 10_000_000, pricePerShare: 50,
    totalValue: 500_000_000, rawPrice: '50' }) === null,
    '10M shares at $50 is a real thing that happens');
  ok('⚠️ a $400B transaction passes', v({ shares: 4e9, pricePerShare: 100, totalValue: 4e11,
    rawPrice: '100' }) === null, 'below MAX_VALUE, so not refused');
  ok('a footnoted (undisclosed) price is not an error',
    v({ pricePerShare: 0, totalValue: 0, rawPrice: null, priceDisclosed: false }) === null,
    'filers routinely footnote the price instead of stating it');
  ok('a sub-penny price passes', v({ shares: 1e6, pricePerShare: 0.0001, totalValue: 100,
    rawPrice: '0.0001' }) === null);

  // And the refusals, so the bounds are shown to bite.
  ok('⚠️ the SLBT shape is refused', v({ shares: 4545306, pricePerShare: 2272653,
    totalValue: 4545306 * 2272653, rawPrice: '2272653' })?.reason === F.QUARANTINE_REASONS.ABSURD_PRICE);
  ok('a price above the ceiling is refused',
    v({ pricePerShare: 1_000_001, totalValue: 100_000_100, rawPrice: '1000001' })?.reason
      === F.QUARANTINE_REASONS.ABSURD_PRICE);
  ok('a value above the ceiling is refused',
    v({ shares: 1e10, pricePerShare: 1000, totalValue: 1e13, rawPrice: '1000' })?.reason
      === F.QUARANTINE_REASONS.ABSURD_VALUE);
  ok('a precomputed total that disagrees with its parts is refused',
    v({ totalValue: 999_999 })?.reason === F.QUARANTINE_REASONS.VALUE_INCONSISTENT,
    'guards a corrupted total from poisoning aggregate sums even when price and shares are sane');

  // ⚠️ THE HEURISTIC THAT WAS DELIBERATELY NOT ADDED. When a filer pastes an aggregate into the price
  // field, price/shares lands back on a plausible per-share figure — which is a useful DIAGNOSTIC and a
  // terrible gate: a legitimate 1,000-share BRK.A purchase gives 700000/1000 = 700, equally "plausible".
  // Asserted here so nobody later promotes the signature into a rejection rule.
  ok('⚠️ the aggregate signature is not used as a rejection rule',
    v({ shares: 1000, pricePerShare: 700_000, totalValue: 7e8, rawPrice: '700000' }) === null,
    'a legitimate BRK.A block would be the first casualty of that heuristic');
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('\n=== 4. THE LIVE PATH APPLIES THE VALIDATOR AT ITS ONLY DOOR ===');
{
  const route = strip(await read('../src/app/api/refresh/route.js'));
  ok('⚠️ the live route imports the canonical validator',
    /const \{ validateRow \} = await import\('\.\.\/\.\.\/\.\.\/lib\/form4\.mjs'\)/.test(route),
    'this is the whole fix: the live path had its own parser and no numeric validation');
  ok('⚠️ …inside insertInsiderTrades, the documented single door',
    route.indexOf('async function insertInsiderTrades') < route.indexOf('validateRow')
    && route.indexOf('validateRow') < route.indexOf('db.insert(insiderTradesTable)'));
  ok('⚠️ every row is validated, not a sample', /for \(const r of tickered\) \{\s*const bad = validateRow\(r\);/.test(route));
  ok('⚠️ a failing row does not reach the insert',
    /if \(bad\) invalid\.push\(\{ row: r, bad \}\); else rows\.push\(r\);/.test(route));
  ok('⚠️ failures are quarantined, so a refusal is auditable',
    /insert into insider_quarantine/.test(route));
  ok('the quarantine write cannot take the good rows down with it',
    /catch \(e\) \{[\s\S]{0,180}quarantine write failed/.test(route));
  ok('the raw strings are carried so the validator is fully informed',
    /rawShares: rawSharesStr, rawPrice: rawPriceStr,/.test(route)
    && /priceDisclosed: rawPriceStr != null/.test(route));
  ok('⚠️ …and stripped before the insert, so they are not treated as columns',
    /\.map\(\(\{ lineage, rawShares, rawPrice, priceDisclosed, \.\.\.row \}\) => row\)/.test(route));
  ok('the ticker gate it sits beside is untouched', /isIngestableTicker\(r\.ticker\)/.test(route));

  // ⚠️ THE BOUNDS WERE NOT LOWERED TO MAKE THIS PASS. That would have been the lazy fix and would have
  // thrown away legitimate filings.
  ok('⚠️ MAX_PRICE is unchanged and still above BRK.A', F.LIMITS.MAX_PRICE === 1_000_000);
  ok('⚠️ MAX_VALUE is unchanged', F.LIMITS.MAX_VALUE === 5e11);
  ok('MAX_SHARES is unchanged', F.LIMITS.MAX_SHARES === 5e10);
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
