// Repair rate-limit counters that have no expiry.
//
//   node --env-file=.env.local scripts/repair-ratelimit-ttls.mjs [--apply]
//
// ⚠️ A COUNTER WITHOUT A TTL IS A PERMANENT BLOCK. api-guard set the expiry only when the counter
// was created (n === 1); if that call was ever lost the key never expired, n never returned to 1,
// and the expiry was never attempted again — so the IP stayed 429'd forever. The guard now heals
// itself, and this clears the keys that were already stuck.
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const APPLY = process.argv.includes('--apply');
const kv = async (p) => {
  const r = await fetch(`${URL_}${p}`, { method: 'POST', headers: { Authorization: `Bearer ${TOK}` }, cache: 'no-store' });
  return r.ok ? r.json() : { error: r.status };
};
const keys = (await kv('/keys/rl:*')).result || [];
let stuck = 0;
for (const k of keys) {
  const ttl = (await kv(`/ttl/${encodeURIComponent(k)}`)).result;
  if (ttl !== -1) { console.log(`  ok    ${k} (ttl ${ttl}s)`); continue; }
  stuck++;
  const count = (await kv(`/get/${encodeURIComponent(k)}`)).result;
  if (APPLY) {
    // Deleted rather than given a TTL: the count accumulated over an unbounded period and does not
    // describe any real window, so carrying it forward would keep punishing an address for traffic
    // that may be hours old.
    await kv(`/del/${encodeURIComponent(k)}`);
    console.log(`  CLEARED ${k} (was count=${count}, no expiry)`);
  } else {
    console.log(`  STUCK   ${k} (count=${count}, no expiry) — run with --apply to clear`);
  }
}
console.log(`\n${stuck} of ${keys.length} keys had no expiry${APPLY ? ' — cleared' : ''}`);
