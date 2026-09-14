// Persistence for the normalized primary-source stream. Owns every write to primary_events and
// feed_state; src/lib/primary-sources.mjs stays pure.

import { db } from './db';
import { sql } from 'drizzle-orm';
import { FEEDS, PENDING, activeFeeds, fetchFeed, normalize, TICKERABLE, categoryOf, importanceOf, contentHash, companyPhrases, isTickerableSource } from './primary-sources.mjs';
import { resolveIssuerItems } from './name-resolver';
import { canonicalUrl, eventKey, factKey, findCluster, normHash, PROXIMITY_MS } from './event-cluster.mjs';
import { canonicalHeadline, factSignature, entityToken, scoreImportance, isDisplayable } from './news-normalize.mjs';
import { generateBatch, validateHeadline, validateFacts, BATCH_SIZE } from './headline-writer.mjs';
import { TRUSTED_SOURCES, TRUSTED_REWRITE_ATTEMPTS } from './trusted-sources.mjs';

// The trusted list as a Postgres array LITERAL with an explicit cast, matching how every other
// array is bound in this file. Passing the JS array straight into any() leaves the parameter
// untyped and the query fails at parse time.
const TRUSTED = `{${[...TRUSTED_SOURCES].join(',')}}`;

// Two unique constraints guard the table: (source, source_uid) for the same item seen twice, and
// content_hash for the same event arriving on two different feeds. Both are DO NOTHING, so a
// re-poll is free and an overlapping feed cannot double-post.
export async function insertEvents(events) {
  if (!events?.length) return 0;
  let written = 0;
  // One statement per event. Volumes are tens of items per pass and almost all conflict away, so
  // the simplicity is worth more than batching, and every value stays properly bound.
  //
  // Ingestion stores the item verbatim and resolves its cluster, both synchronously — so an event
  // is deduped before it can ever be displayed. Extraction and headline rewriting happen afterwards
  // in runEnrichment(), which is why an LLM outage can never delay or lose capture.
  for (const e of events) {
    const res = await db.execute(sql`
      insert into primary_events (source, source_name, source_kind, source_type, source_uid,
        headline, source_headline, summary, published_at, original_url, canonical_url, tickers,
        category, importance, content_hash, headline_status, pipeline_status, event_key,
        fact_key, fact_sig, norm_hash, display_hash, entity, display_ready, first_seen_at, last_seen_at,
        cluster_id, raw)
      values (${e.source}, ${e.source_name ?? e.source}, ${e.source_kind ?? 'external'},
        ${e.source_type}, ${e.source_uid}, ${e.headline}, ${e.source_headline ?? e.headline},
        ${e.summary ?? null}, ${e.published_at ?? null}::timestamptz, ${e.original_url},
        ${e.canonical_url ?? null},
        ${`{${(e.tickers || []).join(',')}}`}::text[], ${e.category ?? null},
        ${e.importance ?? 0}::smallint, ${e.content_hash},
        ${e.headline_status ?? 'pending'}, ${e.pipeline_status ?? 'pending'},
        ${e.event_key ?? null},
        -- Deterministic dedupe keys, computed at ingest so layers 2-4 are indexed equality checks.
        ${e.fact_key ?? null}, ${e.fact_sig ?? null}, ${e.norm_hash ?? null},
        -- normHash of the DISPLAY headline — the words the trader actually reads, which is what
        -- must never appear twice. Rewritten again whenever enrichment changes the headline.
        ${e.display_hash ?? null}, ${e.entity ?? null},
        ${e.display_ready ?? true}, now(), now(),
        -- NULL = this row is the canonical event. Set = it folded into an existing one. Decided
        -- by the INSERT itself, so a row is never visible without its cluster already resolved.
        ${e.cluster_id ?? null}::bigint,
        ${JSON.stringify(e.raw ?? {})}::jsonb)
      on conflict do nothing
      returning seq, cluster_id`);
    const row = (res.rows ?? res)?.[0];
    if (!row) continue;                       // conflicted away: already had this exact item
    written++;
    e._seq = row.seq;
    // A duplicate folded into an existing event bumps that event's source count. The raw row stays
    // in the table either way; only the canonical view collapses it.
    if (e.cluster_id) {
      // The canonical event learns from its duplicates: another source corroborating it, the time
      // it was most recently reported, and a ticker or figure this member resolved that the head
      // did not have. The head's own headline and provenance are never overwritten.
      await db.execute(sql`
        update primary_events
           set source_count = source_count + 1,
               last_seen_at = now(),
               tickers = case when cardinality(tickers) = 0
                              then ${`{${(e.tickers || []).join(',')}}`}::text[] else tickers end,
               fact_sig = coalesce(nullif(fact_sig, ''), ${e.fact_sig ?? null}),
               fact_key = coalesce(fact_key, ${e.fact_key ?? null}),
               importance = greatest(importance, ${e.importance ?? 0}::smallint),
               display_ready = display_ready or ${e.display_ready ?? true}
         where seq = ${e.cluster_id}`);
    }
  }
  return written;
}

