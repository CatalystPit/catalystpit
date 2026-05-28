// scripts/seed-congress.mjs
//
// Local one-time (resumable) seed for the congress_trades table. Pulls both
// FMP chambers, joins the roster, dedups on tx_hash, then enriches
// price_at_trade (Tiingo) and current_price (Finnhub) in capped batches.
//
// Local execution only. Never deploy to Vercel.
//
// Run (re-run as many times as needed — it's idempotent, see below):
//   node --env-file=.env.local scripts/seed-congress.mjs
//
// IDEMPOTENCY (why re-runs are safe):
//   • Inserts use onConflictDoNothing(tx_hash) — a re-seen disclosure hashes to
//     the same tx_hash and is skipped. No duplicate rows, ever.
//   • price_at_trade enrichment selects ONLY rows WHERE price_at_trade IS NULL.
//     An already-priced row is never selected, so it is never re-fetched or
//     re-written. price_at_trade is write-once.
//   • current_price seeds ONLY tickers with no price row yet (LEFT JOIN … IS
//     NULL). Re-runs don't re-quote tickers already seeded; the cron keeps them
//     fresh afterwards.
// So each run only advances NULLs forward. Run it ~4x to clear the ~141-ticker
// seed under Tiingo's 50/hr cap (SEED_TIINGO_BATCH below).
//
// DRIFT WARNING: the pgTable definitions below mirror src/lib/schema.js. A
// node-run .mjs can't import that ESM-syntax .js. Keep in sync on schema change
// (same constraint as scripts/backfill-insiders.mjs).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { and, eq, isNull, isNotNull, or } from 'drizzle-orm';
import {
  pgTable, serial, text, integer, boolean, doublePrecision, date, timestamp,
} from 'drizzle-orm/pg-core';
import { buildIndex } from '../src/lib/congress-match.mjs';
import {
  fetchCongressRows, fetchTiingoDaily, pickPriceOnOrBefore, fetchFinnhubQuote, throttle,
} from '../src/lib/congress-ingest.mjs';

const SEED_TIINGO_BATCH = 45;   // distinct null-price tickers per run (< 50/hr)

const { DATABASE_URL, FMP_API_KEY, TIINGO_API_KEY, FINNHUB_KEY } = process.env;
for (const [k, v] of Object.entries({ DATABASE_URL, FMP_API_KEY, TIINGO_API_KEY, FINNHUB_KEY })) {
  if (!v) { console.error(`[seed] ${k} not set — run with: node --env-file=.env.local scripts/seed-congress.mjs`); process.exit(1); }
}

