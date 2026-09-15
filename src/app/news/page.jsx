import NewsFeed from '../../components/NewsFeed';
import { pageMeta } from '../../lib/seo';

export const metadata = pageMeta({
  title: { absolute: "News · CatalystPit" },
  description: "Real-time financial news, categorized and searchable. Built for active traders who can\\'t afford to miss a catalyst.",
  path: "/news",
});

export default function NewsPage() {
  return <NewsFeed/>;
}
