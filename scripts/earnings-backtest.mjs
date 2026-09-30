// WALK-FORWARD BACKTEST: proposed model vs the estimator in production.
//
// ⚠️ THE ONLY RULE THAT MATTERS HERE. Every prediction of event k is made from events 0..k-1 only,
// with "now" pinned to the day after event k-1. Nothing about event k — not its date, not its
// existence — is visible to either model. A backtest that leaks the answer measures nothing.
import fs from 'node:fs';
import path from 'node:path';
import { estimateNext } from '../src/lib/earnings-next.mjs';
import { estimateNextEarnings } from '../src/lib/earnings-estimate.js';

const DIR = path.join(process.cwd(), 'node_modules', '.cache', 'earnings');
const DAY = 86_400_000;
const d2ms = (s) => Date.parse(`${s}T00:00:00Z`);
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));

// ⚠️ SAME WEEK IS THE METRIC THE PROPOSED UI ACTUALLY RESTS ON. A panel headed "This Week" /
// "Next Week" is wrong only when the ticker lands in the wrong week; being a day out inside the
// right week still puts it in front of the right reader on the right Monday. Exact-day accuracy is
// the honest number for a date printed as fact — both are reported, because they answer different
// product questions.
const monday = (ms) => { const w = new Date(ms).getUTCDay(); return ms - ((w + 6) % 7) * DAY; };
const sameWeek = (predMs, actMs) => monday(predMs) === monday(actMs);

const mkStats = () => ({ n: 0, exact: 0, d1: 0, d2: 0, d3: 0, d5: 0, d7: 0, week: 0, errs: [], signed: [] });
const record = (s, err, inWeek) => {
  const a = Math.abs(err);
  s.n++; s.errs.push(a); s.signed.push(err);
  if (inWeek) s.week++;
  if (a === 0) s.exact++;
  if (a <= 1) s.d1++;
  if (a <= 2) s.d2++;
  if (a <= 3) s.d3++;
  if (a <= 5) s.d5++;
  if (a <= 7) s.d7++;
};
const pctl = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : null);
const line = (name, s) => {
  if (!s.n) return `${name.padEnd(30)}        no predictions`;
  const f = (x) => `${((x / s.n) * 100).toFixed(1)}%`.padStart(7);
  const bias = [...s.signed].sort((a, b) => a - b)[Math.floor(s.signed.length / 2)];
  return `${name.padEnd(30)} ${String(s.n).padStart(6)} ${f(s.exact)} ${f(s.d1)} ${f(s.d3)} ${f(s.d7)} ${f(s.week)} ${String(pctl(s.errs, 0.5)).padStart(5)} ${String(pctl(s.errs, 0.9)).padStart(4)} ${String(bias).padStart(5)}`;
};
const HEAD = `${''.padEnd(30)} ${'n'.padStart(6)} ${'exact'.padStart(7)} ${'<=1d'.padStart(7)} ${'<=3d'.padStart(7)} ${'<=7d'.padStart(7)} ${'week'.padStart(7)} ${'med'.padStart(5)} ${'p90'.padStart(4)} ${'bias'.padStart(5)}`;

const groups = {};
const g = (k) => (groups[k] ||= { old: mkStats(), neu: mkStats() });

let issuers = 0, withAnn = 0, annEvents = 0, usedFallback = 0, noHistory = 0;
const coverage = { total: 0, estimable4: 0, estimable8: 0 };

for (const f of files) {
  const j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  issuers++;
  coverage.total++;

  // The announcement series, de-duplicated to ONE event per quarter: an issuer sometimes files a
  // second 2.02 (an 8-K/A, or a revenue pre-release) within days of the real one, and counting both
  // would invent a quarter that never happened.
  const raw = (j.announcements || []).map((a) => a.event).filter(Boolean).sort();
  const ann = [];
  for (const d of raw) if (!ann.length || (d2ms(d) - d2ms(ann[ann.length - 1])) / DAY > 45) ann.push(d);

  const periodic = (j.periodic || []).map((p) => p.filed).filter(Boolean).sort();
  const source = ann.length >= 5 ? 'item2.02' : 'periodic-fallback';
  const series = ann.length >= 5 ? ann : periodic;
  if (ann.length >= 5) { withAnn++; annEvents += ann.length; } else usedFallback++;
  if (series.length < 4) { noHistory++; continue; }
  if (series.length >= 4) coverage.estimable4++;
  if (series.length >= 8) coverage.estimable8++;

  for (let k = 3; k < series.length; k++) {
    const asOf = d2ms(series[k - 1]) + DAY;
    const actual = d2ms(series[k]);
    const history = series.slice(0, k);

    const oldPred = (() => {
      const realNow = Date.now;
      Date.now = () => asOf;
      const r = estimateNextEarnings(history.map((d) => ({ report_date: d })));
      Date.now = realNow;
      return r;
    })();
    const newPred = estimateNext(history, asOf, { periods: (j.periodic || []).filter((p) => p.period && d2ms(p.period) < asOf) });

    const depth = k >= 8 ? '8+' : '4+';
    const buckets = ['ALL', `cap:${j.cap}`, `hist:${depth}`, `src:${source}`];
    if (oldPred) {
      const e = Math.round((d2ms(oldPred) - actual) / DAY);
      for (const b of buckets) record(g(b).old, e, sameWeek(d2ms(oldPred), actual));
    }
    if (newPred) {
      const e = Math.round((d2ms(newPred.date) - actual) / DAY);
      for (const b of buckets) record(g(b).neu, e, sameWeek(d2ms(newPred.date), actual));
    }
  }
}

console.log(`issuers cached:                 ${issuers}`);
console.log(`with >=5 Item 2.02 events:      ${withAnn}  (${((withAnn / issuers) * 100).toFixed(1)}%)`);
console.log(`fell back to 10-Q/10-K history: ${usedFallback}`);
console.log(`too little history for either:  ${noHistory}`);
console.log(`total Item 2.02 events cached:  ${annEvents}`);
console.log(`\ncoverage: >=4 events ${coverage.estimable4}/${coverage.total} (${((coverage.estimable4 / coverage.total) * 100).toFixed(1)}%)`
  + `   >=8 events ${coverage.estimable8}/${coverage.total} (${((coverage.estimable8 / coverage.total) * 100).toFixed(1)}%)`);

console.log(`\n${HEAD}`);
for (const k of Object.keys(groups)) {
  console.log('─'.repeat(HEAD.length));
  console.log(line(`${k}  OLD`, groups[k].old));
  console.log(line(`${k}  NEW`, groups[k].neu));
}