export async function getFeedState(key) {
  const res = await db.execute(sql`select * from feed_state where feed_key = ${key}`);
  return (res.rows ?? res)[0] || null;
}

// One read for every feed. The cron runs each minute, so ten individual SELECTs per pass would be
// ~14k pointless round trips a day; this is one.
export async function allFeedState() {
  const res = await db.execute(sql`select * from feed_state`);
  const map = new Map();
  for (const r of res.rows ?? res) map.set(r.feed_key, r);
  return map;
}

export async function saveFeedState(key, patch) {
  await db.execute(sql`
    insert into feed_state (feed_key, etag, last_modified, last_polled_at, last_success_at,
      last_status, consecutive_failures, events_seen, note)
    values (${key}, ${patch.etag ?? null}, ${patch.lastModified ?? null}, now(),
      ${patch.ok ? sql`now()` : sql`null`}, ${patch.status ?? null},
      ${patch.ok ? 0 : 1}, ${patch.seen ?? 0}, ${patch.note ?? null})
    on conflict (feed_key) do update set
      etag = coalesce(excluded.etag, feed_state.etag),
      last_modified = coalesce(excluded.last_modified, feed_state.last_modified),
      last_polled_at = now(),
      last_success_at = case when ${!!patch.ok} then now() else feed_state.last_success_at end,
      last_status = excluded.last_status,
      -- A failing feed backs itself off through isDue(); it never blocks the others.
      consecutive_failures = case when ${!!patch.ok} then 0 else feed_state.consecutive_failures + 1 end,
      events_seen = feed_state.events_seen + ${patch.seen ?? 0},
      -- Metered APIs count every call that actually left the building, reset on the UTC day
      -- boundary. Kept here rather than in Redis so polling never costs a cache command.
      quota_used = case when ${!!patch.metered}
                        then (case when feed_state.quota_date = current_date
                                   then feed_state.quota_used else 0 end) + 1
                        else feed_state.quota_used end,
      quota_date = case when ${!!patch.metered} then current_date else feed_state.quota_date end,
      note = excluded.note`);
}

// Exponential backoff on repeated failure, capped, so a dead feed costs one request an hour rather
// than one a minute, and a healthy feed is unaffected.
function isDue(feed, state) {
  // A metered API stops for the rest of the UTC day once its free allowance is spent. Checked
  // before anything else so an exhausted key costs zero requests rather than a stream of 402s.
  if (feed.quotaPerDay) {
    const today = new Date().toISOString().slice(0, 10);
    const used = String(state?.quota_date ?? '').slice(0, 10) === today ? Number(state.quota_used) || 0 : 0;
    if (used >= feed.quotaPerDay) return false;
  }
  if (!state?.last_polled_at) return true;
  const fails = Number(state.consecutive_failures) || 0;
  const backoff = fails ? Math.min(2 ** fails, 60) : 1;
  const dueMs = feed.everySec * 1000 * backoff;
  return Date.now() - new Date(state.last_polled_at).getTime() >= dueMs;
}


// Tickers a source did not state. Two independent gates: the headline must yield a company-shaped
// phrase, and that phrase must then map to exactly one SEC registrant. Either failing means none.
// A ticker the SOURCE itself published is a stated fact and is left exactly as it arrived.
async function resolveTickers(events) {
  const candidates = events.filter((e) => isTickerableSource(e.source) && !(e.tickers || []).length);
  if (!candidates.length) return;
  const items = candidates.map((e, i) => ({
    cusip: String(i),
    issuers: companyPhrases(e.source_headline || e.headline),
    current: null,
  })).filter((it) => it.issuers.length);
  if (!items.length) return;
  try {
    const hits = await resolveIssuerItems(items);
    for (const h of hits) {
      const e = candidates[Number(h.cusip)];
      if (e && h.ticker) e.tickers = [h.ticker];
    }
  } catch { /* resolution is best-effort; no ticker is always an acceptable outcome */ }
}

// ── ingest-time deduplication ────────────────────────────────────────────────
// Runs BEFORE insert, so a row is never visible without its cluster already decided. Two outlets
// filing the same story seconds apart collapse to one canonical event on arrival, not later.
const CLUSTER_WINDOW_HOURS = 48;

