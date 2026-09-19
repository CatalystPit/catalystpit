// "What Changed" as a trader would read it, for real Catalyst Pit tickers chosen to demonstrate
// each evidence pattern. Read-only; every line comes from a stored filing.
//
// Run: node --env-file=.env.local --import ./scripts/real-db-register.mjs scripts/probe-evidence-demo.mjs

import { tickerEvidence } from '../src/lib/evidence/resolve.js';
import { freshness } from '../src/lib/evidence/model.mjs';

const NOW = Date.now();
const DAY = 86400e3;
const L = (s = '') => console.log(s);

const CASES = [
  ['AMRZ', 'E — multiple evidence families at once'],
  ['ALK', 'A + C — officer purchase after silence, plus a congressional disclosure'],
  ['AMRC', 'A — insider cluster buying'],
  ['AIM', 'B — repeated material 8-K filings'],
  ['AGPU', 'D — meaningful 13F breadth change'],
  ['MSFT', 'mega-cap control: should be quiet, not noisy'],
];

const ago = (iso) => {
  const mins = (NOW - new Date(iso).getTime()) / 60000;
  if (mins < 60) return `${Math.round(mins)}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.floor(mins / 1440)}d ago`;
};
const day = (v) => (v ? new Date(v).toISOString().slice(0, 10) : null);

const TAG = { catalyst: 'SEC 8-K', insider: 'FORM 4', institution: 'INSTITUTIONS', congress: 'CONGRESS' };

for (const [ticker, why] of CASES) {
  const r = await tickerEvidence(ticker, { now: NOW });
  L('');
  L('┌' + '─'.repeat(76));
  L(`│ ${ticker}   —   ${why}`);
  L(`│ ${r.evidence.length} items` +
    (r.failedFamilies.length ? `, FAILED: ${r.failedFamilies.map((f) => f.family).join(',')}` : '') +
    (r.quarantined.length ? `, quarantined: ${r.quarantined.map((q) => q.reason).join(',')}` : ''));
  L('└' + '─'.repeat(76));

  const today = r.evidence.filter((e) => freshness(e, { now: NOW }) === 'today');
  const older = r.evidence.filter((e) => freshness(e, { now: NOW }) !== 'today');

  const render = (list, heading) => {
    if (!list.length) return;
    L(`\n  ${heading}`);
    for (const e of list) {
      L(`    ${(TAG[e.family] || e.family).padEnd(13)} ${e.summary}`);
      if (e.context?.text) L(`                  ${e.context.text}`);
      // Both clocks, wherever they differ.
      if (e.family === 'institution' && e.facts?.quarterEnd) {
        L(`                  Quarter ended ${e.facts.quarterEnd} · Disclosed ${day(e.publicTime)}`);
      } else if (e.family === 'congress' && e.facts?.transactionDate) {
        L(`                  Traded ${day(e.facts.transactionDate)} · disclosed ${e.facts.disclosureLagDays} days later`);
      }
      L(`                  ${ago(e.publicTime)}${e.url ? '   ' + e.url.slice(0, 78) : '   (no link stored)'}`);
    }
  };
  render(today, 'TODAY');
  render(older, today.length ? 'OLDER / STILL RELEVANT' : 'RECENT');
  if (!r.evidence.length) L('\n  (no qualifying changes in the last 45 days)');
}

L('\n');
