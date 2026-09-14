// Can a suppressed foreign row be corrected rather than merely hidden? The only correction that
// invents nothing is the issuer's OWN English edition of the same release, so this counts how many
// suppressed rows have one — in their cluster, or as a separate canonical row with the same facts.
// Run: node --env-file=.env.local scripts/probe-foreign-siblings.mjs
import { neon } from '@neondatabase/serverless';
import { materiallyNonEnglish } from '../src/lib/language.mjs';
const sql = neon(process.env.DATABASE_URL);

const rows = await sql.query(`select seq, source, headline, summary, fact_sig, entity, tickers,
    cluster_id, display_ready, published_at::text pa
  from primary_events where published_at > now() - interval '30 days'`);

const foreign = rows.filter((r) => !r.cluster_id && materiallyNonEnglish(r.headline, r.summary).nonEnglish);
const english = rows.filter((r) => !materiallyNonEnglish(r.headline, r.summary).nonEnglish);

let clusterSibling = 0, factSibling = 0;
for (const f of foreign) {
  const inCluster = rows.some((r) => r.cluster_id === f.seq
    && !materiallyNonEnglish(r.headline, r.summary).nonEnglish);
  if (inCluster) { clusterSibling++; continue; }
  // Same issuer token and the same numeric signature, within a day: that is the same release.
  const near = english.some((r) => r.entity && r.entity === f.entity && r.fact_sig && r.fact_sig === f.fact_sig
    && Math.abs(Date.parse(r.pa) - Date.parse(f.pa)) < 24 * 3600 * 1000);
  if (near) factSibling++;
}
console.log(`suppressed foreign canonical rows : ${foreign.length}`);
console.log(`  with an English edition in-cluster : ${clusterSibling}`);
console.log(`  with an English same-facts sibling : ${factSibling}`);
console.log(`  no English source material at all  : ${foreign.length - clusterSibling - factSibling}`);