// How many GENUINE rewrite attempts an event gets. Only a real model judgement consumes one; an
// infrastructure outage never does — see the `available` handling in runEnrichment.
const MAX_REWRITE_ATTEMPTS = 3;

async function clusterCandidates() {
  const res = await db.execute(sql`
    select seq, cluster_id, event_key, fact_key, fact_sig, norm_hash, display_hash, entity, headline,
           source_headline, summary, tickers, canonical_url, published_at, received_at
      from primary_events
     where received_at > now() - (${CLUSTER_WINDOW_HOURS} || ' hours')::interval
     order by seq desc
     limit 600`);
  return res.rows ?? res;
}

// Assign a cluster and insert, ONE event at a time, appending each inserted row to the candidate
// list as it goes. Interleaving matters: a batch-then-insert design cannot let two items in the
// same sweep collapse together, because neither has a seq yet for the other to point at. Doing it
// row by row means the second of two simultaneous reports folds into the first immediately.
export async function dedupeAndInsert(events) {
  if (!events.length) return { written: 0, folded: 0 };
  const candidates = await clusterCandidates();
  let written = 0, folded = 0;

  for (const e of events) {
    e.canonical_url = canonicalUrl(e.original_url);
    e.event_key = eventKey({
      tickers: e.tickers || [], headline: e.source_headline || e.headline,
      summary: e.summary, publishedAt: e.published_at,
    });
    // entity + event type + the headline number. The layer that collapses differently-worded
    // reports of one event without consulting a model.
    e.fact_key = factKey({
      entity: e.entity, headline: e.source_headline || e.headline,
      summary: e.summary, factSig: e.fact_sig,
    });
    const hit = findCluster(e, candidates);
    // Point at the HEAD of the matched cluster, never at a member, so clusters stay one level deep.
    if (hit) e.cluster_id = hit.match.cluster_id ?? hit.match.seq;

    const n = await insertEvents([e]);
    if (!n) continue;                       // conflicted away; not a new event
    written++;
    // Counted only once the row actually landed, so the number reports real folds rather than
    // match attempts that were about to conflict away on the unique constraint.
    if (e.cluster_id) folded++;
    candidates.unshift({
      seq: e._seq, cluster_id: e.cluster_id ?? null, event_key: e.event_key,
      fact_key: e.fact_key, fact_sig: e.fact_sig, norm_hash: e.norm_hash, entity: e.entity,
      published_at: e.published_at, received_at: new Date().toISOString(),
      headline: e.headline, source_headline: e.source_headline, summary: e.summary,
      tickers: e.tickers || [], canonical_url: e.canonical_url,
    });
  }
  return { written, folded };
}

// Poll every due feed. Failures are per-feed: one bad source never aborts the pass.
//
// `budgetMs` turns one invocation into a sweep LOOP rather than a single pass. Vercel cron cannot
// fire faster than once a minute, so a single-pass design caps first-event latency at 60s. Sweeping
// every few seconds inside the invocation brings detection down to the feed's own cadence — seconds
// for priority feeds — at no extra cost, because a conditional GET on an unchanged feed is a 304
// with no body.
export async function runPrimarySources({ only = null, budgetMs = 0, onNew = null } = {}) {
  const t0 = Date.now();
  const pool = only ? FEEDS : activeFeeds();
  const feeds = only ? pool.filter((f) => f.key === only || f.source === only) : pool;
  const report = new Map();
  let written = 0, sweeps = 0, folded = 0;

  do {
    sweeps++;
    const states = await allFeedState();
    let sweepWrote = 0;

    for (const feed of feeds) {
      const state = states.get(feed.key) || null;
      if (!isDue(feed, state)) {
        if (!report.has(feed.key)) report.set(feed.key, { feed: feed.key, skipped: 'not due' });
        continue;
      }
      const res = await fetchFeed(feed, state);
      if (res.status === 304) {
        await saveFeedState(feed.key, { ok: true, status: 304, etag: res.etag, lastModified: res.lastModified, metered: !!feed.quotaPerDay });
        report.set(feed.key, { feed: feed.key, status: 304, new: report.get(feed.key)?.new || 0 });
        continue;
      }
      if (res.status !== 200) {
        await saveFeedState(feed.key, { ok: false, status: res.status, note: res.error, metered: !!feed.quotaPerDay });
        report.set(feed.key, { feed: feed.key, status: res.status, error: res.error });
        continue;
      }
      const events = res.items.map((it) => normalize(feed, it));
      await resolveTickers(events);
      const ins = await dedupeAndInsert(events);
      const n = ins.written;
      folded += ins.folded;
      written += n; sweepWrote += n;
      await saveFeedState(feed.key, { ok: true, status: 200, etag: res.etag, lastModified: res.lastModified, seen: events.length, metered: !!feed.quotaPerDay });
      const prev = report.get(feed.key);
      report.set(feed.key, { feed: feed.key, status: 200, items: events.length, new: (prev?.new || 0) + n });
    }

    // Hand new rows straight to enrichment instead of waiting for its own cron tick. Enrichment
    // updates the event that is ALREADY captured and already deduped, so this only sharpens a row
    // that is safely stored — it can fail freely without costing us the event.
    if (sweepWrote && onNew) { try { await onNew(sweepWrote); } catch { /* never blocks ingest */ } }

    const left = budgetMs - (Date.now() - t0);
    if (left <= 6000) break;
    await new Promise((r) => setTimeout(r, Math.min(5000, left - 5000)));
  } while (Date.now() - t0 < budgetMs);

  // The 8-K projection is a scan over the last 14 days of eightk_filings. Its upstream cron runs
  // every 5 minutes, so re-scanning every minute would find nothing new 4 times out of 5. It is
  // gated through the same feed_state machinery, on the same cadence as the source it mirrors.
  const secKey = { key: '_project_sec', everySec: 300 };
  let projected = { sec: 0, skipped: 'not due' };
  if (isDue(secKey, (await allFeedState()).get(secKey.key))) {
    projected = await projectExisting();
    await saveFeedState(secKey.key, { ok: true, status: 200, seen: projected.sec, note: '8-K projection' });
  }
  return { written, folded, sweeps, projected, pending: PENDING.map((p) => p.source),
    feeds: [...report.values()], ms: Date.now() - t0 };
}

