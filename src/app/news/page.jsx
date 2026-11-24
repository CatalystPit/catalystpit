import NewsFeed from '../../components/NewsFeed';
import { pageMeta } from '../../lib/seo';

export const metadata = pageMeta({
  // ⚠️ THE DESCRIPTION SHIPPED A LITERAL BACKSLASH. The source escaped an apostrophe inside a
  // DOUBLE-quoted string, where it needs no escape, so the backslash itself was emitted. Production
  // served it, and it appeared in the search snippet exactly as written.
  //
  // The title is also doing more work now. "News" is not a phrase anyone searches on its own, and
  // this room is two things a reader does search for — today's market headlines, and the SEC
  // filings behind the moves — which is also the distinction the page now draws in its ordering.
  title: { absolute: "Stock Market News Today · Market-Moving Headlines and SEC Filings · CatalystPit" },
  description: "Today's stock market news from the major financial newsrooms, with the material SEC 8-K filings behind the moves kept in a section of their own. Ordered by significance and publication time.",
  path: "/news",
});

export default function NewsPage() {
  return <NewsFeed/>;
}
