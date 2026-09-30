// FREE / PRO GATING — what an UNAUTHENTICATED caller can actually get out of production.
//
//   node scripts/verify-gating-production.mjs [--base https://www.catalystpit.com]
//
// ⚠️ A HIDDEN BUTTON IS NOT A GATE. Every check here calls the API directly with no session, the way
// somebody would who had read the network tab. What matters is not whether the UI offered the
// feature but whether the server hands over the data when asked without credentials.
//
// ⚠️ AND THE ABSENCE OF DATA IS NOT PROOF OF A GATE. A route that 500s, or returns [] because a
// ticker is wrong, "passes" any naive check. So each assertion below requires the endpoint to
// RESPOND USEFULLY and to be delayed/truncated — never merely to be empty.
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('base', 'https://www.catalystpit.com');
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
import { readdirSync } from 'node:fs';
function srcFiles(rel) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(new URL(dir + '/', import.meta.url), { withFileTypes: true })) {
      if (e.isDirectory()) walk(dir + '/' + e.name);
      else if (/[.](jsx?|mjs)$/.test(e.name)) out.push(dir + '/' + e.name);
    }
  };
  walk(rel);
  return out;
}
const L = (s) => console.log(`\n=== ${s} ===`);
const get = async (p) => {
  const r = await fetch(`${BASE}${p}`, { headers: { 'cache-control': 'no-cache' } });
  let j = null; try { j = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, json: j, headers: r.headers };
};


