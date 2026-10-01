// PRODUCTION VERIFICATION FOR #8, #9 AND #10.
//
// ⚠️ #9 CANNOT BE MEASURED ON REAL PIT SCAN ROWS WITHOUT A PRO ACCOUNT — /scan is Pro-gated, so an
// anonymous visitor sees the upgrade state and no rows. What CAN be measured, and is what actually
// governs the real controls, is whether the two tap rules resolve to a comfortable box at 390px. So the
// classes are applied to probe elements in the live page's own stylesheet context and the COMPUTED
// geometry is read back. Stated plainly rather than implied.
import { attach, newTab } from './cdp.mjs';
const BASE = 'https://www.catalystpit.com';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const p = await attach(await newTab());

L('#10 — the licensing probe, and no secret in a world-readable endpoint');
{
  const h = await (await fetch(`${BASE}/api/health`)).json();
  const lic = (h.checks || []).find((c) => c.name === 'licensing.realtime');
  ok('health reports the licensing state', !!lic, JSON.stringify(lic));
  ok('⚠️ …and it is ok, so an intentional state is not an alert', lic?.ok === true);
  ok('…naming which state is in force', ['live', 'stopped', 'off', 'unconfigured'].includes(lic?.state), String(lic?.state));
  ok('⚠️ overall health is not degraded by it', h.ok === true && h.status === 'healthy', String(h.status));
  const s = JSON.stringify(lic);
  ok('⚠️ no credential, token or URL is published', !/[A-Za-z0-9_-]{25,}/.test(s) && !/http/.test(s), s);
  const all = JSON.stringify(h);
  // ⚠️ THE VENDOR NAME IS NOT A SECRET, AND FORBIDDING IT WAS WRONG. This matched /TIINGO/i anywhere in
  // the payload and fired on the dividends job heartbeat note — {"ok":true,"source":"tiingo",...} —
  // which is an operational record of which provider ingested, not a credential. The vendor identity is
  // published on the legal pages by contractual requirement; what must never appear is a key, a token,
  // an authenticated URL, a plan tier or a contract term.
  const SECRETISH = /KV_REST|Bearer |[A-Za-z0-9]{32,}|upstash\.io|sk_[a-z]+_|pk_[a-z]+_|invoice|contract|plan_/i;
  ok('⚠️ no credential, token, authenticated URL, plan or contract term anywhere in the payload',
    !SECRETISH.test(all), (all.match(SECRETISH) || [])[0] || '');
  console.log(`         licensing.realtime → ${lic.state} · ${lic.note}`);
}

L('#8 — the freshness claim an anonymous visitor is served');
{
  const m = await (await fetch(`${BASE}/api/screener?meta=1`)).json();
  const f = m.capabilities?.quoteFreshness;
  ok('the capability payload states a freshness', !!f, String(f));
  ok('⚠️ an anonymous caller is NOT told realtime', f !== 'realtime', String(f));
  ok('…and no provider or plan identifier is shipped',
    !/tiingo|provider/i.test(JSON.stringify(m.capabilities || {})), JSON.stringify(m.capabilities));
  console.log(`         anonymous quoteFreshness → ${f}`);
  // The quotes API must label what it serves the same way.
  const q = await (await fetch(`${BASE}/api/quotes?symbols=AAPL`)).json();
  ok('⚠️ /api/quotes does not claim realtime for an anonymous caller',
    q.freshness !== 'realtime', String(q.freshness));
  console.log(`         anonymous /api/quotes freshness → ${q.freshness}`);
}

