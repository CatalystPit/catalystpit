// src/lib/form4.mjs
//
// Single shared Form 4 / 4-A parser + validator. Deliberately .mjs so BOTH the Next
// route (src/app/api/refresh) and the standalone node scripts import the SAME code —
// this retires the DRIFT WARNING in scripts/backfill-insiders.mjs, where the parser
// and schema were copy-pasted and could silently diverge.
//
// Principles:
//  - The raw SEC transaction code is preserved verbatim and NEVER replaced.
//  - Acquisition is NOT assumed to be a buy, nor disposition a sale. Only P and S are
//    open-market; everything else is OTHER. (See src/lib/insider-meaning.js.)
//  - Nothing is silently dropped. Anything that fails validation is returned as a
//    quarantine record carrying its raw source URL so it can be investigated.
//  - No network calls here; callers own fetching and rate limiting.

const extractValue = (xml, tag) =>
  xml.match(new RegExp(`<${tag}>\\s*<value>([\\s\\S]*?)</value>`))?.[1]?.trim();

const extractText = (xml, tag) =>
  xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim();

// A <tag> whose <value> may be absent because the filer footnoted the number instead,
// e.g. <transactionPricePerShare><footnoteId id="F1"/></transactionPricePerShare>.
// That is a value we DON'T have, not a malformed one — returning the raw markup here
// quarantined 55% of real rows in testing. Any residue containing markup is dropped.
const extractValueOrText = (xml, tag) => {
  const v = extractValue(xml, tag);
  if (v != null && v !== '') return v;
  const t = extractText(xml, tag);
  if (t == null || t === '' || t.includes('<')) return null;
  return t;
};

export const decodeEntities = (s) => {
  if (typeof s !== 'string') return s;
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .trim();
};

// SEC dates sometimes carry a timezone tail ("2026-03-02-05:00") that Postgres
// rejects as a date. Keep the leading YYYY-MM-DD or return null.
export const normalizeDate = (d) => {
  if (!d) return null;
  const m = String(d).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
};

const isTrue = (v) => ['true', '1'].includes(String(v ?? '').toLowerCase());

// ─── Validation bounds ──────────────────────────────────────────────────────
// Chosen to catch unit/decimal corruption without rejecting legitimate extremes.
// BRK.A trades near $700k, so the price ceiling sits above that deliberately.
export const LIMITS = {
  MAX_SHARES: 5e10,       // > total shares outstanding of any US issuer
  MAX_PRICE: 1_000_000,   // above BRK.A, so a real filing never trips it
  MAX_VALUE: 5e11,        // $500B single transaction is not real
  MAX_BACKDATE_DAYS: 1825, // transaction >5y before its filing = suspect
  FUTURE_DAYS: 3,          // small tolerance for timezone edges
};

export const QUARANTINE_REASONS = {
  MALFORMED_SHARES: 'MALFORMED_SHARES',
  MALFORMED_PRICE: 'MALFORMED_PRICE',
  ABSURD_SHARES: 'ABSURD_SHARES',
  ABSURD_PRICE: 'ABSURD_PRICE',
  ABSURD_VALUE: 'ABSURD_VALUE',
  NEGATIVE_OWNERSHIP: 'NEGATIVE_OWNERSHIP',
  MISSING_TXN_DATE: 'MISSING_TXN_DATE',
  FUTURE_TXN_DATE: 'FUTURE_TXN_DATE',
  IMPLAUSIBLE_BACKDATE: 'IMPLAUSIBLE_BACKDATE',
  ZERO_PRICE_OPEN_MARKET: 'ZERO_PRICE_OPEN_MARKET',
  VALUE_INCONSISTENT: 'VALUE_INCONSISTENT',
  UNKNOWN_TXN_CODE: 'UNKNOWN_TXN_CODE',
  NO_TICKER: 'NO_TICKER',
};

// Values filers use to mean "this issuer has no trading symbol". Not tickers.
const PLACEHOLDER_SYMBOLS = new Set(['N/A', 'NA', 'NONE', 'NULL', '-', '--', '', 'N.A.']);

// SEC Form 4 Table I/II transaction codes. Anything outside this set is quarantined
// rather than guessed at — an unrecognised code means our understanding is stale.
const KNOWN_CODES = new Set(['P', 'S', 'A', 'D', 'F', 'I', 'M', 'C', 'E', 'H', 'O', 'X', 'G', 'L', 'W', 'Z', 'J', 'K', 'U', 'V']);

// Only P and S are open-market. This mirrors insider-meaning.js and is the ONLY
// place buy/sell is decided.
export function classifyAction(code) {
  if (code === 'P') return 'BUY';
  if (code === 'S') return 'SELL';
  return 'OTHER';
}
export const isOpenMarketBuy = (row) => row.transactionCode === 'P' && !row.isDerivative;

const daysBetween = (a, b) => (new Date(a) - new Date(b)) / 86400000;

