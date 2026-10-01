/**
 * THE SEC XBRL CONCEPTS CATALYST PIT READS, AND THE RULES THAT MAKE EACH ONE SAFE.
 *
 * ── ⚠️ WHY A REGISTRY AND NOT A LIST OF TAG NAMES ────────────────────────────
 *
 * A tag name alone is not enough to read a fact correctly. Four things have to travel with it:
 *
 *   kind       An INSTANT fact (balance sheet) and a DURATION fact (income, cash flow) are read
 *              differently, summed differently, and a duration fact has a period length that must be
 *              checked. Deciding this by sniffing for a `start` field at read time — which the existing
 *              /api/financials does — works, but it means every caller re-derives it.
 *   unit       `USD` and `USD-per-shares` are different frame endpoints. A concept read with the wrong
 *              unit silently returns nothing, which looks exactly like "this company does not report it".
 *   chain      The tag a company uses for the SAME fact varies by era and by industry. Measured on the
 *              live frames API: AAPL and MU report revenue as
 *              RevenueFromContractWithCustomerExcludingAssessedTax; NVDA reports it as Revenues. Neither
 *              is wrong. A single tag would silently lose a third of the market.
 *   period     Whether a 3-month, 12-month or point-in-time window is the valid one.
 *
 * ── ⚠️ THE AAPL STALE-REVENUES TRAP, WHICH IS WHY `chain` IS ORDERED BY RECENCY AND NOT BY PREFERENCE ──
 *
 * Apple's companyfacts contains BOTH revenue tags. `Revenues` is the pre-ASC-606 tag and its data ends
 * in 2018; `RevenueFromContractWithCustomerExcludingAssessedTax` is the live one. A naive "first tag that
 * exists wins" therefore reads Apple's 2018 revenue as current, and it does so confidently and forever,
 * because the stale tag never disappears. The same shape bites any company that changed tags: the old
 * series is still there, still valid for its own period, and still wrong as an answer to "what is
 * revenue now".
 *
 * So a chain is never resolved by position. It is resolved by WHICH CANDIDATE HAS THE LATEST PERIOD END
 * for the period being asked about, with position used only to break a genuine tie. See resolveChain in
 * xbrl-facts.mjs — the rule lives there because it needs the facts, but it is documented here because
 * this is where somebody will come looking when they add a concept.
 */

/** A fact measured over a span of time: income statement, cash flow. */
export const DURATION = 'duration';
/** A fact measured at a point in time: balance sheet, share counts. */
export const INSTANT = 'instant';

/**
 * ⚠️ COMPANY-EXTENSION CONCEPTS ARE DELIBERATELY ABSENT, AND MUST STAY ABSENT.
 *
 * A company may define its own concepts in its own namespace. They are real facts and they are NOT
 * comparable across issuers: two companies' extensions can share a name and mean different things. Every
 * entry below is a standard `us-gaap` or `dei` concept, and the ingestion refuses any taxonomy not named
 * here, so an extension cannot be read as if it were standard. If a specific extension ever has to be
 * supported it needs its own entry, its own validation, and a provenance value that says so.
 */
const ALLOWED_TAXONOMIES = new Set(['us-gaap', 'dei']);
export const isAllowedTaxonomy = (t) => ALLOWED_TAXONOMIES.has(String(t));

/**
 * One metric Catalyst Pit publishes, and everything needed to read it.
 *
 * `chain` is in rough preference order for TIE-BREAKING ONLY. Recency decides.
 */
