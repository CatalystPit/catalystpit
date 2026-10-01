// CONGRESS / POLITICIAN DATA — identity, amount representation and the two clocks.
//
//   node --env-file=.env.local scripts/verify-congress-integrity.mjs
//
// ⚠️ WHAT THIS GUARDS. Two defects were found by auditing production, and neither looked like broken
// code. A name SUFFIX arriving in the lastName field ({Angus, Jr.}) made the matcher miss, and the
// ingest then coined that non-name as a member of Congress — so 'angus-jr', 'william-iv',
// 'neal-facs' and 'neal-patrick-dunn-md-facs' appeared on /politicians, and because member_slug is
// an input to the dedupe hash, 29 of their 40 trades were second copies of trades already held under
// the correct member. And the multi-trade chart tooltip printed amount_mid, our own derived midpoint,
// as though Congress had disclosed an exact figure.
//
// Both produce a plausible page rather than an error, which is why they are asserted here.
import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';
import { buildIndex, matchMember, norm } from '../src/lib/congress-match.mjs';
import { buildRow } from '../src/lib/congress-ingest.mjs';

const sql = neon(process.env.DATABASE_URL);
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
// ⚠️ LINE COMMENTS FIRST, THEN BLOCK COMMENTS. This codebase contains `/*` inside line comments, and
// stripping blocks first treats one as an opener and deletes everything to the next `*/`.
const stripComments = (s) => s
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const one = async (q) => (await q)[0];

const roster = JSON.parse(read('../src/lib/congress-roster.json'));
const index = buildIndex(roster);
const rosterIds = new Set(roster.map((e) => e.bioguide));
const trade = (over) => ({ amount: '$1,001 - $15,000', transactionDate: '2024-06-01', disclosureDate: '2024-06-20', symbol: 'AAPL', type: 'purchase', ...over });

L('⚠️ every trade belongs to a REAL, identified member');
{
  // ⚠️ THE BIOGUIDE ID IS THE IDENTITY. A slug that is not one means the matcher missed and a name
  // fragment was coined as a person — which is exactly how four phantom members reached /politicians.
  const bad = await one(sql`select count(*)::int n from congress_trades where member_slug !~ '^[A-Z][0-9]{6}$'`);
  ok('⚠️ every member_slug is a Bioguide ID, never a name fragment', bad.n === 0, `${bad.n} rows`);
  const slugs = (await sql`select distinct member_slug from congress_trades`).map((r) => r.member_slug);
  const orphans = slugs.filter((s) => !rosterIds.has(s));
  ok('…and every one exists in the roster', orphans.length === 0, orphans.join(','));

  // ⚠️ ONE DISCLOSURE DOCUMENT HAS EXACTLY ONE FILER, so a document cited by two members is an
  // attribution error. This is the check that exposed the phantoms, and it needs no name comparison.
  const shared = await one(sql`select count(*)::int n from (
    select link from congress_trades where link is not null group by link having count(distinct member_slug) > 1) z`);
  ok('⚠️ no source document is attributed to two different members', shared.n === 0, `${shared.n} links`);
  const split = await one(sql`select count(*)::int n from (
    select transaction_date, ticker, action, amount_min, amount_max, link from congress_trades
    where ticker is not null and link is not null group by 1,2,3,4,5,6
    having count(distinct member_slug) > 1) z`);
  ok('…and no single trade is held under two identities', split.n === 0, `${split.n} groups`);
}

