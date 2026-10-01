import { attach, newTab } from './cdp.mjs';
const BASE = 'https://www.catalystpit.com';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const p = await attach(await newTab());
for (const mobile of [false, true]) {
  const label = mobile ? '@390px' : '@1440px';
  console.log(`\n=== Screener ${label}, anonymous ===`);
  await p.viewport(mobile ? 390 : 1440, mobile ? 844 : 900, mobile);
  // ⚠️ SAMPLE FROM FIRST PAINT: a flash that has resolved by the time you look is still a flash.
  await p.goto(`${BASE}/screener`, { settleMs: 300, ceilingMs: 40_000 });
  const samples = [];
  for (let i = 0; i < 16; i++) {
    samples.push(await p.eval(`(() => {
      const tabs = [...document.querySelectorAll('button')].filter((b) => /^(Overview|Ownership|Technical|Performance|Valuation|Financial|News)( · Pro)?$/.test((b.textContent||'').trim()));
      const own = tabs.find((b) => /^Ownership/.test((b.textContent||'').trim()));
      return { tabs: tabs.length, ownText: own ? own.textContent.trim() : null };
    })()`));
    await new Promise((r) => setTimeout(r, 300));
  }
  const ownStates = [...new Set(samples.map((s) => s.ownText).filter(Boolean))];
  ok(`${label} the Ownership tab exists`, ownStates.length > 0, JSON.stringify(ownStates));
  // ⚠️ THIS ASSERTION WAS MEASURING THE WRONG THING. It required the tab's LABEL never to change, and the
  // label does change: "Ownership" while entitlement is unknown, then "Ownership · Pro" once it resolves
  // as non-Pro. That is a label appearing, not Pro data appearing and being withdrawn, and it is the
  // deliberate side of a trade — marking the tab "· Pro" BEFORE resolution would put an upgrade badge on
  // a Pro subscriber's own tab, which is the flash item 4 names explicitly.
  //
  // What must never happen is the aggregate becoming visible, or an upgrade mark landing on a Pro user.
  // Both are asserted instead.
  // ⚠️ NOT TESTABLE FROM AN ANONYMOUS SESSION, AND SAYING SO IS THE POINT. The rule is that a PRO
  // subscriber must never see the "· Pro" mark on their own tab. For a non-Pro session the mark is
  // correct whenever it appears — my first version asserted it must be absent from the first sample and
  // failed because entitlement resolved in ~250ms, faster than the first 300ms observation. That was the
  // test measuring its own timing rather than the product. The Pro-side guarantee lives in
  // `locked = gated && pro !== true` and is exercised in verify-screener-gating; what this browser run
  // CAN establish is the one-way transition asserted below.
  ok(`${label} ⚠️ the label only ever gains the mark, never loses it`,
    (() => { const seq = samples.map((x) => / · Pro$/.test(x.ownText || '')); return seq.indexOf(true) === -1 || !seq.slice(seq.indexOf(true)).includes(false); })(),
    JSON.stringify(samples.map((x) => x.ownText)));
  await new Promise((r) => setTimeout(r, 4000));
  const v = await p.eval(`(() => {
    const tabs = [...document.querySelectorAll('button')].map((b) => (b.textContent||'').trim());
    const own = [...document.querySelectorAll('button')].find((b) => /^Ownership/.test((b.textContent||'').trim()));
    const headers = [...document.querySelectorAll('th')].map((h) => (h.textContent||'').trim().toLowerCase());
    return {
      ownLabel: own ? own.textContent.trim() : null,
      proTabs: tabs.filter((t) => / · Pro$/.test(t)),
      tickerLinks: document.querySelectorAll('a[href^="/ticker/"]').length,
      headers: headers.slice(0, 14),
      ownershipCols: headers.filter((h) => /insider|congress|fund|consensus/.test(h)),
      overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      broken: /unavailable|something went wrong/i.test(document.body.innerText)
    };
  })()`);
  // ⚠️ RESOLVED-OR-UNRESOLVED ARE BOTH ACCEPTABLE HERE, AND ONLY ONE IS INTERESTING. On a cold Vercel
  // instance the first navigation can still be unresolved after nine seconds — the meta endpoint itself
  // measures 223-341ms, so this is the page's own bundle-and-hydrate sequence, not the gate. Unresolved
  // is the FAIL-CLOSED state: no label, not selectable, no gated column. So the assertion is that the tab
  // is in one of those two states and never in a third.
  ok(`${label} ⚠️ Ownership is either marked Pro or still unresolved — never open`,
    v.ownLabel === 'Ownership · Pro' || v.ownLabel === 'Ownership', String(v.ownLabel));
  if (v.ownLabel === 'Ownership') console.log(`         (entitlement still unresolved at +9s on this load — fail-closed: no gated column, not selectable)`);
  ok(`${label} ⚠️ …and Ownership is the only locked tab`, v.proTabs.length === 1 && v.proTabs[0] === 'Ownership · Pro', JSON.stringify(v.proTabs));
  ok(`${label} ⚠️ no ownership column is rendered by default`, v.ownershipCols.length === 0, JSON.stringify(v.ownershipCols));
  ok(`${label} the basic board still renders rows`, v.tickerLinks > 10, `${v.tickerLinks}`);
  ok(`${label} …and does not report itself broken`, v.broken === false);
  ok(`${label} no horizontal overflow`, v.overflow <= 1, `${v.overflow}px`);
  // Clicking the gated tab must not switch the view.
  await p.eval(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/^Ownership/.test((x.textContent||'').trim())); if(b) b.click(); })()`);
  await new Promise((r) => setTimeout(r, 1500));
  const after = await p.eval(`[...document.querySelectorAll('th')].map(h=>(h.textContent||'').trim().toLowerCase()).filter(h=>/insider|congress|fund|consensus/.test(h)).length`);
  ok(`${label} ⚠️ clicking it does not reveal the aggregate`, after === 0, String(after));
  const hard = p.collected.pageErrors.filter((e) => !/ResizeObserver|Hydration/i.test(e));
  ok(`${label} no uncaught exception`, hard.length === 0, hard.slice(0, 1).join(''));
  console.log(`         headers: ${JSON.stringify(v.headers.slice(0, 9))}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
p.close();
process.exit(fail ? 1 : 0);
