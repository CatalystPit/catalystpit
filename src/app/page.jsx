import { pageMeta } from '../lib/seo';
import HomeClient from './HomeClient';

// Server wrapper: a 'use client' file cannot export metadata, so the page's own title,
// description and canonical live here and the interactive component sits alongside.
export const metadata = pageMeta({
  title: { absolute: "CatalystPit · Insider Trades, Congress Trades & Market Catalysts" },
  description: "Track insider buying, Congressional stock trades, institutional 13F activity and SEC filings as they happen. Every catalyst, before the bell.",
  path: "/",
});

export default function Page() {
  return <HomeClient />;
}
