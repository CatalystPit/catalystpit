import { db } from '../../../lib/db';
import { sql } from 'drizzle-orm';
import { pageMeta } from '../../../lib/seo';
import PoliticianDetail from './PoliticianDetail';

// Every politician page previously shared ONE static title, "Politician · CatalystPit", across
// every member — so hundreds of URLs were duplicates in search. The metadata is now built from the
// member the slug actually resolves to.
//
// Read-only, and it reads the same column the existing list view groups by. No congress data logic
// is touched: this is a name lookup, nothing more.
async function member(slug) {
  try {
    const r = await db.execute(sql`
      select max(representative) as name, max(party) as party,
             max(state) as state, max(chamber) as chamber,
             count(*)::int as trades
        from congress_trades
       where member_slug = ${slug}`);
    const row = (r.rows ?? r)?.[0];
    return row?.name ? row : null;
  } catch { return null; }
}

export async function generateMetadata({ params }) {
  const { slug } = await params;
  const m = await member(slug);

  // CONSERVATIVE FALLBACK. If the slug resolves to nobody we do not guess a name from the URL —
  // a fabricated "John Smith" title on a page that renders "not found" is worse than a generic one.
  // The page stays out of the sitemap either way, so this is about honesty, not ranking.
  if (!m) {
    return pageMeta({
      title: 'Congressional Trade History',
      description: 'Stock trades disclosed under the STOCK Act, with return-since-trade performance.',
      path: `/politicians/${slug}`,
    });
  }

  const chamber = m.chamber === 'senate' ? 'Senator' : m.chamber === 'house' ? 'Representative' : null;
  // Only the facts the row actually carries; any missing part simply drops out of the sentence.
  const who = [chamber, m.name].filter(Boolean).join(' ');
  const where = [m.party, m.state].filter(Boolean).join('-');
  const count = Number(m.trades) || 0;

  return pageMeta({
    title: `${m.name} · Stock Trades & Disclosures`,
    description: `${who}${where ? ` (${where})` : ''} stock trades disclosed under the STOCK Act`
      + `${count ? `, covering ${count.toLocaleString('en-US')} reported transactions` : ''}`
      + ', with return-since-trade performance and filing dates.',
    path: `/politicians/${slug}`,
    ogType: 'profile',
  });
}

export default async function Page({ params }) {
  const { slug } = await params;
  return <PoliticianDetail slug={slug} />;
}