// ── projections from pipelines that ALREADY fetch their data ─────────────────
// Neither of these issues a network request. The 8-K Wire and /api/halts keep their own tables,
// crons, cadence and response shapes untouched; this only mirrors what they already stored.
export async function projectExisting() {
  const out = { sec: 0 };   // halts are projected by /api/halts itself, see projectHalts below

  // 8-K: one row per filing we already hold. Keyed on accession, so re-running is free.
  const sec = await db.execute(sql`
    insert into primary_events (source, source_name, source_kind, source_type, source_uid, headline,
      source_headline, summary, published_at, original_url, tickers, category, importance,
      content_hash, headline_status, pipeline_status, raw)
    select 'SEC', 'SEC EDGAR', 'sec', 'filing', f.accession,
           coalesce(f.company, f.ticker) || ' · 8-K' ||
             case when f.items is not null and f.items <> '' then ' (' || f.items || ')' else '' end,
           -- source_headline: identical to headline, because an SEC filing is NEVER rewritten.
           coalesce(f.company, f.ticker) || ' · 8-K' ||
             case when f.items is not null and f.items <> '' then ' (' || f.items || ')' else '' end,
           null,
           f.filed_at,
           coalesce(f.primary_doc_url, f.filing_url),
           case when f.ticker is not null then array[f.ticker] else '{}'::text[] end,
           'FILING',
           case when f.material then 2 else 0 end,
           encode(sha256(('SEC|' || f.accession)::bytea), 'hex'),
           -- Lands already finished: never 'pending', so the enrich worker's queue cannot see it.
           'not_required', 'ready',
           jsonb_build_object('accession', f.accession, 'cik', f.cik, 'items', f.items, 'projected', true)
      from eightk_filings f
     where f.filed_at > now() - interval '14 days'
    on conflict do nothing
    returning seq`);
  out.sec = (sec.rows ?? sec)?.length || 0;

  return out;
}

// Nasdaq states halt times as a separate MM/DD/YYYY date and HH:MM:SS clock time, both US Eastern
// with no offset stated. The real ET offset for that calendar day is computed rather than assumed,
// so a halt either side of a DST change is not silently shifted by an hour. (The transition itself
// is at 02:00, outside any trading session, so the probe instant cannot land inside it.)
function etToIso(haltDate, haltTime) {
  const d = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(haltDate || '').trim());
  // Nasdaq emits both "16:02:01" and "19:50:00.000"; the fractional part is optional and ignored.
  const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/.exec(String(haltTime || '').trim());
  if (!d || !t) return null;
  const naive = Date.UTC(+d[3], +d[1] - 1, +d[2], +t[1], +t[2], +(t[3] || 0));
  const probe = new Date(naive);
  const offset = Date.parse(probe.toLocaleString('en-US', { timeZone: 'UTC' }))
    - Date.parse(probe.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  if (!Number.isFinite(offset)) return null;
  return new Date(naive + offset).toISOString();
}

