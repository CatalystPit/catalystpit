'use client';
import { useEffect, useRef, useState } from 'react';
import { timeframe, DEFAULT_TIMEFRAME } from './chart-source.mjs';

// THE EVIDENCE A CHART SHOWS, FETCHED ONCE AND THE SAME WAY EVERYWHERE.
//
// ── ⚠️ THE CHART IS A RENDERER; THE HOST OWNS THE QUERY ─────────────────────
//
// CPChart deliberately does not fetch. That is what lets the Evidence Timeline and What Changed be
// two consumers of one API rather than two places that know how to ask, and it is why this is a
// hook rather than something inside the chart. What changed is only WHO calls it: the ticker page
// always did, and the Terminal — which renders the same chart — never did, so its Evidence control
// had nothing to control and was gated off at every width. Both hosts call this now.
//
// ── ⚠️ THE THREE RULES THAT MATTER, AND WHY ─────────────────────────────────
//
// 1. CLEARED BEFORE THE REQUEST GOES OUT, not when it lands. The chart treats null as "no evidence"
//    and wipes its markers, so the previous ticker's filings cannot sit over the new ticker's
//    candles even for the duration of one fetch. A cache HIT for the new symbol is set immediately
//    instead, which is the same guarantee arrived at sooner — it is that symbol's own evidence.
// 2. A SUPERSEDED RESPONSE IS DISCARDED. A fast request for the new symbol can land before a slow
//    one for the old; applying the loser would put AAPL's filings on MSTR.
// 3. A FAILURE RESOLVES TO "NO EVIDENCE", NEVER TO AN ERROR. The timeline is an enhancement. If it
//    fails the chart must still be a chart, and candles must never wait on it — this runs in its
//    own effect and the bars load on their own.

/**
 * Evidence is fetched for a fixed span rather than the live viewport.
 *
 * ⚠️ IT MUST COVER THE CHART. Derived from the timeframe definition rather than restated, so the
 * window and the default chart's span cannot drift apart — they did once, and years three to five
 * of the chart everyone opens on had no markers at all.
 */
export const EVIDENCE_WINDOW_DAYS = timeframe(DEFAULT_TIMEFRAME)?.window?.days ?? 365 * 2;

/**
 * Bounded, in-session, shared by every chart on the page.
 *
 * ⚠️ SMALL AND SHORT-LIVED. Evidence is a list of filings per symbol; a map that is never evicted is
 * a leak in a Terminal tab left open all day. Switching AAPL → MSTR → NVDA → AAPL is the movement
 * this exists for, not a day's browsing history.
 */
const MAX_CACHED = 10;
const TTL_MS = 5 * 60_000;
const cache = new Map();

function cacheGet(sym, now = Date.now()) {
  const hit = cache.get(sym);
  if (!hit) return null;
  if (now - hit.at > TTL_MS) return null;
  cache.delete(sym); cache.set(sym, hit);        // LRU: a read is a use
  return hit.data;
}
function cachePut(sym, data, now = Date.now()) {
  if (!sym || !Array.isArray(data)) return;
  if (cache.has(sym)) cache.delete(sym);
  cache.set(sym, { data, at: now });
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
}

/** For the suite, and for a host that needs to drop it. */
export const evidenceCacheSize = () => cache.size;
export function clearEvidenceCache() { cache.clear(); }

/**
 * @param symbol the ticker whose evidence to load. null clears.
 * @returns the evidence array, [] when there is none or the request failed, or null while loading.
 */
export function useTickerEvidence(symbol) {
  const [evidence, setEvidence] = useState(null);
  const reqRef = useRef(0);

  useEffect(() => {
    const sym = symbol ? String(symbol).toUpperCase() : null;
    if (!sym) { setEvidence(null); return undefined; }
    const id = ++reqRef.current;

    // Rule 1. A hit is this symbol's own evidence, so it may be shown at once; a miss clears.
    const cached = cacheGet(sym);
    setEvidence(cached || null);

    const ctrl = new AbortController();
    const to = new Date();
    const from = new Date(to.getTime() - EVIDENCE_WINDOW_DAYS * 86400000);

    // ONE REQUEST PER SYMBOL, NOT ONE PER PAN. The visible range changes on every scroll and every
    // timeframe click; refetching on those would be a request storm for data already in memory.
    fetch(`/api/evidence?ticker=${encodeURIComponent(sym)}`
      + `&from=${from.toISOString()}&to=${to.toISOString()}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        // Rule 2.
        if (ctrl.signal.aborted || id !== reqRef.current) return;
        const list = Array.isArray(d?.evidence) ? d.evidence : [];
        cachePut(sym, list);
        setEvidence(list);
      })
      // Rule 3.
      .catch(() => { if (id === reqRef.current && !ctrl.signal.aborted) setEvidence(cached || []); });

    return () => ctrl.abort();
  }, [symbol]);

  return evidence;
}
