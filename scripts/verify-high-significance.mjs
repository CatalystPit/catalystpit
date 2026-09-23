// HIGH SIGNIFICANCE IS AN ATTENTION TAG, AND IT NEVER TOUCHES DIRECTION.
//
//   node --env-file=.env.local --experimental-loader ./scripts/ext-resolve-loader.mjs \
//        scripts/verify-high-significance.mjs [--mutate=m] [--live]
//
// Mutations:
//   --mutate=materiality   the catalyst rule uses raw materiality again (tagged 83 of 99 rows)
//   --mutate=vpcounts      "Vice President" counts as a lead role
//   --mutate=midpoint      congress uses the band midpoint instead of its lower bound
//   --mutate=drivesdir     the tag is allowed to change Positive/Negative

const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1] || '';
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const fs = await import('node:fs/promises');
const read = (p) => fs.readFile(new URL(p, import.meta.url), 'utf8');
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const H = await import('../src/lib/consensus/high-significance.mjs');
const { highSignificance, isLeadRole, ROLE_PURCHASE_USD, ANY_PURCHASE_USD,
  CLUSTER_PURCHASE_USD, CONGRESS_PURCHASE_USD } = H;

const insider = (facts, extra = {}) => ({ family: 'insider', type: 'insider_buy', facts, ...extra });
const congress = (facts) => ({ family: 'congress', type: 'congress_disclosure', facts });

L('=== ⚠️ ROLE DETECTION: PRESIDENT IS NOT VICE PRESIDENT ===');
{
  for (const t of ['Chief Executive Officer', 'CEO', 'President and CEO', 'President & CEO',
    'President', 'Chief Financial Officer', 'CFO', 'PRESIDENT & CEO']) {
    ok(`"${t}" is a lead role`, isLeadRole(t));
  }
  for (const t of ['Vice President', 'VP', 'EVP', 'SVP', 'AVP', 'Vice President of Sales',
    'Assistant Controller', 'Director', '10% Owner', 'Chief Growth Officer', 'Other']) {
    ok(`⚠️ "${t}" is NOT a lead role`, mut('vpcounts') ? false : !isLeadRole(t));
  }
  ok('an empty title is not a role', !isLeadRole('') && !isLeadRole(null));
}

L('\n=== ⚠️ INSIDER THRESHOLDS ===');
{
  const lead = highSignificance([insider({ leadRoleValue: 801_000, leadRoleTitle: 'Chief Executive Officer', buyers: 1 })]);
  ok('a CEO purchase at $801K qualifies', lead.high);
  ok('…and the reason states the concrete fact',
    /CEO purchased \$801K on the open market/.test(lead.reasons[0].reason), lead.reasons[0]?.reason);
  ok('a CEO purchase just under the bar does not',
    !highSignificance([insider({ leadRoleValue: 499_000, leadRoleTitle: 'CEO', buyers: 1 })]).high);
  ok('a $1M purchase by any single insider qualifies',
    highSignificance([insider({ topBuyerValue: 1_200_000, buyers: 1 })]).high);
  ok('…a $900K one by a non-lead role does not',
    !highSignificance([insider({ topBuyerValue: 900_000, buyers: 1 })]).high);
  ok('several insiders totalling $1M qualifies',
    highSignificance([insider({ totalValue: 1_500_000, topBuyerValue: 400_000, buyers: 4 })]).high);
  ok('…but a single buyer is not "several"',
    !highSignificance([insider({ totalValue: 1_500_000, topBuyerValue: 1_500_000, buyers: 1 })]).reasons
      .some((r) => /insiders purchased/.test(r.reason)));

  // ⚠️ ONE PURCHASE MUST NOT PRODUCE THREE REASONS.
  const one = highSignificance([insider({ leadRoleValue: 2_000_000, topBuyerValue: 2_000_000, totalValue: 2_000_000, buyers: 1, leadRoleTitle: 'CEO' })]);
  ok('⚠️ the same money is reported once, not three times', one.reasons.length === 1, JSON.stringify(one.reasons.map((r) => r.reason)));

  // Rarity strengthens, never creates.
  const rare = highSignificance([insider({ totalValue: 9_000, buyers: 1 }, { context: { text: 'First purchase in 312 days' } })]);
  ok('⚠️ rarity alone does NOT qualify a $9,000 odd lot', !rare.high,
    'true of a tiny lot as often as a large cluster');
  const both = highSignificance([insider({ leadRoleValue: 900_000, leadRoleTitle: 'CEO', buyers: 1 }, { context: { text: 'First officer purchase in 236 days' } })]);
  ok('…but it is attached to a reason that already qualified', both.reasons[0].rarity != null);
}

