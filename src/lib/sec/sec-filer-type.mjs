/**
 * IS THIS REGISTRANT A DOMESTIC FILER OR A FOREIGN PRIVATE ISSUER?
 *
 * ── ⚠️ WHY THIS IS ITS OWN STORED FACT ───────────────────────────────────────
 *
 * It is the single input that decides whether a market capitalisation may be published. SEC's
 * dei:EntityCommonStockSharesOutstanding is the registrant's ORDINARY share count; for a foreign private
 * issuer the US-listed line is an American Depositary Share representing some multiple of those shares,
 * and that ratio appears nowhere in SEC data. Multiplying ordinary shares by an ADS price is how TSM came
 * out at $11.8 trillion earlier in this work — arithmetically perfect, describing two different
 * instruments.
 *
 * ⚠️ AND IT CANNOT BE INFERRED FROM THE FRAMES. A frame row carries accn, cik, entityName, loc, start,
 * end and val — no form. `loc` is the state or country of the registrant's address, which is suggestive
 * and not the same question: a US-incorporated subsidiary of a foreign group files 10-K, and a
 * foreign-domiciled company may do so too. The only honest source for "which forms does this filer file"
 * is the filer's own submissions record.
 *
 * ── ⚠️ WHY IT IS CACHED IN THE DATABASE AND NOT FETCHED PER REQUEST ──────────
 *
 * One submissions request per registrant, and there are ~18,000 securities. SEC asks for 10 requests a
 * second and this session has already been throttled to a standstill by a job that ignored that. The
 * answer also changes about as often as a company reincorporates, so caching it is not a performance
 * trick — it is the correct shape for the data. A ticker whose filer type has not been established yet
 * gets a NULL market cap rather than an assumed one, so coverage grows without a single wrong number
 * being published on the way.
 */
import { db } from '../db';
import { sql } from 'drizzle-orm';

const UA = {
  'User-Agent': 'CatalystPit Research bcoghill88@gmail.com',
  'Accept-Encoding': 'gzip',
};
const PACE_MS = 350;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;

export const DOMESTIC = 'domestic';
export const FOREIGN = 'foreign';
export const UNKNOWN_FILER = 'unknown';

export async function ensureFilerTypeTable() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS sec_filer_type (
    cik           integer PRIMARY KEY,
    filer_type    text NOT NULL,
    forms         text,
    entity_name   text,
    source        text NOT NULL DEFAULT 'sec:submissions',
    checked_at    timestamptz NOT NULL DEFAULT now()
  )`);
  // ⚠️ THE CHECK CONSTRAINT IS THE POINT, not decoration. This column decides whether a market cap is
  // published, so a typo or a future refactor writing 'Domestic' or '' must fail at the database rather
  // than quietly resolve to "not foreign" and let an ADR through.
  await db.execute(sql`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_sec_filer_type') THEN
      ALTER TABLE sec_filer_type ADD CONSTRAINT ck_sec_filer_type
        CHECK (filer_type IN ('domestic','foreign','unknown'));
    END IF;
  END $$`);
}

/**
 * Classify one registrant from its own filing history.
 *
 * ⚠️ A WHITELIST ON THE DOMESTIC FORMS, NOT A BLACKLIST ON THE FOREIGN ONES. A registrant that files
 * neither 10-K/10-Q nor 20-F/40-F is an unknown shape — a trust, a shell, a fund — and an unknown shape
 * does not get a market cap. Returning 'unknown' rather than defaulting to domestic is what keeps the
 * failure closed.
 *
 * ⚠️ AND FOREIGN WINS A TIE. A handful of filers carry both form families across an era change. If 20-F
 * appears at all, the ADS question is live and the cap is not publishable.
 */
export function classifyForms(forms) {
  const s = new Set(forms || []);
  const foreign = s.has('20-F') || s.has('40-F') || s.has('20-F/A') || s.has('40-F/A');
  const domestic = s.has('10-K') || s.has('10-Q') || s.has('10-K/A') || s.has('10-Q/A');
  if (foreign) return FOREIGN;
  if (domestic) return DOMESTIC;
  return UNKNOWN_FILER;
}

/** Already-known filer types, as Map(cik → { filerType, forms }). */
export async function loadFilerTypes() {
  await ensureFilerTypeTable();
  const res = await db.execute(sql`select cik, filer_type, forms from sec_filer_type`);
  const out = new Map();
  for (const r of (res.rows ?? res)) out.set(Number(r.cik), { filerType: r.filer_type, forms: r.forms });
  return out;
}

/**
 * Fetch and store the filer type for one CIK.
 *
 * @returns { ok: true, filerType } | { ok: false, reason, throttled?: true }
 */
export async function resolveFilerType(cik, { fetchImpl = fetch } = {}) {
  const pad = String(cik).padStart(10, '0');
  const wait = PACE_MS - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  try {
    const r = await fetchImpl(`https://data.sec.gov/submissions/CIK${pad}.json`, { headers: UA, cache: 'no-store' });
    // ⚠️ A THROTTLE IS REPORTED, NOT SWALLOWED. Returning 'unknown' on a 429 would write a wrong answer
    // for every ticker in the batch and then cache it — the failure mode that made an earlier backfill in
    // this session report "zero fetched" as though SEC held no data.
    if (r.status === 429 || r.status >= 500) return { ok: false, reason: `sec-${r.status}`, throttled: true };
    if (!r.ok) return { ok: false, reason: `http-${r.status}` };
    const j = await r.json();
    const forms = [...new Set(j?.filings?.recent?.form || [])];
    const filerType = classifyForms(forms);
    const keep = forms.filter((f) => /^(10-K|10-Q|20-F|40-F)(\/A)?$/.test(f)).sort().join(',');
    await db.execute(sql`
      insert into sec_filer_type (cik, filer_type, forms, entity_name, source, checked_at)
      values (${Number(cik)}, ${filerType}, ${keep || null}, ${j?.name || null}, 'sec:submissions', now())
      on conflict (cik) do update set
        filer_type = excluded.filer_type, forms = excluded.forms,
        entity_name = excluded.entity_name, checked_at = now()`);
    return { ok: true, filerType, forms: keep };
  } catch (e) {
    return { ok: false, reason: `network: ${e.message}` };
  }
}