export const CONCEPTS = Object.freeze({
  // ── INCOME STATEMENT (duration) ──────────────────────────────────────────
  revenue: {
    label: 'Revenue',
    kind: DURATION,
    unit: 'USD',
    taxonomy: 'us-gaap',
    // ⚠️ THE ORDER HERE IS NOT THE SELECTION RULE. See the trap note above.
    chain: [
      'RevenueFromContractWithCustomerExcludingAssessedTax',
      'Revenues',
      'RevenueFromContractWithCustomerIncludingAssessedTax',
      // Banks and insurers report revenue as interest + non-interest income and frequently tag neither
      // of the above. `Revenues` covers most; this covers some of the rest.
      'RevenuesNetOfInterestExpense',
    ],
  },
  operatingIncome: {
    label: 'Operating income',
    kind: DURATION,
    unit: 'USD',
    taxonomy: 'us-gaap',
    chain: ['OperatingIncomeLoss'],
  },
  netIncome: {
    label: 'Net income',
    kind: DURATION,
    unit: 'USD',
    taxonomy: 'us-gaap',
    // ⚠️ THE PARENT-COMPANY FIGURE FIRST. NetIncomeLoss is net income attributable to the PARENT, which
    // is the number an EPS denominator belongs to. The ...IncludingPortionAttributableToNoncontrollingInterest
    // variant includes minority interests and is a different quantity; it is a last resort, never a peer.
    chain: ['NetIncomeLoss', 'ProfitLoss'],
  },
  epsBasic: {
    label: 'EPS basic',
    kind: DURATION,
    unit: 'USD-per-shares',
    taxonomy: 'us-gaap',
    chain: ['EarningsPerShareBasic', 'EarningsPerShareBasicAndDiluted'],
    perShare: true,
  },
  epsDiluted: {
    label: 'EPS diluted',
    kind: DURATION,
    unit: 'USD-per-shares',
    taxonomy: 'us-gaap',
    // A company with no dilutive securities reports a single combined figure; it is the diluted number.
    chain: ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted'],
    perShare: true,
  },

  // ── BALANCE SHEET (instant) ──────────────────────────────────────────────
  assets: { label: 'Total assets', kind: INSTANT, unit: 'USD', taxonomy: 'us-gaap', chain: ['Assets'] },
  liabilities: { label: 'Total liabilities', kind: INSTANT, unit: 'USD', taxonomy: 'us-gaap', chain: ['Liabilities'] },
  equity: {
    label: "Stockholders' equity",
    kind: INSTANT,
    unit: 'USD',
    taxonomy: 'us-gaap',
    // ⚠️ PARENT EQUITY FIRST, for the same reason as net income: StockholdersEquity excludes
    // noncontrolling interests. The ...IncludingPortion variant is a different quantity and is only a
    // fallback for filers that report no parent-only figure at all.
    chain: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
  },
  cash: {
    label: 'Cash & equivalents',
    kind: INSTANT,
    unit: 'USD',
    taxonomy: 'us-gaap',
    // ⚠️ "RELIABLY IDENTIFIABLE" IS THE BRIEF'S WORD AND IT MATTERS HERE. The second tag includes
    // RESTRICTED cash, which is not the same thing as cash available to the business. It is accepted only
    // when the unrestricted figure is absent, and the provenance records which tag answered — so a reader
    // comparing two companies can see that they were measured differently.
    chain: [
      'CashAndCashEquivalentsAtCarryingValue',
      'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
    ],
  },

  // ── SHARES (instant, dei namespace) ──────────────────────────────────────
  sharesOutstanding: {
    label: 'Shares outstanding',
    kind: INSTANT,
    unit: 'shares',
    taxonomy: 'dei',
    // ⚠️ THE COVER-PAGE COUNT, AND IT IS NOT FREE FLOAT. dei:EntityCommonStockSharesOutstanding is the
    // count the registrant states on the cover of its own filing. Free float — shares excluding
    // restricted and closely-held stock — is not published by SEC as a single reported fact and is NOT
    // derivable from this. Nothing in this codebase may label this as float; see the note in
    // lib/finra-short-interest.mjs for what that mislabelling cost.
    chain: ['EntityCommonStockSharesOutstanding'],
  },

  // ── CASH FLOW (duration) ─────────────────────────────────────────────────
  //
  // ⚠️ ANNUAL ONLY, AND THAT IS A MEASURED LIMIT RATHER THAN A PREFERENCE. Cash-flow statements are
  // reported CUMULATIVELY from the fiscal year start, so a company almost never publishes a discrete
  // 3-month operating-cash-flow fact. Measured on the live frames API: the CY2026Q2 quarterly frame for
  // NetCashProvidedByUsedInOperatingActivities contains 334 filers and excludes AAPL and MU, while the
  // CY2025 annual frame contains 5,767 and includes both. Reading the quarterly frame would have
  // produced cash-flow coverage of about 6% and called it complete.
  operatingCashFlow: {
    label: 'Operating cash flow',
    kind: DURATION,
    unit: 'USD',
    taxonomy: 'us-gaap',
    annualOnly: true,
    chain: [
      'NetCashProvidedByUsedInOperatingActivities',
      'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations',
    ],
  },
  capex: {
    label: 'Capital expenditures',
    kind: DURATION,
    unit: 'USD',
    taxonomy: 'us-gaap',
    annualOnly: true,
    // ⚠️ CAPEX HAS NO SINGLE STANDARD TAG, which is why free cash flow is only published when the capex
    // fact is actually present rather than assumed to be zero. PaymentsToAcquirePropertyPlantAndEquipment
    // is the common one; the second is used by filers that combine PP&E with intangibles. A company that
    // reports neither gets a null capex and therefore a null free cash flow — not a free cash flow equal
    // to operating cash flow, which is what treating an absent capex as 0 would produce.
    chain: [
      'PaymentsToAcquirePropertyPlantAndEquipment',
      'PaymentsToAcquireProductiveAssets',
    ],
  },
});

/** Every concept key, for iteration. */
export const CONCEPT_KEYS = Object.freeze(Object.keys(CONCEPTS));

/** Concept keys that are read from quarterly duration frames (and therefore feed the TTM engine). */
export const QUARTERLY_KEYS = Object.freeze(
  CONCEPT_KEYS.filter((k) => CONCEPTS[k].kind === DURATION && !CONCEPTS[k].annualOnly));

/** Concept keys read from instant frames. */
export const INSTANT_KEYS = Object.freeze(CONCEPT_KEYS.filter((k) => CONCEPTS[k].kind === INSTANT));

/** Concept keys read from annual duration frames only. */
export const ANNUAL_ONLY_KEYS = Object.freeze(CONCEPT_KEYS.filter((k) => CONCEPTS[k].annualOnly));

/**
 * The EPS basis the product publishes as "EPS", stated once so no surface can quietly pick the other.
 *
 * ⚠️ DILUTED, AND THE EXISTING CODE DISAGREED WITH ITSELF ABOUT THIS. /api/financials read
 * EarningsPerShareDiluted while lib/sec-earnings.mjs read EarningsPerShareBasic, so the statements tab
 * and the earnings history could show different EPS for the same quarter and both be "correct". Diluted
 * is the conservative figure, is what a P/E is conventionally quoted on, and is what a reader comparing
 * two companies expects. Basic remains available as its own field, clearly labelled.
 */
export const PE_EPS_BASIS = 'epsDiluted';
export const PE_EPS_BASIS_LABEL = 'trailing twelve-month diluted EPS';
