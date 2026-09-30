// TRIAL THE CANDIDATE frame-src SOURCE BEFORE SHIPPING IT.
//
// ⚠️ THE CHOICE IS NOT "ADD www.google.com OR DON'T". CSP source expressions accept a path prefix, so
// `https://www.google.com/recaptcha/` permits exactly the attestation frame the AdSense loader wants and
// nothing else on that origin — strictly tighter than the bare host every recipe lists. The catch is
// that path matching is ignored across redirects, so whether the tight form actually works is an
// empirical question, not a spec-reading one. This serves each candidate to the live page and counts.
import { attach, newTab } from './cdp.mjs';

const BASE_CSP = process.env.BASE_CSP;
if (!BASE_CSP) { console.error('BASE_CSP is required'); process.exit(1); }

const CANDIDATES = {
  'control · unchanged production policy': null,
  'tight  · https://www.google.com/recaptcha/': 'https://www.google.com/recaptcha/',
  'broad  · https://www.google.com': 'https://www.google.com',
};

const p = await attach(await newTab());
await p.viewport(1440, 900, false);

for (const [label, src] of Object.entries(CANDIDATES)) {
  const csp = src
    ? BASE_CSP.split(';').map((d) => (d.trim().startsWith('frame-src') ? `${d.trim()} ${src}` : d.trim()))
      .filter(Boolean).join('; ')
    : BASE_CSP;

  await p.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Response' }] });
  let stop = false, i = p.events.length;
  (async () => {
    while (!stop) {
      while (i < p.events.length) {
        const m = p.events[i++];
        if (m.method !== 'Fetch.requestPaused') continue;
        const { requestId, responseHeaders, responseStatusCode, resourceType } = m.params;
        try {
          if (resourceType !== 'Document' || !responseHeaders) { await p.send('Fetch.continueRequest', { requestId }); continue; }
          const headers = responseHeaders.filter((h) => !/^content-security-policy$/i.test(h.name))
            .concat([{ name: 'Content-Security-Policy', value: csp }]);
          const body = await p.send('Fetch.getResponseBody', { requestId });
          await p.send('Fetch.fulfillRequest', {
            requestId, responseCode: responseStatusCode || 200, responseHeaders: headers,
            body: body.base64Encoded ? body.body : Buffer.from(body.body, 'utf8').toString('base64'),
          });
        } catch { try { await p.send('Fetch.continueRequest', { requestId }); } catch { /* gone */ } }
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  })();

  await p.goto('https://www.catalystpit.com/', { settleMs: 2200, ceilingMs: 35_000 });
  await new Promise((r) => setTimeout(r, 9000));
  stop = true;
  await p.send('Fetch.disable').catch(() => {});

  const viol = p.collected.consoleErrors.filter((e) => /Content Security Policy directive/i.test(e));
  const hosts = viol.map((e) => { try { return new URL((e.match(/'(https?:\/\/[^']+)'/) || [])[1]).host; } catch { return '?'; } });
  // Did the loader still run, and did anything become visible?
  const state = await p.eval(`(() => {
    const f = [...document.querySelectorAll('iframe')];
    const vis = f.filter((x) => /aswift|google_ads|doubleclick/i.test(x.id + ' ' + (x.src || '')))
      .filter((x) => { const b = x.getBoundingClientRect(); return b.width > 20 && b.height > 20; });
    return { adsbygoogle: typeof window.adsbygoogle, visibleAds: vis.length,
      recaptchaFrame: f.some((x) => /www\\.google\\.com\\/recaptcha/.test(x.src || '')) };
  })()`);
  console.log(`\n${label}`);
  console.log(`   CSP violations: ${viol.length}${hosts.length ? '  → ' + [...new Set(hosts)].join(', ') : ''}`);
  console.log(`   loader ran: ${state.adsbygoogle !== 'undefined'}   recaptcha frame present: ${state.recaptchaFrame}   visible ads: ${state.visibleAds}`);
}
p.close();
