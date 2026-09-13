'use client';

// PIT WIRE — the trader-facing tape.
//
// Consumes canonical events from /api/wire ONLY. It never touches raw source records, never
// deduplicates (the engine already did, before anything became visible), and never ingests. One
// real-world event is one Pit Wire row, whatever number of outlets reported it.
//
// Delivery is CURSOR POLLING rather than SSE, deliberately. The backend is SSE-ready and the cursor
// shape is identical either way, but on Vercel every open SSE connection pins a serverless instance
// for its whole life and still dies at the function timeout — so a tape left open all session would
// reconnect constantly anyway. A `WHERE seq > cursor` poll is one indexed query that usually returns
// zero rows, costs nothing while idle, survives sleep/suspend, and makes reconnect recovery the
// same code path as the normal tail. Swapping to SSE later needs no change to this component's
// state model.
//
// AI NEVER GATES DISPLAY. Events arrive already normalised and displayable; when Haiku later
// improves one, it arrives on the update channel and is merged onto the SAME row by seq.

import { memo, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { C } from '../lib/cp-shared';
import { EVENT_TYPES, CATEGORIES, SOURCE_GROUPS, CAP_BUCKETS, NOISE_FILTERS, IMPACT } from '../lib/wire-taxonomy.mjs';

const PREF_KEY = 'cp_pitwire_v1';
const MAX_EVENTS = 2000;      // hard ceiling on retained history — bounds memory and DOM
const PAGE = 120;             // rows rendered initially; grows as the trader scrolls
const POLL_ACTIVE = 4000;     // tab visible
const POLL_HIDDEN = 30000;    // tab backgrounded — stay live, stop spending requests
const UPDATE_EVERY = 3;       // enrichment sweep runs every Nth poll, not every poll

// ── time ─────────────────────────────────────────────────────────────────────
// ET with seconds, as a trading tape requires. Formatter built once, not per row.
const ET = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
});
const ET_DAY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' });
const tsOf = (e) => Date.parse(e.published_at || e.first_seen_at || e.received_at) || 0;
const byRecency = (a, b) => (tsOf(b) - tsOf(a)) || (Number(b.seq) - Number(a.seq));

const stamp = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '--:--:--' : ET.format(d); };
const sameETDay = (iso) => { const d = new Date(iso); return !Number.isNaN(d) && ET_DAY.format(d) === ET_DAY.format(new Date()); };

// ── impact styling ───────────────────────────────────────────────────────────
// Readable at a glance, restrained on the page. CRITICAL gets a spine and a solid chip; HIGH a
// quiet outlined chip; MEDIUM and LOW carry no chrome at all so the loud tiers stay loud.
// CRITICAL_RED is a constant, not the themed C.red, on purpose: C.red lightens to #E06B6B in dark
// mode, which would drop white badge text to about 3:1. Pinning the badge ground keeps it at ~7:1
// in both themes, the same reasoning behind the existing greenOnDark constant in cp-shared.
const CRITICAL_RED = '#A83030';
const IMPACT_UI = {
  3: { label: 'CRITICAL', chip: { bg: CRITICAL_RED, fg: '#fff', bd: CRITICAL_RED }, spine: C.red },
  2: { label: 'HIGH', chip: { bg: 'transparent', fg: C.gold, bd: C.gold }, spine: C.gold },
  1: { label: 'MED', chip: null, spine: 'transparent' },
  0: { label: '', chip: null, spine: 'transparent' },
};

const DEFAULTS = {
  preset: 'everything',
  impact: [3, 2, 1, 0],
  categories: CATEGORIES.map((c) => c.key),
  types: EVENT_TYPES.map((t) => t.key),
  groups: SOURCE_GROUPS.map((g) => g.key).concat('other'),
  caps: CAP_BUCKETS.map((b) => b.key),
  capUnknown: true,          // show events whose ticker has no reliable market cap
  tickerMode: 'all',         // 'all' | 'watchlist' | 'specific'
  tickers: [],
  noise: [],                 // noise keys the user has chosen to HIDE
};

