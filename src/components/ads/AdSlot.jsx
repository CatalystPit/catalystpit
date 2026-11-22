'use client';

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { ADSENSE_CLIENT, adSlotId } from '../../lib/adsense.mjs';
import {
  getAdsEligible, getAdsEligibleServerSnapshot, subscribeAdsEligible,
} from '../../lib/ads-eligibility.mjs';

/**
 * ONE AD PLACEMENT. The only component in the product that renders advertising markup.
 *
 * ── ⚠️ IT RENDERS NOTHING UNLESS BOTH FACTS ARE TRUE ─────────────────────────────────────────────
 *
 *   1. The visitor is eligible — resolved once by <AdSenseLoader/> and published to the shared
 *      store. `null` (not yet known) and `false` both render nothing. See ads-eligibility.mjs.
 *   2. This placement has a real ad unit id from the AdSense dashboard.
 *
 * Returning `null` rather than an empty container is the point. An `ins` with no entitlement is an
 * advertisement served to a paying member the instant the loader arrives; an `ins` with a fabricated
 * slot id is a unit that can never fill, which both looks exactly like the fill problem we are
 * trying to diagnose and is a policy smell in its own right.
 *
 * ── ⚠️ NO RESERVED SPACE WHEN THERE IS NO AD ─────────────────────────────────────────────────────
 *
 * A placeholder box sized for an ad is the standard way to avoid layout shift, and it is wrong here:
 * a Pro subscriber would get a permanent empty gap in the page as the visible residue of advertising
 * they pay to not have. Nothing renders, so nothing shifts for them. For eligible visitors the slot
 * appears once, early, and `min-height` keeps the reflow to a single step.
 *
 * ── ⚠️ ONE PUSH PER ELEMENT, EVER ────────────────────────────────────────────────────────────────
 *
 * `adsbygoogle.push({})` claims the next unfilled `ins` on the page. Pushing twice for one element
 * is the documented cause of "All ins elements in the DOM with class=adsbygoogle already have ads in
 * them", and in React a remount or a Strict Mode double-effect gets you there without trying. The
 * guard is per-element, on the node itself, so it survives re-render but not a genuinely new slot.
 */
export default function AdSlot({
  placement,
  minHeight = 90,
  label = true,
  style,
  className,
}) {
  const eligible = useSyncExternalStore(
    subscribeAdsEligible, getAdsEligible, getAdsEligibleServerSnapshot,
  );
  const insRef = useRef(null);
  const pushed = useRef(false);
  const slot = adSlotId(placement);
  const show = eligible === true && !!slot;

  useEffect(() => {
    if (!show || pushed.current || !insRef.current) return;
    // Already carries an ad (a remount over a live slot) — pushing again is the duplicate-ad error.
    if (insRef.current.getAttribute('data-adsbygoogle-status')) { pushed.current = true; return; }
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
      pushed.current = true;
    } catch {
      // ⚠️ SWALLOWED ON PURPOSE. A blocked or failed loader must not take a research page down with
      // it. Advertising is secondary to the product and never gets to throw inside it.
    }
  }, [show, slot]);

  if (!show) return null;

  return (
    <div
      className={className}
      style={{
        // Centred, never wider than its column, and out of the way of everything else. The slot is
        // placed BETWEEN content blocks by its caller — it is never positioned over a chart, a
        // table, the navigation or any control, because it is in normal document flow and has no
        // position, z-index or overlay of any kind.
        display: 'block', width: '100%', maxWidth: '100%', overflow: 'hidden',
        margin: '18px auto', textAlign: 'center', minHeight,
        ...style,
      }}
    >
      {label && (
        /* ⚠️ LABELLED, BECAUSE AN UNLABELLED AD BESIDE REAL RESEARCH IS THE DECEPTIVE CASE. Google
           requires advertising to be distinguishable from content, and on a site whose entire value
           is "this number came from a filing" the labelling is ours to want, not just theirs. */
        <div style={{
          font: '400 10px/1.4 system-ui, -apple-system, sans-serif',
          letterSpacing: '.08em', textTransform: 'uppercase',
          color: 'rgba(125,125,135,.75)', marginBottom: 4, userSelect: 'none',
        }}>
          Advertisement
        </div>
      )}
      <ins
        ref={insRef}
        className="adsbygoogle"
        style={{ display: 'block', width: '100%' }}
        data-ad-client={ADSENSE_CLIENT}
        data-ad-slot={slot}
        data-ad-format="auto"
        data-full-width-responsive="true"
      />
    </div>
  );
}
