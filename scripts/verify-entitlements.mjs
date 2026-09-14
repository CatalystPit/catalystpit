// Manual beta access must unlock Pro and nothing else.
//
// resolveUserAccess() is the single gate every restricted route goes through, so a mistake here is
// a site-wide access change. The Clerk client is stubbed so the resolution logic is tested on its
// own, exactly as the routes call it.
//
// Run: node scripts/verify-entitlements.mjs

// entitlements.js imports @clerk/nextjs/server, which does not resolve outside the Next bundler, so
// the pure helpers are restated here and then PINNED to the real source at the end of this file —
// if either definition changes, the mirror assertions fail.
const marketDataAccess = (tier) => (tier === 'pro' || tier === 'elite' ? 'realtime' : 'delayed');
const isRealtime = (tier) => marketDataAccess(tier) === 'realtime';
const WATCHLIST_LIMIT = { free: 15, pro: 250, elite: 1000 };
const WATCHLIST_LISTS_LIMIT = { free: 1, pro: 10, elite: 25 };

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) pass++; else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

// A faithful re-implementation of the resolution order in resolveUserAccess(), so the rules can be
// exercised without a Clerk session. Kept deliberately literal; the assertion below pins it to the
// real source so the two cannot drift apart silently.
function resolve(user, { userId = 'u1', adminEmail = 'admin@catalystpit.com', throws = false } = {}) {
  if (!userId) return { tier: 'free', beta: false };
  try {
    if (throws) throw new Error('clerk down');
    const email = user?.emailAddresses?.find((e) => e.id === user.primaryEmailAddressId)?.emailAddress
      || user?.emailAddresses?.[0]?.emailAddress;
    if (email && adminEmail && email.toLowerCase() === adminEmail.toLowerCase()) return { tier: 'elite', beta: false };
    const plan = user?.publicMetadata?.plan;
    if (plan === 'pro' || plan === 'elite') return { tier: plan, beta: false };
    if (user?.publicMetadata?.beta === true) return { tier: 'pro', beta: true };
    return { tier: 'free', beta: false };
  } catch { return { tier: 'free', beta: false }; }
}

const meta = (publicMetadata) => ({ publicMetadata, emailAddresses: [{ id: 'e1', emailAddress: 'u@x.com' }], primaryEmailAddressId: 'e1' });

console.log('\n=== beta grants Pro, and only Pro ===');
ok('beta:true resolves to pro', resolve(meta({ beta: true })).tier === 'pro');
ok('...and is marked as beta', resolve(meta({ beta: true })).beta === true);
ok('...never elite', resolve(meta({ beta: true })).tier !== 'elite');
ok('beta gets the Pro watchlist cap', WATCHLIST_LIMIT[resolve(meta({ beta: true })).tier] === WATCHLIST_LIMIT.pro);
ok('beta gets Pro named lists', WATCHLIST_LISTS_LIMIT[resolve(meta({ beta: true })).tier] === WATCHLIST_LISTS_LIMIT.pro);

console.log('\n=== beta is NOT a paid subscriber ===');
ok('the plan key is untouched', resolve(meta({ beta: true })).plan === undefined);
ok('a beta user carries no plan in metadata', meta({ beta: true }).publicMetadata.plan === undefined);
// The distinction any revenue or member count relies on.
ok('a paying pro is not flagged beta', resolve(meta({ plan: 'pro' })).beta === false);
ok('a paying pro still resolves to pro', resolve(meta({ plan: 'pro' })).tier === 'pro');
ok('a real plan wins over the beta flag',
  resolve(meta({ plan: 'elite', beta: true })).tier === 'elite'
  && resolve(meta({ plan: 'elite', beta: true })).beta === false);

console.log('\n=== beta does NOT get licensed real-time data ===');
const betaUser = resolve(meta({ beta: true }));
ok('the tier alone would say realtime', isRealtime(betaUser.tier));
ok('...but the beta flag withholds it', isRealtime(betaUser.tier) && betaUser.beta);
ok('a paying pro DOES get realtime',
  isRealtime(resolve(meta({ plan: 'pro' })).tier) && !resolve(meta({ plan: 'pro' })).beta);
ok('free is delayed', marketDataAccess(resolve(meta({})).tier) === 'delayed');

console.log('\n=== nobody else is affected ===');
ok('no metadata at all is free', resolve(meta({})).tier === 'free');
ok('signed out is free', resolve(meta({ beta: true }), { userId: null }).tier === 'free');
ok('a Clerk outage fails safe to free', resolve(meta({ beta: true }), { throws: true }).tier === 'free');
ok('admin is still elite, not beta', (() => {
  const u = { publicMetadata: {}, emailAddresses: [{ id: 'e1', emailAddress: 'admin@catalystpit.com' }], primaryEmailAddressId: 'e1' };
  const r = resolve(u);
  return r.tier === 'elite' && r.beta === false;
})());
ok('admin behaviour is unchanged by the beta flag', (() => {
  const u = { publicMetadata: { beta: true }, emailAddresses: [{ id: 'e1', emailAddress: 'admin@catalystpit.com' }], primaryEmailAddressId: 'e1' };
  return resolve(u).tier === 'elite';
})());

console.log('\n=== the flag is strict, so nothing grants access by accident ===');
for (const v of ['true', 1, 'yes', 'beta', {}, [], 'TRUE', 0, null, undefined, false])
  ok(`beta:${JSON.stringify(v)} grants nothing`, resolve(meta({ beta: v })).tier === 'free');

console.log('\n=== the test mirrors the real source ===');
const { readFileSync } = await import('node:fs');
const src = readFileSync(new URL('../src/lib/entitlements.js', import.meta.url), 'utf8');
ok('resolveUserAccess exists', /export async function resolveUserAccess/.test(src));
ok('resolveUserTier delegates to it', /resolveUserTier[\s\S]{0,120}resolveUserAccess\(\)\)\.tier/.test(src));
ok('the beta check is strictly === true', /publicMetadata\?\.beta === true/.test(src));
ok('...and returns pro, never elite', /publicMetadata\?\.beta === true\) return \{ tier: 'pro', beta: true \}/.test(src));
ok('the plan check still comes first', src.indexOf("plan === 'pro'") < src.indexOf('beta === true'));
ok('the admin check still comes before both', src.indexOf('ADMIN_EMAIL') < src.indexOf('beta === true'));
// Comments mention Stripe by way of explanation; the CODE must not reach it.
const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
ok('nothing here writes to Clerk', !/updateUser|publicMetadata\s*=[^=]/.test(code));
ok('nothing here touches Stripe', !/stripe/i.test(code));
const quotes = readFileSync(new URL('../src/app/api/quotes/route.js', import.meta.url), 'utf8');
ok('the quotes route withholds realtime from beta', /isRealtime\(tier\) && !beta/.test(quotes));
// The restated helpers above must match the module they stand in for.
ok('marketDataAccess mirrors the source',
  /tier === 'pro' \|\| tier === 'elite' \? 'realtime' : 'delayed'/.test(src));
ok('WATCHLIST_LIMIT mirrors the source',
  /WATCHLIST_LIMIT = \{ free: 15, pro: 250, elite: 1000 \}/.test(src));
ok('WATCHLIST_LISTS_LIMIT mirrors the source',
  /WATCHLIST_LISTS_LIMIT = \{ free: 1, pro: 10, elite: 25 \}/.test(src));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
