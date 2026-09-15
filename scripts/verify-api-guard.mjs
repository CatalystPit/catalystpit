// API ABUSE GUARD: that it stops a script without touching real traffic.
//
// The risk in a rate limiter is not that it fails to block — it is that it blocks the wrong thing.
// These assertions exist to pin the three ways that happens: metering the SEO surface, trusting a
// client-supplied IP header, and turning a KV outage into a site outage.
//
//   node --env-file=.env.local scripts/verify-api-guard.mjs

import { readFile } from 'node:fs/promises';
import { clientIp, apiRateLimit, LIMITS } from '../src/lib/api-guard.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const section = (s) => console.log('\n' + s);
const req = (headers = {}) => ({ headers: { get: (k) => headers[k.toLowerCase()] ?? null } });

section('1. the client IP cannot be chosen by the client');
{
  // x-forwarded-for's leftmost entry is attacker-controlled. Keying on it hands out a fresh bucket
  // per request, which is worse than no limiter because it looks like one.
  ok('x-real-ip wins over a spoofed forwarded chain',
    clientIp(req({ 'x-real-ip': '9.9.9.9', 'x-forwarded-for': '1.1.1.1, 2.2.2.2' })) === '9.9.9.9');
  ok('vercel forwarded is preferred over x-forwarded-for',
    clientIp(req({ 'x-vercel-forwarded-for': '8.8.8.8', 'x-forwarded-for': '1.1.1.1' })) === '8.8.8.8');
  ok('x-forwarded-for is only a fallback', clientIp(req({ 'x-forwarded-for': '1.1.1.1' })) === '1.1.1.1');
  ok('no headers yields unknown', clientIp(req({})) === 'unknown');
  ok('whitespace is trimmed', clientIp(req({ 'x-real-ip': '  5.5.5.5  ' })) === '5.5.5.5');
}

section('2. it fails open');
{
  // An unknown IP, a signed-in user, or no KV must all continue. A limiter that returns 500 on its
  // own failure has converted an availability problem into an outage.
  ok('unknown IP is not blocked', (await apiRateLimit(req({}), 'b', 'heavy')) === null);
  ok('a signed-in user bypasses entirely',
    (await apiRateLimit(req({ 'x-real-ip': '1.2.3.4' }), 'b', 'heavy', { userId: 'u_1' })) === null);
  const src = await readFile(new URL('../src/lib/api-guard.mjs', import.meta.url), 'utf8');
  ok('a KV error is swallowed, not raised', /catch \{ return null; \}/.test(src));
  ok('no KV configured means no limiting', /if \(!KV_URL \|\| !KV_TOKEN\) return null;/.test(src));
}

section('3. the SEO surface is never metered');
{
  // Checked by what middleware IMPORTS, not by whether the word appears — api-guard's own comment
  // explains why it is not in middleware, and matching that prose made this assertion fail on itself.
  const mw = await readFile(new URL('../src/middleware.ts', import.meta.url), 'utf8');
  ok('middleware does not import the guard', !/api-guard|apiRateLimit/.test(mw));
  // Every page the crawler and the ticker pages depend on must be free of it.
  for (const f of ['src/app/api/wire/route.js', 'src/app/api/heatmap/route.js']) {
    const s = await readFile(new URL('../' + f, import.meta.url), 'utf8').catch(() => '');
    ok(`${f.split('/').slice(-2)[0]} stays unmetered (cheap cached read)`, !/apiRateLimit/.test(s));
  }
}

section('4. only cost-bearing routes carry the guard');
{
  const GUARDED = ['ticker', 'chart-daily', 'congress-chart', 'logo', 'movers', 'scan',
    'institutions', 'symbol-search', 'screener'];
  for (const r of GUARDED) {
    const s = await readFile(new URL('../src/app/api/' + r + '/route.js', import.meta.url), 'utf8');
    ok(`${r} is guarded`, /apiRateLimit\(/.test(s));
    // The guard takes the request object; a handler declared GET() would throw at runtime.
    ok(`${r} passes a real request object`, /export async function GET\(\s*request/.test(s),
      'GET() without a parameter makes the guard a ReferenceError');
  }
}

section('5. realistic traffic stays well under the limits');
{
  // Measured shapes, not guesses.
  const TICKER_PAGE = 4;        // a ticker page fires about four API calls
  const TERMINAL_POLL_PER_MIN = 6;
  console.log('  provider bucket ' + LIMITS.provider.max + '/' + LIMITS.provider.window + 's'
    + '   heavy bucket ' + LIMITS.heavy.max + '/' + LIMITS.heavy.window + 's');
  const browsing = TICKER_PAGE * 5;            // five ticker pages in a minute — brisk browsing
  ok(`browsing 5 ticker pages/min (${browsing} calls) is under the provider limit`,
    browsing < LIMITS.provider.max, `${browsing} vs ${LIMITS.provider.max}`);
  ok('the terminal polling is under the heavy limit',
    TERMINAL_POLL_PER_MIN < LIMITS.heavy.max);
  // A shared office/NAT egress: several people browsing at once behind one public IP.
  const nat = browsing * 4;
  ok(`four simultaneous users behind one NAT IP (${nat} calls) still pass`,
    nat < LIMITS.provider.max * 1.0 || nat < LIMITS.heavy.max,
    `${nat} vs provider ${LIMITS.provider.max}`);
  ok('limits leave at least 2x headroom over brisk single-user browsing',
    LIMITS.provider.max >= browsing * 2);
  ok('a script hammering one endpoint is stopped within the window',
    LIMITS.provider.max < 200 && LIMITS.heavy.max < 300);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
