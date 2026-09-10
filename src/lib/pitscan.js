import 'server-only';
// ─────────────────────────────────────────────────────────────────────────────
//  PIT SCAN — CatalystPit proprietary momentum / abnormal-activity engine.
//  PRIVATE. This module is server-only (the `server-only` import above makes any
//  client import a BUILD ERROR). Weights, thresholds, normalization curves and
//  qualification rules live here and MUST NOT be returned to the client. The API
//  layer strips every scored row down to the approved output fields — see
//  pitscan-feed.js `toPublicRow()`. Do not import this from a 'use client' file.
//
//  It answers "what is experiencing the fastest increase in abnormal market
//  activity RIGHT NOW?" — Pit Pressure = how unusual the stock already is;
//  Pit Ignition = whether that abnormality is accelerating this moment.
// ─────────────────────────────────────────────────────────────────────────────

const EPS = 1e-9;
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const logistic = (x, mid, k) => 1 / (1 + Math.exp(-k * (x - mid)));
const ratio100 = (r, mid, k) => 100 * logistic(r, mid, k);          // ratio (1 = normal) → 0..100
const mag100 = (m, mid, k) => 100 * logistic(m, mid, k);            // magnitude → 0..100
function percentile(v, arr) {                                        // 0..100 percentile rank
  if (!Array.isArray(arr) || arr.length < 8) return null;
  let c = 0; for (const x of arr) if (x <= v) c++;
  return clamp((c / arr.length) * 100, 0, 100);
}

// ── PRIVATE tuning (do not expose) ──
const W = { rvol: 0.20, volAccel: 0.20, priceVel: 0.20, priceAccel: 0.15, range: 0.10, liq: 0.10, loc: 0.05 };
const K = { // logistic midpoints/steepness per metric — the "shape" of each normalization
  rvolMid: 1.5, rvolK: 2.2,
  volAbnMid: 1.6, volAbnK: 2.0, volAccMid: 1.4, volAccK: 2.4, volAbnWeight: 0.65,
  velMid: 1.2, velK: 1.7,
  accMid: 1.0, accK: 1.8,
  rangeMid: 1.5, rangeK: 1.9,
  liqMid: 1.5, liqK: 1.8,
  locBand: 0.03,                       // within 3% of HOD/LOD = strong
  ignMid: 0, ignK: 0.14,               // pressure-delta → ignition
  catFreshMin: 120,                    // a catalyst is "fresh" for 2h
};
const LIQ_MIN_DOLLAR_VOL = 2_000_000;  // daily $ volume floor before a name can rank
const OUTLIER_RET = 0.60;              // a >60% 1-min move is treated as a bad tick and clamped

const sum = (a) => a.reduce((s, x) => s + (x || 0), 0);

