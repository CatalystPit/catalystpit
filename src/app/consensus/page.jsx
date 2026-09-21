import ConsensusClient from './ConsensusClient';
import { pageMeta } from '../../lib/seo';

export const metadata = pageMeta({
  // ⚠️ THIS DESCRIBED A PRODUCT THAT NO LONGER EXISTS. "Where Smart Money Is Stacking" and
  // "all buying (or all selling)" are the old confluence pitch: one direction, everyone agreeing.
  // The frozen Consensus surfaces DISAGREEMENT as readily as agreement — every row on the live
  // board today reads "Cross-source conflict" — so the old copy promised the opposite of what a
  // visitor finds, in the browser tab and in search results.
  title: { absolute: "Pit Consensus · Evidence Alignment and Conflict · CatalystPit" },
  description: "Where public evidence from insiders, Congress, institutions and SEC filings agrees — and where it conflicts. Evidence accounting, not a score.",
  path: "/consensus",
});

export default function ConsensusPage() {
  return <ConsensusClient />;
}
