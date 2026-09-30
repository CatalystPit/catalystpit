// DOES ABLY STILL CONNECT, AND WHAT DOES /terminal SHOW ANONYMOUSLY?
//
// ⚠️ ABLY DOES NOT CONNECT ON PAGE LOAD, BY DESIGN. PitDock mounts PitChat only while the chat panel is
// open — the comment in PitDock.jsx says so explicitly, to free the connection slot when collapsed. So
// "0 Ably requests on /" is the intended behaviour, not a CSP regression, and verifying the realtime
// path means opening the dock the way a customer would.
import { attach, newTab } from './cdp.mjs';

const BASE = 'https://www.catalystpit.com';
const p = await attach(await newTab());
await p.viewport(1440, 900, false);

console.log('=== 1 · open the chat dock and watch the realtime connection ===');
await p.goto(BASE + '/', { settleMs: 2200, ceilingMs: 30_000 });
await new Promise((r) => setTimeout(r, 3000));

// Find the dock toggle by what it says, not by a class name that may change.
const toggle = await p.eval(`(() => {
  const cands = [...document.querySelectorAll('button, [role="button"], a')];
  const hit = cands.find((e) => /chat|pit\\s*chat|community/i.test((e.innerText || '') + ' ' + (e.getAttribute('aria-label') || '') + ' ' + (e.title || '')));
  if (!hit) return null;
  hit.scrollIntoView({ block: 'center' });
  const r = hit.getBoundingClientRect();
  return { text: (hit.innerText || hit.getAttribute('aria-label') || '').slice(0, 40), x: r.x + r.width / 2, y: r.y + r.height / 2 };
})()`);
console.log('  dock toggle found:', JSON.stringify(toggle));

if (toggle) {
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: toggle.x, y: toggle.y, button: 'left', clickCount: 1 });
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: toggle.x, y: toggle.y, button: 'left', clickCount: 1 });
  await new Promise((r) => setTimeout(r, 9000));   // SDK from CDN, then token, then socket

  const ably = p.collected.responses.filter((r) => /ably/.test(r.url));
  const ablyFailed = p.collected.failed.filter((f) => /ably/.test(f));
  const state = await p.eval(`(() => ({
    sdkLoaded: typeof window.Ably,
    cdnTag: [...document.querySelectorAll('script')].some((s) => /cdn\\.ably\\.com/.test(s.src)),
    // ably-js exposes connection state on the Realtime instance; the app may not expose it globally, so
    // fall back to what the DOM says about the chat panel.
    panelText: (document.body.innerText.match(/.{0,60}(connect|sign in|chat).{0,60}/i) || [''])[0].slice(0, 120)
  }))()`);
  console.log('  ably SDK/CDN:', JSON.stringify(state));
  console.log('  ably responses:', JSON.stringify(ably.map((r) => `${r.status} ${new URL(r.url).host}${new URL(r.url).pathname}`.slice(0, 70))));
  console.log('  ably failures:', JSON.stringify(ablyFailed));
  const viol = p.collected.consoleErrors.filter((e) => /Content Security Policy directive/i.test(e));
  console.log('  CSP violations after opening the dock:', viol.length);
  for (const v of viol) console.log('    ' + v.slice(0, 200));
}

console.log('\n=== 2 · what /terminal actually renders to an anonymous visitor ===');
await p.goto(BASE + '/terminal', { settleMs: 2500, ceilingMs: 35_000 });
await new Promise((r) => setTimeout(r, 9000));
const term = await p.eval(`(() => {
  const t = document.body.innerText;
  return { chars: t.length, head: t.slice(0, 700) };
})()`);
console.log('  chars:', term.chars);
console.log('  ---- visible text ----');
console.log(term.head.split('\n').map((l) => '  | ' + l).join('\n'));
const tviol = p.collected.consoleErrors.filter((e) => /Content Security Policy directive/i.test(e));
console.log('  CSP violations on /terminal:', tviol.length);
p.close();