for (const w of [390, 360]) {
  L(`#9 — the tap rules at ${w}px, measured from the live stylesheet`);
  await p.viewport(w, 780, true);
  await p.goto(`${BASE}/scan`, { settleMs: 2000, ceilingMs: 35_000 });
  await new Promise((r) => setTimeout(r, 3500));
  const m = await p.eval(`(() => {
    const mk = (cls, inline) => {
      const b = document.createElement('button');
      b.className = cls; b.textContent = 'Board';
      Object.assign(b.style, inline);
      document.body.appendChild(b);
      const r = b.getBoundingClientRect();
      const cs = getComputedStyle(b);
      const out = { h: Math.round(r.height), w: Math.round(r.width), minH: cs.minHeight, padT: cs.paddingTop, display: cs.display };
      b.remove();
      return out;
    };
    return {
      // Reproduces the real board-tab inline style, which is what the class has to lift.
      pill: mk('cp-tap-pill', { fontSize: '11px', padding: '4px 10px', borderRadius: '999px', border: '1px solid #ccc' }),
      pillBefore: mk('', { fontSize: '11px', padding: '4px 10px', borderRadius: '999px', border: '1px solid #ccc' }),
      // ⚠️ MEASURED WITH THE INLINE padding:0 THE REAL CONTROLS USED TO CARRY, because that is what
      // defeated the rule. The controls no longer set it and the rule is now !important, so both the
      // historical and the current shape must come out comfortable.
      act: mk('cp-scan-act', { fontSize: '10.5px', padding: '0', border: 'none', background: 'none' }),
      actClean: mk('cp-scan-act', { fontSize: '10.5px', border: 'none', background: 'none' }),
      overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      pageChars: document.body.innerText.length
    };
  })()`);
  ok(`${w}px ⚠️ the untagged pill really was too small`, m.pillBefore.h <= 24, `${m.pillBefore.h}px`);
  ok(`${w}px ⚠️ the tagged pill is a comfortable target`, m.pill.h >= 36, `${m.pill.h}px (was ${m.pillBefore.h}px)`);
  ok(`${w}px …and it did not grow horizontally`, Math.abs(m.pill.w - m.pillBefore.w) <= 2,
    `${m.pillBefore.w} → ${m.pill.w}px`);
  ok(`${w}px ⚠️ the bare text action is comfortable even with an inline padding:0`, m.act.h >= 30, `${m.act.h}px`);
  ok(`${w}px …and without one`, m.actClean.h >= 30, `${m.actClean.h}px`);
  ok(`${w}px ⚠️ no horizontal overflow on the page`, m.overflow <= 1, `${m.overflow}px`);
  ok(`${w}px the page still renders`, m.pageChars > 300, `${m.pageChars} chars`);
  console.log(`         pill ${m.pillBefore.h}px → ${m.pill.h}px (min-height ${m.pill.minH}) · bare action ${m.act.h}px (inline reset) / ${m.actClean.h}px (clean)`);
}

L('#9 — desktop must be unchanged');
{
  await p.viewport(1440, 900, false);
  await p.goto(`${BASE}/scan`, { settleMs: 1500, ceilingMs: 30_000 });
  await new Promise((r) => setTimeout(r, 2500));
  const d = await p.eval(`(() => {
    const b = document.createElement('button');
    b.className = 'cp-tap-pill'; b.textContent = 'Board';
    Object.assign(b.style, { fontSize: '11px', padding: '4px 10px', borderRadius: '999px', border: '1px solid #ccc' });
    document.body.appendChild(b);
    const r = b.getBoundingClientRect(); const cs = getComputedStyle(b);
    const out = { h: Math.round(r.height), minH: cs.minHeight }; b.remove(); return out;
  })()`);
  ok('⚠️ the pill rule does not apply on desktop', d.minH === '0px' || d.minH === 'auto', `min-height ${d.minH}`);
  ok('…so the desktop pill keeps its compact height', d.h <= 26, `${d.h}px`);
  console.log(`         desktop pill ${d.h}px, min-height ${d.minH}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log('\nNOT LIVE-TESTED — needs a real account:');
console.log('  · a PRO session seeing REAL-TIME / REAL-TIME · PARTIAL on actual Pit Scan rows');
console.log('  · tapping the real board tabs and row actions on a Pro board at 390px');
console.log('  · a PRO session during an active stop order (would require throwing the switch in production)');
console.log('  All three are covered by executed assertions in scripts/verify-items-8-9-10.mjs.');
p.close();
process.exit(fail ? 1 : 0);
