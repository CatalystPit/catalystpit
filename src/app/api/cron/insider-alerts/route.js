import { db } from '../../../../lib/db';
import { insiderTrades, watchlist } from '../../../../lib/schema';
import { and, gt, lte, inArray, asc } from 'drizzle-orm';
import { clerkClient } from '@clerk/nextjs/server';

export const runtime = 'nodejs';
export const maxDuration = 60;

// C2 — insider alerts. Emails each watcher when a NEW open-market Form 4 (P/S) is ingested
// for a ticker on their watchlist. Dedup via a KV watermark on inserted_at; first run just
// sets the watermark (no backlog blast). Send via Resend REST (no SDK). Graceful 503 until
// RESEND_API_KEY + ALERTS_FROM_EMAIL are set. Opt-out = remove the ticker from the watchlist.
const KV_TOKEN       = process.env.KV_REST_API_TOKEN;
const CRON_SECRET    = process.env.CRON_SECRET;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM           = process.env.ALERTS_FROM_EMAIL;   // "CatalystPit Alerts <alerts@catalystpit.com>"
const SITE           = 'https://catalystpit.com';
const KV_BASE        = 'https://powerful-grouper-86116.upstash.io';
const WATERMARK_KEY  = 'catalystpit:alerts:insider_watermark';
const MAX_FILINGS    = 800;   // safety cap per run
const MAX_EMAILS     = 300;   // safety cap per run

