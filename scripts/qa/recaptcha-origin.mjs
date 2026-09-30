// IS THE www.google.com/recaptcha FRAME MINE, OR WAS IT ALREADY THERE?
//
// ⚠️ THIS DECIDES WHETHER MY CSP CHANGE INTRODUCED A VIOLATION. The brief was explicit that no new
// violations may be introduced. The blocked frame is reCAPTCHA, which is not part of AdSense — but
// "probably unrelated" is not evidence. This is a causal test: block adsbygoogle.js at the network layer
// so the loader cannot run at all, and see whether the reCAPTCHA frame still gets requested.
//
// If it still appears with AdSense dead, it was never AdSense's, and the violation predates the change.
import { attach, newTab } from './cdp.mjs';

const p = await attach(await newTab());
await p.viewport(1440, 900, false);

const run = async (blockAdsense) => {
  await p.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  let stop = false;
  let i = 0;
  (async () => {
    while (!stop) {
      while (i < p.events.length) {
        const m = p.events[i++];
        if (m.method !== 'Fetch.requestPaused') continue;
        const { requestId, request } = m.params;
        try {
          if (blockAdsense && /pagead2\.googlesyndication\.com|googleads\.g\.doubleclick\.net|adtrafficquality/.test(request.url)) {
            await p.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
          } else {
            await p.send('Fetch.continueRequest', { requestId });
          }
        } catch { /* request already gone */ }
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  })();

  const mark = p.events.length;
  await p.goto('https://www.catalystpit.com/', { settleMs: 2200, ceilingMs: 35_000 });
  await new Promise((r) => setTimeout(r, 9000));
  stop = true;
  await p.send('Fetch.disable').catch(() => {});

  const recaptcha = [];
  const adsense = [];
  for (const ev of p.events.slice(mark)) {
    if (ev.method !== 'Network.requestWillBeSent') continue;
    const u = ev.params?.request?.url || '';
    if (/www\.google\.com\/recaptcha/.test(u)) {
      recaptcha.push({ url: u.slice(0, 70), type: ev.params.type, init: ev.params.initiator?.type,
        initUrl: (ev.params.initiator?.url || ev.params.initiator?.stack?.callFrames?.[0]?.url || '').slice(0, 70) });
    }
    if (/adsbygoogle\.js/.test(u)) adsense.push(u.slice(0, 60));
  }
  const viol = p.collected.consoleErrors.filter((e) => /Content Security Policy directive/i.test(e));
  return { recaptcha, adsenseRequests: adsense.length, violations: viol.length,
    violHosts: viol.map((e) => (e.match(/'(https?:\/\/[^']+)'/) || [])[1]) };
};

console.log('--- A · normal page (AdSense allowed) ---');
const a = await run(false);
console.log(JSON.stringify(a, null, 2));

console.log('\n--- B · AdSense blocked at the network layer ---');
const b = await run(true);
console.log(JSON.stringify(b, null, 2));

console.log('\nVERDICT:');
console.log(b.recaptcha.length > 0
  ? '  The reCAPTCHA frame is requested even with AdSense dead → PRE-EXISTING, not introduced by the CSP change.'
  : '  The reCAPTCHA frame disappears when AdSense is blocked → it IS the loader, and the change introduced it.');
p.close();
