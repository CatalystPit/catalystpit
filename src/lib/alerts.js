import { sql, eq, and, inArray, desc } from 'drizzle-orm';
import { db } from './db';
import { alerts, screenerStocks, eightkFilings, pitNotifications } from './schema';
import { getQuotes } from './market-data';
import { ensureNotifTables } from './notifications';
import { buildConds } from './screener-filters';

// ─────────────────────────────────────────────────────────────────────────────
//  Centralized alert engine. Rules live in `alerts` (per user); a cron calls
//  evaluateAlerts() which checks each active rule against current data and fires
//  an in-app notification (the existing bell) when triggered. One-shot by default
//  (active→false on fire) so it never spams; the user re-arms from the panel.
//  Adding a new alert type = add it to ALERT_TYPES + a case in `evalOne`.
// ─────────────────────────────────────────────────────────────────────────────

// UI metadata (also used to validate types on create). needsThreshold=false → event alert.
export const ALERT_TYPES = [
  { key: 'price_above',  label: 'Price above',     unit: '$', needsThreshold: true },
  { key: 'price_below',  label: 'Price below',     unit: '$', needsThreshold: true },
  { key: 'change_above', label: 'Change % above',  unit: '%', needsThreshold: true },
  { key: 'change_below', label: 'Change % below',  unit: '%', needsThreshold: true },
  { key: 'rvol_above',   label: 'Rel Vol above',   unit: '×', needsThreshold: true },
  { key: 'volume_above', label: 'Volume above',    unit: '',  needsThreshold: true },
  { key: 'news',         label: 'Fresh news (8-K)', unit: '',  needsThreshold: false },
  { key: 'halt',         label: 'Trading halt',    unit: '',  needsThreshold: false },
];
const TYPE_KEYS = new Set(ALERT_TYPES.map((t) => t.key));