L('⚠️ no upsell renders while entitlement is still unknown');
{
  const { readFileSync } = await import('node:fs');
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const UPSELL = /UNLOCK PRO|Unlock Pro|Start Pro|Upgrade to Pro|is a Pro feature/;

  // ⚠️ useState(null) IS NOT ENOUGH ON ITS OWN. `{!pro && <Upsell/>}` still renders the pitch while
  // pro is null, because !null is true. What prevents the flash is a render condition that
  // distinguishes "not Pro" from "not known yet", so that is what is asserted — per surface.

  // Homepage: a dedicated wrapper that returns null until the answer is in.
  const home = read('../src/components/CatalystPit.jsx');
  ok('the homepage has an explicit unresolved state',
    /resolved: isLoaded && \(!isSignedIn \|\| tier !== null\)/.test(home));
  ok('⚠️ …and its FreeOnly wrapper renders nothing while unresolved OR for a Pro viewer',
    /if \(!resolved \|\| pro\) return null;/.test(home));
  // Every upsell on the page must actually be inside one of those wrappers.
  const blocks = [...home.matchAll(/<FreeOnly>([\s\S]*?)<\/FreeOnly>/g)].map((m) => m[1]).join('\n');
  const upsellLines = home.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => UPSELL.test(l) && !l.trim().startsWith('//') && !l.trim().startsWith('*'));
  const uncovered = upsellLines.filter(([, l]) => !blocks.includes(l));
  ok('⚠️ …and every upsell on the homepage sits inside one', uncovered.length === 0,
    uncovered.map(([n]) => `line ${n}`).join(', '));

  // Terminal: the whole page is the gate, so the loading branch must come FIRST.
  const term = read('../src/app/terminal/TerminalClient.jsx');
  ok('the Terminal shows a loading state, not the pitch, while tier is null',
    /\{tier === null \? \(/.test(term));
  ok('⚠️ …and that branch is evaluated before the upsell branch',
    term.indexOf('tier === null ?') < term.indexOf('is a Pro feature'));
  ok('⚠️ …and an admin passes the Terminal gate exactly like a Pro',
    /const isPro = tier === 'pro' \|\| tier === 'elite' \|\| admin;/.test(term));

  // Ticker page: the locked COUNT is what draws the upsell, so it must be 0 while unknown.
  const tick = read('../src/app/ticker/[symbol]/TickerPage.jsx');
  ok('the ticker page starts entitlement as unknown, not as free',
    /const \[pro, setPro\] = useState\(null\)/.test(tick));
  ok('⚠️ …and computes locked only once the answer is false, never while it is null',
    /const locked = pro === false \?/.test(tick)
    && !/const locked = !pro \?/.test(tick));
}

L('⚠️ admin is Pro everywhere the product gates');
{
  const { readFileSync } = await import('node:fs');
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

  // ⚠️ TWO MECHANISMS, AND BOTH MUST HOLD. resolveUserAccess maps the admin email to 'elite', so
  // admin is Pro by tier alone; routes that ALSO consult isAdminUser must not contradict that by
  // gating on tier in a way that excludes it. A route that checked `tier === 'pro'` exactly would
  // lock the owner out of the product they sell.
  const ent = read('../src/lib/entitlements.js');
  ok('the admin email resolves to the top tier', /return \{ tier: 'elite', beta: false \};/.test(ent));
  ok('⚠️ …and a signed-out or failed lookup falls back to free, never up',
    /if \(!userId\) return \{ tier: 'free', beta: false \};/.test(ent)
    && /catch \{\s*\n?\s*return \{ tier: 'free', beta: false \};/.test(ent));

  // ⚠️ NO ROUTE MAY TEST FOR 'pro' ALONE. 'elite' is what an admin gets, so an exact equality check
  // is how the owner — and any future Elite subscriber — silently loses access.
  const offenders = [];
  for (const f of srcFiles('../src/app/api')) {
    const s = read(f).split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    for (const m of s.matchAll(/tier\s*===\s*'pro'/g)) {
      const around = s.slice(Math.max(0, m.index - 120), m.index + 120);
      if (!/'elite'/.test(around)) offenders.push(f);
    }
  }
  ok('⚠️ no API gates on tier === "pro" without also accepting elite',
    offenders.length === 0, [...new Set(offenders)].join(', '));

  // Beta testers get Pro features but NOT licensed real-time data.
  ok('⚠️ a beta tester gets Pro features on delayed data, not the licensed feed',
    /return \{ tier: 'pro', beta: true \};/.test(ent));
  const rtOffenders = [];
  for (const f of srcFiles('../src/app/api')) {
    const s = read(f);
    if (!/isRealtime\(/.test(s)) continue;
    // ⚠️ MATCHED ON THE INVARIANT, NOT ON ONE SPELLING. This required the literal
    // "isRealtime(tier) && !beta" and failed when the destructuring changed to a.tier / a.beta —
    // reporting a defect that was a rename. What must hold is that the beta flag negates the
    // real-time decision, however the variables are named.
    if (!/isRealtime\(\s*\w+(?:\.\w+)?\s*\)\s*&&\s*!\s*\w+(?:\.\w+)?\b/.test(s)) rtOffenders.push(f);
  }
  ok('⚠️ …enforced at every real-time decision, not just documented',
    rtOffenders.length === 0, rtOffenders.join(', '));
}
L('⚠️ market data is DELAYED for an unauthenticated caller');
{
  const q = await get('/api/quotes?symbols=AAPL,MSFT');
  ok('quotes responds', q.status === 200 && !!q.json, `HTTP ${q.status}`);
  // ⚠️ THE RESPONSE MUST SAY WHICH IT IS. A quote with no freshness marker cannot be checked by
  // anyone — including us — so "it did not claim real-time" is not good enough.
  const marker = JSON.stringify(q.json || {});
  // ⚠️ THE MARKER THE ROUTE ACTUALLY EMITS. This first asserted "delayed":true / "access":"delayed"
  // and failed against a correct response — the route reports `freshness` and `delayMinutes`. An
  // assertion that invents the field name it expects reports the product broken when it is not, and
  // would have been "fixed" by loosening it until it passed.
  const first = Object.values(q.json || {})[0] || {};
  // ⚠️ AND THERE ARE TWO CORRECT ANSWERS, DEPENDING ON THE CLOCK. This asserted freshness ===
  // 'delayed' unconditionally and so failed every night against a correct response: once the session
  // is over there is no 15-minute-delayed quote to serve, and the route says so with 'eod' plus an
  // asOf of the closing print. Asserting only the intraday label made the product look broken for
  // most of the day, and the tempting "fix" — dropping the number check — would have removed the only
  // assertion that can tell a delayed feed from the licensed one wearing a sticker.
  ok('⚠️ …and declares its freshness, so the claim can be checked at all',
    first.freshness === 'delayed' || first.freshness === 'eod', JSON.stringify(first).slice(0, 160));
  if (first.freshness === 'delayed') {
    // Intraday: the label is not enough — a quote stamped "delayed" but one second old is real-time.
    ok('⚠️ …and a delayed quote really is delayed, verified against the timestamp',
      Number(first.delayMinutes) >= 15
      && (Date.now() - new Date(first.asOf).getTime()) / 60000 >= 14,
      `delayMinutes=${first.delayMinutes} asOf=${first.asOf}`);
  } else {
    // Outside the session: the print must belong to a session that has actually finished. Measured
    // against the real exchange calendar — lastCompletedSession() walks weekends, holidays and early
    // closes — not against "older than 24 hours", which is wrong across every long weekend.
    // ⚠️ THE CLOSE INSTANT, NOT THE CALENDAR DATE. Comparing ET dates accepted a quote stamped with
    // the live clock: at 01:15 UTC it is still 21:15 ET on the SAME date as the finished session, so a
    // real-time print relabelled 'eod' passed. The bound has to be the session's own close, and
    // closeMinute() is what knows an early close is 13:00 rather than 16:00.
    const { lastCompletedSession, closeMinute } = await import('../src/lib/market/market-session.mjs');
    const session = lastCompletedSession();                       // 'YYYY-MM-DD'
    const etParts = (iso) => new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(iso)).reduce((a, p) => (a[p.type] = p.value, a), {});
    const p = etParts(first.asOf);
    const asOfDate = `${p.year}-${p.month}-${p.day}`;
    const asOfMinute = Number(p.hour) % 24 * 60 + Number(p.minute);
    ok('⚠️ …and an EOD quote is a closing print from a session that has already ended',
      !!first.asOf && (asOfDate < session || (asOfDate === session && asOfMinute <= closeMinute(session) + 1)),
      `asOf=${first.asOf} (ET ${asOfDate} ${p.hour}:${p.minute}) session=${session} close=${closeMinute(session)}min`);
  }
  ok('⚠️ …and never claims real-time to a signed-out caller',
    !/"freshness"\s*:\s*"realtime"|"realtime"\s*:\s*true|"access"\s*:\s*"realtime"/.test(marker));

  // ⚠️ THIS ASSERTED THE OLD RULE, that a signed-out caller got DELAYED intraday bars. Intraday is
  // now Pro-only, so a 200 here would be the defect and the 403 is the pass. Kept rather than
  // deleted because "intraday is refused, and refused by every label" is the thing worth pinning.
  for (const r of ['1m', '5m', '15m', '30m', '1h', '4h', '1D', '5D']) {
    const c = await get(`/api/chart-intraday?ticker=AAPL&range=${r}`);
    ok(`⚠️ intraday range ${r} is refused without Pro`, c.status === 403, `HTTP ${c.status}`);
    // ⚠️ REFUSED, NOT SUBSTITUTED. Answering with daily candles would put bars on a chart labelled
    // 5m that are nothing of the kind, and the caller could not tell they had been downgraded.
    ok(`…and returns no bars for ${r}`, !Array.isArray(c.json?.bars) || c.json.bars.length === 0);
  }
  ok('⚠️ …including 1D and 5D, which are this chart\'s intraday buttons despite the daily-looking id',
    (await get('/api/chart-intraday?ticker=AAPL&range=1D')).status === 403);

  // The end-of-day timeframes Free is entitled to must still work, and still be EOD.
  for (const r of ['1M', '1Y', 'all']) {
    const d = await get(`/api/chart-daily?ticker=AAPL&range=${r}`);
    ok(`daily range ${r} still serves Free`, d.status === 200 && (d.json?.candles?.length ?? 0) > 0,
      `HTTP ${d.status} candles=${d.json?.candles?.length}`);
  }
}

L('⚠️ Pro-only rows are withheld SERVER-SIDE, not hidden in the page');
{
  const b = await get('/api/consensus-board');
  ok('consensus board responds', b.status === 200 && !!b.json, `HTTP ${b.status}`);
  const rows = b.json?.rows || b.json?.board || [];
  // FREE_ROWS = 5 in the route. The locked remainder must never appear in the payload.
  ok('⚠️ …truncated to the free preview rather than the full board',
    Array.isArray(rows) && rows.length <= 5, `${Array.isArray(rows) ? rows.length : '?'} rows`);
  ok('…and the count it withheld is disclosed rather than silently dropped',
    b.json?.locked != null || b.json?.lockedCount != null || b.json?.isFull === false,
    JSON.stringify(Object.keys(b.json || {})));

  const i = await get('/api/insiders?view=rows&limit=100');
  ok('insiders responds', i.status === 200 && !!i.json, `HTTP ${i.status}`);
  const irows = i.json?.rows || [];
  ok('⚠️ …previewed, not served in full, to a signed-out caller',
    Array.isArray(irows) && irows.length <= 10, `${Array.isArray(irows) ? irows.length : '?'} rows`);
}


L('⚠️ every tier-aware list is truncated for an anonymous caller');
{
  // ⚠️ EACH ONE MUST RETURN SOMETHING AND STILL BE SHORT. `rows <= cap` is satisfied by a 500, an
  // empty array, or a typo in the query string, so every case below also requires the endpoint to
  // have answered with real data and to have DISCLOSED what it withheld. A silent truncation and a
  // broken endpoint look identical otherwise.
  const cases = [
    ['congress trades', '/api/congress-trades?limit=100', 'trades', 10, 'lockedCount'],
    ['politicians', '/api/politicians?limit=100', 'members', 10, 'lockedCount'],
    ['news', '/api/news?limit=50', 'data', 10, 'lockedCount'],
    ['confluence board (bull)', '/api/confluence?dir=bull', 'list', 5, 'lockedCount'],
    ['confluence board (bear)', '/api/confluence?dir=bear', 'list', 5, 'lockedCount'],
  ];
  for (const [label, path, key, cap, lockKey] of cases) {
    const r = await get(path);
    const rows = r.json?.[key];
    ok(`${label} responds with data`, r.status === 200 && Array.isArray(rows) && rows.length > 0,
      `HTTP ${r.status} ${Array.isArray(rows) ? rows.length : typeof rows}`);
    ok(`⚠️ …capped at the free preview (${cap})`, Array.isArray(rows) && rows.length <= cap,
      `${Array.isArray(rows) ? rows.length : '?'} rows`);
    ok('…and says how much it withheld rather than truncating silently',
      Number(r.json?.[lockKey]) > 0, `${lockKey}=${r.json?.[lockKey]}`);
    ok('…and never reports the caller as pro', r.json?.tier === undefined || r.json?.tier === 'free',
      String(r.json?.tier));
  }

  // Bulls & Bears strips the points themselves server-side — the locked ones never leave the server.
  const bb = await get('/api/bulls-bears?ticker=AAPL');
  ok('bulls & bears responds', bb.status === 200 && !!bb.json, `HTTP ${bb.status}`);
  ok('⚠️ …with one point a side, not the full breakdown',
    (bb.json?.bulls?.length ?? 99) <= 1 && (bb.json?.bears?.length ?? 99) <= 1,
    `bulls=${bb.json?.bulls?.length} bears=${bb.json?.bears?.length}`);
  ok('…and the withheld counts are disclosed',
    Number(bb.json?.lockedBullCount) > 0 || Number(bb.json?.lockedBearCount) > 0,
    `${bb.json?.lockedBullCount}/${bb.json?.lockedBearCount}`);
}

L('⚠️ movers boards are end-of-day for an anonymous caller');
{
  for (const p of ['/api/movers', '/api/market-movers']) {
    const r = await get(p);
    ok(`${p} responds`, r.status === 200 && !!r.json, `HTTP ${r.status}`);
    // ⚠️ eod OR delayed, NEVER realtime. Which of the two is a product decision per board; what is
    // licensed is that neither is the live feed.
    ok(`⚠️ …and is marked eod/delayed, never realtime`,
      r.json?.freshness === 'eod' || r.json?.freshness === 'delayed', String(r.json?.freshness));
  }
}
L('⚠️ Pro-only WRITES are refused without a session');
{
  const post = async (p, body) => {
    const r = await fetch(`${BASE}${p}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
    });
    let j = null; try { j = await r.json(); } catch { /* non-JSON */ }
    return { status: r.status, json: j };
  };
  // ⚠️ 401/403 ONLY. A 500 would also "not grant access", but it means the route reached its work
  // before deciding, which is a gate that happens to be failing rather than a gate.
  for (const [label, path, body] of [
    ['watchlist add', '/api/watchlist', { ticker: 'AAPL' }],
    ['named watchlists (Pro)', '/api/watchlist/lists', { name: 'test' }],
    ['post to the feed', '/api/feed', { body: 'test' }],
    ['post to The Pit', '/api/pit/messages', { text: 'test' }],
    ['start checkout', '/api/stripe/checkout', { interval: 'monthly' }],
    ['open billing portal', '/api/stripe/portal', {}],
  ]) {
    const r = await post(path, body);
    ok(`${label} is refused with 401/403`, r.status === 401 || r.status === 403, `HTTP ${r.status}`);
  }
}

L('⚠️ the tier endpoint itself cannot be spoofed or cached');
{
  const p = await get('/api/me/plan');
  ok('/api/me/plan resolves for a signed-out caller', p.status === 200 && !!p.json, `HTTP ${p.status}`);
  ok('⚠️ …to free, never pro', p.json?.tier === 'free', JSON.stringify(p.json));
  // ⚠️ A CDN-CACHED PLAN IS A CROSS-USER LEAK. One Pro response cached at the edge would be served
  // to every signed-out visitor behind it, which hands out entitlement to strangers.
  const cc = String(p.headers.get('cache-control') || '');
  ok('⚠️ …and is never cached, so one user\'s plan cannot be served to another',
    /no-store/.test(cc) && /private/.test(cc), cc);

  // A forged header must not be believed.
  const forged = await fetch(`${BASE}/api/me/plan`, { headers: { 'x-user-tier': 'pro', 'x-plan': 'pro' } });
  const fj = await forged.json().catch(() => ({}));
  ok('⚠️ a client-supplied tier header is ignored', fj?.tier === 'free', JSON.stringify(fj));
}

L('⚠️ admin surfaces are not readable by an anonymous caller');
{
  const a = await get('/api/me/admin');
  ok('/api/me/admin answers false rather than leaking', a.status === 200 && a.json?.admin === false,
    `HTTP ${a.status} ${JSON.stringify(a.json)}`);
  const m = await get('/api/internal/metrics');
  ok('the internal metrics endpoint stays closed', m.status === 401, `HTTP ${m.status}`);
}


L('⚠️ edge-cached responses stay user-independent');
{
  const { readFileSync } = await import('node:fs');
  const read2 = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  // ⚠️ THE RULE THAT MAKES EDGE CACHING SAFE. /api/ticker is served with s-maxage, so ONE response is
  // shared by every visitor. The moment that route resolves a session, a tier, or a cookie, the first
  // user's answer is handed to everybody behind the same cache entry — a gating hole created by a
  // performance change, which is exactly the kind nobody goes looking for.
  const t = read2('../src/app/api/ticker/route.js');
  const code = t.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  const shared = /s-maxage/.test(code);
  ok('the ticker route is edge-cached', shared);
  ok('⚠️ …and therefore resolves no session, tier or cookie',
    !/\bauth\(\)/.test(code) && !/resolveUser(Tier|Access)/.test(code)
    && !/cookies\(\)/.test(code) && !/Set-Cookie/i.test(code));
  ok('⚠️ …and the entitlement-bearing market endpoints are NOT edge-cached',
    !/s-maxage/.test(read2('../src/app/api/quotes/route.js'))
    && !/s-maxage/.test(read2('../src/app/api/chart-intraday/route.js')));
}

L('⚠️ Pro-only products send no data to an anonymous caller');
{
  // ⚠️ A LOCKED UI IS NOT A GATE. Each of these had a professional upgrade wall on the page and an
  // API that answered anyone who asked. What is asserted is the PAYLOAD: refused, and carrying no
  // rows — not merely that some flag says "locked".
  const consensus = await get('/api/consensus-board');
  ok('consensus board still responds', consensus.status === 200 && !!consensus.json, `HTTP ${consensus.status}`);
  const crows = consensus.json?.rows ?? consensus.json?.board ?? [];
  ok('⚠️ …with ZERO rows, not a five-row taste of a Pro product',
    Array.isArray(crows) && crows.length === 0, `${Array.isArray(crows) ? crows.length : '?'} rows`);
  ok('…while still saying how many are locked, so the page can be honest',
    Number(consensus.json?.lockedCount) > 0, String(consensus.json?.lockedCount));
  // The names themselves must not be anywhere in the document.
  ok('⚠️ …and no ticker leaks through another field',
    !/"ticker"\s*:/.test(JSON.stringify(consensus.json)));

  for (const [label, path] of [['pit scan', '/api/pitscan'], ['pit scan boards', '/api/scan-board']]) {
    const r = await get(path);
    ok(`⚠️ ${label} is refused without Pro`, r.status === 403, `HTTP ${r.status}`);
    const rows = r.json?.rows ?? [];
    ok(`…and returns no scan rows`, Array.isArray(rows) && rows.length === 0);
    ok('…and leaks no provider readiness or board contents',
      !/"provider"|"providerLabel"|"candidates"\s*:\s*\[/.test(JSON.stringify(r.json || {})));
  }
}

L('⚠️ the public tier is capped at ten records per surface');
{
  const cases = [
    ['insiders', '/api/insiders?view=rows&limit=500', 'trades'],
    ['congress trades', '/api/congress-trades?limit=500', 'trades'],
    ['politicians', '/api/politicians?limit=500', 'members'],
  ];
  for (const [label, path, key] of cases) {
    const r = await get(path);
    const rows = r.json?.[key];
    // ⚠️ ASKING FOR 500 IS THE TEST. A cap that only holds when the client asks nicely is not a cap.
    ok(`${label} answers`, r.status === 200 && Array.isArray(rows) && rows.length > 0, `HTTP ${r.status}`);
    ok(`⚠️ …capped at 10 even when 500 are requested`, rows.length <= 10, `${rows.length} rows`);
    ok('…and discloses the remainder rather than truncating silently',
      Number(r.json?.lockedCount) > 0, `lockedCount=${r.json?.lockedCount}`);
  }
  // Institutions is capped in the payload, across every array it returns.
  const inst = await get('/api/institutions?limit=500');
  ok('institutions answers', inst.status === 200 && !!inst.json, `HTTP ${inst.status}`);
  const arrays = Object.entries(inst.json || {}).filter(([, v]) => Array.isArray(v));
  ok('⚠️ …with no array over ten records',
    arrays.every(([, v]) => v.length <= 10), arrays.map(([k, v]) => `${k}=${v.length}`).join(' '));
  ok('…and marks itself a public preview', inst.json?.publicPreview === true);
  // ⚠️ AND THE EDGE CACHE SURVIVES, which is the SEO and performance path.
  ok('⚠️ …while still being cacheable for the public/SEO path',
    /s-maxage|public/.test(String(inst.headers.get('cache-control') || '')),
    String(inst.headers.get('cache-control')));
}

L('⚠️ the public gate sells an account, not a subscription');
{
  const { readFileSync } = await import('node:fs');
  const read3 = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const shared = read3('../src/lib/cp-shared.jsx');
  ok('the shared locked CTA offers a free account when signed out',
    /<SignedOut>[\s\S]{0,200}href="\/sign-up"[\s\S]{0,120}Create a free account to continue/.test(shared));
  ok('⚠️ …and only shows the paid CTA to somebody who already has an account',
    /<SignedIn>[\s\S]{0,200}startCheckout\(\)[\s\S]{0,200}Unlock Pro/.test(shared));
  // ⚠️ NO PUBLIC SURFACE MAY ASK A STRANGER FOR $20 TO SEE ROW ELEVEN.
  for (const f of ['../src/app/insiders/InsidersClient.jsx',
    '../src/app/politicians/CongressTransactions.jsx',
    '../src/app/politicians/PoliticiansList.jsx']) {
    const s = read3(f);
    ok(`${f.split('/').pop()} routes its locked CTA through LockedCta`,
      /<LockedCta/.test(s) && !/Unlock Pro · \$20\/month/.test(s));
  }
}

L('⚠️ Free keeps the research product it is paying nothing for');
{
  // Free is signed-in, which this suite cannot be. What IS assertable without a session is that the
  // row limit keys off having an account rather than off paying — the bug that made Free identical
  // to logged-out.
  const { readFileSync } = await import('node:fs');
  const read4 = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const ins = read4('../src/app/api/insiders/route.js');
  ok('⚠️ insider pagination is unlocked by signing in, not by paying',
    /if \(loggedIn\) \{/.test(ins) && !/if \(isPro\) \{\s*\n\s*const rows = await base/.test(ins));
  const pol = read4('../src/app/api/politicians/route.js');
  ok('⚠️ …and so are the politician previews', !/isPro \?/.test(pol));
  const cong = read4('../src/app/api/congress-trades/route.js');
  ok('…congress already worked that way', /const take = loggedIn \?/.test(cong));
  // Freshness stays the Pro line, on all three.
  for (const [n, s] of [['insiders', ins], ['politicians', pol], ['congress', cong]]) {
    ok(`${n} still applies the EOD cutoff by tier`, /eodCutoffIso\(tier\)/.test(s));
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
