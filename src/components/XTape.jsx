'use client';

// "Tape (via X)" — an embed-only rolling feed of an X (Twitter) List the operator curates
// (e.g. "Pit Wire"). It is PRESENCE, not a wire: X's own official widget renders the posts in
// an iframe, so it visibly says "via X" and we never copy tweet text into our own cards or
// promote a post into Top Stories. 8-K/PR (server-side) stays the source of truth.
//
// The List URL defaults to the operator's "Pit Wire" list and can be overridden anytime via
// NEXT_PUBLIC_X_LIST_URL (set in Vercel) to swap the List with no code change. It's a public URL,
// not a secret. If it's ever cleared to empty, the component renders NOTHING (page never breaks).
//
// Reliability note: X's syndication endpoint that feeds this widget rate-limits (HTTP 429) PER
// VISITOR IP. That fetch happens in the visitor's own browser, so every rebuild is spent out of
// that one visitor's budget, and a refused rebuild is SILENT — it leaves the previous tape on
// screen, which is indistinguishable from a tape that simply has nothing new. Rebuilding on a blind
// timer therefore burns the budget on an unchanged timeline and is throttled exactly when a post
// finally lands. We use createTimeline() (one clean call, no repeated widgets.load storms), rebuild
// only when the list has actually moved, retry with backoff so a transient 429 self-heals, and fall
// back to a direct "open on X" link if it still can't paint — the box is never left dead.

import { useEffect, useRef, useState } from 'react';
import { C } from '../lib/cp-shared';

// Default: the "Pit Wire" X List. Override with NEXT_PUBLIC_X_LIST_URL to swap without a code change.
const LIST_URL = process.env.NEXT_PUBLIC_X_LIST_URL || 'https://x.com/i/lists/2096931068477620423';
const LIST_ID = (LIST_URL.match(/lists\/(\d+)/) || [])[1] || null;
const WIDGETS_SRC = 'https://platform.twitter.com/widgets.js';
const RETRY_DELAYS = [3000, 8000, 20000]; // backoff for transient 429s / slow syndication
const CREATE_TIMEOUT = 15000;             // createTimeline must settle or we treat it as a failure

// X's widget renders a SNAPSHOT at creation time and never polls for new posts, so the only way to
// get a new post out of an embed we cannot read into is to rebuild it.
//
// WHAT DRIVES A REBUILD: /api/x-tape/head, which reads the newest post id on the list from our own
// server (one read per 15s shared by every open Terminal, no post content, nothing stored) and
// costs the visitor nothing against X's per-IP limit. When that id differs from the one the visible
// tape was built against, there is a post the embed cannot be showing, so we rebuild — and because
// our server and the browser read the same syndication document, that rebuild is fetching a
// snapshot which actually contains it. When the list is quiet we make NO request to X at all, which
// is what leaves the rate-limit budget available for the moment a post does land. The blind 60s
// timer this replaces did the opposite: it spent the visitor's whole budget re-fetching an
// unchanged timeline, and a refused rebuild silently leaves the OLD tape up — a stale tape.
//
// If the head signal is unavailable for any reason the component falls straight back to the plain
// 60s timer, so this can only add freshness, never remove it.
const HEAD_URL = '/api/x-tape/head';
const HEAD_POLL_MS = 8 * 1000;            // same-origin; does not touch X, so poll faster than it
const MIN_REBUILD_MS = 20 * 1000;         // floor between two syndication requests from one visitor
const TIMER_REFRESH_MS = 60 * 1000;       // fallback cadence when the head signal is unavailable
const IDLE_REBUILD_MS = 10 * 60 * 1000;   // safety net: rebuild eventually even with no head change
const HIDDEN_REFRESH_MS = 30 * 60 * 1000; // backgrounded: keep it alive, stop spending requests
// A cross-origin iframe swallows pointer events, so pointerleave is not guaranteed to fire — the
// hover guard below must never be able to latch on and freeze the tape for the rest of the session.
const HOVER_MAX_HOLD_MS = 3 * 60 * 1000;
const TICK_MS = 2000;
// A build that has not settled in this long is treated as abandoned, so the scheduler can never be
// locked out permanently by a promise chain that neither resolves nor rejects.
const BUILD_STALL_MS = 90 * 1000;
// How long both tapes stay mounted and stacked after the new one is revealed. The old tape is the
// safety net: while it is still there, no ordering mistake in the reveal can show an empty panel.
const OVERLAP_MS = 400;

