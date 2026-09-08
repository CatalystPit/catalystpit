import ConfluenceClient from './ConfluenceClient';

export const metadata = {
  title: 'Confluence — Where Smart Money Is Stacking — CatalystPit',
  description: 'Stocks where insiders, Congress, and hedge funds are all buying (or all selling) — the cross-signal conviction board.',
};

export default function ConfluencePage() {
  return <ConfluenceClient />;
}
