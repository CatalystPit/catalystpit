// Grant ONE existing Clerk user manual beta access: publicMetadata.beta = true.
//
// It does not touch `plan`, does not reach Stripe, and does not grant elite or admin. Existing
// public metadata is read, merged in memory and written back whole, so nothing already there is
// lost. The script refuses rather than guesses: if the email matches zero users or more than one,
// if it is not that user's PRIMARY email, or if the write would alter `plan`, it stops.
//
//   CLERK_SECRET_KEY=sk_live_... node scripts/grant-beta.mjs dannabwcx3@aol.com
//   CLERK_SECRET_KEY=sk_live_... node scripts/grant-beta.mjs dannabwcx3@aol.com --revoke
//   CLERK_SECRET_KEY=sk_live_... node scripts/grant-beta.mjs dannabwcx3@aol.com --dry-run
//
// The key must be the PRODUCTION secret (sk_live_...). Clerk keeps separate user lists per
// environment, so a test key will simply not find the account.

const KEY = process.env.CLERK_SECRET_KEY;
const email = process.argv[2];
const revoke = process.argv.includes('--revoke');
const dryRun = process.argv.includes('--dry-run');

if (!KEY) { console.error('CLERK_SECRET_KEY is not set'); process.exit(1); }
if (!email || !email.includes('@')) { console.error('usage: node scripts/grant-beta.mjs <email> [--revoke] [--dry-run]'); process.exit(1); }
if (!KEY.startsWith('sk_live_')) console.warn(`! key is ${KEY.slice(0, 8)}..., not sk_live_ — this may be the wrong Clerk environment\n`);

const api = async (path, init = {}) => {
  const r = await fetch(`https://api.clerk.com/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${init.method || 'GET'} ${path} -> ${r.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body;
};

const primaryEmailOf = (u) =>
  u.email_addresses?.find((e) => e.id === u.primary_email_address_id)?.email_address || null;

// ── find the user ────────────────────────────────────────────────────────────
const found = await api(`/users?email_address=${encodeURIComponent(email)}&limit=10`);
const users = Array.isArray(found) ? found : found.data || [];
if (users.length === 0) { console.error(`no user with email ${email}`); process.exit(2); }
if (users.length > 1) { console.error(`${users.length} users match ${email}; refusing to guess`); process.exit(2); }

const user = users[0];
const primary = primaryEmailOf(user);
if ((primary || '').toLowerCase() !== email.toLowerCase()) {
  console.error(`${email} is not the PRIMARY email for ${user.id} (primary is ${primary}); refusing`);
  process.exit(2);
}

const before = user.public_metadata || {};
console.log(`user            : ${user.id}`);
console.log(`primary email   : ${primary}`);
console.log(`public metadata : ${JSON.stringify(before)}`);
console.log(`current plan    : ${before.plan ?? '(none)'}`);
console.log(`current beta    : ${before.beta ?? '(none)'}`);

// ── build the new metadata ───────────────────────────────────────────────────
const after = { ...before };
if (revoke) delete after.beta; else after.beta = true;

// The one thing that must never change here.
if (JSON.stringify(after.plan ?? null) !== JSON.stringify(before.plan ?? null)) {
  console.error('refusing: this write would change `plan`'); process.exit(3);
}
for (const k of Object.keys(before)) {
  if (k !== 'beta' && JSON.stringify(after[k]) !== JSON.stringify(before[k])) {
    console.error(`refusing: this write would change existing key "${k}"`); process.exit(3);
  }
}

console.log(`\nwould write     : ${JSON.stringify(after)}`);
if (dryRun) { console.log('\n--dry-run, nothing written'); process.exit(0); }

// ── write, then read back ────────────────────────────────────────────────────
await api(`/users/${user.id}/metadata`, {
  method: 'PATCH',
  body: JSON.stringify({ public_metadata: after }),
});

const check = await api(`/users/${user.id}`);
const now = check.public_metadata || {};
console.log(`\nread back       : ${JSON.stringify(now)}`);

// Mirrors resolveUserAccess() in src/lib/entitlements.js, in the same order.
const isAdmin = process.env.ADMIN_EMAIL && primary.toLowerCase() === process.env.ADMIN_EMAIL.toLowerCase();
const resolved = isAdmin ? { tier: 'elite', beta: false }
  : (now.plan === 'pro' || now.plan === 'elite') ? { tier: now.plan, beta: false }
    : now.beta === true ? { tier: 'pro', beta: true }
      : { tier: 'free', beta: false };

console.log(`resolves as     : tier=${resolved.tier} beta=${resolved.beta}`);
console.log(`real-time data  : ${resolved.tier !== 'free' && !resolved.beta ? 'yes' : 'no (delayed)'}`);
console.log(`plan unchanged  : ${JSON.stringify(now.plan ?? null) === JSON.stringify(before.plan ?? null)}`);

const good = revoke
  ? resolved.tier === 'free' && now.beta === undefined
  : resolved.tier === 'pro' && resolved.beta === true;
console.log(good ? '\nOK' : '\nUNEXPECTED RESULT — check the output above');
process.exit(good ? 0 : 4);