// Validate one parsed row. Returns null when clean, else { reason, detail }.
export function validateRow(row, { today = new Date() } = {}) {
  const { shares, pricePerShare, sharesOwnedAfter, transactionDate, filingDate, transactionCode } = row;

  if (!Number.isFinite(shares)) return { reason: QUARANTINE_REASONS.MALFORMED_SHARES, detail: `shares=${row.rawShares}` };
  if (shares < 0) return { reason: QUARANTINE_REASONS.MALFORMED_SHARES, detail: `negative shares ${shares}` };
  if (shares > LIMITS.MAX_SHARES) return { reason: QUARANTINE_REASONS.ABSURD_SHARES, detail: `${shares} shares exceeds ${LIMITS.MAX_SHARES}` };

  if (!Number.isFinite(pricePerShare)) return { reason: QUARANTINE_REASONS.MALFORMED_PRICE, detail: `price=${row.rawPrice}` };
  if (pricePerShare < 0) return { reason: QUARANTINE_REASONS.MALFORMED_PRICE, detail: `negative price ${pricePerShare}` };
  if (pricePerShare > LIMITS.MAX_PRICE) return { reason: QUARANTINE_REASONS.ABSURD_PRICE, detail: `$${pricePerShare}/share exceeds $${LIMITS.MAX_PRICE}` };

  const value = shares * pricePerShare;
  if (value > LIMITS.MAX_VALUE) return { reason: QUARANTINE_REASONS.ABSURD_VALUE, detail: `$${value.toFixed(0)} transaction value` };
  // totalValue must be derivable from its own parts — guards against a corrupted
  // precomputed value poisoning heatmap/aggregate sums.
  if (Number.isFinite(row.totalValue) && Math.abs(row.totalValue - value) > Math.max(1, value * 1e-6)) {
    return { reason: QUARANTINE_REASONS.VALUE_INCONSISTENT, detail: `total ${row.totalValue} != ${shares}*${pricePerShare}` };
  }

  if (sharesOwnedAfter != null && (!Number.isFinite(sharesOwnedAfter) || sharesOwnedAfter < 0)) {
    return { reason: QUARANTINE_REASONS.NEGATIVE_OWNERSHIP, detail: `ownedAfter=${sharesOwnedAfter}` };
  }

  if (!transactionDate) return { reason: QUARANTINE_REASONS.MISSING_TXN_DATE, detail: 'no transactionDate' };
  if (daysBetween(transactionDate, today) > LIMITS.FUTURE_DAYS) {
    return { reason: QUARANTINE_REASONS.FUTURE_TXN_DATE, detail: `txn ${transactionDate} is in the future` };
  }
  if (filingDate && daysBetween(filingDate, transactionDate) > LIMITS.MAX_BACKDATE_DAYS) {
    return { reason: QUARANTINE_REASONS.IMPLAUSIBLE_BACKDATE, detail: `txn ${transactionDate} filed ${filingDate}` };
  }

  if (!KNOWN_CODES.has(transactionCode)) {
    return { reason: QUARANTINE_REASONS.UNKNOWN_TXN_CODE, detail: `code "${transactionCode}"` };
  }
  // A P or S at $0 is either a data error or not really open-market. Either way it
  // must not reach the heatmap, where it would distort dollar totals.
  if ((transactionCode === 'P' || transactionCode === 'S') && shares > 0 && pricePerShare === 0) {
    return { reason: QUARANTINE_REASONS.ZERO_PRICE_OPEN_MARKET, detail: `${transactionCode} at $0 for ${shares} shares` };
  }
  return null;
}

/**
 * Parse one Form 4 / 4-A XML document.
 * @param {string} xml       raw document text
 * @param {object} filing    { accession, filingDate, indexUrl, docUrl }
 * @returns {{ rows: object[], quarantine: object[], meta: object }}
 */