// Halts are projected by /api/halts itself, from the feed it already fetched. Exported so that
// route can hand us the rows without a second poll of nasdaqtrader.com.
export async function projectHalts(halts) {
  if (!halts?.length) return 0;
  const events = halts.slice(0, 300).map((h) => {
    const sym = String(h.symbol || h.sym || '').toUpperCase();
    const headline = `${sym} halted${h.reason ? ` · ${h.reason}` : ''}`;
    const published = etToIso(h.haltDate, h.haltTime);
    // Keyed on what the feed itself stated, so a date we could not parse still has a stable
    // identity and cannot be re-inserted on the next poll.
    const uid = `${sym}|${h.haltDate || ''}|${h.haltTime || ''}|${h.reasonCode || ''}`;
    return {
      source: 'NASDAQ', source_name: 'Nasdaq Trader', source_type: 'halt',
      // A halt line is mechanical, not prose: there is nothing to restate, so it is final on insert.
      headline_status: 'not_required', pipeline_status: 'ready',
      source_uid: uid,
      headline,
      source_headline: headline,
      summary: h.resumeTrade ? `Resumption ${h.resumeTrade}` : null,
      published_at: published,
      original_url: 'https://www.nasdaqtrader.com/trader.aspx?id=TradeHalts',
      tickers: sym ? [sym] : [],          // the feed states the symbol; no inference involved
      category: categoryOf('NASDAQ'),
      importance: importanceOf({ source: 'NASDAQ', type: 'halt', title: headline }),
      // Hash the uid, not the headline: one symbol can be LULD-paused several times in a day for
      // the same reason, and a headline+day hash would silently swallow every pause after the first.
      content_hash: contentHash({ source: 'NASDAQ', title: uid, publishedAt: published }),
      raw: { ...h, projected: true },
    };
  });
  return insertEvents(events);
}

// ── early halt detection ─────────────────────────────────────────────────────
// A trusted wire sometimes states a halt before Nasdaq's feed carries it. This finds those events
// so the Halt Scanner can show them immediately, and it is deliberately hard to satisfy.
//
// TWO independent gates, both required:
//   1. a ticker the conservative resolver actually resolved — never a symbol parsed out of prose
//   2. a phrase that can only mean a SECURITIES trading halt
//
// Gate 2 is the one that matters. "Halt", "pause" and "stopped" on their own are everywhere in
// ordinary news and must never create a halt: our own tape carried "Amazon halts operations with 21
// aircraft after Miami crash" and "Saudi oil pipeline to be out of service" in the same window. So
// every pattern below anchors the word to trading itself — "trading halted", "shares halted",
// "halted pending news" — and a company halting a factory, a flight or a drug trial matches none of
// them. NASDAQ's own projected rows are excluded: those already ARE the official feed.
const HALT_PHRASES = [
  /\btrading (?:is |was |has been )?halted\b/i,
  /\btrading halt\b/i,
  /\bshares? (?:are |were |is |was )?halted\b/i,
  /\bstock (?:is |was )?halted\b/i,
  /\bhalted (?:for|pending) news\b/i,
  /\bhalted,? news pending\b/i,
  /\bnews pending halt\b/i,
  /\bvolatility (?:trading )?(?:halt|pause)\b/i,
  /\bregulatory halt\b/i,
  /\btrading pause[ds]?\b/i,
  /\blimit up[- ]limit down\b/i,
  /\bLULD\b/,
];

export async function detectedHalts({ withinMinutes = 240 } = {}) {
  const res = await db.execute(sql`
    select seq, source, headline, source_headline, tickers, published_at, received_at
      from primary_events
     where cluster_id is null
       and source_kind <> 'sec'
       and source <> 'NASDAQ'
       and cardinality(tickers) > 0
       and coalesce(published_at, received_at) > now() - (${withinMinutes} || ' minutes')::interval
       -- Cheap prefilter so the regex gate below only sees plausible rows.
       and (headline ~* '\\mhalt' or headline ~* '\\mLULD\\M' or source_headline ~* '\\mhalt')
     order by coalesce(published_at, received_at) desc
     limit 60`);
  const out = [];
  for (const r of (res.rows ?? res)) {
    const hay = `${r.headline || ''} ${r.source_headline || ''}`;
    if (!HALT_PHRASES.some((re) => re.test(hay))) continue;
    const at = new Date(r.published_at || r.received_at);
    if (Number.isNaN(at.getTime())) continue;
    // Formatted to match the official feed's own shape so the panel needs no special case.
    const et = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: '2-digit',
      day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    const p = Object.fromEntries(et.formatToParts(at).map((x) => [x.type, x.value]));
    out.push({
      symbol: String(r.tickers[0]).toUpperCase(),
      reason: 'Halt reported — awaiting official confirmation',
      haltDate: `${p.month}/${p.day}/${p.year}`,
      haltTime: `${p.hour}:${p.minute}:${p.second}.000`,
      seq: r.seq,
    });
  }
  // One row per symbol, newest kept.
  const bySym = new Map();
  for (const h of out) if (!bySym.has(h.symbol)) bySym.set(h.symbol, h);
  return [...bySym.values()];
}