async function kvGet(key) {
  try {
    const r = await fetch(`${KV_BASE}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
    if (!r.ok) return null;
    const d = await r.json();
    return d?.result ?? null;   // raw ISO string
  } catch { return null; }
}
async function kvSet(key, value) {   // persistent (no TTL) — the watermark must not expire
  await fetch(`${KV_BASE}/set/${encodeURIComponent(key)}`, {
    method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'text/plain' }, body: value,
  });
}

const fmtVal = (n) => {
  const v = Number(n);
  if (!v || isNaN(v)) return '';
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toLocaleString('en-US')}`;
};
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function buildEmail(items, tickers) {
  const subject = tickers.length === 1
    ? `New insider ${items[0].action === 'BUY' ? 'buy' : 'activity'}: ${tickers[0]}`
    : `New insider activity: ${tickers.slice(0, 3).join(', ')}${tickers.length > 3 ? '…' : ''}`;
  const rows = items.slice(0, 30).map((f) => {
    const color = f.action === 'BUY' ? '#1E5C38' : '#A83030';
    const verb = f.action === 'BUY' ? 'bought' : 'sold';
    return `<tr><td style="padding:8px 0;border-bottom:1px solid #eee;">
      <a href="${SITE}/ticker/${encodeURIComponent(f.ticker)}" style="color:#1E5C38;font-weight:700;text-decoration:none;">${esc(f.ticker)}</a>
      <span style="color:#555;"> · ${esc(f.executive || 'Insider')} ${verb}</span>
      <span style="color:${color};font-weight:700;"> ${fmtVal(f.totalValue)}</span>
      <span style="color:#999;font-size:12px;"> · ${esc(f.filingDate || '')}${f.code ? ' · ' + esc(f.code) : ''}</span>
    </td></tr>`;
  }).join('');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1A2018;">
    <div style="font-size:18px;font-weight:700;color:#0C1410;margin-bottom:4px;">New Form 4 filings on your watchlist</div>
    <div style="font-size:13px;color:#5A6458;margin-bottom:14px;">Insiders just reported open-market trades in stocks you're tracking.</div>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">${rows}</table>
    <div style="margin-top:18px;">
      <a href="${SITE}/insiders" style="background:#1E5C38;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-size:13px;font-weight:600;">See all insider trades →</a>
    </div>
    <div style="margin-top:20px;font-size:11px;color:#8A9088;line-height:1.5;">
      You're receiving this because these tickers are on your CatalystPit watchlist. Manage your list at
      <a href="${SITE}/watchlist" style="color:#1E5C38;">catalystpit.com/watchlist</a>. Filings as reported to the SEC. Not financial advice.
    </div>
  </div>`;
  return { subject, html };
}

async function sendEmail(to, subject, html) {
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to, subject, html }),
    });
    if (!r.ok) { console.log(`[insider_alerts] resend ${r.status}: ${(await r.text().catch(() => '')).slice(0, 160)}`); return false; }
    return true;
  } catch (e) { console.log(`[insider_alerts] send error: ${e.message}`); return false; }
}

export async function GET(request) {
  const isVercelCron = request.headers.get('x-vercel-cron') === '1';
  if (!isVercelCron && request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`)
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (!RESEND_API_KEY || !FROM) {
    console.log('[insider_alerts] RESEND_API_KEY / ALERTS_FROM_EMAIL not set');
    return Response.json({ ok: false, error: 'not_configured' }, { status: 503 });
  }

  const runStartIso = new Date().toISOString();
  const watermark = await kvGet(WATERMARK_KEY);
  if (!watermark) {                                        // first run — set watermark, don't blast backlog
    await kvSet(WATERMARK_KEY, runStartIso);
    console.log('[insider_alerts] initialized watermark, no backlog sent');
    return Response.json({ ok: true, initialized: true, watermark: runStartIso });
  }

  const filings = await db.select({
    ticker: insiderTrades.ticker, company: insiderTrades.company, executive: insiderTrades.executive,
    action: insiderTrades.action, totalValue: insiderTrades.totalValue,
    filingDate: insiderTrades.filingDate, code: insiderTrades.transactionCode,
  }).from(insiderTrades)
    .where(and(
      inArray(insiderTrades.action, ['BUY', 'SELL']),
      gt(insiderTrades.insertedAt, new Date(watermark)),
      lte(insiderTrades.insertedAt, new Date(runStartIso)),
    ))
    .orderBy(asc(insiderTrades.insertedAt))
    .limit(MAX_FILINGS);

  if (filings.length === 0) {
    await kvSet(WATERMARK_KEY, runStartIso);
    return Response.json({ ok: true, newFilings: 0, usersNotified: 0 });
  }

  const tickers = [...new Set(filings.map(f => f.ticker))];
  const wl = await db.select({ userId: watchlist.userId, ticker: watchlist.ticker })
    .from(watchlist).where(inArray(watchlist.ticker, tickers));

  if (wl.length === 0) {
    await kvSet(WATERMARK_KEY, runStartIso);
    return Response.json({ ok: true, newFilings: filings.length, usersNotified: 0 });
  }

  const byTicker = new Map();
  for (const f of filings) {
    if (!byTicker.has(f.ticker)) byTicker.set(f.ticker, []);
    byTicker.get(f.ticker).push(f);
  }
  const userTickers = new Map();                           // userId → Set(watched tickers with new filings)
  for (const w of wl) {
    if (!byTicker.has(w.ticker)) continue;
    if (!userTickers.has(w.userId)) userTickers.set(w.userId, new Set());
    userTickers.get(w.userId).add(w.ticker);
  }

  const client = await clerkClient();
  const users = [...userTickers.entries()].slice(0, MAX_EMAILS);
  let sent = 0, failed = 0, skipped = 0;
  for (const [userId, tset] of users) {
    let email = null;
    try {
      const u = await client.users.getUser(userId);
      email = u.emailAddresses.find(e => e.id === u.primaryEmailAddressId)?.emailAddress
        || u.emailAddresses[0]?.emailAddress || null;
    } catch { email = null; }
    if (!email) { skipped++; continue; }

    const items = [];
    for (const t of tset) for (const f of byTicker.get(t)) items.push(f);
    items.sort((a, b) => Number(b.totalValue) - Number(a.totalValue));
    const { subject, html } = buildEmail(items, [...tset]);
    (await sendEmail(email, subject, html)) ? sent++ : failed++;
  }

  await kvSet(WATERMARK_KEY, runStartIso);
  const summary = { ok: true, newFilings: filings.length, watchers: userTickers.size, sent, failed, skipped, capped: userTickers.size > MAX_EMAILS };
  console.log(`[insider_alerts] ${JSON.stringify(summary)}`);
  return Response.json(summary);
}
