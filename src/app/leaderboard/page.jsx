import LeaderboardClient from './LeaderboardClient';
import { pageMeta } from '../../lib/seo';

export const metadata = pageMeta({
  title: { absolute: "Leaderboard · CatalystPit" },
  description: "The most active and influential traders in The Pit community.",
  path: "/leaderboard",
});

export default function LeaderboardPage() {
  return <LeaderboardClient />;
}
