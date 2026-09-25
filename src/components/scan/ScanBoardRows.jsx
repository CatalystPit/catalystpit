'use client';

// PIT SCAN — THE COMPACT ROW.
//
// ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
//
// Not the Consensus card. Consensus answers "what does the public evidence say about this
// company"; Scan answers "what is moving, and why". Reproducing the card here would make Scan a
// worse Consensus and give a trader two places to read the same thing.
//
// So the row is deliberately four lines and a pair of facts:
//
//   TICKER  $last  ±%  [freshness]
//   STRUCTURE   daily tags, or —
//   EVIDENCE    one line, at most two clauses
//   JOIN        what price is doing about the evidence
//   · fact      · fact
//
// ⚠️ FORBIDDEN ON THIS ROW, and asserted in the suite: any score, an alignment percentage, a
// confidence word, a Bullish/Bearish headline, family soup ("Insiders Positive · Institutions
// Positive · …"), 13F occupancy ("116 funds hold this"), and RVOL. RVOL in particular cannot exist
// here: there is no consolidated volume on this feed, and a ratio against a different methodology
// would be a fabrication rather than a missing number.
//
// ⚠️ AND THE FRESHNESS IS ALWAYS VISIBLE — IN WHICHEVER DIRECTION IS TRUE. Realtime is entitled
// now, so a row's price may be a live consolidated print or the last completed session's close,
// and the row says which. A board called "Moving Now" that hid either would be telling a trader
// something untrue at the moment they act: stale prices passed off as current, or — the failure
// that actually shipped — current prices disclaimed as delayed.

import { useCallback, useEffect, useState } from 'react';
import { C, Badge, TickerLogo } from '../../lib/cp-shared';
import { inspectEvidence, evidenceInspectorAvailable } from '../../lib/terminalEvidenceBus';

const BOARD_TABS = [
  // ⚠️ THE BLURB NO LONGER NAMES A CLOCK, AND THAT IS THE POINT. It used to read "on the last
  // completed session", which was true while realtime was unentitled and became a false claim the
  // day it was not — printed directly beneath a banner saying LIVE. A static subtitle cannot know
  // what the feed delivered; the banner and the per-row badges can, and they do. So the subtitle
  // says what the board SELECTS and leaves what it is PRICED FROM to the two places that measure it.
  { key: 'moving-now', label: 'Moving Now',
    blurb: 'A meaningful move, with the evidence that explains it.' },
  { key: 'catalysts-now', label: 'Evidence Now',
    blurb: 'Fresh material filings and unusual activity. Price may be flat — timing comes from the filing.' },
  { key: 'divergence', label: 'Divergence',
    blurb: 'Meaningful evidence and a meaningful move pointing opposite ways. The gate is deliberately tight.' },
];

/**
 * THE FEED BANNER — one component, used by the Terminal panel and any page wrapper.
 *
 * ── ⚠️ IT HAD NO LIVE STATE, AND THAT BECAME THE BUG ────────────────────────
 *
 * This was two states — DELAYED or LAST CLOSE — written when Tiingo commercial realtime was not
 * entitled, on the reasoning that a LIVE branch could only ever be wrong. The entitlement is on
 * now, and the missing branch inverted: there was no input for which this banner could tell the
 * truth to an entitled reader. A fully live board fell through to "Last completed session — not
 * live quotes", and a board with one unpriced row among twenty-five reported 'near', which read
 * as "Delayed quotes — not live" over a screen of live consolidated prices.
 *
 * ⚠️ THE STATE COMES FROM THE SERVED ROWS, NOT FROM THE ENTITLEMENT. aggregateFreshness reads the
 * freshness the rows actually carry, so LIVE appears only when live prices were delivered. Being
 * entitled to realtime and receiving it are different facts, and only the second one may be
 * announced. A Free reader's rows are 'eod' or 'delayed' and this renders exactly as it always did.
 */