L('\n=== ⚠️ CONGRESS USES THE BAND’S LOWER BOUND ===');
{
  ok('a $500,001–$1,000,000 band qualifies',
    highSignificance([congress({ buyAmountMin: 500_001, amountRange: '$500,001 - $1,000,000' })]).high);
  ok('⚠️ a $250,001–$500,000 band does NOT',
    mut('midpoint') ? false : !highSignificance([congress({ buyAmountMin: 250_001, amountRange: '$250,001 - $500,000' })]).high,
    'its midpoint is $375K and its maximum is $500K — neither supports a ">= $500K" claim');
  ok('the reason names the band', /\$500K\+ congressional purchase disclosed/.test(
    highSignificance([congress({ buyAmountMin: 500_001, amountRange: '$500,001 - $1,000,000' })]).reasons[0].reason));
  ok('a disclosure with no purchase amount does not qualify',
    !highSignificance([congress({ buyAmountMin: null })]).high);
}

L('\n=== ⚠️ CATALYSTS USE THE ENGINE’S SIGNIFICANCE, NOT MATERIALITY ===');
{
  const src = strip(await read('../src/lib/consensus/high-significance.mjs'));
  ok('⚠️ the rule calls familySignificance', mut('materiality') ? false : /familySignificance\(ev\)/.test(src),
    'materiality scores a material agreement at 0.735 and tagged 83 of 99 board rows');
  ok('…and never reads raw materiality for the threshold', !/Number\(ev\.materiality\)\s*[><]?=/.test(src));
  ok('⚠️ nothing infers significance from headline wording',
    !/summary\.(includes|match)|headline\.(includes|match)|\/.*(merger|acquisition|bankrupt)/i.test(src));
}

L('\n=== ⚠️ INSTITUTIONS GET NO DOLLAR THRESHOLD ===');
{
  const src = strip(await read('../src/lib/consensus/high-significance.mjs'));
  const inst = src.slice(src.indexOf("fam === 'institution'"));
  ok('⚠️ no dollar threshold is applied to institutions',
    !/\d{3}_000|\d{6}/.test(inst.slice(0, 300)),
    '13F breadth exists for almost every company; a flat bar would tag the market');
  ok('…it uses the existing canonical unusual flag', /facts\?\.unusual === true/.test(src));
  ok('⚠️ and it reads facts.unusual, not only context.unusual', /ev\.facts\?\.unusual === true \|\|/.test(src),
    'GPUS carries facts.unusual=true with context.unusual undefined — reading context alone drops real hits');
  ok('a normal breadth change does not qualify',
    !highSignificance([{ family: 'institution', facts: { unusual: false }, summary: 'x' }]).high);
}