const PRESETS = {
  everything: { label: 'Everything', patch: () => ({ ...DEFAULTS, preset: 'everything' }) },
  moving: {
    label: 'Market Moving',
    patch: () => ({ ...DEFAULTS, preset: 'moving', impact: [3, 2], noise: ['lowPr', 'transcripts', 'commentary', 'papers', 'govRoutine'] }),
  },
  smallcap: {
    label: 'Small Cap',
    patch: () => ({ ...DEFAULTS, preset: 'smallcap', impact: [3, 2, 1], caps: ['small', 'micro'], capUnknown: false, noise: ['transcripts', 'papers', 'commentary'] }),
  },
  watchlist: { label: 'My Watchlist', patch: () => ({ ...DEFAULTS, preset: 'watchlist', tickerMode: 'watchlist' }) },
};

const loadPrefs = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(PREF_KEY) || 'null');
    return raw && typeof raw === 'object' ? { ...DEFAULTS, ...raw } : { ...DEFAULTS };
  } catch { return { ...DEFAULTS }; }
};
const savePrefs = (f) => { try { localStorage.setItem(PREF_KEY, JSON.stringify(f)); } catch { /* private mode */ } };

// ── filtering ────────────────────────────────────────────────────────────────
// Pure and synchronous over already-decorated events, so a filter change is instant even against a
// full 2,000-event history. Filtering NEVER affects ingestion — the engine keeps collecting the
// entire firehose no matter what any individual trader chooses to look at.
function passes(ev, f, watch) {
  if (!f.impact.includes(ev.importance ?? 0)) return false;
  if (!f.categories.includes(ev.wireCategory)) return false;
  if (!f.types.includes(ev.wireType)) return false;
  if (!f.groups.includes(ev.wireGroup)) return false;
  if (ev.wireCap) { if (!f.caps.includes(ev.wireCap)) return false; }
  else if (!f.capUnknown) return false;
  if (f.tickerMode === 'watchlist') {
    if (!watch.size || !(ev.tickers || []).some((t) => watch.has(t))) return false;
  } else if (f.tickerMode === 'specific') {
    if (!f.tickers.length || !(ev.tickers || []).some((t) => f.tickers.includes(t))) return false;
  }
  if (f.noise.length && (ev.wireNoise || []).some((n) => f.noise.includes(n))) return false;
  return true;
}

// ── small UI atoms ───────────────────────────────────────────────────────────
function Chip({ on, onClick, children, tone }) {
  return (
    <button onClick={onClick} type="button"
      style={{
        fontSize: 10.5, fontWeight: 600, padding: '3px 8px', borderRadius: 999, cursor: 'pointer',
        border: `1px solid ${on ? (tone || C.green) : C.border2}`,
        background: on ? (tone || C.green) : 'transparent',
        color: on ? '#fff' : C.muted, lineHeight: 1.4, whiteSpace: 'nowrap',
      }}>{children}</button>
  );
}

function Section({ title, right, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.7, color: C.dim, textTransform: 'uppercase' }}>{title}</span>
        {right}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>{children}</div>
    </div>
  );
}

