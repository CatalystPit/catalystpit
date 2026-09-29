import { pageMeta } from '../../lib/seo';
import AffiliatesClient from './AffiliatesClient';

// Server wrapper: a 'use client' file cannot export metadata, so the page's own title,
// description and canonical live here and the interactive component sits alongside.
//
// ⚠️ THE DESCRIPTION SAYS THE PROGRAMME IS NOT OPEN. This string is what a search result shows, so
// it is the one piece of this page most likely to be read out of context — by someone deciding
// whether to click, having never seen the banner. It must not read as a recruitment ad.
export const metadata = pageMeta({
  title: "Affiliate Program Terms",
  description: "The terms that will govern the CatalystPit affiliate program. The program is not yet open and is not accepting affiliates.",
  path: "/affiliates",
});

export default function Page() {
  return <AffiliatesClient />;
}
