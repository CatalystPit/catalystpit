import TickerPage from './TickerPage';

export async function generateMetadata({ params }) {
  const { symbol } = await params;
  const s = (symbol || '').toUpperCase();
  return {
    title: `${s} · Stock Price, News, Insider & Congress Trades · CatalystPit`,
    description: `${s} stock quote, key stats, market news, insider trades, and congressional trades, all on one page.`,
  };
}

export default async function Page({ params }) {
  const { symbol } = await params;
  return <TickerPage symbol={(symbol || '').toUpperCase()} />;
}
