import FeedClient from './FeedClient';
import { pageMeta } from '../../lib/seo';

export const metadata = pageMeta({
  title: { absolute: "Feed · CatalystPit" },
  description: "The community feed, where traders share thoughts, ideas, and catalysts.",
  path: "/feed",
});

export default function FeedPage() {
  return <FeedClient />;
}
