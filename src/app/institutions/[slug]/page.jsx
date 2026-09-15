import { db } from '../../../lib/db';
import { sql } from 'drizzle-orm';
import { pageMeta } from '../../../lib/seo';
import FundProfile from './FundProfile';

// Every fund page previously shared ONE static title, "Fund holdings · CatalystPit". The institutions
// table has thousands of filers, so that was thousands of duplicate titles. Built from the row now.
//
// Read-only name lookup; no 13F ingestion or holdings logic is touched.
async function fund(slug) {
  try {
    const r = await db.execute(sql`
      select name, featured_label as "featuredLabel", manager, cik, last_quarter as "lastQuarter"
        from institutions where slug = ${slug} limit 1`);
    const row = (r.rows ?? r)?.[0];
    return row?.name || row?.featuredLabel ? row : null;
  } catch { return null; }
}

// Filer names are filed in block capitals ("CHILTON CAPITAL MANAGEMENT LLC"). Shouting them in a
// search result reads as scraped data, so they are title-cased — the same treatment the X publisher
// gives EDGAR registrant names. A name already in mixed case is left exactly as filed.
const KEEP = new Set(['LLC', 'LP', 'LLP', 'INC', 'PLC', 'NA', 'SA', 'AG', 'LTD', 'USA', 'US', 'UK']);
function titleCase(name) {
  const s = String(name || '').trim();
  if (!s || s !== s.toUpperCase()) return s;
  return s.split(/\s+/).map((w) => {
    const bare = w.replace(/[^A-Z]/g, '');
    if (KEEP.has(bare)) return w;
    return w.charAt(0) + w.slice(1).toLowerCase();
  }).join(' ');
}

export async function generateMetadata({ params }) {
  const { slug } = await params;
  const f = await fund(slug);

  // CONSERVATIVE FALLBACK: an unresolved slug gets a generic title rather than a name invented from
  // the URL. Family roll-ups ("family--blackrock") have no institutions row and land here too.
  if (!f) {
    return pageMeta({
      title: '13F Holdings & Institutional Activity',
      description: 'Quarterly 13F holdings and quarter-over-quarter position changes, filed with the SEC.',
      path: `/institutions/${slug}`,
    });
  }

  const name = titleCase(f.featuredLabel || f.name);
  const q = f.lastQuarter ? ` Latest filing: ${f.lastQuarter}.` : '';
  return pageMeta({
    title: `${name} · 13F Holdings`,
    description: `${name} portfolio holdings from SEC Form 13F-HR filings, with position sizes, `
      + `values and quarter-over-quarter buys, sells and exits.${q}`,
    path: `/institutions/${slug}`,
  });
}

export default async function Page({ params }) {
  const { slug } = await params;
  return <FundProfile slug={slug} />;
}
