// THE CANONICAL MARKET TAXONOMY — one trader-facing sector per security, for the whole product.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
//
// Sectors were derived by a function that described itself accurately:
//
//     // Coarse SIC-code → GICS-ish sector (approximate; good enough for screening buckets).
//
// It was good enough for screening buckets. It is now what colours the market heatmap, and a
// heatmap is a claim about where money moved. Measured against live data, the coarse ranges put:
//
//   TSLA  in INDUSTRIALS          SIC 3711, caught by `3000-3999 → Industrials`
//   PG    in BASIC MATERIALS      SIC 2841 (soap), caught by `2800-2899 → Basic Materials`
//   PLD   in FINANCIAL SERVICES   SIC 6798 (REIT), caught by `6000-6799 → Financial Services`
//
// Tesla was the reported symptom; Procter & Gamble and Prologis are the same defect, which is why a
// ticker override would have fixed one third of a problem and hidden the rest. The skew showed in
// the totals too: 16 securities in Energy, 53 in Real Estate, 81 in Consumer Defensive.
//
// ── SIC IS A SOURCE, NOT THE TAXONOMY ────────────────────────────────────────
//
// SIC is the SEC's filing classification. Its top-level divisions are organised around what a
// company MAKES, so every manufacturer lands together — a car, a chip and a syringe share a
// division. A trader-facing taxonomy is organised around what drives the stock, which is why Tesla
// belongs with consumer cyclicals and a medical-device maker with healthcare.
//
// So SIC is translated here, deterministically, at the 4-digit level where it matters. This is not a
// guess and it is not a name-based inference: SIC codes are precise, and the old mapping was simply
// coarse. Nothing in this file looks at a company's name.
//
// ── PRECEDENCE ───────────────────────────────────────────────────────────────
//
//   1. EXACT four-digit code     the cases where a range would be wrong (3711, 2841, 6798 …)
//   2. RANGES, in listed order   first match wins, narrow ranges are listed before broad ones
//   3. null                      unknown or unmappable. NOT a sector, and never guessed.
//
// `null` is deliberate and load-bearing: a security we cannot classify must be visibly unclassified
// rather than quietly filed under whichever range happened to catch it. That is the failure this
// file exists to end.

/** The canonical top-level groups. Stable, recognisable, and the only values a sector may take. */
export const SECTORS = Object.freeze([
  'Technology',
  'Financial Services',
  'Healthcare',
  'Consumer Cyclical',
  'Consumer Defensive',
  'Communication Services',
  'Industrials',
  'Energy',
  'Basic Materials',
  'Utilities',
  'Real Estate',
]);

const S = Object.fromEntries(SECTORS.map((x) => [x, x]));

// ── 1. EXACT CODES ───────────────────────────────────────────────────────────
// Only codes whose enclosing range gives the wrong answer. Kept small on purpose: this is a
// correction list, not a classification database, and every entry is a SIC code rather than a ticker.
const EXACT = new Map(Object.entries({
  // Autos sit inside SIC's transportation-equipment block with aircraft and railcars. The stocks do
  // not trade together — TSLA, F, GM, RIVN, LCID are consumer cyclicals.
  3711: S['Consumer Cyclical'],   // motor vehicles & passenger car bodies  ← TSLA
  3713: S['Consumer Cyclical'],   // truck & bus bodies
  3714: S['Consumer Cyclical'],   // motor vehicle parts & accessories
  3715: S['Consumer Cyclical'],   // truck trailers
  3716: S['Consumer Cyclical'],   // motor homes
  3751: S['Consumer Cyclical'],   // motorcycles & bicycles
  3792: S['Consumer Cyclical'],   // travel trailers & campers

  // Household & personal products are chemistry by SIC and staples by behaviour.
  2840: S['Consumer Defensive'],  // soap & other detergents
  2841: S['Consumer Defensive'],  // soap & detergents                       ← PG
  2842: S['Consumer Defensive'],  // specialty cleaning & polishing
  2844: S['Consumer Defensive'],  // perfumes, cosmetics, toilet preparations

  // A REIT is real estate, not a financial. SIC files it in the 6700 holding/investment block.
  6798: S['Real Estate'],         // real estate investment trusts           ← PLD
  6726: S['Financial Services'],  // investment offices / closed-end funds — genuinely financial

  // Tobacco is a staple, not agriculture.
  2100: S['Consumer Defensive'], 2111: S['Consumer Defensive'],
}));

