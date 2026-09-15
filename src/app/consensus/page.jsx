import ConsensusClient from './ConsensusClient';
import { pageMeta } from '../../lib/seo';

export const metadata = pageMeta({
  title: { absolute: "Pit Consensus · Where Smart Money Is Stacking · CatalystPit" },
  description: "Stocks where insiders, Congress, and hedge funds are all buying (or all selling). The cross-signal conviction board.",
  path: "/consensus",
});

export default function ConsensusPage() {
  return <ConsensusClient />;
}
