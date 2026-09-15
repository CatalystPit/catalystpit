// CROSS-ISSUER 13F TICKER REPAIR.
//
// THE DEFECT. A ticker names one security. Characters 1-6 of a CUSIP identify the ISSUER, so a
// ticker's holdings should carry one issuer prefix. 563 carried more, because the issuer-NAME
// fallback assigned a ticker whenever either condensed name was a PREFIX of the other, and a fund
// sponsor's name is a prefix of every product it sponsors: the ProShares trust landed on AGQ, 12
// unrelated Invesco prefixes on IVZ, the Innovator trust on INHD, the BlackRock closed-end municipal
// trusts on BLK, Global X and Global Payments on GTLL, the SPDR S&P 500 trust on STT, CRH plc on RH.
//
// WHAT THIS DOES, AND WHAT IT REFUSES TO DO. It adjudicates each (ticker, CUSIP issuer prefix) group
// inside that 563-ticker set and nowhere else. It never deletes a holding, never invents a ticker,
// and never nulls a row merely because we cannot prove the mapping — absence of proof is the normal
// state of 2.9M correct holdings that simply have no OpenFIGI answer, and treating it as guilt would
// destroy IBM, TXN and QCOM along with the contamination.
//
//   1. authority names a DIFFERENT ticker for the CUSIP        -> reassign to it
//   2. some CUSIP in the group is authoritatively mapped here   -> keep (this IS the security)
//   3. the group's issuer matches the ticker's PROVEN identity  -> keep (an old CUSIP, a redomicile,
//        (an authoritative prefix's issuer, or the                    a corporate action)
//         first-party company name)
//   4. identity is proven and this group is a DIFFERENT issuer  -> NULL, and reject the CUSIP
//   5. the ticker's identity cannot be established at all       -> leave alone, report as ambiguous
//
// Rule 5 also fires when nothing in a ticker would survive: a ticker losing every holding means the
// identity was never established, not that all of it was contamination.
//
// Rejected CUSIPs get status 'rejected' in cusip_map and their KV key dropped, so the nightly
// inference cannot put the mapping back. OpenFIGI can still overwrite a rejection — authority wins
// over a repair, always.
//
// Read-only unless --apply, and re-running re-derives the same verdicts from the same evidence.
// One group is knowingly left unapplied: BUR/0G1797, a single row on Burford Capital's second CUSIP,
// which reads as a different issuer only because CAPITAL is not a droppable word. That is the
// measured price of keeping CAPITAL out of the vocabulary, and the vocabulary is worth more.
//   node --env-file=.env.local scripts/repair-cross-issuer.mjs [--apply]
//   ... --explain=AGQ,IVZ   per-prefix verdict for named tickers
//   ... --list-null         every group it would null

import { neon } from '@neondatabase/serverless';
import { ncore, isDerivativeClass } from '../src/lib/issuer-core.mjs';

const APPLY = process.argv.includes('--apply');
const sql = neon(process.env.DATABASE_URL);
const n = (x) => Number(x).toLocaleString('en-US');
const AUTH = ['openfigi', 'manual', 'consensus'];
const isAuth = (s) => AUTH.includes(s);
const KV_URL = process.env.KV_REST_API_URL, KV_TOKEN = process.env.KV_REST_API_TOKEN;
const SEP = String.fromCharCode(1);

console.log(APPLY ? '=== APPLYING ===' : '=== DRY RUN (pass --apply to write) ===');

// -- load -------------------------------------------------------------------
const map = new Map();
for (let i = 0; ; i += 20000) {
  const r = await sql.query('select cusip, ticker, source, status from cusip_map order by cusip limit 20000 offset $1', [i]);
  for (const x of r) map.set(x.cusip, x);
  if (r.length < 20000) break;
}
const names = new Map();
for (const r of await sql.query('select ticker, company from screener_stocks where company is not null'))
  names.set(r.ticker, ncore(r.company));

// The classifier already in the database decides what is a derivative line. No second regex.
const clsKind = new Map();
for (let i = 0; ; i += 50000) {
  const r = await sql.query('select cusip, cls, put_call, kind from security_position_class order by cusip, cls, put_call limit 50000 offset $1', [i]);
  for (const x of r) clsKind.set(x.cusip + SEP + x.cls + SEP + x.put_call, x.kind);
  if (r.length < 50000) break;
}
// DERIVATIVES, NOT DEBT. A derivative line carries a pseudo-CUSIP and the underlying's or sponsor's
// name, so it cannot speak for a security's identity. 'debt' is deliberately NOT excluded here: the
// classifier reads a position as debt from how the FILER worded the class, and filers word bond-fund
// and bond-ETF equity lines exactly like bonds — 1,679 of BSV's own rows read as debt. Suppressing
// those would empty a ticker's evidence and make the repair null the very security the ticker names.
const NONEQUITY = new Set(['option', 'warrant', 'right', 'preferred']);
const speaksForIdentity = (r) => r.put_call === ''
  && !NONEQUITY.has(clsKind.get(r.cusip + SEP + r.class + SEP + r.put_call))
  && !isDerivativeClass(r.class);