export function parseForm4(xml, filing) {
  const out = { rows: [], quarantine: [], meta: {} };

  const documentType = extractText(xml, 'documentType') || '';
  // Accept amendments. The previous parser rejected anything !== '4', which silently
  // discarded every 4/A — so corrections never reached us at all.
  if (documentType !== '4' && documentType !== '4/A') return out;
  const isAmendment = documentType === '4/A';

  // Non-listed filers (funds, operating partnerships) file Form 4 with a placeholder
  // symbol. Treating those as a real ticker put 835 rows worth $29.8B under a literal
  // "N/A" ticker in production, which flowed straight into heatmap and pulse totals.
  const rawSymbol = extractText(xml, 'issuerTradingSymbol')?.toUpperCase().trim();
  const ticker = PLACEHOLDER_SYMBOLS.has(rawSymbol) ? null : rawSymbol;
  const company = decodeEntities(extractText(xml, 'issuerName'));
  const issuerCik = extractText(xml, 'issuerCik')?.replace(/^0+/, '') || null;
  const ownerCik = extractText(xml, 'rptOwnerCik')?.replace(/^0+/, '') || null;

  const periodOfReport = normalizeDate(extractText(xml, 'periodOfReport'));
  // 4/A carries the accession of the filing it corrects when the filer supplies it.
  const amendsAccession = extractText(xml, 'accessionNumber') || null;

  out.meta = { documentType, isAmendment, ticker, company, issuerCik, ownerCik, periodOfReport };

  if (!ticker) {
    out.quarantine.push({
      accession: filing.accession, issuerCik, ownerCik, ticker: null,
      filingDate: filing.filingDate, reason: QUARANTINE_REASONS.NO_TICKER,
      detail: `issuer "${company || '?'}" has no trading symbol`,
      parsed: { company, issuerCik, documentType }, rawUrl: filing.docUrl || filing.indexUrl,
    });
    return out;
  }

  const executive = decodeEntities(extractText(xml, 'rptOwnerName') || '');
  const isDirector = isTrue(extractText(xml, 'isDirector'));
  const isOfficer = isTrue(extractText(xml, 'isOfficer'));
  const isTenPercent = isTrue(extractText(xml, 'isTenPercentOwner'));
  const isOther = isTrue(extractText(xml, 'isOther'));
  const officerTitle = decodeEntities(extractText(xml, 'officerTitle') || '');
  let title;
  if (isOfficer && officerTitle) title = officerTitle;
  else if (isOfficer) title = 'Officer';
  else if (isDirector) title = 'Director';
  else if (isTenPercent) title = '10% Owner';
  else title = 'Other';

  const fnBlock = xml.match(/<footnotes>([\s\S]*?)<\/footnotes>/i)?.[1] || '';
  const footnotes = [...fnBlock.matchAll(/<footnote[^>]*>([\s\S]*?)<\/footnote>/gi)]
    .map((m) => decodeEntities(m[1].replace(/\s+/g, ' ').trim())).join('  |  ') || null;
  const footnotesMention10b5 = /10b5-?1/i.test(fnBlock);
  const affDoc = extractText(xml, 'aff10b5One');

  // Table I (non-derivative) and Table II (derivative) are both captured. Derivatives
  // are flagged, not discarded: they are excluded from open-market buy logic but are
  // needed to understand exercises and to keep the filing's record complete.
  const tables = [
    { block: xml.match(/<nonDerivativeTable>([\s\S]*?)<\/nonDerivativeTable>/)?.[1], tag: 'nonDerivativeTransaction', derivative: false },
    { block: xml.match(/<derivativeTable>([\s\S]*?)<\/derivativeTable>/)?.[1], tag: 'derivativeTransaction', derivative: true },
  ];

  for (const { block, tag, derivative } of tables) {
    if (!block) continue;
    const txns = [...block.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]);

    for (const txn of txns) {
      const transactionCode = extractText(txn, 'transactionCode') || '';
      const affTxn = extractText(txn, 'aff10b5One') ?? affDoc;
      let rule10b5_1 = null;
      if (affTxn != null && affTxn !== '') rule10b5_1 = isTrue(affTxn);
      else if (footnotesMention10b5) rule10b5_1 = true;

      const rawShares = extractValueOrText(txn, 'transactionShares');
      const rawPrice = extractValueOrText(txn, 'transactionPricePerShare');
      const rawSOA = extractValueOrText(txn, 'sharesOwnedFollowingTransaction');

      // A footnoted (non-numeric) price is absent, not zero.
      const shares = rawShares == null || rawShares === '' ? NaN : parseFloat(rawShares);
      const pricePerShare = rawPrice == null || rawPrice === '' ? 0 : parseFloat(rawPrice);
      const sharesOwnedAfter = rawSOA == null || rawSOA === '' ? null : parseFloat(rawSOA);

      const row = {
        ticker, company, executive, title,
        transactionCode,
        action: classifyAction(transactionCode),
        acquiredDisposed: extractValueOrText(txn, 'transactionAcquiredDisposedCode') || null,
        shares,
        pricePerShare,
        totalValue: (Number.isFinite(shares) ? shares : 0) * (Number.isFinite(pricePerShare) ? pricePerShare : 0),
        sharesOwnedAfter,
        securityTitle: decodeEntities(extractValueOrText(txn, 'securityTitle') || ''),
        transactionDate: normalizeDate(extractValueOrText(txn, 'transactionDate')) || periodOfReport,
        filingDate: filing.filingDate,
        accession: filing.accession,
        filingUrl: filing.indexUrl,
        issuerCik, ownerCik,
        periodOfReport,
        formType: documentType,
        isAmendment,
        amendsAccession: isAmendment ? amendsAccession : null,
        ownershipType: extractValueOrText(txn, 'directOrIndirectOwnership') || null,
        ownershipNature: decodeEntities(extractValueOrText(txn, 'natureOfOwnership') || '') || null,
        isDerivative: derivative,
        isOfficer, isDirector, isTenPctOwner: isTenPercent, isOtherRelation: isOther,
        rule10b5_1,
        footnotes,
        rawShares, rawPrice,
      };

      const bad = validateRow(row);
      if (bad) {
        out.quarantine.push({
          accession: filing.accession, issuerCik, ownerCik, ticker,
          filingDate: filing.filingDate, reason: bad.reason, detail: bad.detail,
          parsed: row, rawUrl: filing.docUrl || filing.indexUrl,
        });
        continue;
      }
      delete row.rawShares; delete row.rawPrice;
      out.rows.push(row);
    }
  }
  return out;
}
