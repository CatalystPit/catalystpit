/**
 * SEC XBRL → STORED FACTS → DERIVED FUNDAMENTALS.
 *
 * ── THE FLOW, END TO END ─────────────────────────────────────────────────────
 *
 *   SEC frames endpoint (one request per concept per period, whole market)
 *     → per-CIK candidate facts, one per concept per period
 *     → chain resolution by RECENCY (xbrl-facts.resolveChain)
 *     → period validation against the requested shape (quarter / annual / instant)
 *     → sec_xbrl_facts, one row per (ticker, concept, period_end) with full provenance
 *     → derived metrics: TTM sums, market cap, P/E, free cash flow
 *     → screener_fundamentals (source 'sec'), read by the Screener
 *     → ticker page reads the same stored rows; it makes NO SEC request on a page load
 *
 * ── ⚠️ WHAT IS STORED IS THE SELECTED FACT, NOT THE WHOLE FILING ─────────────
 *
 * sec_xbrl_facts holds the facts the selectors chose, each with its accession, taxonomy, concept, unit and
 * exact period. That is the lineage Phase 9 asks for: any published number can be traced to the filing it
 * came from, and a disagreement can be investigated without re-running the pipeline. It is deliberately
 * not a mirror of companyfacts — storing everything would be gigabytes and would not answer the question
 * "why does the Screener say this".
 */
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { CONCEPTS, QUARTERLY_KEYS, INSTANT_KEYS, ANNUAL_ONLY_KEYS, PE_EPS_BASIS } from './xbrl-concepts.mjs';
import { fetchFrame, recentQuarterFrames, recentAnnualFrame, SecThrottled } from './xbrl-frames.mjs';
import {
  resolveChain, validateDuration, validateInstant, computeTtm, deriveFourthQuarter,
  computeMarketCap, computePe, computeFreeCashFlow, fiscalLabel, detectFiscalYearEndMonth,
} from './xbrl-facts.mjs';

export const FACT_SOURCE = 'sec:xbrl-frames';
export const FUNDAMENTALS_SOURCE = 'sec';