// ── STAGE 2: enrichment ──────────────────────────────────────────────────────
// Completely independent of ingestion. Reads rows that are ALREADY captured, already deduped and
// already canonical, then sharpens them in place: the Catalyst Pit headline, the extracted facts,
// and any ticker the first pass could not resolve. If this never runs, nothing is lost — rows stay
// 'pending' and display their source headline, which is a real sentence a real source wrote.
//
// SEC CAN NEVER APPEAR HERE. SEC rows are inserted as 'ready', so the queue below — which selects
// only 'pending' — has no way to reach them. The source_kind guard is a second, independent lock.

async function claimPending(limit) {
  // Newest first: a breaking item is enriched before any backlog drains.
  const res = await db.execute(sql`
    select seq, source, source_name, source_type, headline, source_headline, summary, published_at,
           original_url, tickers, entity, fact_sig, category, importance, enrich_attempts, cluster_id,
           headline_status
      from primary_events
     -- headline_status is the AUTHORITATIVE eligibility signal. It used to be pipeline_status, and
     -- the two drifted apart: enrichment runs during the credit outage marked rows 'ready' while
     -- their headline was still the publisher's, stranding 1,468 events that no worker would ever
     -- look at again. A row needing Catalyst Pit wording says so in one place now.
     where headline_status = 'rewrite_pending'
       and source_kind <> 'sec'
       -- A trusted source keeps trying long after an ordinary event would have been parked. Its
       -- wording must never be what the tape settles on, so it does not get three attempts and a
       -- shrug; it stays in the queue until a Catalyst Pit headline exists.
       and enrich_attempts < (case when source = any(${TRUSTED}::text[]) then ${TRUSTED_REWRITE_ATTEMPTS}
                                   else ${MAX_REWRITE_ATTEMPTS} end)
     -- Trusted first, then newest. A breaking flash is rewritten before anything else waiting.
     order by (source = any(${TRUSTED}::text[])) desc, seq desc
     limit ${Math.max(1, Math.min(60, limit))}`);
  return res.rows ?? res;
}