// scope: tickers whose holdings carry MORE THAN ONE CUSIP issuer prefix
const rows = await sql.query(`
  with pfx as (select ticker, left(cusip, 6) p from fund_holdings
                where ticker is not null and cusip ~ '^[0-9A-Z]{9}$' group by ticker, left(cusip, 6)),
  disputed as (select ticker from pfx group by ticker having count(*) > 1)
  select f.ticker, f.cusip, f.issuer, f.class, f.put_call, count(*)::int rows,
         count(distinct f.cik)::int filers, sum(f.value)::numeric val
    from fund_holdings f join disputed d on d.ticker = f.ticker
   where f.cusip ~ '^[0-9A-Z]{9}$' group by 1, 2, 3, 4, 5`);
console.log(`loaded: cusip_map ${n(map.size)}  first-party names ${n(names.size)}  classifier ${n(clsKind.size)}  in-scope lines ${n(rows.length)}`);

// -- group by (ticker, issuer prefix) ---------------------------------------
const G = new Map();
for (const r of rows) {
  const k = r.ticker + '|' + r.cusip.slice(0, 6);
  let g = G.get(k);
  if (!g) G.set(k, g = { ticker: r.ticker, pfx: r.cusip.slice(0, 6), rows: 0, val: 0,
    cusips: new Set(), cores: new Map(), allCores: new Map(), auth: false, other: new Map() });
  g.rows += r.rows; g.val += Number(r.val) || 0; g.cusips.add(r.cusip);
  const m = map.get(r.cusip);
  if (m && isAuth(m.source) && m.ticker === r.ticker) g.auth = true;
  if (m && isAuth(m.source) && m.ticker && m.ticker !== r.ticker) g.other.set(m.ticker, (g.other.get(m.ticker) || 0) + r.rows);
  const c = ncore(r.issuer);
  if (!c || c.length < 3) continue;
  const bump = (mm) => { const e = mm.get(c) || { rows: 0, filers: 0 }; e.rows += r.rows; e.filers += r.filers; mm.set(c, e); };
  bump(g.allCores);
  if (speaksForIdentity(r)) bump(g.cores);
}

// What a group is allowed to say about itself. Derivative lines are excluded FIRST, because an
// options line carries a pseudo-CUSIP and whatever name the filer felt like typing. But a group whose
// every line is a derivative is not thereby unjudgeable — AGQ's stray ProShares option and IVZ's four
// Invesco option pseudo-CUSIPs are exactly that shape — so when the clean evidence is empty the
// issuer strings are read anyway. Only a group with no issuer name at all has nothing to say.
const evidence = (g) => (g.cores.size ? g.cores : g.allCores);
const dominant = (g) => {
  let best = null, bestRows = -1;
  for (const [c, e] of evidence(g)) if (e.rows > bestRows || (e.rows === bestRows && c < best)) { best = c; bestRows = e.rows; }
  return best;
};

// CORROBORATION, NOT COINCIDENCE. Filers spell one issuer a dozen ways — Accenture's own CUSIP is
// written ACCENTURE IRELAND on 1,840 lines and ACCENTURE on 419 — so a group has to be allowed to
// match the ticker's identity on ANY of its spellings. Requiring the DOMINANT spelling to match would
// null 2,345 rows of real Accenture, 1,299 of Royal Caribbean and 845 of Check Point for the crime of
// being worded differently from a two-row US line.
//
// What must NOT count is a single filer's slip. One line reading "INVESCO" on an Invesco BulletShares
// CUSIP, and one reading "BLACKROCK" on Bowater's, are exactly how contamination smuggles itself back
// through a set match. So the matching spelling has to come from more than one filer: 419, 128, 174
// and 19 independent filers wrote the matching name in the legitimate cases above; exactly one did in
// each contaminated one. This is a statement about corroboration, not a tuned percentage.
//
// So a group's claim is the name MOST of its filers give it, and a different spelling may still carry
// the claim — but only with corroboration. A lone line is never enough to overturn what the rest of
// the group says, and in a one-line group there is nothing to overturn.
const matchesTruth = (g, T) => {
  const dom = dominant(g);
  if (dom && T.has(dom)) return true;
  for (const [c, e] of evidence(g)) if (T.has(c) && e.filers > 1) return true;
  return false;
};

