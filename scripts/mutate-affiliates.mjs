// BREAK EACH REDIRECT GUARD ON PURPOSE AND REQUIRE THE SUITE TO NOTICE.
//
//   node scripts/mutate-affiliates.mjs
//
// ⚠️ EVERY MUTATION HERE IS A PLAUSIBLE SIMPLIFICATION, not a vandalism. That is the point: each of these
// guards is one line that a reader could reasonably think is redundant, and the suite has to disagree.
//
//   endsWith for the host check    — the single commonest way a hostname allowlist is written wrong, and
//                                    it accepts both `evil-partner.test` and `partner.test.evil.test`
//   drop the scheme check          — javascript:, data: and an http:// downgrade all become destinations
//   allow a caller's subid         — turns a fixed placement id into an arbitrary outbound parameter
//   forward the query string       — the shortest path from "no PII" to "whatever was on the URL"
//   fall back to any partner       — the tempting fix for "the card disappeared"
//   301 instead of 302             — un-revocable once a browser has cached it
//   skip the placement allowlist   — lets an unvalidated string become a sub-id value
//   treat an unknown tier as paid  — silently hides placements from everyone on an auth hiccup
//
// The script edits the source, runs the real suite, restores the file and verifies the restore
// byte-identically, because a mutation harness that leaves a mutation behind is worse than none.

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const SUITE = ['--import', './scripts/lib/server-stub-hook.mjs', '--env-file=.env.local',
  'scripts/verify-affiliates.mjs'];

const P = 'src/lib/affiliates/partners.mjs';
const G = 'src/lib/affiliates/go-request.mjs';
const T = 'src/lib/affiliates/tier-policy.mjs';

const MUTATIONS = [
  {
    name: 'host check: endsWith instead of exact-or-dot-anchored',
    file: P,
    from: '  const hostOk = allowed.some((a) => host === a || host.endsWith(`.${a}`));',
    to: '  const hostOk = allowed.some((a) => host.endsWith(a));',
  },
  {
    name: 'scheme check: accept anything parseable',
    file: P,
    from: "  if (u.protocol !== 'https:') return { ok: false, reason: `scheme ${u.protocol} is not https` };",
    to: '  // mutated',
  },
  {
    name: 'protocol-relative: stop refusing //host',
    file: P,
    from: "  if (s.startsWith('//')) return { ok: false, reason: 'protocol-relative url' };",
    to: '  // mutated',
  },
  {
    name: 'credentials: allow user:pass@ in the destination',
    file: P,
    from: "  if (u.username || u.password) return { ok: false, reason: 'url carries credentials' };",
    to: '  // mutated',
  },
  {
    name: 'sub-id: send whatever placement string arrived',
    file: P,
    from: '  if (!PLACEMENT_IDS.includes(placement)) return out;',
    to: '  if (placement == null) return out;',
  },
  {
    name: 'placement allowlist: trust the query parameter',
    file: G,
    from: '  const placement = PLACEMENT_IDS.includes(requested) ? requested : null;',
    to: '  const placement = requested;',
  },
  {
    name: 'redirect status: 301 instead of 302',
    file: G,
    from: 'export const GO_REDIRECT_STATUS = 302;',
    to: 'export const GO_REDIRECT_STATUS = 301;',
  },
  {
    name: 'traversal: stop refusing a key containing a slash',
    file: G,
    from: '  if (/[/\\\\]/.test(decoded)) return null;',
    to: '  // mutated',
  },
  {
    name: 'fail safe: fall back to the first partner that resolves',
    file: P,
    from: '  return { ok: false, reason: v.reason };\n}',
    to: `  // mutated: substitute any working partner
  for (const alt of partners) {
    if (alt.key === p.key || alt.enabled !== true) continue;
    const a = validateAffiliateUrl(env[alt.envVar], alt.allowedHost);
    if (a.ok) return { ok: true, url: a.url.toString(), kind: 'affiliate', partner: alt, reason: null };
  }
  return { ok: false, reason: v.reason };
}`,
  },
  {
    name: 'tier policy: treat an unknown tier as paid',
    file: T,
    from: "  return !PAID_TIERS.has(String(tier || '').toLowerCase());",
    to: "  return String(tier || '').toLowerCase() === 'free';",
  },
  {
    name: 'editorial rel: nofollow every outbound link',
    file: P,
    from: "export const EDITORIAL_REL = 'noopener noreferrer';",
    to: "export const EDITORIAL_REL = 'nofollow noopener noreferrer';",
  },
];

const originals = new Map();
const results = [];

const run = () => {
  try { return { out: execFileSync('node', SUITE, { encoding: 'utf8' }), code: 0 }; }
  catch (e) { return { out: (e.stdout || '') + (e.stderr || ''), code: e.status ?? 1 }; }
};

try {
  const base = run();
  const baseLine = (base.out.match(/^\d+ passed, \d+ failed$/m) || ['(none)'])[0];
  console.log(`baseline: ${baseLine}`);
  if (base.code !== 0) { console.error('the suite is not green before mutating; fix that first'); process.exit(1); }

  for (const m of MUTATIONS) {
    const src = originals.get(m.file) ?? readFileSync(m.file, 'utf8');
    originals.set(m.file, src);
    if (!src.includes(m.from)) { results.push({ name: m.name, verdict: 'ANCHOR MISSING' }); continue; }
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
  for (const n of (r.names || []).slice(0, 2)) console.log(`               caught by: ${n}`);
}
console.log(`\n${results.length - survived}/${results.length} mutations killed`);
if (survived) console.error('\n⚠️  A SURVIVING MUTATION IS A GUARD NOTHING DEFENDS. Add the assertion that catches it.');
process.exit(survived ? 1 : 0);
