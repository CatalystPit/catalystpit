// AUTO-REPLY DRY RUN. Runs the production engine — the same eligibility, the same context builder,
// the same model call, the same validator — against real ingested Walter Bloomberg posts and prints
// exactly what would have been published. It POSTS NOTHING and writes nothing.
//
//   node --env-file=.env.local scripts/dry-run-x-reply.mjs [--limit=5]

import { neon } from '@neondatabase/serverless';
import { replyEligibility, validateReply, MIN_REPLY_CHARS, TARGET_MAX_CHARS } from '../src/lib/x-reply.mjs';
import { buildReplyContext, generateReply } from '../src/lib/x-reply-context.mjs';

const sql = neon(process.env.DATABASE_URL);
const arg = (k, d) => { const h = process.argv.find((a) => a.startsWith(`--${k}=`)); return h ? h.split('=')[1] : d; };
const LIMIT = Number(arg('limit', 5));

const rows = await sql.query(`
  select seq, source, source_headline, headline, summary, tickers, category, importance, entity,
         to_char(published_at,'YYYY-MM-DD HH24:MI:SS') as pub, source_uid, original_url
    from primary_events
   where source = 'WALTERBLOOMBERG' and cluster_id is null
   order by published_at desc limit ${LIMIT}`);

console.log(`Walter Bloomberg — ${rows.length} most recent ingested posts, through the live engine.\n`);

const recent = [];
let yes = 0, no = 0;
for (const [i, ev] of rows.entries()) {
  // The X post id the engine requires. Ingestion is from Telegram, so this is null — recorded
  // honestly rather than substituted, because substituting it is how a reply lands under the wrong
  // post. Set for the purpose of showing what the rest of the engine produces.
  const xPostId = ev.x_post_id ?? null;
  const facts = await buildReplyContext(ev);
  // Eligibility is evaluated twice: as production would see it (no X id), and with the id present so
  // the remaining gates are exercised and visible.
  const asProduction = replyEligibility({ ...ev, x_post_id: xPostId }, facts);
  const withId = replyEligibility({ ...ev, x_post_id: 'PRESENT' }, facts);

  console.log('═'.repeat(100));
  console.log(`${i + 1}. seq ${ev.seq}   ${ev.pub} UTC`);
  console.log(`\n   WALTER'S POST:\n   ${String(ev.source_headline).replace(/\s+/g, ' ').slice(0, 600)}`);
  console.log(`\n   DETECTED   tickers=${JSON.stringify(ev.tickers || [])}  category=${ev.category}  importance=${ev.importance}  entity=${ev.entity ?? '-'}`);

  const known = [];
  if (facts.identity?.company) known.push(`identity: ${facts.identity.company} (${facts.identity.exchange})`);
  if (facts.lastClose) known.push(`last close ${facts.lastClose.close} on ${facts.lastClose.date}`);
  if (facts.insider?.length) known.push(`${facts.insider.length} insider trades in 90d`);
  if (facts.congress?.length) known.push(`${facts.congress.length} congress trades in 180d`);
  if (facts.priorEvents?.length) known.push(`${facts.priorEvents.length} prior events on the ticker`);
  if (facts.filings?.length) known.push(`${facts.filings.length} recent 8-K filings`);
  if (facts.priorPrints?.length) known.push(`${facts.priorPrints.length} earlier events on the same story`);
  console.log(`   INTERNAL EVIDENCE: ${known.length ? known.join('; ') : 'none'}`);

  if (!withId.eligible) {
    no++;
    console.log(`\n   WOULD REPLY: NO`);
    console.log(`   REASON: ${withId.reason}`);
    console.log(`   (production also blocked by: ${asProduction.reason})\n`);
    continue;
  }

  const gen = await generateReply(ev, facts);
  if (!gen.text) {
    no++;
    console.log(`\n   WOULD REPLY: NO`);
    console.log(`   REASON: ${gen.reason}\n`);
    continue;
  }
  const v = validateReply(gen.text, ev, facts, recent);
  if (!v.valid) {
    no++;
    console.log(`\n   WOULD REPLY: NO`);
    console.log(`   REASON: generated reply failed validation — ${v.reason}`);
    console.log(`   (rejected text, NOT published: "${gen.text.slice(0, 160)}")\n`);
    continue;
  }
  yes++;
  recent.push(gen.text);
  console.log(`\n   WOULD REPLY: YES   (${gen.text.length} chars, target ${MIN_REPLY_CHARS}-${TARGET_MAX_CHARS})`);
  console.log(`   REPLY: ${gen.text}`);
  console.log(`   SUPPORTED BY: ${known.join('; ') || 'the post itself'}\n`);
}

console.log('═'.repeat(100));
console.log(`\nSUMMARY: ${yes} would reply, ${no} skipped, of ${rows.length}.`);
console.log('Nothing was posted. Nothing was written to the database.');