// a ticker's PROVEN identity: the issuer names on its authoritative CUSIPs, plus its first-party name
const truth = new Map();
const addTruth = (t, c) => { let s = truth.get(t); if (!s) truth.set(t, s = new Set()); s.add(c); };
for (const g of G.values()) if (g.auth) for (const c of g.cores.keys()) addTruth(g.ticker, c);
for (const g of G.values()) { const fp = names.get(g.ticker); if (fp && fp.length >= 3) addTruth(g.ticker, fp); }

const byTicker = new Map();
for (const g of G.values()) { let a = byTicker.get(g.ticker); if (!a) byTicker.set(g.ticker, a = []); a.push(g); }
for (const [t, gs] of byTicker) {
  const T = truth.get(t);
  for (const g of gs) {
    if (g.auth) g.d = 'keep_auth';
    else if (g.other.size === 1) g.d = 'reassign';
    else if (!T) g.d = 'ambiguous';
    // No issuer name at all — nothing to judge, so judge nothing. Silence is not proof of guilt.
    else if (!evidence(g).size) g.d = 'ambiguous';
    else g.d = matchesTruth(g, T) ? 'keep_same_issuer' : 'null_unproven';
  }
  if (!gs.some((g) => g.d === 'keep_auth' || g.d === 'keep_same_issuer' || g.d === 'reassign'))
    for (const g of gs) if (g.d === 'null_unproven') g.d = 'ambiguous';
}

// -- ALSO: holdings anywhere that an authoritative mapping flatly contradicts ------------------
// Outside the multi-prefix set but the same defect: a holding carrying a ticker the security-level
// answer says is wrong. Four CUSIPs, all slash-form share classes and one foreign line that never got
// normalised (BRK/B, BRK/A, HEI/A, TRI4EUR).
const contradicted = await sql.query(`
  select f.ticker, f.cusip, m.ticker correct, count(*)::int rows
    from fund_holdings f join cusip_map m on m.cusip = f.cusip
   where f.ticker is not null and m.source = any($1) and m.ticker is not null and m.ticker <> f.ticker
   group by 1, 2, 3 order by rows desc`, [AUTH]);

// -- report the plan --------------------------------------------------------
const groups = [...G.values()];
const sum = (d) => groups.filter((g) => g.d === d).reduce((s, g) => s + g.rows, 0);
console.log('\n=== PLAN, per (ticker, CUSIP issuer prefix) ===');
for (const d of ['keep_auth', 'keep_same_issuer', 'reassign', 'null_unproven', 'ambiguous'])
  console.log('  ' + d.padEnd(18) + String(groups.filter((g) => g.d === d).length).padStart(5) + ' groups  ' + n(sum(d)).padStart(10) + ' rows');
console.log('  contradicted elsewhere  ' + String(contradicted.length).padStart(6) + ' cusips  '
  + n(contradicted.reduce((s, r) => s + r.rows, 0)).padStart(10) + ' rows -> reassigned by authority');

// CUSIPs to reject: only those that will be left on NO ticker ANYWHERE once the nulls are applied.
// Scoping this to the in-scope groups was wrong — 35909D109 contaminates ULCC and is legitimately
// FYBR's own security, and rejecting it would block it from resolving where it belongs.
const nulls = groups.filter((g) => g.d === 'null_unproven');
const survivingCusip = new Set((await sql.query(`
  select distinct f.cusip from fund_holdings f
   where f.ticker is not null and f.cusip ~ '^[0-9A-Z]{9}$'
     and not exists (select 1 from unnest($1::text[], $2::text[]) as u(t, p)
                      where u.t = f.ticker and u.p = left(f.cusip, 6))`,
  [nulls.map((g) => g.ticker), nulls.map((g) => g.pfx)])).map((r) => r.cusip));
const rejectCusips = new Set();
for (const g of nulls) for (const c of g.cusips) if (!survivingCusip.has(c)) rejectCusips.add(c);
console.log('  cusips to mark rejected ' + String(rejectCusips.size).padStart(6));