// createTimeline returns X's own promise. It normally resolves (with the element, or with undefined
// when X declines), but a hung syndication request can leave it pending forever, and a promise that
// never settles means the catch that schedules the retry never runs: the box sits on "Loading tape
// from X…" until the page is reloaded. Racing it against a deadline makes every outcome reachable.
const withDeadline = (p, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('createTimeline timed out')), ms);
  Promise.resolve(p).then(
    (v) => { clearTimeout(t); resolve(v); },
    (e) => { clearTimeout(t); reject(e); },
  );
});

// Resolve once X's embed is genuinely ON SCREEN — which is a different moment from "has height".
//
// This is the exact lifecycle, read out of platform.twitter.com/widgets.js. The sandbox creates its
// iframe with
//     { position:'absolute', visibility:'hidden', display:'block', width:'0px', height:'0px' }
// and reveals it later with
//     { position:'static', visibility:'visible' }
// through makeVisible(). The timeline factory calls setWaitToSwapUntilRendered(true), so that
// reveal is deferred to the END of the render chain — results, then makeVisible, then rendered —
// while the iframe's real width and height arrive EARLIER, on the resize message from inside the
// frame.
//
// That ordering is what defeated the previous attempt. `visibility:hidden` does not remove an
// element from layout, so offsetHeight reads ~600 on an iframe that is still invisible. Waiting on
// height alone therefore resolved during the gap: we revealed the staging slot and dropped the old
// one while X's new iframe was still hidden, and the panel went blank until makeVisible() ran.
//
// So readiness is BOTH: real height AND computed visibility. Both are observable from outside a
// cross-origin frame; its load event and its contents are not.
const MIN_RENDERED_PX = 120;
const PAINT_TIMEOUT = 10000;
const PAINT_POLL_MS = 80;
const isOnScreen = (frame) => {
  if (!frame || frame.offsetHeight < MIN_RENDERED_PX || frame.offsetWidth < 40) return false;
  const cs = window.getComputedStyle(frame);
  return cs.visibility === 'visible' && cs.display !== 'none' && Number(cs.opacity || '1') > 0.99;
};
const waitPainted = (slot, isCancelled) => new Promise((resolve, reject) => {
  const started = Date.now();
  const tick = () => {
    if (isCancelled()) return resolve(undefined);        // teardown, not a failure
    const frame = slot?.querySelector('iframe');
    // Two consecutive passes, so a dimension caught mid-write is never mistaken for a stable one.
    if (isOnScreen(frame)) return requestAnimationFrame(() => {
      if (isCancelled()) return resolve(undefined);
      if (isOnScreen(frame)) return resolve(frame);
      setTimeout(tick, PAINT_POLL_MS);
    });
    // Timing out is a real failure: it routes into the retry/backoff below, which leaves the tape
    // already on screen exactly where it is.
    if (Date.now() - started > PAINT_TIMEOUT) return reject(new Error('embed never became visible'));
    setTimeout(tick, PAINT_POLL_MS);
  };
  tick();
});

