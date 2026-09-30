// Trial a candidate CSP against the LIVE page before shipping it.
//
// ⚠️ WHY INTERCEPT RATHER THAN DEPLOY AND SEE. The question is which directives the AdSense loader
// genuinely needs, and the honest way to answer it is to serve the candidate policy to a real browser
// and count the violations it produces. Deploying a guess and reading production is the same
// experiment with users in it.
//
// The document response's Content-Security-Policy header is replaced on the fly; everything else about
// the page is production.
import { attach, newTab } from './cdp.mjs';

const CANDIDATES = {
  'A · script-src only (verification minimum)':
    "script-src 'self' 'unsafe-inline' https://pagead2.googlesyndication.com",
  'B · script + frame + connect (the measured footprint)':
    "script-src 'self' 'unsafe-inline' https://pagead2.googlesyndication.com; "
    + 'frame-src https://googleads.g.doubleclick.net https://tpc.googlesyndication.com; '
    + 'connect-src https://pagead2.googlesyndication.com https://googleads.g.doubleclick.net https://ep1.adtrafficquality.google https://ep2.adtrafficquality.google',
};

// The production policy, with the candidate's directives merged in. Kept verbatim otherwise.
const BASE_CSP = process.env.BASE_CSP;

const p = await attach(await newTab());
await p.viewport(1440, 900, false);

for (const [label, extra] of Object.entries(CANDIDATES)) {
  // Merge: for each directive the candidate names, append its sources to the base directive.
  const add = {};
  for (const d of extra.split(';')) {
    const parts = d.trim().split(/\s+/);
    if (!parts[0]) continue;
    add[parts[0]] = parts.slice(1).filter((s) => !/^'self'|'unsafe-inline'$/.test(s));
  }
  const merged = BASE_CSP.split(';').map((d) => {
    const t = d.trim(); if (!t) return null;
    const name = t.split(/\s+/)[0];
    return add[name] ? `${t} ${add[name].join(' ')}` : t;
  }).filter(Boolean);
  // A directive the base does not have at all (none here, but be correct) gets appended.
  for (const [name, srcs] of Object.entries(add)) {
    if (!merged.some((d) => d.trim().startsWith(name))) merged.push(`${name} 'self' ${srcs.join(' ')}`);
  }
  const csp = merged.join('; ') + ';';

  await p.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Response' }] });
  const handler = async (msg) => {
    if (msg.method !== 'Fetch.requestPaused') return;
    const { requestId, responseHeaders, responseStatusCode } = msg.params;
    if (!responseHeaders) { try { await p.send('Fetch.continueRequest', { requestId }); } catch {} return; }
    const isDoc = msg.params.resourceType === 'Document';
    const headers = responseHeaders
      .filter((h) => !(isDoc && /^content-security-policy$/i.test(h.name)))
      .concat(isDoc ? [{ name: 'Content-Security-Policy', value: csp }] : []);
    try {
      const body = await p.send('Fetch.getResponseBody', { requestId });
      await p.send('Fetch.fulfillRequest', {
        requestId, responseCode: responseStatusCode || 200, responseHeaders: headers,
        body: body.base64Encoded ? body.body : Buffer.from(body.body, 'utf8').toString('base64'),
      });
    } catch { try { await p.send('Fetch.continueRequest', { requestId }); } catch {} }
  };
  p.events.length = 0;
  const origOnMessage = p.send;   // handler wired via the shared event list below

  // The cdp driver pushes every event into p.events; poll it for Fetch.requestPaused.
  let stop = false;
  (async () => {
    let i = 0;
    while (!stop) {
      while (i < p.events.length) { await handler(p.events[i]); i++; }
      await new Promise((r) => setTimeout(r, 15));
    }
  })();

  await p.goto('https://www.catalystpit.com/', { settleMs: 2500, ceilingMs: 30_000 });
  await new Promise((r) => setTimeout(r, 4500));
  stop = true;
  await p.send('Fetch.disable').catch(() => {});

  const viol = [...new Set(p.collected.consoleErrors.filter((e) => /Content Security Policy/i.test(e)))];
  const blockedHosts = [...new Set(viol.map((v) => (v.match(/https?:\/\/([^/'\s]+)/) || [])[1]).filter(Boolean))];
  const adRendered = await p.eval(`document.querySelectorAll('iframe[id^="aswift"], ins.adsbygoogle').length`);
  console.log(`\n${label}`);
  console.log(`   CSP violations: ${viol.length}`);
  for (const h of blockedHosts) console.log(`     blocked host: ${h}`);
  console.log(`   ad iframes/slots rendered: ${adRendered}`);
}

p.close();