// --explain / --list-null: how every decision here was checked by hand before it was allowed to run.
const explain = (process.argv.find((a) => a.startsWith('--explain=')) || '').slice(10);
if (explain) for (const t of explain.split(',')) {
  console.log('\n' + t + '   proven identity: ' + [...(truth.get(t) || [])].slice(0, 6).join(', '));
  for (const g of (byTicker.get(t) || []).sort((a, b) => b.rows - a.rows))
    console.log('    ' + g.pfx + '  ' + String(g.rows).padStart(6) + 'r  $' + n(Math.round(g.val)).padStart(15)
      + '  ' + String(g.d).padEnd(17) + '  ' + String(dominant(g)).slice(0, 52));
}
if (process.argv.includes('--list-null')) {
  console.log('\n=== every group this would NULL ===');
  for (const g of nulls.sort((a, b) => b.rows - a.rows))
    console.log('  ' + g.ticker.padEnd(9) + g.pfx + ' ' + String(g.rows).padStart(6) + 'r  ' + String(dominant(g)).slice(0, 60));
}

if (!APPLY) {
  console.log('\n(dry run - nothing written)');
  process.exit(0);
}

// -- apply ------------------------------------------------------------------
let reassigned = 0, nulled = 0;
for (const r of contradicted) {
  await sql.query('update fund_holdings set ticker = $1 where ticker = $2 and cusip = $3', [r.correct, r.ticker, r.cusip]);
  reassigned += r.rows;
  console.log(`  reassigned ${n(r.rows)} rows  ${r.ticker} -> ${r.correct}`);
}
for (const g of groups.filter((x) => x.d === 'reassign')) {
  const to = [...g.other.keys()][0];
  await sql.query('update fund_holdings set ticker = $1 where ticker = $2 and left(cusip,6) = $3', [to, g.ticker, g.pfx]);
  reassigned += g.rows;
  console.log(`  reassigned ${n(g.rows)} rows  ${g.ticker}/${g.pfx} -> ${to}`);
}
for (let i = 0; i < nulls.length; i += 50) {
  const b = nulls.slice(i, i + 50);
  await sql.query(`update fund_holdings h set ticker = null
    from unnest($1::text[], $2::text[]) as u(t, p)
   where h.ticker = u.t and left(h.cusip, 6) = u.p`, [b.map((g) => g.ticker), b.map((g) => g.pfx)]);
  nulled += b.reduce((s, g) => s + g.rows, 0);
}
console.log(`\n  rows reassigned to another ticker  ${n(reassigned)}`);
console.log(`  rows set to NULL                   ${n(nulled)}`);

// cusip_map: mark rejected, keeping whichever source examined it where there is one.
// RETURNING, because the neon HTTP driver hands back a plain row array with no rowCount.
const rj = [...rejectCusips];
let mapUpdated = 0, mapInserted = 0;
for (let i = 0; i < rj.length; i += 500) {
  const b = rj.slice(i, i + 500);
  const u = await sql.query("update cusip_map set ticker = null, status = 'rejected', updated_at = now() where cusip = any($1) returning cusip", [b]);
  mapUpdated += u.length;
  const ins = await sql.query(`insert into cusip_map (cusip, ticker, status, confidence, source, updated_at)
     select c, null, 'rejected', null, 'repair', now() from unnest($1::text[]) c
      on conflict (cusip) do nothing returning cusip`, [b]);
  mapInserted += ins.length;
}
console.log(`  cusip_map rows marked rejected     ${n(mapUpdated)} updated, ${n(mapInserted)} inserted`);

// A rejection is only ever about a CUSIP that no longer carries a ticker anywhere. Anything that
// still does must not stay rejected, or the inference is blocked where it was right.
const unrej = await sql.query(`update cusip_map m set status = 'unresolved', updated_at = now()
  where m.status = 'rejected'
    and exists (select 1 from fund_holdings f where f.cusip = m.cusip and f.ticker is not null)
  returning m.cusip`);
if (unrej.length) console.log(`  rejections lifted (still in use)   ${n(unrej.length)}`);

// KV: drop only the keys for CUSIPs this repair touched
let kvDeleted = 0, kvMissing = 0;
if (KV_URL && KV_TOKEN) {
  const keys = [...new Set([...rj, ...contradicted.map((r) => r.cusip)])];
  for (let i = 0; i < keys.length; i += 40) {
    const b = keys.slice(i, i + 40);
    const res = await Promise.all(b.map((c) => fetch(`${KV_URL}/del/${encodeURIComponent('catalystpit:cusip:' + c)}`,
      { method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}` } }).then((r) => r.json()).catch(() => null)));
    for (const r of res) { if (r && r.result === 1) kvDeleted++; else kvMissing++; }
  }
}
console.log(`  KV mappings invalidated            ${n(kvDeleted)} deleted, ${n(kvMissing)} had no key`);
console.log('\ndone.');