// input = per-ticker intraday snapshot + private baselines + pressure history (all server-side):
//   { ticker, price, prevClose, dayHigh, dayLow, cumVolToday, marketCap, float, avgDollarVol,
//     bars:[{t,o,h,l,c,v,vw}...] oldest→newest,
//     baselines:{ cumVolTod, avg1mVolTod, avg1mDollarTod, sd1m, sd3m, sd5m, normRange5m,
//                 rvolTodHist:[], pressureDeltaHist:[] },
//     pressureHistory:[{t,pressure}...], catalyst:{type,agoMin}|null, nowTs }
// Returns the FULL internal object (never sent to client) or null if it can't/ shouldn't rank.
export function scoreTicker(input) {
  if (!input || !Array.isArray(input.bars) || input.bars.length < 6) return null;
  const b = input.bars, n = b.length;
  const price = input.price ?? b[n - 1].c;
  if (!(price > 0)) return null;

  // liquidity gate — one odd print in an illiquid name must not trigger Pit Scan
  if (price < 1 || (input.avgDollarVol ?? 0) < LIQ_MIN_DOLLAR_VOL) return null;
  const bl = input.baselines || {};

  // clamped 1-min returns (outlier / bad-tick protection)
  const ret = (a, z) => { const p0 = b[a]?.c, p1 = b[z]?.c; if (!(p0 > 0) || !(p1 > 0)) return 0; return clamp(p1 / p0 - 1, -OUTLIER_RET, OUTLIER_RET); };
  const RET_1M = ret(n - 2, n - 1);
  const RET_3M = ret(n - 4, n - 1);
  const RET_5M = ret(n - 6, n - 1);

  // 1) Time-of-day RVOL
  const RVOL_TOD = (input.cumVolToday ?? 0) / Math.max(bl.cumVolTod ?? 0, EPS);
  const rvolScore = percentile(RVOL_TOD, bl.rvolTodHist) ?? ratio100(RVOL_TOD, K.rvolMid, K.rvolK);

  // 2) Volume acceleration (weight abnormality > raw acceleration)
  const vol1 = b[n - 1].v || 0;
  const rate3 = sum(b.slice(n - 3).map((x) => x.v)) / 3;
  const rate5 = sum(b.slice(n - 5).map((x) => x.v)) / 5;
  const VOL_ACCEL_RAW = vol1 / Math.max(rate5, EPS);
  const VOL_ABNORMALITY = vol1 / Math.max(bl.avg1mVolTod ?? 0, EPS);
  const volAccelScore = clamp(
    K.volAbnWeight * ratio100(VOL_ABNORMALITY, K.volAbnMid, K.volAbnK) +
    (1 - K.volAbnWeight) * ratio100(VOL_ACCEL_RAW, K.volAccMid, K.volAccK), 0, 100);

  // 3) Price velocity (z vs the stock's OWN intraday behavior; most weight to 1m & 3m)
  const z1 = RET_1M / Math.max(bl.sd1m ?? 0, EPS);
  const z3 = RET_3M / Math.max(bl.sd3m ?? 0, EPS);
  const z5 = RET_5M / Math.max(bl.sd5m ?? 0, EPS);
  const velMag = 0.45 * Math.abs(z1) + 0.35 * Math.abs(z3) + 0.20 * Math.abs(z5);
  const priceVelScore = mag100(velMag, K.velMid, K.velK);

  // 4) Price acceleration — moving FASTER than a moment ago
  const velNow = RET_1M, velPrev = ret(n - 3, n - 2);
  const acc1 = (velNow - velPrev) / Math.max(bl.sd1m ?? 0, EPS);
  const ret3prev = n >= 7 ? ret(n - 7, n - 4) : 0;
  const acc3 = (RET_3M - ret3prev) / Math.max(bl.sd3m ?? 0, EPS);
  const priceAccelScore = mag100(0.6 * Math.abs(acc1) + 0.4 * Math.abs(acc3), K.accMid, K.accK);

  // 5) Range expansion
  const last5 = b.slice(n - 5);
  const RANGE_5M = Math.max(...last5.map((x) => x.h)) - Math.min(...last5.map((x) => x.l));
  const RANGE_EXPANSION = RANGE_5M / Math.max(bl.normRange5m ?? 0, EPS);
  const rangeScore = mag100(RANGE_EXPANSION, K.rangeMid, K.rangeK);

  // 6) Dollar-volume pressure (normalizes $2 vs $200 names)
  const vwap1 = b[n - 1].vw || price;
  const DOLLAR_VOL_RATIO = (vol1 * vwap1) / Math.max(bl.avg1mDollarTod ?? 0, EPS);
  const liqScore = mag100(DOLLAR_VOL_RATIO, K.liqMid, K.liqK);

  // direction (independent bull/bear) from the 3-min drift, refined by day location
  const dir = RET_3M >= 0 ? 'bull' : 'bear';

  // 7) HOD/LOD location — reward proximity to the extreme in the move's direction
  const distHod = input.dayHigh > 0 ? (input.dayHigh - price) / input.dayHigh : 1;
  const distLod = input.dayLow > 0 ? (price - input.dayLow) / input.dayLow : 1;
  const locDist = dir === 'bull' ? distHod : distLod;
  const locationScore = clamp(100 * (1 - clamp(locDist / K.locBand, 0, 1)), 0, 100);

  // 8) Catalyst reaction — modest bonus, neutral (not zero) when none is fresh
  let catalystScore = 50, catalystType = null;
  if (input.catalyst && input.catalyst.agoMin != null && input.catalyst.agoMin <= K.catFreshMin) {
    catalystScore = clamp((priceVelScore + volAccelScore + rangeScore) / 3, 0, 100);
    catalystType = input.catalyst.type || 'Catalyst';
  }
  const catalystBonus = clamp((catalystScore - 50) / 5, 0, 10);

  // ── Pit Pressure ──
  const pressure = W.rvol * rvolScore + W.volAccel * volAccelScore + W.priceVel * priceVelScore +
    W.priceAccel * priceAccelScore + W.range * rangeScore + W.liq * liqScore + W.loc * locationScore;
  const pitPressure = clamp(pressure + catalystBonus, 0, 100);

  // ── Pit Ignition — is Pit Pressure itself accelerating? ──
  const pAt = (agoMin) => {
    const hist = input.pressureHistory; if (!Array.isArray(hist) || !hist.length) return null;
    const target = (input.nowTs ?? Date.now()) - agoMin * 60000;
    let best = null, bestD = Infinity;
    for (const h of hist) { const d = Math.abs(h.t - target); if (d < bestD) { bestD = d; best = h; } }
    return bestD <= 150000 ? best.pressure : null;   // within 2.5 min of the target
  };
  const p1 = pAt(1), p3 = pAt(3), p5 = pAt(5);
  const d1 = p1 == null ? 0 : pitPressure - p1;
  const d3 = p3 == null ? 0 : pitPressure - p3;
  const d5 = p5 == null ? 0 : pitPressure - p5;
  const ignRaw = 0.50 * d1 + 0.30 * d3 + 0.20 * d5;
  const pitIgnition = percentile(ignRaw, bl.pressureDeltaHist) ?? (100 * logistic(ignRaw, K.ignMid, K.ignK));

  // ── Ranking: pressure + ignition, with high ignition able to temporarily outrank ──
  let rankScore = 0.60 * pitPressure + 0.40 * pitIgnition;
  if (pitIgnition >= 80 && pitIgnition > pitPressure) rankScore += (pitIgnition - pitPressure) * 0.20;
  rankScore = clamp(rankScore, 0, 100);

  // ── Signal state ──
  const strong = [rvolScore, volAccelScore, priceVelScore, rangeScore].filter((s) => s >= 65).length;
  let signal = null;
  if (pitPressure >= 88 || (rvolScore >= 90 && priceVelScore >= 80)) signal = 'EXTREME';
  else if (pitIgnition >= 75 && strong >= 3) signal = 'IGNITION';
  else if (pitPressure >= 60 || (pitIgnition >= 65 && strong >= 2)) signal = 'HEATING';
  else if (pitPressure >= 42 || strong >= 1) signal = 'WATCHING';
  if (!signal) return null;   // doesn't qualify

  return {
    ticker: input.ticker,
    // approved-for-output values:
    price, prevClose: input.prevClose ?? null,
    changePct: input.prevClose > 0 ? (price / input.prevClose - 1) * 100 : null,
    rvol: RVOL_TOD, volume: input.cumVolToday ?? null,
    marketCap: input.marketCap ?? null, float: input.float ?? null,
    catalyst: catalystType, direction: dir, signal,
    pitPressure: Math.round(pitPressure), pitIgnition: Math.round(pitIgnition),
    triggeredAt: input.nowTs ?? Date.now(),
    // PRIVATE (never leaves the server — stripped by toPublicRow):
    _rankScore: rankScore,
    _sub: { rvolScore, volAccelScore, priceVelScore, priceAccelScore, rangeScore, liqScore, locationScore, catalystScore },
  };
}