// `generate` is injectable so the enrichment write path can be verified without spending an API
// call, and so a future model change is a parameter rather than an edit here. It defaults to the
// real batch generator.
export async function runEnrichment({ limit = BATCH_SIZE * 2, generate = generateBatch } = {}) {
  const t0 = Date.now();
  const rows = await claimPending(limit);
  const stats = { claimed: rows.length, ready: 0, original: 0, fallback: 0, tickers: 0 };
  if (!rows.length) return { ...stats, ms: Date.now() - t0 };

  // 1) Any ticker the ingest pass could not resolve. Same two-gate conservative path.
  const pend = rows.map((r) => ({ source: r.source, source_headline: r.source_headline, headline: r.headline, tickers: r.tickers || [] }));
  await resolveTickers(pend);
  rows.forEach((r, i) => { r.tickers = pend[i].tickers; });

  // 2) Headline + facts, in batches.
  //
  // `available` separates an INFRASTRUCTURE failure (no credits, API down, timeout, rate limit)
  // from the model genuinely judging an item. An outage must not burn the item's retry budget or
  // mark it finished — otherwise a billing lapse silently retires the whole backlog, which is
  // exactly how 1,468 events were stranded. A Map return is still accepted so older callers and
  // test stubs keep working.
  const generated = new Map();
  let modelAvailable = true;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const res = await generate(rows.slice(i, i + BATCH_SIZE));
    const map = res instanceof Map ? res : (res?.results ?? new Map());
    if (!(res instanceof Map) && res?.available === false) {
      modelAvailable = false;
      stats.unavailable = String(res.error || 'model unavailable').slice(0, 80);
      break;                                   // no point asking again this pass
    }
    for (const [idx, val] of map) generated.set(i + idx, val);
  }

  // Nothing to apply and nothing was the item's fault: leave every claimed row exactly as it is,
  // still rewrite_pending, attempts untouched, so the next run with credits picks all of them up.
  if (!modelAvailable && !generated.size) {
    return { ...stats, ready: 0, skipped: rows.length, modelAvailable: false, ms: Date.now() - t0 };
  }

  // 3) Validate and persist. Clustering already happened at ingest; enrichment only updates the
  //    event in place, so a canonical event never changes identity after it becomes visible.
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const sourceText = `HEADLINE: ${r.source_headline || r.headline}\n${r.summary || ''}`;
    const gen = generated.get(i);

    // The model never reached this row because the API was down. Leave it completely untouched —
    // no write, no attempt consumed — so an outage costs nothing but time.
    if (!gen && !modelAvailable) { stats.skipped = (stats.skipped || 0) + 1; continue; }

    // A row arrives here already displaying either a composed Catalyst Pit sentence or the
    // source's wording marked rewrite_pending. If the model's output cannot be grounded, that
    // status is PRESERVED — a pending rewrite is never quietly relabelled as ours, and the row
    // stays eligible for another attempt.
    let headline = r.headline || canonicalHeadline(r.source_headline, r.tickers || []);
    let headlineStatus = r.headline_status === 'composed' ? 'composed' : 'rewrite_pending';
    let facts = null;
    if (gen?.headline) {
      const v = validateHeadline(gen.headline, sourceText, r.tickers || []);
      if (v.ok) { headline = gen.headline.trim().replace(/\s+/g, ' '); headlineStatus = 'original'; stats.original++; }
      else stats.fallback++;
      facts = validateFacts(gen.facts, sourceText);
    } else stats.fallback++;

    // A ticker resolved just now belongs in the displayed headline too.
    if ((r.tickers || []).length) {
      stats.tickers++;
      if (headlineStatus === 'normalized') headline = canonicalHeadline(r.source_headline, r.tickers);
    }
    // Recomputed because a ticker resolved just now can make an item identifiable that was not
    // identifiable at ingest — which lets later reports of the same event still fold into it.
    const key = eventKey({
      tickers: r.tickers || [], headline: r.source_headline || r.headline,
      summary: r.summary, publishedAt: r.published_at,
    });
    const fkey = factKey({
      entity: (r.tickers || [])[0] || r.entity, headline: r.source_headline || r.headline,
      summary: r.summary, factSig: r.fact_sig,
    });

    await db.execute(sql`
      update primary_events
         set headline = ${headline},
             headline_status = ${headlineStatus},
             facts = ${facts ? JSON.stringify(facts) : null}::jsonb,
             tickers = ${`{${(r.tickers || []).join(',')}}`}::text[],
             event_key = coalesce(${key}, event_key),
             fact_key = coalesce(${fkey}, fact_key),
             importance = greatest(importance, ${r.importance ?? 0}::smallint),
             display_hash = ${normHash(headline) || null},
             display_ready = display_ready or ${isDisplayable(r.source_headline || r.headline)},
             pipeline_status = 'ready',
             enrich_attempts = enrich_attempts + 1,
             enriched_at = now()
       where seq = ${r.seq}`);
    stats.ready++;
    // Rewriting can CREATE a duplicate that did not exist at ingest. Four language editions of one
    // press release, or two outlets whose phrasings missed the similarity threshold, all become the
    // same English sentence once Catalyst Pit has worded them. Dedupe ran before that happened, so
    // this is the only place that collapse can be caught.
    if (!r.cluster_id) stats.foldedAfterRewrite = (stats.foldedAfterRewrite || 0) + await foldOnDisplayHeadline(r.seq, headline, r.published_at);
  }

  return { ...stats, ms: Date.now() - t0 };
}

// Fold a freshly-reworded event into an older canonical event that now reads identically.
//
// The OLDER row always wins, which is what keeps "first source on screen immediately" true: the row
// the trader has already seen keeps its seq, its position and its timestamp, and the late arrival
// becomes a member of it. Never touches SEC, never merges a row into itself or into one of its own
// members, and never fires on a headline too short to be a safe identity.
async function foldOnDisplayHeadline(seq, headline, publishedAt) {
  const hash = normHash(headline);
  if (!hash || hash.split(' ').length < 4) return 0;   // too thin to assert two events are one
  const res = await db.execute(sql`
    with head as (
      select seq, published_at from primary_events
       where display_hash = ${hash}
         and cluster_id is null
         and source_kind <> 'sec'
         and seq <> ${seq}
         -- The same proximity gate every other layer uses. The Fed prints "Federal Reserve issues
         -- FOMC statement" verbatim eight times a year and those stay eight events.
         and abs(extract(epoch from (coalesce(published_at, received_at)
             - ${publishedAt ?? null}::timestamptz))) <= ${PROXIMITY_MS / 1000}
       order by seq asc
       limit 1)
    update primary_events p
       set cluster_id = head.seq
      from head
     where p.seq = ${seq} and head.seq < p.seq
    returning p.seq`);
  const folded = (res.rows ?? res)?.length || 0;
  if (folded) {
    await db.execute(sql`
      update primary_events
         set source_count = source_count + 1, last_seen_at = now()
       where seq = (select cluster_id from primary_events where seq = ${seq})`);
  }
  return folded;
}

