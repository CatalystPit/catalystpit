import { db } from '../../../../lib/db';
import { shortInterest } from '../../../../lib/schema';
import { eq } from 'drizzle-orm';
import {
  settlementCandidates, fetchSettlementReport, mapRecord, chunk,
} from '../../../../lib/finra-short-interest.mjs';

export const runtime = 'nodejs';
export const maxDuration = 300;          // Vercel ceiling; a full report is ~22k rows / ~5 pages.

const CRON_SECRET = process.env.CRON_SECRET;

const INSERT_CHUNK = 1000;               // rows per bulk insert (10 cols → 10k params, well under PG limit)
const DEFAULT_MAX_REPORTS = 2;           // steady-state: ingest the newest unprocessed report(s)

// Insert one mapped report, chunked, ON CONFLICT (settlement_date, ticker) DO NOTHING.
// A chunk failure falls back to row-by-row so one bad row can't drop the whole chunk.
async function insertRows(rows, date, results) {
  let inserted = 0;
  for (const part of chunk(rows, INSERT_CHUNK)) {
    try {
      const got = await db.insert(shortInterest).values(part)
        .onConflictDoNothing({ target: [shortInterest.settlementDate, shortInterest.ticker] })
        .returning({ ticker: shortInterest.ticker });
      inserted += got.length;
    } catch (e) {
      console.log(`[short-interest] ${date}: chunk insert failed (${e.message}); retrying row-by-row`);
      for (const row of part) {
        try {
          const got = await db.insert(shortInterest).values(row)
            .onConflictDoNothing({ target: [shortInterest.settlementDate, shortInterest.ticker] })
            .returning({ ticker: shortInterest.ticker });
          inserted += got.length;
        } catch (e2) {
          results.failed.push({ date, ticker: row.ticker, error: e2.message });
        }
      }
    }
  }
  return inserted;
}

// Process one settlement date: fetch → map → insert. Returns true if it produced data.
async function processDate(date, results) {
  let report;
  try {
    report = await fetchSettlementReport(date);
  } catch (e) {
    console.log(`[short-interest] ${date}: fetch failed: ${e.message}`);
    results.failed.push({ date, error: e.message });
    return false;
  }
  if (!report.rows.length) {                                // 204 / empty → not published yet
    results.skipped.push(`${date}:no-data`);
    return false;
  }
  const rows = report.rows.map(mapRecord).filter((r) => r.ticker);
  const inserted = await insertRows(rows, date, results);
  const existing = rows.length - inserted;
  console.log(`[short-interest] Settlement ${date}: inserted ${inserted} rows, skipped ${existing} existing`);
  results.processed.push({ date, inserted, skippedExisting: existing, total: rows.length });
  return true;
}

export async function GET(request) {
  const isVercelCron = request.headers.get('x-vercel-cron') === '1';
  if (!isVercelCron && request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const forcedDate = searchParams.get('date');             // backfill one specific report, bypass the stop rule
  const maxReports = Math.min(Math.max(parseInt(searchParams.get('reports') ?? `${DEFAULT_MAX_REPORTS}`, 10) || DEFAULT_MAX_REPORTS, 1), 12);

  const results = { processed: [], skipped: [], failed: [], timestamp: new Date().toISOString() };

  if (forcedDate) {
    await processDate(forcedDate, results);
    return Response.json(results);
  }

  // Default sweep: newest→oldest candidates. Stop at the first date already in Postgres
  // (no point reprocessing older reports we already have); cap new reports per run.
  let newReports = 0;
  for (const date of settlementCandidates(4)) {
    const have = await db.select({ t: shortInterest.ticker }).from(shortInterest)
      .where(eq(shortInterest.settlementDate, date)).limit(1);
    if (have.length) { results.skipped.push(`${date}:already-have`); break; }
    const produced = await processDate(date, results);     // 204s just skip and we keep scanning
    if (produced && ++newReports >= maxReports) break;
  }
  return Response.json(results);
}
