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
import { useAuth } from '@clerk/nextjs';
import { loadAlertSubs, onAlertSubsChange, toggleAlert, UNKNOWN_SUBS } from '../lib/alerts/alert-subs-client';
import { C, startCheckout } from '../lib/cp-shared';

export default function AlertToggle({ symbol, variant = 'text', onNotice = null }) {
  const sym = String(symbol || '').toUpperCase();
  // ⚠️ THREE STATES, NOT TWO, AND THAT IS THE FIX.
  //
  // This started at `on = false` and never read `pro` at all — the entitlement was already in the
  // payload and nothing consumed it. Two things followed:
  //
  //   a Free or signed-out visitor got a control that looked exactly like a working one, clicked it,
  //   and received a toast saying the feature is Pro. The brief's wording for that is a functional
  //   toggle that fails after they click it.
  //
  //   a Pro subscriber whose ticker was already enabled saw "Alert" on first paint and then watched it
  //   flip to "Alert On" — the entitlement-loading flash, on the one control whose entire job is to
  //   tell you what state you are in.
  //
  // So until the set has loaded the answer is "not known yet" and nothing clickable is rendered.
  const { isLoaded: authLoaded, isSignedIn } = useAuth();
  const [subs, setSubs] = useState(UNKNOWN_SUBS);
  const [busy, setBusy] = useState(false);
  const on = subs.tickers.has(sym);

  useEffect(() => {
    let alive = true;
    const sync = () => loadAlertSubs().then((s) => { if (alive) setSubs(s); });
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

  // ⚠️ UNKNOWN RENDERS NOTHING AT ALL, in every variant. An inline placeholder in the scan row or the
  // watchlist row would reserve width and then be replaced, which is the layout shift this is meant to
  // avoid; these rows are dense and the control is one word. The window is one request.
  if (!subs.ready || !authLoaded) return null;

  // ⚠️ A NON-PRO VISITOR GETS A LINK TO THE PRO PAGE, NOT A DEAD TOGGLE. The route refuses them
  // server-side whatever is rendered — hiding a control was never the access control, and still is not
  // — so this is purely about not offering an action that cannot succeed. It is deliberately the same
  // affordance the rest of the product uses for a Pro capability, and deliberately not a modal, a
  // banner, or a second upgrade prompt on a row that may already sit next to one.
  if (!subs.pro) {
    const proTitle = `Evidence Alerts are a Pit Pro feature.
${caveat}`;
    // ⚠️ THE PRODUCT'S OWN UPGRADE PATH, NOT A URL I MADE UP. The first version of this linked to
    // /pro, which does not exist — there is no pricing page in this app. LockedCta is the existing
    // pattern for a Pro capability: /sign-up when signed out, startCheckout() when signed in. Same
    // two destinations here, in a form that fits a dense row.
    const go = (e) => { e.preventDefault(); e.stopPropagation(); if (isSignedIn) startCheckout(); else { window.location.href = '/sign-up'; } };
    if (variant === 'icon') {
      // The dense watchlist row: the bell stays, dimmed, and offers the upgrade instead of posting.
      return (
        <button type="button" onClick={go} title={proTitle} aria-label={`Evidence Alerts for ${sym} require Pit Pro`}
          style={{ background: 'none', border: 'none', padding: '0 2px', cursor: 'pointer', lineHeight: 0, flexShrink: 0, opacity: 0.45 }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={C.dim}
            strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
          </svg>
        </button>
      );
    }
    if (variant === 'button') {
      return (
        <button type="button" onClick={go} title={proTitle}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 700,
            fontFamily: "'DM Sans',sans-serif", padding: '6px 11px', borderRadius: 7, cursor: 'pointer',
            background: C.white, color: C.muted, border: `1px solid ${C.border}` }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={C.muted}
            strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
          </svg>
          Alerts · Pro
        </button>
      );
    }
    // Pit Scan: the same bare text slot, so the row's four actions keep their spacing.
    return (
      <button type="button" onClick={go} title={proTitle} className="cp-scan-act"
        style={{ fontSize: 10.5, fontWeight: 700, color: C.dim, background: 'none', border: 'none',
          cursor: 'pointer', fontFamily: 'inherit' }}>
        Alert · Pro
      </button>
    );
  }

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
  //
  // ⚠️ `cp-scan-act` CARRIES THE TAP TARGET. At 10.5px with padding:0 the touchable box was about
  // thirteen pixels tall, twelve pixels from Watch — and a mis-tap here creates a subscription the
  // reader did not ask for, which is the worst of the four to get wrong. The class grows the hit box
  // and cancels it with an equal negative margin, so the row height is genuinely unchanged.
  return (
    <button type="button" onClick={click} disabled={busy} title={title} aria-pressed={on} className="cp-scan-act"
      style={{ fontSize: 10.5, fontWeight: 700, color: on ? C.green : C.muted, background: 'none',
        border: 'none', cursor: 'pointer', fontFamily: 'inherit', opacity: busy ? 0.5 : 1 }}>
      {label}
    </button>
  );
}
