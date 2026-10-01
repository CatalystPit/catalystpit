// BREAK EACH GUARD ON PURPOSE AND REQUIRE THE SUITE TO NOTICE.
//
//   node scripts/mutate-social-publishing.mjs
//
// ⚠️ WHY THIS IS A SEPARATE SCRIPT RATHER THAN A FLAG. The first version of this was a --mutate flag
// inside verify-social-publishing.mjs, and it was worthless: each branch asserted the same condition
// and only changed the message, so all five "mutations" ran green and the green run looked like
// evidence. A mutation that does not change the code under test proves nothing.
//
// So this edits the SOURCE, runs the real suite, restores the file, and reports KILLED or SURVIVED.
// Every guard here is one line that a future reader could plausibly delete as redundant, which is
// exactly the set worth defending:
//
//   the conditional claim        — remove it and two concurrent workers both publish
//   the mid-publish hold         — reclaim it and an ambiguous timeout becomes a double post
//   the publish-phase ambiguity  — retry it and the same
//   the activation watermark     — default it open and a new channel publishes history
//   the channel-scoped unique    — widen it and Instagram and Threads become mutually exclusive
//   the fail-closed switch       — loosen it and a truthy value enables publishing
//
// Restoring is in a finally block, and the script re-verifies that every file came back byte-identical
// before it exits, because a mutation harness that leaves a mutation behind is the worst of all tools.

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const SUITE = ['--import', './scripts/lib/server-stub-hook.mjs', '--env-file=.env.local',
  'scripts/verify-social-publishing.mjs'];

const MUTATIONS = [
  {
    name: 'claim: drop the status condition',
    file: 'src/lib/social/social-store.js',
    from: `     where id = ${'${id}'}
       and channel = ${'${channel}'}
       and status = ${'${DELIVERY_STATUS.PENDING}'}`,
    to: `     where id = ${'${id}'}
       and channel = ${'${channel}'}`,
  },
  {
    name: 'reclaim: pick up a mid-publish row',
    file: 'src/lib/social/social-delivery.mjs',
    from: `  if (row.status === DELIVERY_STATUS.PUBLISHING) return { ready: false, reason: 'left mid-publish, needs manual review' };`,
    to: `  // mutated`,
  },
  {
    name: 'timeout: treat an ambiguous publish timeout as retryable',
    file: 'src/lib/social/social-delivery.mjs',
    from: `    const ambiguous = phase === PHASE.PUBLISH;`,
    to: `    const ambiguous = false;`,
  },
  {
    name: 'watermark: treat an absent activation as no lower bound',
    file: 'src/lib/social/social-delivery.mjs',
    from: `  if (!Number.isFinite(a)) return { fresh: false, reason: 'channel not activated' };
  if (t <= a) return { fresh: false, reason: 'received before the channel was activated' };`,
    to: `  if (Number.isFinite(a) && t <= a) return { fresh: false, reason: 'received before the channel was activated' };`,
  },
  {
    name: 'watermark: move it forward on every call',
    file: 'src/lib/social/social-store.js',
    from: `    on conflict (channel) do nothing`,
    to: `    on conflict (channel) do update set activated_at = now()`,
  },
  {
    name: 'dedupe: make the unique key global instead of per-channel',
    file: 'src/lib/social/social-store.js',
    from: `uq_social_channel_event ON social_deliveries (channel, event_seq)`,
    to: `uq_social_channel_event ON social_deliveries (event_seq)`,
  },
  {
    name: 'switch: accept any truthy value',
    file: 'src/lib/social/social-delivery.mjs',
    from: `export const switchedOn = (value) => String(value ?? '') === 'true';`,
    to: `export const switchedOn = (value) => !!value;`,
  },
  {
    name: 'isolation: run the new channels after the Facebook alarm returns',
    file: 'src/app/api/cron/facebook/route.js',
    from: `    const channels = {};`,
    to: `    const channels = {}; /* moved */ if (res.authFailures) return Response.json({ ok: false, credentialAlarm: true }, { status: 503 });`,
  },
];

const originals = new Map();
const results = [];

const run = () => {
  try { return { out: execFileSync('node', SUITE, { encoding: 'utf8' }), code: 0 }; }
  catch (e) { return { out: (e.stdout || '') + (e.stderr || ''), code: e.status ?? 1 }; }
};

try {
  // A green baseline first: a harness that reports KILLED against an already-red suite says nothing.
  const base = run();
  const baseLine = (base.out.match(/^\d+ passed, \d+ failed$/m) || ['(none)'])[0];
  console.log(`baseline: ${baseLine}`);
  if (base.code !== 0) {
    console.error('the suite is not green before mutating; fix that first');
    process.exit(1);
  }

  for (const m of MUTATIONS) {
    const src = originals.get(m.file) ?? readFileSync(m.file, 'utf8');
    originals.set(m.file, src);
    if (!src.includes(m.from)) {
      results.push({ name: m.name, verdict: 'ANCHOR MISSING' });
      continue;
    }
    writeFileSync(m.file, src.replace(m.from, m.to));
    const r = run();
    const line = (r.out.match(/^\d+ passed, \d+ failed$/m) || ['(no summary)'])[0];
    const failed = Number((line.match(/(\d+) failed/) || [0, 0])[1]);
    const names = [...r.out.matchAll(/^\s*FAIL\s+(.*)$/gm)].map((x) => x[1].trim());
    results.push({ name: m.name, verdict: failed > 0 || r.code !== 0 ? 'KILLED' : 'SURVIVED', line, names });
    writeFileSync(m.file, src);
  }
} finally {
  for (const [file, src] of originals) writeFileSync(file, src);
  // Prove the restore, rather than trusting it.
  let dirty = 0;
  for (const [file, src] of originals) if (readFileSync(file, 'utf8') !== src) { dirty++; console.error(`NOT RESTORED: ${file}`); }
  if (!dirty) console.log(`\nrestored ${originals.size} file(s), verified byte-identical`);
}

console.log('');
let survived = 0;
for (const r of results) {
  if (r.verdict !== 'KILLED') survived++;
  console.log(`${r.verdict.padEnd(14)} ${r.name}`);
  if (r.line) console.log(`               ${r.line}`);
  for (const n of (r.names || []).slice(0, 3)) console.log(`               caught by: ${n}`);
}
console.log(`\n${results.length - survived}/${results.length} mutations killed`);
if (survived) console.error('\n⚠️  A SURVIVING MUTATION IS A GUARD NOTHING DEFENDS. Add the assertion that catches it.');
process.exit(survived ? 1 : 0);