// Load platform.twitter.com/widgets.js exactly once per page, and hand every LATER mount the widgets
// object without waiting for a load event that has already fired.
//
// This is shared by two different mount points: the Terminal workspace panel and the global dock in
// the root layout. Crossing the /terminal boundary unmounts one and mounts the other, so the second
// one always arrives with the script already in the document. Three things follow, and all three are
// handled here rather than being left to a poll that can only time out:
//   • twttr already initialized  → resolve synchronously. The new tape then calls createTimeline()
//     itself, which is the explicit rebuild; nothing waits on a script event.
//   • the tag is present but twttr is not ready yet → listen for load AND use X's own twttr.ready()
//     queue, which its stub installs before widgets is populated.
//   • the tag is present but never produced twttr (blocked, aborted, or a tag left behind by an
//     earlier page) → waiting longer cannot help, so ask for the script again from scratch.
// And a failure is NEVER cached: one bad load must not poison every later mount on every later route.
let widgetsPromise = null;
function injectScript(onDone, onFail) {
  const script = document.createElement('script');
  script.src = WIDGETS_SRC;
  script.async = true;
  script.onload = onDone;
  script.onerror = onFail;
  document.body.appendChild(script);
  return script;
}
function loadWidgets() {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.twttr?.widgets) return Promise.resolve(window.twttr);
  if (widgetsPromise) return widgetsPromise;

  widgetsPromise = new Promise((resolve, reject) => {
    let settled = false;
    const ok = () => { if (!settled) { settled = true; resolve(window.twttr); } };
    const fail = (e) => { if (!settled) { settled = true; reject(e); } };
    // A load event is only a hint. widgets.js publishes window.twttr.widgets as it evaluates, and an
    // event that fired before this mount existed will never fire again, so the poll is the decider
    // and every event merely gives it an early nudge.
    const nudge = () => { if (window.twttr?.widgets) ok(); };

    const existing = document.querySelector(`script[src="${WIDGETS_SRC}"]`);
    if (existing) existing.addEventListener('load', nudge);
    else injectScript(nudge, () => fail(new Error('widgets.js failed')));
    if (typeof window.twttr?.ready === 'function') window.twttr.ready(ok);

    let n = 0;
    const t = setInterval(() => {
      if (settled) { clearInterval(t); return; }
      if (window.twttr?.widgets) { clearInterval(t); ok(); return; }
      n++;
      // ~6s in, a tag that has still produced nothing never will. Ask for the script again instead
      // of waiting out a timeout on an event that already happened.
      if (n === 20 && existing) injectScript(nudge, () => {});
      if (n > 50) { clearInterval(t); fail(new Error('twttr init timeout')); }
    }, 300);
  }).catch((e) => {
    widgetsPromise = null;
    throw e;
  });
  return widgetsPromise;
}