// ── one tape row ─────────────────────────────────────────────────────────────
// Memoised: a poll that appends one event must not re-render the other 1,999.
const Row = memo(function Row({ ev, onPick }) {
  const ui = IMPACT_UI[ev.importance ?? 0] || IMPACT_UI[0];
  const t = ev.published_at || ev.first_seen_at || ev.received_at;
  return (
    <div style={{
      display: 'flex', gap: 8, padding: '5px 9px 5px 7px', alignItems: 'baseline',
      borderBottom: `1px solid ${C.border}`, borderLeft: `3px solid ${ui.spine}`,
      background: ev.importance === 3 ? C.redLight : 'transparent', lineHeight: 1.35,
    }}>
      <span style={{ fontSize: 10.5, color: C.dim, fontVariantNumeric: 'tabular-nums', flexShrink: 0, minWidth: 66 }}
        title={new Date(t).toLocaleString()}>
        {stamp(t)}{!sameETDay(t) && <span style={{ color: C.hint }}> ·{ET_DAY.format(new Date(t))}</span>}
      </span>

      {ui.chip && (
        <span style={{
          fontSize: 8.5, fontWeight: 800, letterSpacing: 0.4, padding: '1px 4px', borderRadius: 3,
          background: ui.chip.bg, color: ui.chip.fg, border: `1px solid ${ui.chip.bd}`, flexShrink: 0,
        }}>{ui.label}</span>
      )}

      {!!(ev.tickers || []).length && (
        <span style={{ flexShrink: 0, display: 'inline-flex', gap: 4 }}>
          {ev.tickers.slice(0, 3).map((tk) => (
            <button key={tk} type="button" onClick={() => onPick?.(tk)}
              style={{ fontSize: 10.5, fontWeight: 800, color: C.green, background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit' }}>
              ${tk}
            </button>
          ))}
        </span>
      )}

      <a href={ev.original_url} target="_blank" rel="noopener noreferrer"
        style={{ fontSize: 12, color: C.text, textDecoration: 'none', flex: 1, minWidth: 0, fontWeight: ev.importance >= 2 ? 600 : 400 }}>
        {ev.headline}
      </a>

      <span style={{ fontSize: 9, color: C.hint, flexShrink: 0, whiteSpace: 'nowrap' }}>
        {ev.wireCategory}
        <span style={{ color: C.border2 }}> · </span>
        {ev.source_name}
        {ev.source_count > 1 && <span style={{ color: C.dim, fontWeight: 700 }}> +{ev.source_count - 1}</span>}
      </span>
    </div>
  );
}, (a, b) => a.ev === b.ev && a.onPick === b.onPick);

// ── filter drawer ────────────────────────────────────────────────────────────
function Filters({ f, set, watchCount, onClose }) {
  const toggle = (key, val) => {
    const cur = f[key];
    const next = cur.includes(val) ? cur.filter((x) => x !== val) : [...cur, val];
    set({ ...f, [key]: next, preset: 'custom' });
  };
  const all = (key, vals) => set({ ...f, [key]: vals, preset: 'custom' });

  return (
    <div style={{ padding: '10px 11px', borderBottom: `1px solid ${C.border}`, background: C.surface, maxHeight: 340, overflowY: 'auto' }}>
      <Section title="Impact">
        {IMPACT.map((i) => (
          <Chip key={i.key} on={f.impact.includes(i.key)} onClick={() => toggle('impact', i.key)}
            tone={i.key === 3 ? C.red : i.key === 2 ? C.gold : C.green}>{i.label}</Chip>
        ))}
      </Section>

      <Section title="Categories" right={
        <button type="button" onClick={() => all('categories', f.categories.length === CATEGORIES.length ? [] : CATEGORIES.map((c) => c.key))}
          style={{ fontSize: 9.5, color: C.green, background: 'none', border: 'none', cursor: 'pointer', fontWeight: 700 }}>
          {f.categories.length === CATEGORIES.length ? 'none' : 'all'}
        </button>}>
        {CATEGORIES.map((c) => <Chip key={c.key} on={f.categories.includes(c.key)} onClick={() => toggle('categories', c.key)}>{c.label}</Chip>)}
      </Section>

      <Section title="Event types" right={
        <button type="button" onClick={() => all('types', f.types.length === EVENT_TYPES.length ? [] : EVENT_TYPES.map((t) => t.key))}
          style={{ fontSize: 9.5, color: C.green, background: 'none', border: 'none', cursor: 'pointer', fontWeight: 700 }}>
          {f.types.length === EVENT_TYPES.length ? 'none' : 'all'}
        </button>}>
        {EVENT_TYPES.map((t) => <Chip key={t.key} on={f.types.includes(t.key)} onClick={() => toggle('types', t.key)}>{t.label}</Chip>)}
      </Section>

      <Section title="Sources">
        {SOURCE_GROUPS.map((g) => <Chip key={g.key} on={f.groups.includes(g.key)} onClick={() => toggle('groups', g.key)}>{g.label}</Chip>)}
        <Chip on={f.groups.includes('other')} onClick={() => toggle('groups', 'other')}>Other</Chip>
      </Section>

      <Section title="Tickers">
        {['all', 'watchlist', 'specific'].map((m) => (
          <Chip key={m} on={f.tickerMode === m} onClick={() => set({ ...f, tickerMode: m, preset: 'custom' })}>
            {m === 'all' ? 'All tickers' : m === 'watchlist' ? `Watchlist (${watchCount})` : 'Specific'}
          </Chip>
        ))}
      </Section>
      {f.tickerMode === 'specific' && (
        <input defaultValue={f.tickers.join(', ')} placeholder="NVDA, AAPL, TSLA"
          onBlur={(e) => set({ ...f, preset: 'custom', tickers: e.target.value.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean) })}
          style={{ width: '100%', marginBottom: 12, fontSize: 11, padding: '5px 7px', borderRadius: 5, border: `1px solid ${C.border2}`, background: C.white, color: C.text, fontFamily: 'inherit' }} />
      )}

      <Section title="Market cap">
        {CAP_BUCKETS.map((b) => <Chip key={b.key} on={f.caps.includes(b.key)} onClick={() => toggle('caps', b.key)}>{b.label}</Chip>)}
        <Chip on={f.capUnknown} onClick={() => set({ ...f, capUnknown: !f.capUnknown, preset: 'custom' })}>Unknown cap</Chip>
      </Section>

      <Section title="Hide noise">
        {NOISE_FILTERS.map((n) => <Chip key={n.key} on={f.noise.includes(n.key)} onClick={() => toggle('noise', n.key)} tone={C.muted}>{n.label}</Chip>)}
      </Section>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 4 }}>
        <button type="button" onClick={() => set({ ...DEFAULTS, preset: 'everything' })}
          style={{ fontSize: 10, color: C.muted, background: 'none', border: `1px solid ${C.border2}`, borderRadius: 5, padding: '3px 9px', cursor: 'pointer' }}>Reset</button>
        <button type="button" onClick={onClose}
          style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: C.green, border: 'none', borderRadius: 5, padding: '4px 12px', cursor: 'pointer' }}>Done</button>
      </div>
    </div>
  );
}