// ── 2. RANGES, FIRST MATCH WINS ──────────────────────────────────────────────
// Ordered narrow-to-broad. The ordering IS the logic, so a broad manufacturing range can no longer
// swallow semiconductors, medical devices or cars.
const RANGES = [
  // Healthcare — pharma, biotech, devices, providers.
  [2830, 2836, S.Healthcare],          // drugs, biologics, diagnostics
  [3826, 3826, S.Healthcare],          // lab analytical instruments
  [3841, 3851, S.Healthcare],          // surgical & medical instruments, devices, ophthalmic goods
  [5047, 5047, S.Healthcare],          // medical & hospital equipment wholesale
  [5122, 5122, S.Healthcare],          // drugs & proprietaries wholesale
  [8000, 8099, S.Healthcare],          // health services

  // Technology — computing, semiconductors, software, communications equipment.
  [3570, 3579, S.Technology],          // computer & office equipment
  [3661, 3669, S.Technology],          // telephone & communications equipment
  [3670, 3679, S.Technology],          // semiconductors & electronic components
  [3821, 3825, S.Technology],          // lab & measuring instruments
  [3827, 3829, S.Technology],
  [3861, 3861, S.Technology],          // photographic equipment
  [7370, 7379, S.Technology],          // software, data processing, computer services
  [5045, 5045, S.Technology],          // computers & peripherals wholesale

  // Communication Services — media, publishing, telecom carriers, entertainment.
  [2700, 2799, S['Communication Services']],   // publishing & printing
  [4800, 4899, S['Communication Services']],   // telephone, broadcasting, cable
  [7810, 7841, S['Communication Services']],   // motion pictures, video
  [7900, 7999, S['Communication Services']],   // amusement & recreation services

  // Energy — extraction through refining, and the services around them.
  [1200, 1299, S.Energy],              // coal
  [1300, 1399, S.Energy],              // oil & gas extraction
  [2900, 2999, S.Energy],              // petroleum refining
  [4610, 4613, S.Energy],              // pipelines
  [5171, 5172, S.Energy],              // petroleum wholesale

  // Utilities.
  [4900, 4999, S.Utilities],

  // Real Estate — operators and REITs.
  [6500, 6599, S['Real Estate']],

  // Financial Services — banks, brokers, insurers, holding companies.
  [6000, 6299, S['Financial Services']],
  [6300, 6499, S['Financial Services']],
  [6700, 6799, S['Financial Services']],

  // Consumer Defensive — food, beverages, staples retail.
  [2000, 2099, S['Consumer Defensive']],       // food & kindred products
  [5140, 5149, S['Consumer Defensive']],       // groceries wholesale
  [5400, 5499, S['Consumer Defensive']],       // food stores
  [5912, 5912, S['Consumer Defensive']],       // drug stores
  [5331, 5331, S['Consumer Defensive']],       // variety stores (mass merchants)

  // Consumer Cyclical — apparel, retail, restaurants, leisure, autos already handled above.
  [2200, 2399, S['Consumer Cyclical']],        // textiles & apparel
  [2510, 2599, S['Consumer Cyclical']],        // furniture
  [3020, 3021, S['Consumer Cyclical']],        // rubber & plastics footwear
  [3140, 3199, S['Consumer Cyclical']],        // footwear & leather
  [3630, 3639, S['Consumer Cyclical']],        // household appliances
  [3650, 3652, S['Consumer Cyclical']],        // household audio & video
  [3940, 3949, S['Consumer Cyclical']],        // toys & sporting goods
  [5500, 5599, S['Consumer Cyclical']],        // auto dealers
  [5600, 5699, S['Consumer Cyclical']],        // apparel retail
  [5700, 5799, S['Consumer Cyclical']],        // furniture & electronics retail
  [5800, 5899, S['Consumer Cyclical']],        // restaurants
  [5900, 5999, S['Consumer Cyclical']],        // misc retail
  [7000, 7021, S['Consumer Cyclical']],        // hotels & lodging
  [7200, 7299, S['Consumer Cyclical']],        // personal services
  [7500, 7549, S['Consumer Cyclical']],        // auto services

  // Basic Materials — mining, chemicals, paper, metals.
  [100, 999, S['Basic Materials']],            // agriculture
  [1000, 1199, S['Basic Materials']],          // metal mining
  [1400, 1499, S['Basic Materials']],          // nonmetallic minerals
  [2600, 2699, S['Basic Materials']],          // paper
  [2800, 2829, S['Basic Materials']],          // industrial chemicals
  [2850, 2899, S['Basic Materials']],          // paints, agricultural & misc chemicals
  [3200, 3299, S['Basic Materials']],          // stone, clay, glass, concrete
  [3300, 3399, S['Basic Materials']],          // primary metal industries

  // Industrials — construction, machinery, aerospace, transport, commercial services.
  [1500, 1799, S.Industrials],                 // construction
  [2400, 2499, S.Industrials],                 // lumber & wood
  [3400, 3499, S.Industrials],                 // fabricated metal
  [3500, 3569, S.Industrials],                 // industrial machinery
  [3580, 3599, S.Industrials],
  [3600, 3629, S.Industrials],                 // electrical equipment
  [3690, 3699, S.Industrials],
  [3700, 3710, S.Industrials],                 // transportation equipment (autos excluded above)
  [3720, 3729, S.Industrials],                 // aircraft & aerospace
  [3730, 3743, S.Industrials],                 // ships, railroad equipment
  [3760, 3790, S.Industrials],
  [3800, 3820, S.Industrials],
  [3900, 3939, S.Industrials],
  [3950, 3999, S.Industrials],
  [4000, 4599, S.Industrials],                 // railroads, trucking, air transport
  [4700, 4789, S.Industrials],                 // transportation services
  [5000, 5044, S.Industrials],                 // durable goods wholesale
  [5046, 5046, S.Industrials],
  [5048, 5099, S.Industrials],
  [5100, 5139, S.Industrials],                 // nondurable goods wholesale
  [5150, 5170, S.Industrials],
  [5173, 5199, S.Industrials],
  [7300, 7369, S.Industrials],                 // business services
  [7380, 7399, S.Industrials],
  [7600, 7699, S.Industrials],                 // repair services
  [8100, 8299, S.Industrials],                 // legal & educational services
  [8300, 8399, S.Industrials],                 // social services
  [8700, 8748, S.Industrials],                 // engineering, accounting, consulting
  [8900, 8999, S.Industrials],
];

/**
 * A SIC code → one canonical market sector, or null when it cannot be mapped.
 *
 * Deterministic and side-effect free. Returns null rather than a fallback sector: an unmappable
 * security must be visibly unclassified, because quietly filing it under the nearest range is the
 * exact failure this replaces.
 */
export function sicToMarketSector(code) {
  const n = typeof code === 'number' ? code : parseInt(String(code ?? '').trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const exact = EXACT.get(String(n));
  if (exact) return exact;
  for (const [lo, hi, sector] of RANGES) if (n >= lo && n <= hi) return sector;
  return null;
}

/** True when `s` is one of the canonical sectors. Anything else is not a sector we may display. */
export const isCanonicalSector = (s) => SECTORS.includes(s);