export default function XTape({ height = 620, onClose, bare = false }) {
  const ref = useRef(null);
  const [status, setStatus] = useState('loading'); // 'loading' | 'ready' | 'error'
  // Bumped by the refresh scheduler to re-run the build effect. builtAtRef is when the visible tape
  // was last painted; builtHeadRef is the newest post id known at the moment that build started, so
  // comparing it with the live head tells us whether the tape can possibly be showing everything.
  const [nonce, setNonce] = useState(0);
  // Seeded with MOUNT TIME, not 0. A tape that has not built yet is not a tape that was last built in
  // 1970: with a zero here every staleness test below ("is it older than 10 minutes / 60 seconds")
  // was true from the first tick, so the scheduler demanded a rebuild every 2s while the very first
  // build was still running, cancelled it through the effect's cleanup, and started another one.
  // That loop is what left the panel on "Loading tape from X…" forever — it also wiped the retry
  // backoff on every pass, so the attempts never exhausted and the error fallback never appeared.
  const builtAtRef = useRef(Date.now());
  const builtHeadRef = useRef(undefined);
  // True while a build (including its retry backoff) is in flight. The scheduler must not restart a
  // build that has not finished: a rebuild takes 1-3s and the tick is 2s, so without this a slow
  // build is restarted forever, and every restart spends another syndication request against X's
  // per-visitor limit until it 429s and no build can ever succeed again.
  const buildingRef = useRef(false);
  const buildSinceRef = useRef(0);
  const headRef = useRef(null);
  const hoverRef = useRef(false);
  const hoverSinceRef = useRef(0);
  const buildSeqRef = useRef(0);
  // The pending removal of the outgoing tape. Held in a ref so a teardown or a second swap can
  // cancel it — the one thing that must never happen is a stale timer removing the tape that is
  // currently on screen.
  const swapTimerRef = useRef(null);

  // The embed lives in a CROSS-ORIGIN iframe, so its text colour is fixed at creation and cannot be
  // restyled afterwards. It therefore has to be built with the theme that is actually active, and
  // rebuilt when the user toggles. `null` until measured on the client, deliberately: the shared
  // useTheme() starts at "light" and corrects after mount, which would build the widget twice on
  // every dark-mode load and burn two syndication requests against X's per-visitor rate limit.
  const [theme, setTheme] = useState(null);
  // Height tracks the window and changes on every resize event. It is read at build time rather than
  // being a dependency, because rebuilding the widget mid-drag of a window edge would fire a
  // syndication request per resize tick and get the visitor rate-limited.
  const heightRef = useRef(height);
  heightRef.current = height;

  useEffect(() => {
    const read = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
    read();
    const obs = new MutationObserver(read);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (!LIST_ID) { setStatus('error'); return; }
    if (!theme) return;                 // not measured yet; never build with a guessed theme
    let cancelled = false;
    let timer;
    // Only the FIRST build shows the loading state. A background refresh must not put "Loading tape
    // from X…" under a tape the trader is already reading.
    if (!ref.current?.querySelector('iframe')) setStatus('loading');
    // This build owns the scheduler until it settles, one way or the other.
    buildingRef.current = true;
    buildSinceRef.current = Date.now();
    // Anchor this build to the head as it is known RIGHT NOW, not to whatever the response turns
    // out to contain. A post published seconds ago can take up to a minute to reach syndication, so
    // anchoring on arrival would let that post fall into the gap and never trigger a second build.
    builtHeadRef.current = headRef.current?.id ?? undefined;

    // The new timeline is built into its OWN slot, appended alongside the current one and hidden
    // until it paints. The iframe is never moved between parents — moving an iframe in the DOM
    // forces it to reload, which would undo the whole point. On failure nothing is touched and the
    // trader keeps looking at the tape they already had.
    //
    // EVERY slot stays absolutely positioned for its whole life, and the swap only ever flips
    // `visibility`. That is what removes the black flash: the previous version finished by setting
    // `slot.style.cssText = ''`, which moved the slot from absolute to static and dropped its
    // width:100%. Re-laying-out a cross-origin iframe makes it repaint from scratch, and X's dark
    // embed paints its background before its content — so the tape blinked black on every refresh.
    // A box that never changes cannot trigger that repaint.
    let slot = null;
    const swapIn = () => {
      if (!ref.current || !slot) return;
      const incoming = slot;
      // The incoming slot is REVEALED ON TOP of the outgoing one, which is not touched. For this
      // moment both tapes are mounted and painted, stacked exactly on each other, so there is no
      // instant at which the panel contains nothing to show.
      incoming.style.zIndex = '2';
      incoming.style.visibility = 'visible';
      incoming.style.pointerEvents = 'auto';
      // Only then, after a real overlap, is the outgoing tape removed. Two frames was not enough
      // margin; a few hundred milliseconds of double-mounting costs nothing and removes the whole
      // class of timing bug. Anything already-visible stays visible for the entire overlap.
      swapTimerRef.current = setTimeout(() => {
        if (!ref.current) return;
        for (const child of [...ref.current.children]) if (child !== incoming) child.remove();
        incoming.style.zIndex = '1';
      }, OVERLAP_MS);
    };

    const attempt = (i) => {
      if (cancelled) return;
      loadWidgets()
        .then((twttr) => {
          if (cancelled || !ref.current) return;
          if (slot) slot.remove();
          slot = document.createElement('div');
          // Laid out (so the widget measures a real width) but invisible and inert until ready.
          slot.style.cssText = 'position:absolute;left:0;top:0;width:100%;visibility:hidden;pointer-events:none;z-index:0';
          ref.current.appendChild(slot);
          // Every createTimeline call mints a new embedId, which widgets.js puts in the iframe URL,
          // so successive rebuilds within a page already miss the browser cache. The FIRST build of
          // a page load does not: widgets.js restarts that counter at zero, so reopening the
          // Terminal produces a byte-identical URL, and X serves that iframe with
          // `cache-control: must-revalidate, max-age=60` — a reopen inside a minute can be answered
          // out of disk cache with the previous visit's posts. Alternating the requested height by
          // one pixel changes the maxHeight query parameter, so no two consecutive builds can
          // collide on a cache entry. One pixel of a ~600px panel is not visible.
          const px = heightRef.current - (buildSeqRef.current++ % 2);
          return withDeadline(twttr.widgets.createTimeline(
            { sourceType: 'list', id: LIST_ID },
            slot,
            // `transparent` is deliberately NOT in this list. It tells X to drop its own background
            // so the host page shows through, but X still emits the DARK theme's light-grey text
            // while the iframe canvas paints white, so usernames, tweet text, timestamps, the X
            // glyphs and the interaction counts all land at roughly 1.3:1 on white. Links and
            // avatars keep their own colours, which is why only part of the feed looked washed out.
            // Letting X paint its own background costs nothing (its light background matches our
            // light card exactly, and its dark background sits inside our dark panel) and is the
            // only way the embed renders its own theme consistently.
            { theme, chrome: 'noheader nofooter', height: px },
          ), CREATE_TIMEOUT);
        })
        .then((el) => {
          if (cancelled) return;
          // Trust what is actually in the DOM over the promise's word. X resolves with undefined when
          // it declines (429), and has also been seen to resolve oddly while the iframe did paint.
          if (!el && !slot?.querySelector('iframe')) throw new Error('timeline not created');
          // An iframe EXISTING is not a rendered tape. widgets.js resolves once it has inserted the
          // element; X then loads the document and sizes the frame to its content. Swapping on the
          // promise alone put an empty frame on screen and let it fill in afterwards, which is the
          // other half of the flash. Wait for the frame to have real height first.
          return waitPainted(slot, () => cancelled);
        })
        .then((painted) => {
          if (cancelled || painted === undefined) return;
          swapIn();
          builtAtRef.current = Date.now();
          buildingRef.current = false;
          setStatus('ready');
        })
        .catch(() => {
          if (cancelled) return;
          if (slot) { slot.remove(); slot = null; }
          if (i < RETRY_DELAYS.length) timer = setTimeout(() => attempt(i + 1), RETRY_DELAYS[i]);
          else {
            // The rebuild lost — most often a 429. Do NOT let it count as a build: clearing the
            // anchor is what makes the scheduler come back to this same head once MIN_REBUILD_MS
            // has passed, instead of concluding the tape is up to date because it tried once.
            builtHeadRef.current = undefined;
            // This build is over. Release the scheduler and restart the freshness clock, so the next
            // attempt arrives on the normal cadence instead of on the very next 2s tick — retrying
            // a rate-limited embed twice a second is what kept it rate-limited.
            buildingRef.current = false;
            builtAtRef.current = Date.now();
            // A failed REFRESH must not blank a tape that is already on screen. Only the very first
            // build has nothing to fall back to, so only that one surfaces the error state.
            if (!ref.current?.querySelector('iframe')) setStatus('error');
            else setStatus('ready');
          }
        });
    };
    attempt(0);

    // Teardown drops only the IN-FLIGHT staging slot, never the visible tape. React runs cleanup
    // before the next effect, so clearing everything here would blank the panel at the start of every
    // refresh and defeat the staging entirely. The visible widget is replaced by swapIn() once its
    // successor has actually painted — which also stops a theme rebuild stacking two iframes, since
    // swapIn removes every sibling.
    return () => {
      cancelled = true;
      // Whatever was in flight is abandoned here; the next effect claims the scheduler again
      // immediately, and React commits both in the same synchronous pass, so no tick can slip in.
      buildingRef.current = false;
      if (timer) clearTimeout(timer);
      // THE BUG THIS GUARD FIXES. `slot` is the staging slot only until swapIn() succeeds; after
      // that it IS the visible tape. The previous version removed it unconditionally, so React's
      // cleanup — which runs BEFORE the next effect — deleted the tape from the DOM at the start of
      // every single refresh and left the panel empty for the whole 1-3s build. The comment here
      // used to claim this dropped "only the in-flight staging slot"; it did not.
      //
      // A hidden slot has never been swapped in, so hidden is exactly the test for "safe to remove".
      if (slot && slot.style.visibility === 'hidden') slot.remove();
      slot = null;
      // A pending overlap removal must not outlive this build and delete the tape belonging to the
      // next one. The next swapIn clears any leftover siblings anyway.
      if (swapTimerRef.current) { clearTimeout(swapTimerRef.current); swapTimerRef.current = null; }
    };
  }, [theme, nonce]);

  // ── head poller ──
  // Same-origin and content-free: it reports only the newest post id on the list. Nothing here
  // touches X from the visitor's browser, so polling it often is free where rebuilding is not.
  useEffect(() => {
    if (!LIST_ID) return;
    let stopped = false;
    let timer;
    const poll = async () => {
      if (!document.hidden) {
        try {
          const r = await fetch(HEAD_URL, { cache: 'no-store' });
          const j = await r.json();
          headRef.current = j?.id ? j : null;   // null = signal unavailable, fall back to the timer
        } catch { headRef.current = null; }
      }
      if (!stopped) timer = setTimeout(poll, HEAD_POLL_MS);
    };
    poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, []);

  // ── refresh scheduler ──
  // Bumping `nonce` re-runs the build effect above, so refreshing reuses the existing build, retry,
  // backoff and teardown path rather than adding a second mechanism.
  useEffect(() => {
    if (!LIST_ID) return;
    let timer;

    // Never rebuild under the trader's cursor: the embed is cross-origin, so its internal scroll
    // position cannot be restored across a rebuild. But pointer events over that iframe do not
    // reach us, so pointerleave is not guaranteed to arrive — parking the cursor on the tape and
    // switching windows used to latch this guard on and stop every refresh for the rest of the
    // session. It is now time-capped, and released whenever the page stops being the focused one.
    const held = () => hoverRef.current && Date.now() - hoverSinceRef.current < HOVER_MAX_HOLD_MS;

    // A build already running owns the tape. Time-capped for the same reason the hover guard is: a
    // flag that can latch on must never be able to stop refreshing for the rest of the session.
    const building = () => buildingRef.current && Date.now() - buildSinceRef.current < BUILD_STALL_MS;

    const shouldBuild = () => {
      const since = Date.now() - builtAtRef.current;
      if (document.hidden) return since >= HIDDEN_REFRESH_MS;
      if (since >= IDLE_REBUILD_MS) return true;          // safety net, head signal or not
      const head = headRef.current;
      if (!head?.id) return since >= TIMER_REFRESH_MS;    // no signal → previous 60s behaviour
      return head.id !== builtHeadRef.current && since >= MIN_REBUILD_MS;
    };

    const tick = () => {
      if (!held() && !building() && shouldBuild()) setNonce((n) => n + 1);
      timer = setTimeout(tick, TICK_MS);
    };
    timer = setTimeout(tick, TICK_MS);

    // Coming back to a backgrounded tab, or back online, checks immediately instead of waiting. A
    // hidden or unfocused page cannot have a cursor resting on the tape, so release the guard too.
    const release = () => { hoverRef.current = false; };
    const wake = () => {
      if (document.hidden) { release(); return; }
      if (!held() && !building() && shouldBuild()) setNonce((n) => n + 1);
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    window.addEventListener('blur', release);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      window.removeEventListener('blur', release);
    };
  }, []);

  if (!LIST_ID) return null;

  return (
    <div style={{ background: C.white, border: bare ? 'none' : `1px solid ${C.border}`, borderRadius: bare ? 0 : 8,
      overflow: bare ? 'auto' : 'hidden', height: bare ? '100%' : undefined, fontFamily: "'DM Sans',sans-serif" }}>
      {/* Green top bar: black X logo + white "Tape" (hidden in bare mode — panel has its own header) */}
      {!bare && (
        <div style={{ background: C.green, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="#000" aria-hidden="true">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
          </svg>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#fff' }}>Tape</span>
          {onClose && (
            <button onClick={onClose} aria-label="Collapse tape"
              style={{ marginLeft: 'auto', background: 'transparent', border: 'none', cursor: 'pointer',
                color: '#fff', fontSize: 16, lineHeight: 1, padding: '2px 4px' }}>
              ✕
            </button>
          )}
        </div>
      )}
      <div style={{ padding: '8px 14px', fontSize: 11, fontWeight: 300, color: C.muted, lineHeight: 1.4, borderBottom: `1px solid ${C.border}` }}>
        Unverified social tape that mixes official prints and rumors. Not investment advice.
      </div>

      {/* Timeline mounts here. Kept in the DOM across states so createTimeline always has its target. */}
      {/* Every slot inside is absolutely positioned so a swap never re-lays-out an iframe, which
          means this container has to carry the height itself or it would collapse to nothing. The
          height asked of X is the height reserved here, so the box is stable across a refresh. */}
      <div ref={ref}
        onPointerEnter={() => { hoverRef.current = true; hoverSinceRef.current = Date.now(); }}
        onPointerLeave={() => { hoverRef.current = false; }}
        style={{ position: 'relative', padding: '0 2px', overflow: 'hidden',
          height: status === 'ready' ? height : undefined,
          minHeight: status === 'ready' ? undefined : 0 }} />

      {status === 'loading' && (
        <div style={{ padding: '18px 14px', fontSize: 12, color: C.dim, textAlign: 'center' }}>
          Loading tape from X…
        </div>
      )}
      {status === 'error' && (
        <div style={{ padding: '16px 14px', fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
          X is rate-limiting the live embed right now.{' '}
          <a href={LIST_URL} target="_blank" rel="noopener noreferrer"
            style={{ color: C.green, fontWeight: 600, textDecoration: 'none' }}>
            Open Pit Wire on X ↗
          </a>
        </div>
      )}
    </div>
  );
}