export async function ensureFactTables() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS sec_xbrl_facts (
    ticker        text    NOT NULL,
    cik           integer NOT NULL,
    concept       text    NOT NULL,
    taxonomy      text    NOT NULL,
    tag           text    NOT NULL,
    unit          text    NOT NULL,
    kind          text    NOT NULL,
    period_start  date,
    period_end    date    NOT NULL,
    fiscal_label  text,
    val           double precision NOT NULL,
    accn          text,
    frame         text,
    source        text    NOT NULL,
    ingested_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (ticker, concept, period_end)
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_sec_facts_ticker ON sec_xbrl_facts (ticker)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_sec_facts_concept ON sec_xbrl_facts (concept, period_end DESC)`);
  // ⚠️ THE SAME DATABASE-LEVEL REFUSAL THE CANDLE TABLE GOT, for the same reason. A provenance column
  // that application code is trusted to populate is a column that will one day be NULL — this is the
  // defect Phase 9 names explicitly, and it has already happened once in this codebase when
  // screener_meta.source existed in the database and not in the drizzle schema. Postgres refuses it here.
  await db.execute(sql`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_sec_facts_source') THEN
      ALTER TABLE sec_xbrl_facts ADD CONSTRAINT ck_sec_facts_source
        CHECK (source LIKE 'sec:%' AND length(source) > 4);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_sec_facts_taxonomy') THEN
      ALTER TABLE sec_xbrl_facts ADD CONSTRAINT ck_sec_facts_taxonomy
        CHECK (taxonomy IN ('us-gaap','dei'));
    END IF;
  END $$`);
}

/**
 * Pull every frame the concept registry needs.
 *
 * ⚠️ IT STOPS ON A THROTTLE RATHER THAN PUSHING THROUGH. A 429 means SEC has asked us to slow down, and
 * the correct response to that is to stop and come back — not to keep asking and have the whole run
 * return empty results that read as "no data". The caller gets what was fetched plus `throttled: true`,
 * and partial data is still useful because every fact is written independently.
 */
export async function fetchAllFrames({ now = new Date(), fetchImpl = fetch, onProgress = null, quarterCount = 8 } = {}) {
  // ⚠️ EIGHT QUARTERS, NOT FOUR, AND THE REASON IS THE Q4 DERIVATION RATHER THAN THE TTM ITSELF.
  //
  // A TTM needs four quarters, so four frames looks sufficient. It is not: one of those four is always a
  // fourth quarter, which no 10-Q reports, so it has to be derived from the fiscal YEAR total minus that
  // year ONE Q1, Q2 and Q3 — and those three quarters sit in the frames BEFORE the TTM window. Measured on
  // Apple: a TTM ending 2026-06-27 needs its FY2025 Q4 (Jun–Sep 2025), whose derivation needs Dec-2024,
  // Mar-2025 and Jun-2025, which live in CY2024Q4, CY2025Q1 and CY2025Q2. With a four-frame window those
  // are simply absent and every ticker reports insufficient-quarters forever.
  //
  // Two years of frames covers any Q4 in the TTM window with its own fiscal year intact. It is still a few
  // dozen requests for the entire market rather than 18,000.
  const quarters = recentQuarterFrames(quarterCount, now);
  const annual = recentAnnualFrame(now);
  const got = { quarterly: [], instant: [], annual: [], annualForQuarterly: [] };
  const misses = [];
  let throttled = false;

  const pull = async (concept, key, taxonomy, tag, unit, frame, bucket, chainIndex) => {
    const res = await fetchFrame({ taxonomy, tag, unit, frame, fetchImpl });
    if (res.ok) {
      got[bucket].push({ concept: key, tag, taxonomy, unit, frame, chainIndex, rows: res.rows });
      if (onProgress) onProgress(`${key}/${tag} ${frame}: ${res.rows.length}`);
    } else {
      misses.push(`${key}/${tag} ${frame}: ${res.reason}`);
    }
  };

  try {
    // Quarterly duration concepts, four periods each, every tag in the chain.
    for (const key of QUARTERLY_KEYS) {
      const c = CONCEPTS[key];
      for (let i = 0; i < c.chain.length; i++) {
        for (const q of quarters) await pull(c, key, c.taxonomy, c.chain[i], c.unit, q.frame, 'quarterly', i);
      }
    }
    // Instant concepts, newest instant frame only — a balance sheet question is "as of now".
    for (const key of INSTANT_KEYS) {
      const c = CONCEPTS[key];
      for (let i = 0; i < c.chain.length; i++) {
        // Two instant frames, so a filer that has not yet filed the newest quarter still has a recent one.
        for (const q of quarters.slice(0, 2)) await pull(c, key, c.taxonomy, c.chain[i], c.unit, q.instantFrame, 'instant', i);
      }
    }
    // Annual-only concepts (cash flow).
    for (const key of ANNUAL_ONLY_KEYS) {
      const c = CONCEPTS[key];
      for (let i = 0; i < c.chain.length; i++) {
        await pull(c, key, c.taxonomy, c.chain[i], c.unit, annual.frame, 'annual', i);
      }
    }
    // ⚠️ THE ANNUAL FRAME FOR THE QUARTERLY CONCEPTS TOO, AND THIS IS WHAT MAKES TTM POSSIBLE AT ALL.
    //
    // A 10-K reports the full year and contains NO discrete three-month fact for the fourth quarter,
    // because the fourth quarter has no 10-Q. So quarterly frames are permanently missing one quarter in
    // four for every company on the market, and a TTM built from them alone refuses everything. Measured
    // on the first validation run: Apple had three revenue quarters and no September, and every ticker in
    // the cohort reported 'insufficient-quarters'.
    //
    // The annual fact is the other half of the arithmetic — see deriveFourthQuarter. Two extra frames per
    // concept, and the same provenance rules apply to both.
    for (const key of QUARTERLY_KEYS) {
      const c = CONCEPTS[key];
      for (let i = 0; i < c.chain.length; i++) {
        for (const fr of [annual.frame, `CY${annual.year - 1}`]) {
          await pull(c, key, c.taxonomy, c.chain[i], c.unit, fr, 'annualForQuarterly', i);
        }
      }
    }
  } catch (e) {
    if (e instanceof SecThrottled) throttled = true; else throw e;
  }

  // ⚠️ `annualFrame`, NOT `annual`. Spreading `got` and then adding `annual` overwrote got.annual — the
  // ARRAY of fetched annual frames — with the frame DESCRIPTOR from recentAnnualFrame, so selectFacts
  // received an object where it expected a list and cash flow silently disappeared from every ticker.
  // Two different things called the same name one line apart.
  return { ...got, misses, throttled, quarters, annualFrame: annual };
}

/**
 * Turn fetched frames into validated per-ticker facts.
 *
 * `cikToTickers` maps a CIK to the ticker(s) we publish for it — a CIK can carry several share classes,
 * and each gets its own row because each has its own price.
 */
export function selectFacts({ frames, cikToTickers }) {
  // candidates[cik][concept][periodEnd] = [{ tag, chainIndex, fact }]
  const byCik = new Map();
  const add = (cik, concept, kind, unit, taxonomy, tag, chainIndex, frame, row, want) => {
    const v = Number(row?.val);
    if (!Number.isFinite(v)) return;
    const fact = { start: row.start ?? null, end: row.end, val: v, accn: row.accn ?? null, loc: row.loc ?? null };
    // ⚠️ VALIDATED BEFORE IT IS EVEN A CANDIDATE. A YTD fact must not reach chain resolution, where it
    // could win on recency and be stored as a quarter.
    const check = kind === 'instant' ? validateInstant(fact) : validateDuration(fact, want);
    if (!check.ok) return;
    if (!byCik.has(cik)) byCik.set(cik, new Map());
    const concepts = byCik.get(cik);
    if (!concepts.has(concept)) concepts.set(concept, new Map());
    const periods = concepts.get(concept);
    if (!periods.has(row.end)) periods.set(row.end, []);
    periods.get(row.end).push({ tag, chainIndex, taxonomy, unit, kind, frame, fact });
  };

  for (const f of frames.quarterly) {
    for (const row of f.rows) add(row.cik, f.concept, 'duration', f.unit, f.taxonomy, f.tag, f.chainIndex, f.frame, row, 'quarter');
  }
  for (const f of frames.instant) {
    for (const row of f.rows) add(row.cik, f.concept, 'instant', f.unit, f.taxonomy, f.tag, f.chainIndex, f.frame, row, 'instant');
  }
  for (const f of frames.annual) {
    for (const row of f.rows) add(row.cik, f.concept, 'duration', f.unit, f.taxonomy, f.tag, f.chainIndex, f.frame, row, 'annual');
  }
  // ⚠️ ANNUAL FACTS FOR QUARTERLY CONCEPTS GO IN A SEPARATE MAP, NEVER ALONGSIDE THE QUARTERS. If an
  // annual revenue fact were stored under the same (concept, period_end) key as a quarter it would win on
  // recency and be served as "this quarter's revenue" — a 12-month number labelled as three months, which
  // is the exact failure mode this module exists to prevent. They are only ever an INPUT to the Q4
  // derivation.
  const annualForQ = new Map();   // cik -> concept -> [{tag, chainIndex, fact}]
  for (const f of frames.annualForQuarterly || []) {
    for (const row of f.rows) {
      const v = Number(row?.val);
      if (!Number.isFinite(v) || !row.start || !row.end) continue;
      const fact = { start: row.start, end: row.end, val: v, accn: row.accn ?? null };
      if (!validateDuration(fact, 'annual').ok) continue;
      if (!annualForQ.has(row.cik)) annualForQ.set(row.cik, new Map());
      const m = annualForQ.get(row.cik);
      if (!m.has(f.concept)) m.set(f.concept, []);
      m.get(f.concept).push({ tag: f.tag, chainIndex: f.chainIndex, taxonomy: f.taxonomy, unit: f.unit, frame: f.frame, fact });
    }
  }

  const out = [];
  for (const [cik, concepts] of byCik) {
    const tickers = cikToTickers.get(Number(cik)) || [];
    if (!tickers.length) continue;

    // ⚠️ THE FISCAL-YEAR-END MONTH COMES FROM ANNUAL PERIOD ENDS ONLY. The first version mixed in
    // quarterly ends, which cluster on all four quarter-end months, and the mode of that mixture is
    // meaningless — it reported Apple's FYE as June and Microsoft's as March, both off by a quarter. An
    // annual fact's end IS the fiscal year end, so only those are evidence.
    const annualEnds = [];
    for (const [concept, list] of (annualForQ.get(Number(cik)) || new Map())) {
      for (const c of list) annualEnds.push(c.fact.end);
    }
    for (const k of ['operatingCashFlow', 'capex']) {
      if (concepts.has(k)) for (const end of concepts.get(k).keys()) annualEnds.push(String(end));
    }
    const fyeMonth = detectFiscalYearEndMonth(annualEnds);

    // ⚠️ DERIVE THE FOURTH QUARTER BEFORE EMITTING. Without this every TTM in the product is refused.
    for (const key of QUARTERLY_KEYS) {
      const periods = concepts.get(key);
      const annuals = (annualForQ.get(Number(cik)) || new Map()).get(key) || [];
      if (!periods || !annuals.length) continue;
      const quarters = [...periods.entries()].map(([end, cands]) => {
        const w = resolveChain(cands);
        return w ? { start: w.fact.start, end, val: w.fact.val, accn: w.fact.accn } : null;
      }).filter(Boolean);
      // One derivation per fiscal year the annual facts cover.
      for (const a of annuals) {
        if (periods.has(a.fact.end)) continue;            // a real Q4 exists; never overwrite it
        const d = deriveFourthQuarter({
          annual: { ...a.fact, tag: a.tag },
          quarters,
        });
        if (!d) continue;
        periods.set(d.end, [{
          tag: a.tag, chainIndex: a.chainIndex, taxonomy: a.taxonomy, unit: a.unit, kind: 'duration',
          frame: a.frame, fact: { start: d.start, end: d.end, val: d.val, accn: d.accn }, derived: true,
        }]);
      }
    }

    for (const [concept, periods] of concepts) {
      for (const [periodEnd, cands] of periods) {
        const winner = resolveChain(cands.map((c) => ({ ...c, fact: c.fact })));
        if (!winner) continue;
        for (const ticker of tickers) {
          out.push({
            ticker,
            cik: Number(cik),
            concept,
            taxonomy: winner.taxonomy,
            tag: winner.tag,
            unit: winner.unit,
            kind: winner.kind,
            periodStart: winner.fact.start,
            periodEnd,
            fiscalLabel: winner.kind === 'instant' ? null : fiscalLabel(periodEnd, fyeMonth),
            val: winner.fact.val,
            accn: winner.fact.accn,
            frame: winner.frame,
            // ⚠️ A DERIVED QUARTER SAYS SO IN ITS OWN PROVENANCE. The accession is the 10-K the annual
            // figure came from, which is correct and is not the whole story; 'sec:xbrl-derived-q4' is.
            source: winner.derived ? 'sec:xbrl-derived-q4' : FACT_SOURCE,
            fyeMonth,
          });
        }
      }
    }
  }
  return out;
}

/** Write selected facts. One row per (ticker, concept, period_end); a re-run refreshes in place. */
export async function storeFacts(facts) {
  if (!facts.length) return 0;
  await ensureFactTables();
  let written = 0;
  for (let i = 0; i < facts.length; i += 500) {
    const batch = facts.slice(i, i + 500);
    const values = batch.map((f) => sql`(${f.ticker}, ${f.cik}, ${f.concept}, ${f.taxonomy}, ${f.tag},
      ${f.unit}, ${f.kind}, ${f.periodStart}::date, ${f.periodEnd}::date, ${f.fiscalLabel}, ${f.val},
      ${f.accn}, ${f.frame}, ${f.source})`);
    await db.execute(sql`
      insert into sec_xbrl_facts
        (ticker, cik, concept, taxonomy, tag, unit, kind, period_start, period_end, fiscal_label, val, accn, frame, source)
      values ${sql.join(values, sql`, `)}
      on conflict (ticker, concept, period_end) do update set
        taxonomy = excluded.taxonomy, tag = excluded.tag, unit = excluded.unit, kind = excluded.kind,
        period_start = excluded.period_start, fiscal_label = excluded.fiscal_label, val = excluded.val,
        accn = excluded.accn, frame = excluded.frame, source = excluded.source, ingested_at = now()`);
    written += batch.length;
  }
  return written;
}

/**
 * Derive the published metrics for one ticker from its stored facts.
 *
 * @param facts  rows for ONE ticker, as stored
 * @param ctx    { price, priceDate, filerType }
 * @returns a fundamentals row plus a `reasons` map explaining every field that is null
 */
export function deriveFundamentals(facts, ctx = {}) {
  const byConcept = new Map();
  for (const f of facts) {
    if (!byConcept.has(f.concept)) byConcept.set(f.concept, []);
    byConcept.get(f.concept).push(f);
  }
  const quarters = (k) => (byConcept.get(k) || [])
    .filter((f) => f.kind === 'duration' && f.period_start)
    .map((f) => ({ start: String(f.period_start).slice(0, 10), end: String(f.period_end).slice(0, 10), val: Number(f.val), accn: f.accn, tag: f.tag }));
  const newestInstant = (k) => {
    const rows = (byConcept.get(k) || []).filter((f) => f.kind === 'instant')
      .sort((a, b) => String(b.period_end).localeCompare(String(a.period_end)));
    return rows[0] || null;
  };
  const newestAnnual = (k) => {
    const rows = (byConcept.get(k) || []).filter((f) => f.kind === 'duration')
      .sort((a, b) => String(b.period_end).localeCompare(String(a.period_end)));
    return rows[0] || null;
  };

  const reasons = {};
  const ttmOf = (k) => {
    const r = computeTtm(quarters(k));
    if (!r.ok) reasons[`${k}Ttm`] = r.reason;
    return r;
  };

  const revTtm = ttmOf('revenue');
  const niTtm = ttmOf('netIncome');
  const oiTtm = ttmOf('operatingIncome');
  const epsDilutedTtm = ttmOf('epsDiluted');
  const epsBasicTtm = ttmOf('epsBasic');

  const shares = newestInstant('sharesOutstanding');
  const assets = newestInstant('assets');
  const liabilities = newestInstant('liabilities');
  const equity = newestInstant('equity');
  const cash = newestInstant('cash');
  const ocf = newestAnnual('operatingCashFlow');
  const capex = newestAnnual('capex');

  const filerType = ctx.filerType || null;
  const mcap = computeMarketCap({
    price: ctx.price,
    priceDate: ctx.priceDate,
    shares: shares ? Number(shares.val) : null,
    sharesAsOf: shares ? String(shares.period_end).slice(0, 10) : null,
    filesDomestic: filerType === 'domestic',
    filesForeign: filerType === 'foreign',
  });
  if (!mcap.ok) reasons.marketCap = mcap.reason;

  // ⚠️ P/E USES THE TTM OF THE DECLARED BASIS, never a quarterly figure and never the other basis.
  const peBasisTtm = PE_EPS_BASIS === 'epsDiluted' ? epsDilutedTtm : epsBasicTtm;
  const pe = computePe({ price: ctx.price, epsTtm: peBasisTtm.ok ? peBasisTtm.value : null });
  if (!pe.ok) reasons.pe = pe.reason;

  const fcf = computeFreeCashFlow({
    operatingCashFlow: ocf ? Number(ocf.val) : null,
    capex: capex ? Number(capex.val) : null,
  });
  if (!fcf.ok) reasons.freeCashFlow = fcf.reason;

  return {
    revenueTtm: revTtm.ok ? revTtm.value : null,
    netIncomeTtm: niTtm.ok ? niTtm.value : null,
    operatingIncomeTtm: oiTtm.ok ? oiTtm.value : null,
    epsDilutedTtm: epsDilutedTtm.ok ? epsDilutedTtm.value : null,
    epsBasicTtm: epsBasicTtm.ok ? epsBasicTtm.value : null,
    sharesOutstanding: shares ? Number(shares.val) : null,
    sharesAsOf: shares ? String(shares.period_end).slice(0, 10) : null,
    assets: assets ? Number(assets.val) : null,
    liabilities: liabilities ? Number(liabilities.val) : null,
    equity: equity ? Number(equity.val) : null,
    cash: cash ? Number(cash.val) : null,
    cashTag: cash ? cash.tag : null,
    operatingCashFlow: ocf ? Number(ocf.val) : null,
    capex: capex ? Number(capex.val) : null,
    freeCashFlow: fcf.ok ? fcf.value : null,
    marketCap: mcap.ok ? mcap.value : null,
    pe: pe.ok ? pe.value : null,
    peBasis: pe.ok ? pe.basis : null,
    ttmEndDate: peBasisTtm.ok ? peBasisTtm.endDate : (revTtm.ok ? revTtm.endDate : null),
    reasons,
  };
}
