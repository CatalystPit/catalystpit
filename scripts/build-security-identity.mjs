// Rebuild the security master (ticker -> canonical display name) against the live database.
//
// The nightly screener cron already does this before every rebuild; this is the manual door, for
// after a migration or when a name needs to appear without waiting for the cron.
//
//   node --env-file=.env.local scripts/build-security-identity.mjs
//
// Read-mostly and idempotent: it upserts one row per ticker and never blanks a name it cannot
// currently resolve. Safe to re-run at any time.
import { register } from 'node:module';
register('./real-db-loader.mjs', import.meta.url);

const { refreshSecurityIdentity } = await import('../src/lib/security-identity.js');
const res = await refreshSecurityIdentity();
console.log(JSON.stringify(res, null, 2));
process.exit(res.ok ? 0 : 1);
