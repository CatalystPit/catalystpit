export const runtime = 'nodejs';
export const maxDuration = 30;

// C1 — The Brief (draft generator). Each weekday ~6 AM ET, compose a send-ready Brief from
// the pit_snapshot: auto-fills catalysts / insider spotlight / Congress / headlines, and
// leaves editorial placeholders for the tape read + one risk (the parts you write). Stores it
// at KV catalystpit:brief:latest and emails the draft to BRIEF_REVIEW_EMAIL via Resend. Sending
// to subscribers (Beehiiv) + the X cross-post stay manual — an X-ready snippet is included.
const KV_TOKEN       = process.env.KV_REST_API_TOKEN;
const CRON_SECRET    = process.env.CRON_SECRET;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM           = process.env.ALERTS_FROM_EMAIL;      // reuse the alerts sender identity
const REVIEW_TO      = process.env.BRIEF_REVIEW_EMAIL;     // where the daily draft is sent
const SITE           = 'https://catalystpit.com';
const KV_BASE        = 'https://powerful-grouper-86116.upstash.io';

async function kvGet(key) {
  try {
    const r = await fetch(`${KV_BASE}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d?.result) return null;
    try { return JSON.parse(d.result); } catch { return d.result; }
  } catch { return null; }
}
async function kvSet(key, value) {
  await fetch(`${KV_BASE}/set/${encodeURIComponent(key)}`, {
    method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'text/plain' }, body: value,
  });
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const arr = (v) => Array.isArray(v) ? v : [];

function compose(snap, dateStr) {
  const catalysts = arr(snap?.catalysts);
  const insiders = arr(snap?.insiders).filter(i => i.action === 'BUY');
  const congress = arr(snap?.congress);
  const stories = arr(snap?.stories);
  const topBuy = insiders[0];
  const cong = congress[0];

  const catLines = catalysts.slice(0, 5).map(c => `${c.sym}: ${c.line} ${c.value}${c.date ? ` (${c.date})` : ''}`);
  const headLines = stories.slice(0, 3).map(s => (s.title || s.headline || '').trim()).filter(Boolean);

  // Plain-text draft
  const text = [
    `THE CATALYST BRIEF · ${dateStr}`,
    ``,
    `1) TAPE READ`,
    `[Write 2–3 sentences on overnight / pre-market context.]`,
    ``,
    `2) TODAY'S CATALYSTS`,
    ...(catLines.length ? catLines.map(l => `• ${l}`) : ['• (no catalysts in snapshot)']),
    ``,
    `3) INSIDER SPOTLIGHT`,
    topBuy ? `• ${topBuy.ticker}: ${topBuy.executive || 'Insider'} bought · ${topBuy.title || ''}`.trim() : `• (no open-market buys in snapshot)`,
    ``,
    `4) CONGRESS PRINT`,
    cong ? `• ${cong.ticker || '—'}: ${cong.representative} ${cong.action}` : `• (no Congress trades in snapshot)`,
    ``,
    `HEADLINES`,
    ...(headLines.length ? headLines.map(h => `• ${h}`) : ['• (no headlines)']),
    ``,
    `5) ONE RISK`,
    `[Write 1–2 sentences on a risk to watch.]`,
    ``,
    `catalystpit.com · filings as reported to the SEC · not financial advice`,
  ].join('\n');

  // X-ready snippet (<= ~270 chars)
  const xBits = [];
  if (topBuy) xBits.push(`insider buy: $${topBuy.ticker}`);
  if (cong) xBits.push(`Congress: $${cong.ticker || ''} ${cong.action}`.trim());
  const xPost = `Before the bell · ${xBits.join(' · ') || 'today’s catalysts'}${catalysts.length ? ` · ${catalysts.length} catalysts` : ''}. Full brief → catalystpit.com`.slice(0, 270);

  // HTML draft (for the review email — copy/paste into Beehiiv)
  const li = (s) => `<li style="margin:4px 0;">${esc(s)}</li>`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#1A2018;">
    <div style="font-size:11px;letter-spacing:1.5px;color:#3A6A48;font-weight:700;">THE CATALYST BRIEF · DRAFT</div>
    <div style="font-size:20px;font-weight:700;color:#0C1410;margin:2px 0 14px;">${esc(dateStr)}</div>

    <div style="font-size:13px;font-weight:700;color:#1E5C38;margin-top:16px;">1 · Tape read</div>
    <div style="font-size:13px;color:#8A9088;font-style:italic;">Write 2–3 sentences on overnight / pre-market context.</div>

    <div style="font-size:13px;font-weight:700;color:#1E5C38;margin-top:16px;">2 · Today's catalysts</div>
    <ul style="font-size:14px;color:#1A2018;padding-left:18px;margin:6px 0;">${(catLines.length ? catLines : ['(no catalysts in snapshot)']).map(li).join('')}</ul>

    <div style="font-size:13px;font-weight:700;color:#1E5C38;margin-top:16px;">3 · Insider spotlight</div>
    <div style="font-size:14px;margin:6px 0;">${topBuy ? `<b>${esc(topBuy.ticker)}</b> · ${esc(topBuy.executive || 'Insider')} bought${topBuy.title ? ` · ${esc(topBuy.title)}` : ''}` : '(no open-market buys in snapshot)'}</div>

    <div style="font-size:13px;font-weight:700;color:#1E5C38;margin-top:16px;">4 · Congress print</div>
    <div style="font-size:14px;margin:6px 0;">${cong ? `<b>${esc(cong.ticker || '—')}</b> · ${esc(cong.representative)} ${esc(cong.action)}` : '(no Congress trades in snapshot)'}</div>

    <div style="font-size:13px;font-weight:700;color:#1E5C38;margin-top:16px;">Headlines</div>
    <ul style="font-size:14px;color:#1A2018;padding-left:18px;margin:6px 0;">${(headLines.length ? headLines : ['(no headlines)']).map(li).join('')}</ul>

    <div style="font-size:13px;font-weight:700;color:#1E5C38;margin-top:16px;">5 · One risk</div>
    <div style="font-size:13px;color:#8A9088;font-style:italic;">Write 1–2 sentences on a risk to watch.</div>

    <div style="margin-top:20px;padding:12px;background:#F0F2EE;border-radius:8px;">
      <div style="font-size:11px;color:#5A6458;font-weight:700;margin-bottom:4px;">X / POST SNIPPET</div>
      <div style="font-size:13px;color:#1A2018;">${esc(xPost)}</div>
    </div>
    <div style="margin-top:16px;font-size:11px;color:#8A9088;">Auto-assembled from the pit snapshot. Add your tape read + risk, then send from Beehiiv. Not financial advice.</div>
  </div>`;

  return { text, html, xPost };
}

async function sendEmail(to, subject, html) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to, subject, html }),
  });
  return r.ok;
}

export async function GET(request) {
  const isVercelCron = request.headers.get('x-vercel-cron') === '1';
  if (!isVercelCron && request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`)
    return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const dateStr = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const snap = await kvGet('catalystpit:pit_snapshot');
  const { text, html, xPost } = compose(snap, dateStr);

  await kvSet('catalystpit:brief:latest', JSON.stringify({ date: dateStr, text, html, xPost, generatedAt: new Date().toISOString() }));

  let emailed = false;
  if (RESEND_API_KEY && FROM && REVIEW_TO) {
    try { emailed = await sendEmail(REVIEW_TO, `Catalyst Brief draft · ${dateStr}`, html); }
    catch (e) { console.log(`[brief] email failed: ${e.message}`); }
  }

  const summary = { ok: true, date: dateStr, hadSnapshot: !!snap, emailed, storedKey: 'catalystpit:brief:latest' };
  console.log(`[brief] ${JSON.stringify(summary)}`);
  return Response.json(summary);
}
