import FearGreedClient from './FearGreedClient';
import { pageMeta } from '../../lib/seo';

export const metadata = pageMeta({
  title: { absolute: 'Fear & Greed · CatalystPit' },
  description: 'Catalyst Pit Fear & Greed: a daily 0-100 read on U.S. equity risk sentiment, '
    + 'built from market momentum, realized volatility, breadth, price strength and credit appetite — '
    + 'each scored against its own two-year distribution, with every component shown.',
  path: '/fear-greed',
});

export default function FearGreedPage() {
  return <FearGreedClient />;
}