// Rows that exhausted their retries are parked rather than retried forever. They keep their source
// headline and stay visible; only the Catalyst Pit rewrite is abandoned.
//
// A TRUSTED source is never parked. Parking is the moment the publisher's wording becomes the final
// answer, and for a trusted source that outcome is not allowed — it keeps its place in the queue
// under the larger budget above instead.
export async function parkExhausted() {
  const res = await db.execute(sql`
    update primary_events
       set pipeline_status = 'ready'
     where pipeline_status = 'pending'
       and enrich_attempts >= ${MAX_REWRITE_ATTEMPTS}
       and not (source = any(${TRUSTED}::text[]))
    returning seq`);
  return (res.rows ?? res)?.length || 0;
}

// Returns every rewrite_pending event to the queue and clears attempts that were consumed by an
// outage rather than by a real model judgement. Safe to run repeatedly; never touches SEC, never
// touches a headline, never touches a raw source field.
export async function requeueRewrites({ resetAttempts = true } = {}) {
  const res = await db.execute(sql`
    update primary_events
       set pipeline_status = 'pending',
           enrich_attempts = ${resetAttempts ? 0 : sql`enrich_attempts`}
     where headline_status = 'rewrite_pending'
       and source_kind <> 'sec'
    returning seq`);
  return (res.rows ?? res)?.length || 0;
}

// The canonical wire: ONE row per real-world event, newest first, duplicates already collapsed.
// Reads the canonical_events view, so a consumer can never see the folded source records — those
// stay in primary_events for provenance and are reachable by cluster_id.
export async function canonicalWire({ since = null, limit = 100, minImportance = null,
  category = null, ticker = null, updatedSince = null } = {}) {
  const n = Math.min(300, Math.max(1, Number(limit) || 100));
  // `updatedSince` is the enrichment channel: rows whose seq the client already has, but which have
  // since been improved (Haiku headline, resolved ticker, another source folding in). The client
  // merges them onto the existing event by seq, so an update never creates a second wire item.
  const upd = updatedSince ? new Date(updatedSince) : null;
  const isUpdate = !!(upd && !Number.isNaN(upd.getTime()));
  const res = await db.execute(sql`
    select e.seq, e.source, e.source_name, e.source_kind, e.source_type, e.headline,
           e.source_headline, e.summary, e.published_at, e.received_at, e.first_seen_at,
           e.last_seen_at, e.original_url, e.tickers, e.category, e.importance, e.source_count,
           e.headline_status, e.enriched_at, e.facts,
           -- Market cap for the first resolved ticker, from the existing daily screener_meta table.
           -- LEFT JOIN on purpose: no cap simply means the cap filters cannot judge this event.
           m.market_cap
      from canonical_events e
      left join lateral (
        select sm.market_cap from screener_meta sm
         where sm.ticker = any(e.tickers) and sm.market_cap is not null
         order by sm.market_cap desc limit 1
      ) m on true
     where (${!isUpdate}::boolean or e.enriched_at > ${isUpdate ? upd.toISOString() : null}::timestamptz
                                  or e.last_seen_at > ${isUpdate ? upd.toISOString() : null}::timestamptz)
       and (${since === null || since === ''}::boolean or e.seq > ${Number(since) || 0})
       and (${minImportance === null || minImportance === ''}::boolean or e.importance >= ${Number(minImportance) || 0})
       and (${category === null || category === ''}::boolean or e.category = ${category})
       and (${ticker === null || ticker === ''}::boolean or ${String(ticker || '').toUpperCase()} = any(e.tickers))
     order by coalesce(e.published_at, e.received_at) desc, e.seq desc
     limit ${n}`);
  return res.rows ?? res;
}

// Cursor read for the future SSE/WebSocket endpoint. Already the right shape; no ingestion change
// will be needed to start pushing.
export async function eventsSince(seq = 0, limit = 200) {
  const res = await db.execute(sql`
    select seq, source, source_type, headline, summary, published_at, received_at,
           original_url, tickers, category, importance
      from primary_events where seq > ${Number(seq) || 0}
     order by seq asc limit ${Math.min(500, Math.max(1, limit))}`);
  return res.rows ?? res;
}