const FEED_STATE = {
  realtime: { label: 'REAL-TIME', text: 'Real-time consolidated quotes.' },
  near: { label: 'REAL-TIME', text: 'Real-time consolidated quotes, seconds behind the tape.' },
  // ⚠️ THE BANNER DESCRIBES THE SERVICE; THE ROW BADGES DESCRIBE THE PRICES.
  //
  // This said PARTLY LIVE, which is accurate as arithmetic over the rows and wrong as a description
  // of the product: a working real-time feed reported as half-broken because one ADR of twenty-five
  // had not traded yet. A board drawn from the entitled consolidated feed is real-time. That a
  // particular symbol has no current print is a fact about that symbol, and its own badge says so —
  // which is why the sentence here points at them rather than hiding them.
  mixed: { label: 'REAL-TIME', text: 'Real-time quotes where available. Each row shows its price status.' },
  delayed: { label: 'DELAYED', text: 'Delayed quotes — not live.' },
  eod: { label: 'LAST CLOSE', text: 'Last completed session — not live quotes.' },
};

export function FeedBanner({ freshness, compact = false }) {
  // An unknown or absent freshness is not a live one.
  const state = FEED_STATE[freshness] || FEED_STATE.eod;
  const { label, text } = state;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      padding: compact ? '5px 8px' : '8px 12px', borderRadius: 6,
      background: C.surface, border: `1px solid ${C.border2}`,
      fontSize: compact ? 10.5 : 11.5, color: C.muted, marginBottom: compact ? 9 : 16,
    }}>
      <Badge>{label}</Badge>
      <span>{text}</span>
      {!compact && (
        <span style={{ color: C.dim }}>
          Evidence timing is unaffected — filings are timestamped from public availability.
        </span>
      )}
    </div>
  );
}

/**
 * THE EVIDENCE ACTION.
 *
 * ⚠️ IT DECIDES AT CLICK TIME, NOT AT RENDER TIME, AND THAT IS DELIBERATE. Whether an inspector is
 * listening is a fact about the page, and the row renders before the Terminal has finished
 * subscribing. Reading it during render would leave the first paint of a Terminal board holding
 * plain links; reading it in the handler means the answer is whatever is true at the moment the
 * trader clicks.
 *
 * It stays an anchor either way — middle-click, copy-link and open-in-new-tab keep working, and a
 * trader who WANTS the full ticker page can still get it from this control without the panel.
 */
function EvidenceAction({ ticker, href }) {
  return (
    <a href={href}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;   // let the browser have it
        if (!evidenceInspectorAvailable()) return;                            // /scan: navigate as before
        e.preventDefault();
        inspectEvidence(ticker);
      }}
      style={{ fontSize: 10.5, fontWeight: 700, color: C.green, textDecoration: 'none' }}>Evidence</a>
  );
}

const JOIN_TONE = {
  'PRICE CONFIRMING': C.green,
  'PRICE DIVERGING': C.conflictAccent,
  'PRICE SELLING OFF': C.red,
  'CONFLICT + MOVING': C.conflictAccent,
  'NO REACTION': C.muted,
  // Neutral on purpose. "We have not matched this to evidence" is a statement about our coverage,
  // not a judgement on the stock, and colouring it like a conflict would read as one.
  'NO MATCHING EVIDENCE': C.dim,
  // A recovered public item. Neutral-positive: it is an attribution, not a verdict on direction.
  'MATCHING CATALYST': C.blue,
  'RECENT RELEVANT CATALYST': C.blue,
  // We looked and found nothing. Dim, because it reports our coverage rather than the stock.
  'NO PUBLIC CATALYST IDENTIFIED': C.dim,
  'REACTION UNAVAILABLE': C.dim,
  '—': C.dim,
};

