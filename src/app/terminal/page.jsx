import TerminalClient from './TerminalClient';
import { pageMeta } from '../../lib/seo';

export const metadata = pageMeta({
  title: { absolute: "Terminal · CatalystPit Pro" },
  description: "Pro trading dashboard: live halt scanner, movers, and catalysts.",
  path: "/terminal",
});

export default function TerminalPage() {
  return <TerminalClient />;
}
