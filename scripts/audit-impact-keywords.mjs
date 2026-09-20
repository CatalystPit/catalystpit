// AUDIT impactOf() KEYWORDS AGAINST REAL HEADLINES. Read-only.
//   node --env-file=.env.local scripts/audit-impact-keywords.mjs
//
// Two different faults, reported separately because they need different fixes:
//
//   FRAGMENT COLLISION — the keyword matches inside a longer word that means something else
//   ("eps" in "keeps", "merges" in "emerges", "appoint" in "disappointing"). Unambiguous, and
//   fixed by matching on word boundaries.
//
//   WRONG SENSE — the keyword matches as a whole word but in a non-corporate sense ("bankruptcy"
//   in a personal-finance advice column, "prices" as a noun rather than the verb a deal uses).
//   A boundary cannot fix this; it needs context.

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

const HIGH_KW = [
  'bankrupt', 'chapter 11', 'going concern', 'delist', 'restate', 'restatement',
  'to acquire', 'acquisition of', 'acquires', 'to be acquired', 'merger', 'merges', 'buyout', 'takeover', 'm&a',
  'fda approv', 'fda reject', 'complete response letter', 'breakthrough therapy', 'meets primary endpoint',
  'phase 3', 'topline', 'fails to meet', 'misses primary', 'halted', 'trading halt',
  'cuts guidance', 'raises guidance', 'withdraws guidance', 'profit warning', 'slashes',
  'sec charges', 'sec investigation', 'subpoena', 'recall', 'data breach', 'cyberattack',
  'strategic alternatives', 'explores sale',
];
const NOTABLE_KW = [
  'earnings', 'results', 'quarter', 'quarterly', 'revenue', 'eps', 'beats', 'misses', 'guidance',
  'offering', 'convertible', 'private placement', 'registered direct', 'notes offering', 'prices',
  'ceo', 'cfo', 'resign', 'appoint', 'steps down', 'names new', 'interim',
  'buyback', 'repurchase', 'dividend', 'special dividend', 'partnership', 'collaboration',
  'contract', 'awarded', 'wins', 'upgrade', 'downgrade', 'initiates coverage', 'price target',
];

const rows = await sql.query(`
  select headline from canonical_events where headline is not null and length(headline) > 12
  union all
  select source_headline from primary_events where source_headline is not null and length(source_headline) > 12
  limit 80000`);
const heads = rows.map((r) => String(r.headline || '').toLowerCase()).filter(Boolean);
console.log(`corpus: ${heads.length} headlines\n`);

// A keyword matched as a whole phrase: the characters either side must not be letters. Applied to
// the WHOLE keyword, so multi-word phrases ("trading halt") behave the same way.
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (k) => new RegExp(`(?<![a-z])${esc(k)}(?![a-z])`, 'i');

console.log('## FRAGMENT COLLISIONS — matched inside a longer word\n');
console.log('| keyword | substring hits | of those, fragment-only | example collision |');
console.log('|---|---|---|---|');
const collide = [];
for (const k of [...HIGH_KW, ...NOTABLE_KW]) {
  const sub = heads.filter((h) => h.includes(k));
  if (!sub.length) continue;
  const frag = sub.filter((h) => !wordRe(k).test(h));
  if (!frag.length) continue;
  // The longer word the keyword hid inside, for the report.
  const m = frag[0].match(new RegExp(`[a-z]*${esc(k)}[a-z]*`, 'i'));
  collide.push({ k, sub: sub.length, frag: frag.length, ex: m ? m[0] : '' });
}
collide.sort((a, b) => b.frag - a.frag);
for (const c of collide) {
  console.log(`| \`${c.k}\` | ${c.sub} | **${c.frag}** (${((100 * c.frag) / c.sub).toFixed(0)}%) | "${c.ex}" |`);
}
if (!collide.length) console.log('| (none) | | | |');

console.log('\n## WHOLE-WORD HITS for the senses a boundary cannot fix\n');
for (const k of ['bankrupt', 'prices', 'recall', 'wins', 'offering', 'results']) {
  const hits = heads.filter((h) => wordRe(k).test(h));
  console.log(`\n### \`${k}\` — ${hits.length} whole-word hits`);
  for (const h of hits.slice(0, 6)) console.log(`  - ${h.slice(0, 96)}`);
}