function Row({ r, onWatch, onAlert, busy, onPick }) {
  const up = Number.isFinite(r.changePct) && r.changePct > 0;
  const moveColor = !Number.isFinite(r.changePct) ? C.dim : up ? C.green : C.red;

  // ⚠️ THE SAME ROW SERVES A PAGE AND A TERMINAL PANEL, AND THE TICKER MEANS SOMETHING DIFFERENT
  // IN EACH. On /scan there is nowhere to sync to, so the symbol is a link to the ticker page and
  // must stay one. Inside the Terminal the panels are wired together, so the symbol should drive
  // the linked chart rather than navigate the whole workspace away from it.
  //
  // It stays an <a> with a real href either way — middle-click, "open in new tab" and a
  // screen reader all keep working — and `onPick` merely intercepts the plain left click. A
  // button would have thrown that away to save nothing.
  const pickTicker = (e) => {
    if (!onPick) return;                       // /scan: let the link do what a link does
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    onPick(r.ticker);
  };

  return (
    <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 8,
      padding: '10px 12px' }}>
      {/* IDENTITY + PRICE, with the freshness of that price beside it. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <TickerLogo symbol={r.ticker} size={20} />
        <a href={`/ticker/${encodeURIComponent(r.ticker)}`} className="cp-tkr"
          onClick={pickTicker}
          title={onPick ? `Load ${r.ticker} in the linked Terminal panels` : undefined}
          style={{ fontSize: 13.5, fontWeight: 800, color: C.ink, textDecoration: 'none' }}>{r.ticker}</a>
        <span style={{ fontSize: 12.5, color: C.text, fontVariantNumeric: 'tabular-nums' }}>
          {/* ⚠️ TWO DECIMALS TURNS A REAL SUB-PENNY PRICE INTO "$0.00". ADTX last traded at
              $0.0046 and the card printed $0.00 beside a percentage move — a row stating a price
              of zero for a security that has one. Sub-dollar prices keep the digits that carry
              their value; a dollar and above is unchanged at two decimals. Nothing is rounded INTO
              existence: a null price is still an em dash. */}
          {Number.isFinite(r.last)
            ? `$${r.last >= 1 ? r.last.toFixed(2) : r.last.toPrecision(2)}`
            : '—'}
        </span>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: moveColor, fontVariantNumeric: 'tabular-nums' }}>
          {Number.isFinite(r.changePct) ? `${up ? '+' : ''}${r.changePct.toFixed(1)}%` : '—'}
        </span>
        {/* Never hidden, never abbreviated away. */}
        {r.freshnessLabel && (
          <Badge size="xs">{r.freshnessLabel}</Badge>
        )}
      </div>

      {/* ⚠️ A FIELD IS PRINTED ONLY WHEN IT HAS SOMETHING TO SAY.
          Every row used to render all three labels, so a price-first mover with no filing behind it
          read "STRUCTURE —  EVIDENCE —  JOIN NO REACTION": three lines, none of them informative
          and one of them false. An empty field advertises what we do not have. The JOIN line stays
          on every row because it is never empty — with no evidence it now says so explicitly. */}
      <div style={{ display: 'grid', gridTemplateColumns: '78px 1fr', gap: '2px 8px', marginTop: 7 }}>
        {r.structure?.length > 0 && (
          <>
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.6px', color: C.dim, paddingTop: 2 }}>STRUCTURE</span>
            <span style={{ fontSize: 11.5, color: C.text }}>{r.structure.join(' · ')}</span>
          </>
        )}

        {r.evidence && (
          <>
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.6px', color: C.dim, paddingTop: 2 }}>EVIDENCE</span>
            <span style={{ fontSize: 11.5, color: C.text, overflowWrap: 'anywhere' }}>{r.evidence}</span>
          </>
        )}

        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.6px', color: C.dim, paddingTop: 2 }}>JOIN</span>
        <span style={{ fontSize: 11.5, fontWeight: 700, color: JOIN_TONE[r.join] || C.muted }}>
          {r.join}
        </span>
      </div>

      {r.facts?.length > 0 && (
        <div style={{ marginTop: 5 }}>
          {r.facts.map((f, i) => (
            <div key={i} style={{ fontSize: 11, color: C.muted, lineHeight: 1.4 }}>· {f}</div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <a href={`/ticker/${encodeURIComponent(r.ticker)}#chart`}
          style={{ fontSize: 10.5, fontWeight: 700, color: C.muted, textDecoration: 'none' }}>Chart</a>
        {/* Into the existing evidence experience — Scan never becomes a second evidence viewer.
            ⚠️ AND INSIDE THE TERMINAL IT DOES NOT NAVIGATE. Leaving the workspace to find out why a
            row is on the board costs a trader every other panel they had arranged, which is a high
            price for a question the scanner itself provoked. Where an inspector is listening, this
            opens it; where there is none — the public /scan page — it stays the link it always was.
            The row asks the bus rather than being told by each of its two callers, so a third
            caller cannot get it wrong by omission. */}
        <EvidenceAction ticker={r.ticker} href={r.evidenceUrl || `/ticker/${encodeURIComponent(r.ticker)}`} />
        <button type="button" onClick={() => onWatch(r.ticker)} disabled={busy === r.ticker}
          style={{ fontSize: 10.5, fontWeight: 700, color: C.muted, background: 'none', border: 'none',
            padding: 0, cursor: 'pointer', fontFamily: 'inherit' }}>Watch</button>
        <button type="button" onClick={() => onAlert(r.ticker)} disabled={busy === r.ticker}
          style={{ fontSize: 10.5, fontWeight: 700, color: C.muted, background: 'none', border: 'none',
            padding: 0, cursor: 'pointer', fontFamily: 'inherit' }}>Alert</button>
      </div>
    </div>
  );
}


/**
 * ⚠️ HOW LONG A PIT SCAN REQUEST MAY TAKE BEFORE THE CLIENT STOPS WAITING.
 *
 * NOT a way to hide a slow server — the server-side causes are fixed separately, and this is longer
 * than the route's own ceiling so it can only fire when something has genuinely gone wrong upstream
 * of it. Its whole job is to guarantee that "Loading Pit Scan…" ends.
 */
const REQUEST_TIMEOUT_MS = 25_000;
/** Evidence moves on filing cadence, not tick cadence. */
const POLL_MS = 120_000;

/**
 * ALL THREE BOARDS, FETCHED ONCE.
 *
 * ── ⚠️ THE THREE FAILURES THIS HOOK EXISTS TO END ───────────────────────────
 *
 * 1. A TAB CLICK COST A ROUND TRIP. Each board was its own request, and the request repeated the
 *    entitlement, the published-board read and a hundred vendor quotes to produce another view of
 *    the same hundred tickers. Switching tabs is now a local state change.
 *
 * 2. "LOADING PIT SCAN…" COULD NEVER END. The old effect did `r.ok ? await r.json() : null` and
 *    then set state to that — so a 503 or a timed-out function set state back to NULL, and null IS
 *    the loading state. The panel sat on "Loading Pit Scan…" forever while its own header, reading
 *    the same null through `state?.freshnessLabel || 'LAST CLOSE'`, looked perfectly resolved.
 *    That is the exact screenshot that was reported. Every request now ends in data, an empty
 *    board, or an explicit retryable error — never back in loading.
 *
 * 3. A BACKGROUND REFRESH BLANKED A WORKING BOARD. A failed poll replaced good data with the
 *    loading screen. Data is only ever replaced by NEWER DATA; a failed refresh leaves what is on
 *    screen alone and says so quietly.
 */
export function useScanBoards() {
  const [boards, setBoards] = useState(null);
  const [error, setError] = useState(null);
  const [stale, setStale] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    // ⚠️ ONE GENERATION PER MOUNT. A response from a superseded effect must not land on the state of
    // the one that replaced it — the race that shows a board the user has already navigated away
    // from, and the one that can resurrect a loading state after a good load.
    const load = async (isRefresh) => {
      try {
        const r = await fetch('/api/scan-board?board=all', {
          cache: 'no-store',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        // ⚠️ A NON-JSON BODY IS A FAILURE, NOT A CRASH. A timed-out serverless function answers with
        // an HTML error page, and .json() throws on it — which is how this path used to end up in
        // the catch with no state at all.
        const j = await r.json().catch(() => null);
        if (!alive) return;
        if (!r.ok || !j || !j.boards) {
          // Keep whatever is already on screen; only say so.
          setStale(true);
          if (!isRefresh) setError(j?.message || 'Pit Scan is unavailable right now.');
          return;
        }
        setBoards(j.boards);
        setError(null);
        setStale(false);
      } catch (e) {
        if (!alive) return;
        setStale(true);
        // ⚠️ AND AN ERROR WITH NO DATA BEHIND IT MUST BE AN ERROR, NOT A SPINNER.
        if (!isRefresh) setError(e?.name === 'TimeoutError' ? 'Pit Scan took too long to respond.' : 'Pit Scan is unavailable right now.');
      }
    };
    load(false);
    const id = setInterval(() => load(true), POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [nonce]);

  const retry = useCallback(() => { setError(null); setNonce((n) => n + 1); }, []);
  // Loading is the ONLY state with neither data nor an error, and it can only be reached before the
  // first response. Nothing sets boards back to null.
  return { boards, error, stale, loading: boards === null && error === null, retry };
}

/**
 * ONE BOARD. Used on its own by /scan (three stacked) and behind tabs in the Terminal panel.
 * There is exactly one Row design and one fetch path; the two surfaces differ only in arrangement.
 *
 * ⚠️ IT NO LONGER FETCHES. The data arrives as a prop from useScanBoards, which is what makes a tab
 * switch local. A component that fetched per board could not be shown three-up on /scan or behind
 * tabs in the Terminal without paying for the same dataset once per view.
 */
export function ScanBoard({ board, data, loading = false, errorText = null, onRetry, title, onState, onPick }) {
  const [busy, setBusy] = useState(null);
  const [toast, setToast] = useState(null);
  const state = data || null;
  const error = errorText || (state?.degraded === true ? (state.message || true) : null);

  // The page-level banner needs the feed state, and it must come from the response rather than from
  // an assumption made in the page.
  useEffect(() => { if (state && onState) onState(state); }, [state, onState]);

  const watch = async (ticker) => {
    setBusy(ticker);
    try {
      const r = await fetch('/api/watchlist', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticker }) });
      const j = await r.json().catch(() => ({}));
      setToast(r.ok ? `${ticker} added to watchlist` : (j.error || 'Could not add'));
    } catch { setToast('Could not add'); } finally { setBusy(null); setTimeout(() => setToast(null), 2500); }
  };

  const alert = async (ticker) => {
    setBusy(ticker);
    try {
      // `news` needs no threshold and is event-driven, which is the honest default from a scan row:
      // an RVOL alert would be meaningless here because there is no live volume to trigger it.
      const r = await fetch('/api/alerts', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: ticker, type: 'news' }) });
      setToast(r.ok ? `Alert set on ${ticker}` : 'Could not set alert');
    } catch { setToast('Could not set alert'); } finally { setBusy(null); setTimeout(() => setToast(null), 2500); }
  };

  const rows = state?.rows || [];

  return (
    <div style={{ fontFamily: "'DM Sans',sans-serif" }}>
      {title && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.6px', color: C.ink }}>
            {title.toUpperCase()}
          </span>
          {state && (
            <span style={{ fontSize: 10.5, color: C.dim }}>
              {rows.length} {rows.length === 1 ? 'name' : 'names'}
            </span>
          )}
        </div>
      )}

      {/* ⚠️ THREE TERMINAL STATES, AND LOADING IS NOT ONE OF THEM ONCE DATA HAS ARRIVED.
          Data, a legitimately empty board, or an explicit retryable error. The old version had a
          fourth path that was none of these: a failed response set state to null, and null rendered
          as "Loading Pit Scan…" — forever, and through every subsequent poll. */}
      {error && !state ? (
        // An unavailable board is not a quiet market and must never render as one.
        <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 8,
          padding: '20px 16px', fontSize: 12.5, color: C.muted }}>
          {typeof error === 'string' ? error : 'Pit Scan is unavailable right now. This is not a statement that nothing is happening.'}
          {onRetry && (
            <button type="button" onClick={onRetry}
              style={{ display: 'block', marginTop: 10, fontSize: 11, fontWeight: 700, cursor: 'pointer',
                padding: '4px 12px', borderRadius: 999, fontFamily: 'inherit',
                border: `1px solid ${C.border2}`, background: C.white, color: C.text }}>Try again</button>
          )}
        </div>
      ) : loading && !state ? (
        <div style={{ fontSize: 12, color: C.muted, padding: 16 }}>Loading Pit Scan…</div>
      ) : !state ? (
        // ⚠️ NEITHER DATA, NOR LOADING, NOR AN ERROR IS NOT A STATE TO SIT IN SILENTLY.
        <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 8,
          padding: '20px 16px', fontSize: 12.5, color: C.muted }}>
          Pit Scan is unavailable right now.
          {onRetry && (
            <button type="button" onClick={onRetry}
              style={{ display: 'block', marginTop: 10, fontSize: 11, fontWeight: 700, cursor: 'pointer',
                padding: '4px 12px', borderRadius: 999, fontFamily: 'inherit',
                border: `1px solid ${C.border2}`, background: C.white, color: C.text }}>Try again</button>
          )}
        </div>
      ) : rows.length === 0 ? (
        <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 8,
          padding: '20px 16px', fontSize: 12.5, color: C.muted }}>
          Nothing currently qualifies for this board.
          {state.rejected?.length > 0 && (
            <div style={{ fontSize: 11, color: C.dim, marginTop: 6 }}>
              {state.rejected.length} candidates were considered and did not meet the threshold.
            </div>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map((r) => (
            <Row key={r.ticker} r={r} onWatch={watch} onAlert={alert} busy={busy} onPick={onPick} />
          ))}
        </div>
      )}

      {toast && (
        <div style={{ marginTop: 8, fontSize: 11, color: C.muted }}>{toast}</div>
      )}
    </div>
  );
}

