'use client';

// THE ONE ALERT CONTROL, WORN THREE WAYS.
//
// Pit Scan rows, the Terminal watchlist and the ticker page all need "Alert / Alert On" and all
// three had their own idea of size. They get one component with a `variant`, so the wording, the
// entitlement message, the optimistic-state rules and the shared subscription set cannot drift
// apart across three copies.
//
// ⚠️ IT NEVER ASKS THE SERVER WHETHER *THIS* TICKER IS ON. It reads the one set that
// alert-subs-client fetched for the page. A hundred scan rows cost one request, not a hundred.

import { useEffect, useState } from 'react';
import { loadAlertSubs, onAlertSubsChange, toggleAlert } from '../lib/alerts/alert-subs-client';
import { C } from '../lib/cp-shared';

export default function AlertToggle({ symbol, variant = 'text', onNotice = null }) {
  const sym = String(symbol || '').toUpperCase();
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const sync = () => loadAlertSubs().then((s) => { if (alive) setOn(s.tickers.has(sym)); });
    sync();
    const off = onAlertSubsChange(sync);
    return () => { alive = false; off(); };
  }, [sym]);

  const click = async (e) => {
    e.preventDefault();
    e.stopPropagation();          // scan rows and watchlist rows have their own click
    if (busy) return;
    setBusy(true);
    try {
      const next = await toggleAlert(sym);
      setOn(next);
      onNotice?.(next ? `Alerting on ${sym}` : `Alerts off for ${sym}`);
    } catch (err) {
      // ⚠️ THE CONTROL DOES NOT MOVE ON A REFUSAL. A non-Pro click must not leave "Alert On"
      // sitting there implying a subscription the server refused to create.
      onNotice?.(err.message);
    } finally { setBusy(false); }
  };

  const label = on ? 'Alert On' : 'Alert';
  // ⚠️ THE CAVEAT TRAVELS WITH THE CONTROL, NOT ONLY WITH THE INBOX. The same line appears at the
  // foot of the bell's alert list, but that list only renders once alerts exist — someone who has
  // just switched a ticker on would otherwise never have been told what the promise is worth.
  const caveat = 'Alerts are informational and may be delayed, incomplete, or unavailable. Delivery is not guaranteed.';
  // ⚠️ TWO STRINGS, BECAUSE THEY HAVE TWO JOBS. `action` names the control for assistive tech and
  // must stay short — a screen reader announcing a two-sentence disclaimer as the button's NAME is
  // worse than not disclosing it here at all. `title` is the hover tooltip, where the caveat fits.
  const action = on
    ? `Stop monitoring ${sym} for new public evidence`
    : `Monitor ${sym} for new public evidence`;
  const title = `${action}\n${caveat}`;

  if (variant === 'icon') {
    // The watchlist row: a bell glyph, because that row has no width to spare and already carries
    // a price, badges and the What Changed line.
    return (
      <button type="button" onClick={click} disabled={busy} title={title} aria-pressed={on}
        aria-label={action}
        style={{ background: 'none', border: 'none', padding: '0 2px', cursor: 'pointer',
          lineHeight: 0, flexShrink: 0, opacity: busy ? 0.5 : 1 }}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill={on ? C.gold : 'none'}
          stroke={on ? C.gold : C.dim} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
      </button>
    );
  }

  if (variant === 'button') {
    // The ticker page, beside the watchlist star.
    return (
      <button type="button" onClick={click} disabled={busy} title={title} aria-pressed={on}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 700,
          fontFamily: "'DM Sans',sans-serif", padding: '6px 11px', borderRadius: 7, cursor: 'pointer',
          background: on ? C.greenLight : C.white, color: on ? C.ink : C.muted,
          border: `1px solid ${on ? C.green : C.border}`, opacity: busy ? 0.6 : 1 }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill={on ? C.green : 'none'}
          stroke={on ? C.green : C.muted} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {label}
      </button>
    );
  }

  // Pit Scan: the same bare text action it already was, beside Watch and Evidence. Enabled state
  // is a colour and a word — the row height does not change.
  return (
    <button type="button" onClick={click} disabled={busy} title={title} aria-pressed={on}
      style={{ fontSize: 10.5, fontWeight: 700, color: on ? C.green : C.muted, background: 'none',
        border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', opacity: busy ? 0.5 : 1 }}>
      {label}
    </button>
  );
}