// ── main ─────────────────────────────────────────────────────────────────────
export default function PitWire({ onPick }) {
  const [events, setEvents] = useState([]);
  const [filters, setFilters] = useState(DEFAULTS);
  const [ready, setReady] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [pending, setPending] = useState([]);        // buffered while the trader is scrolled down
  const [visibleCount, setVisibleCount] = useState(PAGE);
  const [watch, setWatch] = useState(new Set());
  const [conn, setConn] = useState('connecting');    // connecting | live | retrying

  const scrollRef = useRef(null);
  const atTopRef = useRef(true);
  const cursorRef = useRef(0);
  const seenRef = useRef(new Set());                 // seq set — the reconnect duplicate guard
  const lastUpdateRef = useRef(null);
  const pollRef = useRef(null);

  // Restore saved configuration before the first paint of rows.
  useEffect(() => { setFilters(loadPrefs()); setReady(true); }, []);
  useEffect(() => { if (ready) savePrefs(filters); }, [filters, ready]);

  // Watchlist comes from the EXISTING /api/watchlist — no competing watchlist is created here.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch('/api/watchlist', { cache: 'no-store' });
        const j = r.ok ? await r.json() : null;
        if (alive && Array.isArray(j)) setWatch(new Set(j.map((x) => String(x.ticker || x).toUpperCase())));
      } catch { /* wire still works without a watchlist */ }
    })();
    return () => { alive = false; };
  }, []);

  // Merge arriving rows. Keyed by seq: a NEW event is prepended, an ENRICHED one replaces the row
  // already on screen. This is what stops an enrichment update becoming a second wire item, and
  // what makes a reconnect that re-delivers an event harmless.
  const merge = useCallback((rows, { live, updatesOnly = false }) => {
    if (!rows?.length) return;
    const fresh = [], updates = new Map();
    for (const r of rows) {
      const seq = Number(r.seq);
      if (seenRef.current.has(seq)) updates.set(seq, r);
      // The enrichment sweep must only refresh rows already on screen. It returns any event
      // improved recently, including ones older than the loaded window, and inserting those would
      // silently grow the tape underneath someone who is reading.
      else if (!updatesOnly) { seenRef.current.add(seq); fresh.push(r); }
      if (!updatesOnly && seq > cursorRef.current) cursorRef.current = seq;
    }
    const applyUpdates = (list) => (updates.size ? list.map((e) => updates.get(Number(e.seq)) || e) : list);

    if (fresh.length && live && !atTopRef.current) {
      // Scrolled down and reading: do NOT move anything under them.
      setPending((p) => [...fresh, ...p]);
      setEvents((prev) => applyUpdates(prev));
      return;
    }
    setEvents((prev) => {
      const next = applyUpdates(prev);
      if (!fresh.length) return next;
      const merged = [...fresh, ...next];
      merged.sort(byRecency);
      return merged.length > MAX_EVENTS ? merged.slice(0, MAX_EVENTS) : merged;
    });
  }, []);

  // Poll loop. One self-scheduling timer, never an interval, so a slow response can't stack
  // requests on top of each other.
  useEffect(() => {
    let alive = true;
    let tick = 0;

    const poll = async () => {
      if (!alive) return;
      const hidden = typeof document !== 'undefined' && document.hidden;
      try {
        const first = cursorRef.current === 0;
        const url = first
          ? `/api/wire?limit=${PAGE}`
          : `/api/wire?since=${cursorRef.current}&limit=200`;
        const r = await fetch(url, { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (!alive) return;
        merge(j.events, { live: !first });
        if (first) lastUpdateRef.current = j.serverTime;
        setConn('live');

        // Enrichment sweep: rows we already hold whose headline/ticker/importance improved.
        if (!first && ++tick % UPDATE_EVERY === 0 && lastUpdateRef.current) {
          const u = await fetch(`/api/wire?updatedSince=${encodeURIComponent(lastUpdateRef.current)}&limit=200`, { cache: 'no-store' });
          if (u.ok && alive) {
            const uj = await u.json();
            merge(uj.events, { live: false, updatesOnly: true });
            lastUpdateRef.current = uj.serverTime;
          }
        }
      } catch {
        if (alive) setConn('retrying');   // the next tick retries; the cursor makes it a resume
      }
      if (alive) pollRef.current = setTimeout(poll, hidden ? POLL_HIDDEN : POLL_ACTIVE);
    };

    poll();
    // Coming back from a backgrounded tab re-polls at once, so the gap closes immediately rather
    // than after the next scheduled tick.
    const wake = () => { if (!document.hidden) { clearTimeout(pollRef.current); poll(); } };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    return () => { alive = false; clearTimeout(pollRef.current); document.removeEventListener('visibilitychange', wake); window.removeEventListener('online', wake); };
  }, [merge]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atTopRef.current = el.scrollTop <= 6;
    if (atTopRef.current && pending.length) flush();
    // Grow the render window as they reach the bottom instead of mounting everything up front.
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 240) setVisibleCount((n) => n + PAGE);
  };

  const flush = () => {
    setPending((p) => {
      if (!p.length) return p;
      setEvents((prev) => {
        const merged = [...p, ...prev];
        merged.sort(byRecency);
        return merged.length > MAX_EVENTS ? merged.slice(0, MAX_EVENTS) : merged;
      });
      return [];
    });
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    atTopRef.current = true;
  };

  const shown = useMemo(() => events.filter((e) => passes(e, filters, watch)), [events, filters, watch]);
  const windowed = useMemo(() => shown.slice(0, visibleCount), [shown, visibleCount]);
  const pendingShown = useMemo(() => pending.filter((e) => passes(e, filters, watch)).length, [pending, filters, watch]);

  const applyPreset = (key) => {
    const p = PRESETS[key];
    if (p) { setFilters(p.patch()); setVisibleCount(PAGE); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.white, minHeight: 0 }}>
      {/* header: presets + filters + connection */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', borderBottom: `1px solid ${C.border}`, flexShrink: 0, flexWrap: 'wrap' }}>
        {Object.entries(PRESETS).map(([k, p]) => (
          <button key={k} type="button" onClick={() => applyPreset(k)}
            style={{
              fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 5, cursor: 'pointer',
              border: `1px solid ${filters.preset === k ? C.green : C.border2}`,
              background: filters.preset === k ? C.green : 'transparent',
              color: filters.preset === k ? '#fff' : C.muted, whiteSpace: 'nowrap',
            }}>{p.label}</button>
        ))}
        {filters.preset === 'custom' && (
          <span style={{ fontSize: 10, fontWeight: 700, color: C.gold, border: `1px solid ${C.gold}`, borderRadius: 5, padding: '3px 8px' }}>Custom</span>
        )}
        <button type="button" onClick={() => setShowFilters((v) => !v)}
          style={{
            marginLeft: 'auto', fontSize: 10, fontWeight: 700, padding: '3px 9px', borderRadius: 5,
            cursor: 'pointer', border: `1px solid ${showFilters ? C.green : C.border2}`,
            background: showFilters ? C.green : 'transparent', color: showFilters ? '#fff' : C.muted,
          }}>FILTERS</button>
        <span title={conn === 'live' ? 'Live' : 'Reconnecting — missed events will be recovered'}
          style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: conn === 'live' ? C.greenMid : conn === 'retrying' ? C.gold : C.border2 }} />
      </div>

      {showFilters && <Filters f={filters} set={(v) => { setFilters(v); setVisibleCount(PAGE); }} watchCount={watch.size} onClose={() => setShowFilters(false)} />}

      {/* new-event indicator — only appears when they are scrolled away from the top */}
      {pendingShown > 0 && (
        <button type="button" onClick={flush}
          style={{
            position: 'absolute', top: showFilters ? 'auto' : 38, left: '50%', transform: 'translateX(-50%)',
            zIndex: 5, fontSize: 10.5, fontWeight: 800, letterSpacing: 0.3, color: '#fff', background: C.green,
            border: 'none', borderRadius: 999, padding: '4px 13px', cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
          }}>
          ↑ {pendingShown} NEW EVENT{pendingShown === 1 ? '' : 'S'}
        </button>
      )}

      <div ref={scrollRef} onScroll={onScroll} style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {!events.length ? (
          <div style={{ padding: '22px 14px', textAlign: 'center', fontSize: 12, color: C.dim }}>
            {conn === 'retrying' ? 'Reconnecting to the wire…' : 'Connecting to the wire…'}
          </div>
        ) : !shown.length ? (
          <div style={{ padding: '22px 14px', textAlign: 'center', fontSize: 12, color: C.dim, lineHeight: 1.6 }}>
            No events match your filters.<br />
            <span style={{ fontSize: 11, color: C.hint }}>The wire is still collecting everything — this only changes your view.</span>
          </div>
        ) : (
          windowed.map((ev) => <Row key={ev.seq} ev={ev} onPick={onPick} />)
        )}
      </div>

      <div style={{ padding: '3px 9px', borderTop: `1px solid ${C.border}`, fontSize: 9.5, color: C.hint, display: 'flex', justifyContent: 'space-between', flexShrink: 0 }}>
        <span>{shown.length.toLocaleString()} shown · {events.length.toLocaleString()} held</span>
        <span>Catalyst Pit canonical events</span>
      </div>
    </div>
  );
}