L('⚠️ one disclosed trade is one row');
{
  const r = await one(sql`select count(*)::int total, count(distinct tx_hash)::int h from congress_trades`);
  ok('no duplicate tx_hash', r.total === r.h, `${r.total} rows / ${r.h} hashes`);
  // The constraint, not just today's data — a unique index is what makes a re-read idempotent.
  const idx = await sql`select indexdef from pg_indexes where tablename='congress_trades' and indexdef ilike '%unique%'`;
  ok('⚠️ …enforced by a unique index on tx_hash',
    idx.some((i) => /\(tx_hash\)/.test(i.indexdef)), JSON.stringify(idx.map((i) => i.indexdef)));
  ok('…and the insert is idempotent at the application level too',
    /onConflictDoNothing\(\{\s*target:\s*congressTrades\.txHash\s*\}\)/.test(read('../src/lib/congress-sync.js')));
  // ⚠️ THE DEDUPE CANNOT CATCH AN IDENTITY ERROR, because member_slug is one of its inputs. That is
  // not a flaw to fix here — it is the reason the identity assertions above have to exist.
  ok('⚠️ member_slug is part of the canonical identity (so identity errors evade dedupe by design)',
    /canonicalHash\(\{[\s\S]{0,200}memberSlug/.test(read('../src/lib/congress-ingest.mjs')));
}

L('⚠️ a name with no surname identifies nobody');
{
  ok('a credential in the surname field is stripped, not indexed', norm('Dunn, MD, FACS') === 'dunn');
  ok('…and a bare credential leaves nothing', norm('FACS') === '' && norm('PhD') === '');
  ok('…as does a bare generational suffix', norm('Jr.') === '' && norm('IV') === '' && norm('Sr') === '');
  ok('a real surname is never mistaken for one', norm('Dunn') === 'dunn' && norm('Do') === 'do' && norm('King, Jr.') === 'king');

  // ⚠️ THE FOUR SHAPES THAT ACTUALLY ARRIVED. The first must resolve; the rest must refuse.
  const dunn = matchMember(index, { firstName: 'Neal Patrick', lastName: 'Dunn, MD, FACS', chamber: 'house', district: 'FL02' });
  ok('⚠️ "Dunn, MD, FACS" resolves to the one Dunn in the House', dunn.entry?.bioguide === 'D000628', JSON.stringify(dunn.method));
  for (const [f, l, ch] of [['Neal', 'FACS', 'house'], ['Angus', 'Jr.', 'senate'], ['William', 'IV', 'senate']]) {
    const m = matchMember(index, { firstName: f, lastName: l, chamber: ch, district: null });
    const row = buildRow(trade({ firstName: f, lastName: l }), ch, index);
    ok(`⚠️ "${f} / ${l}" is refused rather than coined as a member`,
      m.entry === null && row.memberSlug === null && row.txHash === null, `${m.method} slug=${row.memberSlug}`);
  }
  // ⚠️ AND THE CORRECT SHAPES STILL WORK — the refusal must not be achieved by matching less.
  for (const [f, l, ch, d, want] of [
    ['Angus S', 'King, Jr.', 'senate', null, 'K000383'],
    ['William F', 'Hagerty, IV', 'senate', null, 'H000601'],
    ['Neal P.', 'Dunn', 'house', 'FL02', 'D000628'],
    ['Nancy', 'Pelosi', 'house', 'CA11', 'P000197'],
  ]) {
    const row = buildRow(trade({ firstName: f, lastName: l, district: d }), ch, index);
    ok(`${f} ${l} still resolves to ${want} with party+state`,
      row.memberSlug === want && !!row.party && !!row.state, `${row.memberSlug} ${row.party} ${row.state}`);
  }

  // ⚠️ THE CREDENTIAL LIST MUST NOT EAT A REAL MEMBER'S NAME. 'jd' is excluded because it IS one
  // (V000137, James David Vance). This re-derives the collision check against the LIVE roster, so
  // seating a member whose name collides fails the suite instead of quietly losing their trades.
  const stripped = read('../src/lib/congress-match.mjs')
    .match(/\.replace\(\/\\b\(((?:[a-z]+\|)+[a-z]+)\)\\b\/g, ''\)/g) || [];
  const tokens = new Set(stripped.flatMap((s) => (s.match(/\(([a-z|]+)\)/)?.[1] || '').split('|')).filter(Boolean));
  ok('the strip list was found in the matcher', tokens.size > 10, `${tokens.size} tokens`);
  const names = new Set();
  for (const e of roster) for (const f of [e.nLast, e.nFirst, e.nNick]) String(f || '').split(' ').filter(Boolean).forEach((t) => names.add(t));
  const collide = [...tokens].filter((t) => names.has(t));
  ok('⚠️ no stripped token is a real member\'s name', collide.length === 0,
    collide.map((c) => c + ' -> ' + roster.filter((e) => [e.nLast, e.nFirst, e.nNick].some((f) => String(f || '').split(' ').includes(c))).map((e) => e.bioguide).join('/')).join('; '));

  // ⚠️ THE FMP INGEST IS DELETED, SO THERE IS NO LONGER AN FMP PATH TO DROP ANYTHING. This asserted
  // that fetchCongressRows filtered out records with no identity — a good rule about a client that pulled
  // both chambers from financialmodelingprep.com. Congressional trades come from the official House Clerk
  // and Senate eFD sources, and the identity rule that matters now is the one in the OFFICIAL path.
  // ⚠️ AGAINST THE CODE, NOT THE COMMENT RECORDING THE DELETION. congress-ingest.mjs explains what
  // fetchCongressRows was and where it pulled from, so a raw match on the vendor name fires on the very
  // note that documents its removal.
  const ingestCode = stripComments(read('../src/lib/congress-ingest.mjs'));
  ok('⚠️ the FMP congressional client is gone',
    !/financialmodelingprep/.test(ingestCode) && !/export async function fetchCongressRows/.test(ingestCode));
  ok('⚠️ …and the official ingest still refuses a record that identifies nobody',
    /txHash/.test(read('../src/lib/congress-sync.js')) || /nameSlug/.test(read('../src/lib/congress-sync.js')));
  const syncSrc = read('../src/lib/congress-sync.js');
  ok('…and so does the official-source sync', /\.filter\(\(r\) => r\.txHash\)/.test(syncSrc));
  // ⚠️ AND THE DROP IS VISIBLE. The Senate feed is the only source for its own disclosures, so a
  // silent refusal would quietly lose a real filing. It is counted and carried to the heartbeat note.
  ok('⚠️ a dropped record is counted, not silently discarded',
    /UNIDENTIFIED\[chamber\]/.test(syncSrc) && /out\.unidentified/.test(syncSrc));
  ok('⚠️ …and the count reaches the job heartbeat, where /api/health shows it',
    /unidentified, NOT ingested/.test(read('../src/app/api/cron/congress-sync/route.js')));
}

L('⚠️ Congress discloses a RANGE — never a manufactured exact value');
{
  const a = await one(sql`select
    count(*) filter (where amount_max is not null and amount_min > amount_max)::int inverted,
    count(*) filter (where amount_mid < amount_min)::int below,
    count(*) filter (where amount_max is not null and amount_mid > amount_max)::int above,
    count(*) filter (where amount_min is null)::int nomin
    from congress_trades`);
  ok('no band has min above max', a.inverted === 0, `${a.inverted}`);
  ok('every midpoint sits inside its own band', a.below === 0 && a.above === 0, `${a.below} below / ${a.above} above`);
  ok('every row carries the band\'s lower bound', a.nomin === 0, `${a.nomin}`);
  const r = await one(sql`select count(*)::int n from congress_trades where amount_range is null and amount_min is not null`);
  ok('⚠️ …and the disclosed range itself is retained, not just our derived numbers', r.n === 0, `${r.n} rows lost the range`);

  // ⚠️ A ">= $500K" CLAIM MUST BE TRUE OF THE WHOLE BAND. The $250,001-$500,000 band has a midpoint
  // of $375,000, so only the lower bound can support the claim.
  const res = read('../src/lib/evidence/resolve.js');
  ok('⚠️ evidence reports the band\'s LOWER BOUND for purchases', /buyAmountMin:/.test(res) && /amount_min/.test(res));
  ok('…and passes the disclosed range through', /amountRange: newest\.amount_range/.test(res));
  const hs = read('../src/lib/consensus/high-significance.mjs');
  ok('⚠️ significance tests the lower bound, not the midpoint',
    /const min = Number\(f\.buyAmountMin\)/.test(hs) && /min >= CONGRESS_PURCHASE_USD/.test(hs) && !/amountMid/.test(hs));

  // ⚠️ THE TOOLTIP DEFECT. A marker covering two or more trades printed amount_mid alone, so a
  // "$15,001 - $50,000" disclosure read "$32,500" — a precise figure the filer never reported.
  const chart = read('../src/components/TickerChart.jsx');
  const congressTooltips = chart.match(/\$\{esc\(t\.amountRange \|\| fmtVal\(t\.amountMid\)\)\}/g) || [];
  ok('⚠️ both chart tooltips print the disclosed band, falling back to the midpoint only if absent',
    congressTooltips.length >= 2, `${congressTooltips.length} of 2 call sites`);
  ok('…and neither prints the derived midpoint on its own',
    !/·\s*\$\{fmtVal\(t\.amountMid\)\}/.test(chart));
}

L('⚠️ "Return Since" is measured from a price the trade could have had');
{
  // ⚠️ AN ANCHOR AFTER THE TRADE IS A RETURN MEASURED FROM THE FUTURE. One row reached production
  // that way: FSSL, bought 2025-02-07, anchored to 2025-11-13, because the symbol's price history
  // starts later than the trade and the helper fell back to the earliest bar it had.
  const la = await one(sql`select count(*)::int n from congress_trades
    where price_at_trade_date is not null and price_at_trade_date > transaction_date`);
  ok('⚠️ no price anchor post-dates its own trade', la.n === 0, `${la.n} rows`);
  const bad = await one(sql`select count(*)::int n from congress_trades
    where price_at_trade is not null and (price_at_trade <= 0 or price_at_trade_date is null)`);
  ok('every anchor price is positive and dated', bad.n === 0, `${bad.n}`);
  ok('⚠️ …and no price before the trade yields NO anchor, not the next one after it',
    /return pick \? \{ price: pick\.close, priceDate: pick\.date \} : null;/.test(read('../src/lib/congress-ingest.mjs'))
    && !/if \(!pick\) pick = sorted\[0\]/.test(read('../src/lib/congress-ingest.mjs')));
  ok('…and the live enrichment path was already strict',
    /if \(b\.date <= target\) hit = b; else break;/.test(read('../src/app/api/refresh-congress/route.js')));
}

L('⚠️ two clocks: publicTime is when it became knowable');
{
  const res = read('../src/lib/evidence/resolve.js');
  // ⚠️ THE ONE SUBSTITUTION THAT WOULD BACKDATE EVIDENCE. A congressional trade happens weeks before
  // anyone may know of it; measuring from transaction_date would surface it before its disclosure.
  ok('⚠️ congress evidence publishes on disclosure_date', /publicTime: newest\.disclosure_date/.test(res));
  ok('…and keeps transaction_date as the event only', /eventTime: newest\.transaction_date/.test(res));
  ok('…and windows on the disclosure clock', /recent = r\.filter\(\(x\) => \(ms\(x\.disclosure_date\)[^)]*\) >= cutoff\)/.test(res));
  for (const [n, p] of [['board', '../src/lib/consensus/board.mjs'], ['build-context', '../src/lib/consensus/build-context.mjs']]) {
    const s = read(p);
    ok(`${n} windows congress on disclosure_date, never transaction_date`,
      /disclosure_date/.test(s) && !/transaction_date >= \(/.test(s));
  }
  const model = read('../src/lib/evidence/model.mjs');
  ok('⚠️ changedSince gates on publicTime, which is what makes a backfill safe',
    /const pub = toEpoch\(e\?\.publicTime\);/.test(model) && /pub > t/.test(model));

  // Production: the public clock must never be in the future, or a subscriber is told about a
  // disclosure that has not happened.
  const f = await one(sql`select count(*)::int n from congress_trades where disclosure_date > current_date`);
  ok('⚠️ nothing is disclosed in the future', f.n === 0, `${f.n}`);
  const neg = await one(sql`select count(*)::int n from congress_trades where filing_lag_days < 0`);
  ok('⚠️ no filing lag is negative (an event dated after its own disclosure is clamped, not negated)',
    neg.n === 0, `${neg.n}`);
}

L('⚠️ lateness is measured, never alleged');
{
  // The statute's 45 day deadline is a factual threshold. Calling a late filing a crime is not this
  // product's call to make, and the wording is asserted so it cannot drift into an accusation.
  const ov = read('../src/app/api/congress-overview/route.js');
  ok('the late-filing set is defined by the statutory deadline', /STOCK_ACT_DEADLINE_DAYS/.test(ov));
  ok('⚠️ …and is stated as a reporting failure, not evidence about the trade',
    /A late filing is a[\s\S]{0,40}reporting failure, not evidence of anything about the trade itself/.test(ov));
  ok('⚠️ no shipped congress surface calls a member\'s filing illegal or a violation',
    !/(illegal|unlawful|violat\w*|broke the law)/i.test(ov)
    && !/(illegal|unlawful|violat\w*)/i.test(read('../src/app/api/congress-trades/route.js')));
}

L('⚠️ a repair cannot manufacture an alert');
{
  const rep = read('./repair-congress-identity.mjs');
  // publicTime for a congress trade is disclosure_date. The repair writes identity and derived
  // attribution only, so no row it touches can cross a subscriber watermark however often it re-runs.
  const updates = rep.match(/update congress_trades set[\s\S]*?where id = \$\{u\.id\}/g) || [];
  ok('the repair has an update statement', updates.length > 0);
  ok('⚠️ …which never writes disclosure_date', !updates.some((u) => /disclosure_date/.test(u)));
  ok('…nor inserted_at, nor the source name fields',
    !updates.some((u) => /inserted_at|first_name|last_name/.test(u)));
  ok('⚠️ …and it proves it, by comparing the per-ticker newest disclosure before and after',
    /newest disclosure_date ADVANCED/.test(rep) && /process\.exit\(1\)/.test(rep));
  ok('⚠️ identity comes from a shared document or the roster — never name similarity',
    /ROSTER/.test(rep) && /DOCUMENT/.test(rep) && /targets\.size === 1/.test(rep));
}

L('the hot queries are indexed');
{
  const idx = (await sql`select indexname, indexdef from pg_indexes where tablename='congress_trades'`);
  const on = (col) => idx.some((i) => new RegExp(`\\(${col}\\)`).test(i.indexdef));
  ok('member_slug is indexed (the politician page)', on('member_slug'));
  ok('disclosure_date is indexed (every window and the EOD gate)', on('disclosure_date'));
  ok('ticker is indexed (the ticker page)', on('ticker'));
  ok('transaction_date is indexed (the date filters)', on('transaction_date'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