// ── schema mirror (must match src/lib/schema.js) ──
const congressTrades = pgTable('congress_trades', {
  id: serial('id').primaryKey(),
  txHash: text('tx_hash').notNull(),
  chamber: text('chamber').notNull(),
  firstName: text('first_name'),
  lastName: text('last_name'),
  representative: text('representative'),
  memberSlug: text('member_slug'),
  party: text('party'),
  state: text('state'),
  district: text('district'),
  ticker: text('ticker'),
  assetDescription: text('asset_description'),
  assetType: text('asset_type'),
  owner: text('owner'),
  type: text('type'),
  action: text('action').notNull(),
  amountRange: text('amount_range'),
  amountMin: doublePrecision('amount_min'),
  amountMax: doublePrecision('amount_max'),
  amountMid: doublePrecision('amount_mid'),
  transactionDate: date('transaction_date', { mode: 'string' }),
  disclosureDate: date('disclosure_date', { mode: 'string' }).notNull(),
  filingLagDays: integer('filing_lag_days'),
  capGainsOver200: boolean('cap_gains_over_200'),
  comment: text('comment'),
  link: text('link'),
  priceAtTrade: doublePrecision('price_at_trade'),
  priceAtTradeDate: date('price_at_trade_date', { mode: 'string' }),
  enrichedAt: timestamp('enriched_at', { withTimezone: true }),
  insertedAt: timestamp('inserted_at', { withTimezone: true }).notNull().defaultNow(),
});
const congressTickerPrices = pgTable('congress_ticker_prices', {
  ticker: text('ticker').primaryKey(),
  currentPrice: doublePrecision('current_price'),
  asOfDate: date('as_of_date', { mode: 'string' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

const db = drizzle(neon(DATABASE_URL));
const rosterPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'congress-roster.json');
const index = buildIndex(JSON.parse(readFileSync(rosterPath, 'utf8')));

async function ingest() {
  const rows = await fetchCongressRows(FMP_API_KEY, index);
  const inserted = await db.insert(congressTrades)
    .values(rows)
    .onConflictDoNothing({ target: congressTrades.txHash })
    .returning({ id: congressTrades.id });
  console.log(`[seed] ingest: feed=${rows.length} new=${inserted.length} dupes=${rows.length - inserted.length}`);
}

async function enrichPrices() {
  const tickers = await db.selectDistinct({ ticker: congressTrades.ticker })
    .from(congressTrades)
    .where(and(isNull(congressTrades.priceAtTrade), isNotNull(congressTrades.ticker)))
    .limit(SEED_TIINGO_BATCH);
  if (!tickers.length) { console.log('[seed] price_at_trade: nothing left to enrich ✓'); return 0; }

  let priced = 0, missed = 0;
  await throttle(tickers, 2, 2000, async ({ ticker }) => {   // ~60/min — gentle on Tiingo (avoids 502 bursts)
    const rows = await db.select({ id: congressTrades.id, td: congressTrades.transactionDate })
      .from(congressTrades)
      .where(and(eq(congressTrades.ticker, ticker), isNull(congressTrades.priceAtTrade)));
    const dates = rows.map(r => r.td).filter(Boolean).sort();
    if (!dates.length) return;
    const { ok, status, data } = await fetchTiingoDaily(ticker, dates[0], dates[dates.length - 1], TIINGO_API_KEY);
    if (!ok || !Array.isArray(data)) { missed++; console.log(`[seed]   tiingo ${ticker}: HTTP ${status} (left NULL → shows "—")`); return; }
    for (const row of rows) {
      if (!row.td) continue;
      const p = pickPriceOnOrBefore(data, row.td);
      if (!p) continue;
      await db.update(congressTrades)
        .set({ priceAtTrade: p.price, priceAtTradeDate: p.priceDate, enrichedAt: new Date() })
        .where(eq(congressTrades.id, row.id));
      priced++;
    }
  });

  const [{ n: remaining }] = await db.selectDistinct({ ticker: congressTrades.ticker })
    .from(congressTrades)
    .where(and(isNull(congressTrades.priceAtTrade), isNotNull(congressTrades.ticker)))
    .then(rows => [{ n: rows.length }]);
  console.log(`[seed] price_at_trade: enriched ${priced} rows (${tickers.length} tickers this run, ${missed} unpriced) · ${remaining} distinct tickers still NULL`);
  return remaining;
}

async function seedCurrentPrices() {
  // Retry tickers with no price row OR a NULL price (rate-limit casualties),
  // so a throttled miss recovers instead of showing "—" forever. A genuinely
  // dead ticker (Finnhub c=0) re-resolves to NULL and is the true "—" set.
  const need = await db
    .selectDistinct({ ticker: congressTrades.ticker })
    .from(congressTrades)
    .leftJoin(congressTickerPrices, eq(congressTickerPrices.ticker, congressTrades.ticker))
    .where(and(
      isNotNull(congressTrades.ticker),
      or(isNull(congressTickerPrices.ticker), isNull(congressTickerPrices.currentPrice)),
    ));
  if (!need.length) { console.log('[seed] current_price: all distinct tickers already priced ✓'); return; }

  let ok = 0;
  await throttle(need, 4, 4200, async ({ ticker }) => {   // ~57/min — under Finnhub 60/min
    const q = await fetchFinnhubQuote(ticker, FINNHUB_KEY);
    await db.insert(congressTickerPrices)
      .values({ ticker, currentPrice: q ? q.price : null, asOfDate: q ? q.asOf : null, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: congressTickerPrices.ticker,
        set: { currentPrice: q ? q.price : null, asOfDate: q ? q.asOf : null, updatedAt: new Date() },
      });
    if (q) ok++;
  });
  console.log(`[seed] current_price: seeded ${ok}/${need.length} tickers`);
}

// --skip-enrich: skip the Tiingo price_at_trade step (re-run current_price only
// without spending a Tiingo batch — keeps within the 50/hr cap between full runs).
const SKIP_ENRICH = process.argv.includes('--skip-enrich');

async function main() {
  await ingest();
  const remaining = SKIP_ENRICH ? null : await enrichPrices();
  await seedCurrentPrices();
  console.log('[seed] DONE.');
  if (SKIP_ENRICH) console.log('[seed] (--skip-enrich: price_at_trade step skipped)');
  else if (remaining > 0) console.log(`[seed] ⚠ ${remaining} tickers still need price_at_trade — re-run to continue (respects Tiingo 50/hr).`);
}
main().catch(e => { console.error(`[seed] fatal: ${e.message}`); process.exit(1); });