let _ensured = false;
export async function ensureAlertTables() {
  if (_ensured) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS alerts (
    id SERIAL PRIMARY KEY, user_id TEXT NOT NULL, symbol TEXT, type TEXT NOT NULL,
    threshold DOUBLE PRECISION, note TEXT, active BOOLEAN NOT NULL DEFAULT TRUE,
    last_triggered_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_alerts_user ON alerts (user_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_alerts_active ON alerts (active)`);
  await db.execute(sql`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS config TEXT`);
  _ensured = true;
}

const TICKER_RE = /^[A-Z]{1,6}$/;

export async function createAlert(userId, { symbol, type, threshold, note }) {
  await ensureAlertTables();
  const sym = String(symbol || '').toUpperCase().trim();
  if (!TICKER_RE.test(sym)) throw new Error('valid symbol required');
  if (!TYPE_KEYS.has(type)) throw new Error('unknown alert type');
  const meta = ALERT_TYPES.find((t) => t.key === type);
  const thr = meta.needsThreshold ? Number(threshold) : null;
  if (meta.needsThreshold && !Number.isFinite(thr)) throw new Error('threshold required');
  await db.insert(alerts).values({ userId, symbol: sym, type, threshold: thr, note: note ? String(note).slice(0, 140) : null });
  return listAlerts(userId);
}

export async function listAlerts(userId) {
  await ensureAlertTables();
  return db.select().from(alerts).where(eq(alerts.userId, userId)).orderBy(desc(alerts.createdAt)).limit(200);
}
export async function deleteAlert(userId, id) {
  await ensureAlertTables();
  await db.delete(alerts).where(and(eq(alerts.userId, userId), eq(alerts.id, id)));
  return listAlerts(userId);
}
export async function setAlertActive(userId, id, active) {
  await ensureAlertTables();
  await db.update(alerts).set({ active: !!active, ...(active ? { lastTriggeredAt: null } : {}) }).where(and(eq(alerts.userId, userId), eq(alerts.id, id)));
  return listAlerts(userId);
}

// Run a saved-scan's filters against the screener universe → matching tickers (bounded).
async function runScanTickers(filters) {
  const conds = buildConds(filters || {});
  let q = db.select({ t: screenerStocks.ticker }).from(screenerStocks);
  if (conds.length) q = q.where(and(...conds));
  const rows = await q.limit(200);
  return rows.map((r) => r.t).filter(Boolean);
}

// "Alert when matched" — watch a saved Custom Scanner scan and notify on NEW entrants. Seeds `seen`
// with the current matches so it only fires on future additions.
export async function createScanAlert(userId, { name, filters }) {
  await ensureAlertTables();
  const nm = String(name || 'Scan').slice(0, 60);
  let seen = [];
  try { seen = await runScanTickers(filters); } catch { seen = []; }
  await db.insert(alerts).values({ userId, type: 'scan_new', note: nm, config: JSON.stringify({ filters: filters || {}, seen }) });
  return listAlerts(userId);
}

// ── KV (for the cached halt feed) ──
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
async function kvGet(k) {
  if (!KV_URL || !KV_TOKEN) return null;
  try { const r = await fetch(`${KV_URL}/get/${encodeURIComponent(k)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` }, cache: 'no-store' }); if (!r.ok) return null; const { result } = await r.json(); return result ? JSON.parse(result) : null; } catch { return null; }
}

const fmtNum = (n) => (n == null ? '' : Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `${Math.round(n / 1e3)}K` : `${n}`);

// Return a trigger message if the rule fires now, else null.
function evalOne(a, ctx) {
  const q = ctx.quotes[a.symbol] || null;
  switch (a.type) {
    case 'price_above':  return q?.price != null && q.price >= a.threshold ? `${a.symbol} crossed above $${a.threshold} (now $${q.price.toFixed(2)})` : null;
    case 'price_below':  return q?.price != null && q.price <= a.threshold ? `${a.symbol} fell below $${a.threshold} (now $${q.price.toFixed(2)})` : null;
    case 'change_above': return q?.changePct != null && q.changePct >= a.threshold ? `${a.symbol} up ${q.changePct.toFixed(1)}% (≥ ${a.threshold}%)` : null;
    case 'change_below': return q?.changePct != null && q.changePct <= a.threshold ? `${a.symbol} down ${q.changePct.toFixed(1)}% (≤ ${a.threshold}%)` : null;
    case 'volume_above': return q?.volume != null && q.volume >= a.threshold ? `${a.symbol} volume ${fmtNum(q.volume)} (≥ ${fmtNum(a.threshold)})` : null;
    case 'rvol_above': { const rv = ctx.rvol[a.symbol]; return rv != null && rv >= a.threshold ? `${a.symbol} rel-volume ${rv.toFixed(1)}× (≥ ${a.threshold}×)` : null; }
    case 'halt':       return ctx.halted.has(a.symbol) ? `${a.symbol} is HALTED` : null;
    case 'news': { const t = ctx.news[a.symbol]; return (t && new Date(t) > new Date(a.createdAt)) ? `${a.symbol} filed a new 8-K` : null; }
    default: return null;
  }
}

async function fire(a, message) {
  try {
    await ensureNotifTables();
    await db.insert(pitNotifications).values({ userId: a.userId, actorUserId: 'system', actorName: 'Pit Alerts', type: 'alert', excerpt: message });
  } catch (e) { console.log(`[alerts] notify failed: ${e.message}`); }
  await db.update(alerts).set({ active: false, lastTriggeredAt: new Date() }).where(eq(alerts.id, a.id));
}

// The engine — evaluate all active alerts against current data, fire + disarm any that trigger.
export async function evaluateAlerts() {
  await ensureAlertTables();
  const rows = await db.select().from(alerts).where(eq(alerts.active, true)).limit(2000);
  if (!rows.length) return { checked: 0, fired: 0 };

  const quoteSyms = new Set(), rvolSyms = new Set(), newsSyms = new Set();
  let needHalt = false;
  for (const a of rows) {
    if (['price_above', 'price_below', 'change_above', 'change_below', 'volume_above'].includes(a.type)) quoteSyms.add(a.symbol);
    else if (a.type === 'rvol_above') rvolSyms.add(a.symbol);
    else if (a.type === 'news') newsSyms.add(a.symbol);
    else if (a.type === 'halt') needHalt = true;
  }

  const [quotes, rvol, halted, news] = await Promise.all([
    quoteSyms.size ? getQuotes([...quoteSyms], { realtime: false }).catch(() => ({})) : {},
    (async () => {
      if (!rvolSyms.size) return {};
      try { const rs = await db.select({ t: screenerStocks.ticker, rv: screenerStocks.relVol }).from(screenerStocks).where(inArray(screenerStocks.ticker, [...rvolSyms])); return Object.fromEntries(rs.map((r) => [r.t, r.rv])); } catch { return {}; }
    })(),
    (async () => {
      if (!needHalt) return new Set();
      try { const h = await kvGet('halts:v1'); return new Set((h?.halts || []).filter((x) => !x.resumed).map((x) => x.symbol)); } catch { return new Set(); }
    })(),
    (async () => {
      if (!newsSyms.size) return {};
      try { const rs = await db.select({ t: eightkFilings.ticker, last: sql`max(${eightkFilings.filedAt})` }).from(eightkFilings).where(inArray(eightkFilings.ticker, [...newsSyms])).groupBy(eightkFilings.ticker); return Object.fromEntries(rs.map((r) => [r.t, r.last])); } catch { return {}; }
    })(),
  ]);

  const ctx = { quotes, rvol, halted, news };
  let fired = 0;
  for (const a of rows) {
    if (a.type === 'scan_new') continue;   // handled below (needs the screener query + seen diff)
    let msg = null;
    try { msg = evalOne(a, ctx); } catch { msg = null; }
    if (msg) { await fire(a, msg); fired++; }
  }

  // scan_new — repeatable: fire on NEW tickers entering a saved scan, refresh `seen`, stay armed.
  for (const a of rows) {
    if (a.type !== 'scan_new') continue;
    try {
      const cfg = a.config ? JSON.parse(a.config) : { filters: {}, seen: [] };
      const current = await runScanTickers(cfg.filters);
      const seen = new Set(cfg.seen || []);
      const fresh = current.filter((t) => !seen.has(t));
      if (fresh.length) {
        const msg = `${fresh.length} new in "${a.note || 'scan'}": ${fresh.slice(0, 6).join(', ')}${fresh.length > 6 ? '…' : ''}`;
        await fireScan(a, msg, cfg.filters, current);
        fired++;
      } else if (current.length !== (cfg.seen || []).length) {
        await db.update(alerts).set({ config: JSON.stringify({ filters: cfg.filters, seen: current }) }).where(eq(alerts.id, a.id));
      }
    } catch { /* skip this alert */ }
  }
  return { checked: rows.length, fired };
}

async function fireScan(a, message, filters, current) {
  try {
    await ensureNotifTables();
    await db.insert(pitNotifications).values({ userId: a.userId, actorUserId: 'system', actorName: 'Pit Alerts', type: 'alert', excerpt: message });
  } catch (e) { console.log(`[alerts] scan notify failed: ${e.message}`); }
  await db.update(alerts).set({ config: JSON.stringify({ filters, seen: current }), lastTriggeredAt: new Date() }).where(eq(alerts.id, a.id));
}
