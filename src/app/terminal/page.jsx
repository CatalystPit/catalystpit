import { redirect } from 'next/navigation';
// The stand-alone trading terminal is retired. Keep old bookmarks functional.
export default function TerminalPage() {
  redirect('/markets');
}
