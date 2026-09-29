import { computeMarketBreadth } from '../../../../lib/market-breadth.server.mjs';
import { recordJobRun } from '../../../../lib/job-heartbeat';

// Recompute the market-breadth snapshot from stored daily candles.
//
// ⚠️ THE MARKET IS MEASURED HERE, ONCE. The aggregate walks 52 weeks of history for every eligible
// security — a few hundred thousand candle rows, ~3.5s — and writes ONE row that every homepage read
// then fetches by primary key. This is the job that keeps a market-wide scan off the critical path of
// every page load.
//
// No market-data provider is called: the only input is ticker_daily_candles, which the existing ingest
// maintains. So this can run as often as the candles change and no more.
//
// Idempotent. Running it twice on the same candles writes the same numbers.

export const runtime = 'nodejs';
export const maxDuration = 60;

const CRON_SECRET = process.env.CRON_SECRET;

export async function GET(request) {
  const isVercelCron = request.headers.get('x-vercel-cron') === '1';
  if (!isVercelCron && request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const out = await computeMarketBreadth();
    console.log(`[market-breadth] ${JSON.stringify(out)}`);
    try {
      await recordJobRun('market-breadth', {
        ok: out.ok !== false,
        seen: out.universe || 0,
        note: out.ok === false ? String(out.reason)
          : `${out.as_of_session} · adv ${out.adv}/${out.adv_eligible} · hi ${out.new_high} lo ${out.new_low}`
            + ` · >50 ${out.above_sma50}/${out.sma50_eligible} · >200 ${out.above_sma200}/${out.sma200_eligible} · ${out.ms}ms`,
      });
    } catch { /* a heartbeat is not the work; never fail the run on it */ }
    return Response.json(out);
  } catch (e) {
    console.log(`[market-breadth] failed: ${e.message}`);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