L('\n=== ⚠️ IT IS NOT A DIRECTION AND CANNOT BECOME ONE ===');
{
  const board = strip(await read('../src/lib/consensus/setup-board.js'));
  const card = strip(await read('../src/app/consensus/SetupCard.jsx'));
  const sig = strip(await read('../src/lib/consensus/high-significance.mjs'));

  ok('⚠️ the tag never feeds direction',
    mut('drivesdir') ? false : !/highSignificance[\s\S]{0,200}(direction =|reading\.reading =)/.test(board),
    'a high-significance row may read Positive, Negative or neither');
  ok('…nor qualification, confidence or priority',
    !/highSignificance[\s\S]{0,160}(qualifies|confidence =|priority =)/.test(board));
  ok('⚠️ the module emits no direction of its own',
    !/POSITIVE|NEGATIVE|bullish|bearish/i.test(sig));
  // ⚠️ TESTED ON THE EMITTED REASONS, NOT THE SOURCE. Scanning the source flagged the word "buy"
  // from `/buy/i.test(ev.type)` — a record-type match on "insider_cluster_buy", not a
  // recommendation. What must never contain advice is the text a reader actually sees.
  const emitted = [
    ...highSignificance([insider({ leadRoleValue: 801_000, leadRoleTitle: 'CEO', buyers: 1 })]).reasons,
    ...highSignificance([insider({ topBuyerValue: 2_000_000, buyers: 1 })]).reasons,
    ...highSignificance([insider({ totalValue: 3_000_000, topBuyerValue: 400_000, buyers: 5 })]).reasons,
    ...highSignificance([congress({ buyAmountMin: 1_000_001, amountRange: '$1,000,001 - $5,000,000' })]).reasons,
  ].map((r) => r.reason).join(' | ');
  ok('⚠️ no emitted reason contains prediction or recommendation language',
    !/\b(buy|sell|should|expect|target|likely|will)\b/i.test(emitted), emitted);
  ok('…every emitted reason is a past-tense statement of fact', /purchased|disclosed/.test(emitted));
  ok('the reason is a fact with a number, not an adjective',
    /purchased \$/.test(highSignificance([insider({ leadRoleValue: 801_000, leadRoleTitle: 'CEO', buyers: 1 })]).reasons[0].reason));
  // ⚠️ COMPARED AGAINST A REAL ELEMENT IN THE RAW SOURCE. Anchoring on a comment fails the moment
  // comments are stripped, which is what this suite does two lines earlier.
  const cardRaw = await read('../src/app/consensus/SetupCard.jsx');
  ok('the badge sits beside the setup chip, above the direction word',
    cardRaw.indexOf('HIGH SIGNIFICANCE') > 0
    && cardRaw.indexOf('HIGH SIGNIFICANCE') < cardRaw.indexOf('(readingUI || dir).label'));
  const setupSrc = strip(await read('../src/lib/consensus/setup.mjs'));
  ok('the filter is its own pill', /key: 'highsig'/.test(setupSrc));

  // ⚠️ MAJOR INSIDER BUYING IS A VIEW OF THE SAME QUALIFICATION, NOT A SECOND ONE.
  ok('Major insider buying is a pill', /key: 'majorinsider'/.test(setupSrc));
  ok('⚠️ …and it reads the flag highSignificance already set',
    setupSrc.includes('f.insiderBuying) return list.filter((r) => r.highSignificance?.insider === true)'),
    'a second copy of the insider rules could disagree with the badge on the card');
  ok('⚠️ the flag is computed from the FULL reason list, before the wire slice',
    board.includes('insider: h.reasons.some((r) => r.source === SIGNIFICANCE_SOURCE.INSIDER)')
    && board.indexOf('insider: h.reasons.some') > board.indexOf('reasons: h.reasons.slice(0, 3)'),
    'testing the trimmed array would drop a qualifying reason on a row carrying more than three');
  ok('…the pill duplicates none of the thresholds',
    !/ROLE_PURCHASE_USD|ANY_PURCHASE_USD|CLUSTER_PURCHASE_USD/.test(setupSrc));
  ok('…filtering by it only removes rows', /f\.highSignificance\) return list\.filter/.test(strip(await read('../src/lib/consensus/setup.mjs'))));
  ok('no page-only significance logic exists', !/leadRoleValue|topBuyerValue|ROLE_PURCHASE/.test(card));
}

if (process.argv.includes('--live')) {
  L('\n=== LIVE: THE REAL BOARD ===');
  const { tickerEvidence } = await import('../src/lib/evidence/resolve.js');
  const { boardKey } = await import('../src/lib/consensus/materialization.mjs');
  const U = process.env.KV_REST_API_URL, T = process.env.KV_REST_API_TOKEN;
  let b = (await (await fetch(`${U}/get/${encodeURIComponent(boardKey())}`, { headers: { Authorization: `Bearer ${T}` }, cache: 'no-store' })).json())?.result;
  if (typeof b === 'string') b = JSON.parse(b);
  const rows = (b.rows || []).slice(0, 40);
  let hits = 0; const bySrc = {};
  for (const r of rows) {
    const recs = await tickerEvidence(r.ticker, {});
    const h = highSignificance(recs?.evidence || []);
    if (h.high) { hits += 1; for (const x of h.reasons) bySrc[x.source] = (bySrc[x.source] || 0) + 1; }
    for (const x of h.reasons) {
      ok(`${r.ticker}: reason carries a checkable figure`,
        /\$|material event|historically unusual/.test(x.reason), x.reason);
      break;
    }
  }
  L(`  ${hits}/${rows.length} tagged · reasons ${JSON.stringify(bySrc)}`);
  ok('⚠️ the tag is selective, not universal', hits / rows.length < 0.7, `${hits}/${rows.length}`);
  ok('…and it is not empty', hits > 0);
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