/**
 * THE TERMINAL ARRANGEMENT — the same boards behind tabs, because a panel has one board's worth of
 * height. /scan stacks all three instead. Same component, same API, same row.
 */
export default function ScanBoardRows({ onPick, onFeed } = {}) {
  const [board, setBoard] = useState('catalysts-now');
  // ⚠️ ALL THREE ARRIVE TOGETHER, SO A TAB IS A LOCAL STATE CHANGE. It used to be a fetch, and the
  // fetch repeated every expensive thing the first one had already done.
  const { boards, error, stale, loading, retry } = useScanBoards();
  const current = boards?.[board] || null;
  // The banner reads the freshness of the board being shown, from the response that carried it.
  const feed = current?.freshness ?? null;
  // ⚠️ AND THE PANEL ABOVE READS IT FROM HERE. One request knows the answer; the header should not
  // make a second one to find out, which is what let the two disagree.
  useEffect(() => { if (onFeed) onFeed(current?.freshnessLabel ?? null); }, [current, onFeed]);

  return (
    <div style={{ fontFamily: "'DM Sans',sans-serif" }}>
      {/* Stated at the top of the panel, and again on every row. */}
      <FeedBanner freshness={feed} compact />
      {/* ⚠️ A FAILED REFRESH DOES NOT BLANK A WORKING BOARD — it says so, over the data it could not
          replace. Replacing good rows with a spinner is how a working product looks broken. */}
      {stale && boards && (
        <div style={{ fontSize: 10.5, color: C.dim, marginBottom: 6 }}>
          Showing the last successful load — the latest refresh did not complete.
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
        {BOARD_TABS.map((t) => (
          <button key={t.key} type="button" onClick={() => setBoard(t.key)}
            style={{ fontSize: 11, fontWeight: board === t.key ? 700 : 500, cursor: 'pointer',
              padding: '4px 10px', borderRadius: 999, fontFamily: 'inherit',
              border: `1px solid ${board === t.key ? C.green : C.border}`,
              background: board === t.key ? C.greenLight : C.white,
              color: board === t.key ? C.green : C.muted }}>
            {t.label}
          </button>
        ))}
      </div>
      <div style={{ fontSize: 10.5, color: C.muted, marginBottom: 10, lineHeight: 1.45 }}>
        {BOARD_TABS.find((t) => t.key === board)?.blurb}
      </div>

      <ScanBoard board={board} data={current} loading={loading} errorText={error} onRetry={retry} onPick={onPick} />
    </div>
  );
}

export { BOARD_TABS };
