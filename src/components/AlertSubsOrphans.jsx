'use client';

// EVIDENCE ALERTS ON TICKERS THAT ARE NOT IN THE WATCHLIST.
//
// ⚠️ WHY THIS EXISTS. An Evidence Alert subscription is an independent, explicit preference — adding a
// ticker to the watchlist does not create one, and removing the ticker deliberately does not destroy
// one. That is the right relationship (the subscription is what the person asked for; the watchlist is
// what they are looking at), and it has one consequence that has to be handled rather than shrugged at:
// a subscription for a ticker that is no longer watched had NO surface anywhere. The bell is rendered
// per watchlist row, per scan row and on the ticker page — all of which require the ticker to be in
// front of you. Somebody who removed a name from their watchlist kept receiving alerts for it with no
// way to find the switch short of navigating to that ticker page from memory.
//
// So this lists exactly those, compactly, each with the same control. It renders nothing at all when
// there are none, which is the common case.
//
// ⚠️ DELIBERATELY NOT A NEW PANEL. One line of chips under the watchlist rows, inside the existing
// card, using the shared subscription set that is already fetched for the bells above it — no extra
// request, no new page, no second management screen to keep in sync.

import { useEffect, useState } from 'react';
import { loadAlertSubs, onAlertSubsChange, UNKNOWN_SUBS } from '../lib/alerts/alert-subs-client';
import AlertToggle from './AlertToggle';
import { C } from '../lib/cp-shared';

export default function AlertSubsOrphans({ watched = [] }) {
  const [subs, setSubs] = useState(UNKNOWN_SUBS);

  useEffect(() => {
    let alive = true;
    const sync = () => loadAlertSubs().then((s) => { if (alive) setSubs(s); });
    sync();
    const off = onAlertSubsChange(sync);
    return () => { alive = false; off(); };
  }, []);

  // Nothing to say while the set is unknown, for someone with no subscriptions, or for a non-Pro
  // reader — who cannot have any.
  if (!subs.ready || !subs.pro) return null;
  const inWatchlist = new Set((watched || []).map((t) => String(t).toUpperCase()));
  const orphans = [...subs.tickers].filter((t) => !inWatchlist.has(t)).sort();
  if (!orphans.length) return null;

  return (
    <div style={{ padding: '10px 16px', borderTop: `1px solid ${C.border}`, background: C.surface,
      fontFamily: "'DM Sans',sans-serif" }}>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>
        {/* Says what it is and what to do about it, in one line. */}
        Also alerting on {orphans.length === 1 ? 'a ticker' : `${orphans.length} tickers`} not in your
        watchlist — the bell turns each one off.
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {orphans.map((t) => (
          <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 5,
            background: C.white, border: `1px solid ${C.border}`, borderRadius: 5, padding: '3px 7px' }}>
            <a href={`/ticker/${t}`} style={{ fontSize: 11.5, fontWeight: 700, color: C.ink, textDecoration: 'none' }}>{t}</a>
            <AlertToggle symbol={t} variant="icon" />
          </span>
        ))}
      </div>
    </div>
  );
}
