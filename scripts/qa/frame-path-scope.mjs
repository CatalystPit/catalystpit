// DOES A PATH-SCOPED frame-src SOURCE ACTUALLY PERMIT THE reCAPTCHA FRAME?
//
// ⚠️ ISOLATE THE QUESTION. Trialling candidate policies against the live page failed: replacing the
// document CSP via Fetch interception also replaces it on every ad sub-frame, so the control run showed
// five violations where production shows one. The harness was measuring itself.
//
// So ask only the thing in doubt, on a page with nothing else in it: under
// `frame-src https://www.google.com/recaptcha/`, does Chrome load
// https://www.google.com/recaptcha/api2/aframe? Path matching is ignored across redirects, so this is
// empirical. A local server gives a real CSP response header — not a meta tag, which differs in subtle
// ways — and the page reports which frames loaded.
import { createServer } from 'node:http';
import { attach, newTab } from './cdp.mjs';

const TARGET = 'https://www.google.com/recaptcha/api2/aframe';
const CASES = {
  'no source (expected: blocked)': "frame-src 'self'",
  'path-scoped /recaptcha/': "frame-src 'self' https://www.google.com/recaptcha/",
  'bare host': "frame-src 'self' https://www.google.com",
};

let csp = '';
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': csp });
  res.end(`<!doctype html><html><body><iframe id="f" src="${TARGET}"></iframe></body></html>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const p = await attach(await newTab());
for (const [label, policy] of Object.entries(CASES)) {
  csp = policy;
  await p.goto(url + '?' + Date.now(), { settleMs: 700, ceilingMs: 15_000 });
  await new Promise((r) => setTimeout(r, 1500));
  const blocked = p.collected.consoleErrors.some((e) => /Content Security Policy directive/i.test(e));
  // A blocked frame stays at about:blank; a permitted one navigates (cross-origin, so probe indirectly).
  const loaded = await p.eval(`(() => {
    const f = document.getElementById('f');
    // Cross-origin frames expose a non-null contentWindow but throw on document access; a CSP-blocked
    // frame keeps its original src attribute while never navigating. The console violation is the
    // reliable signal, so report what we can see as a cross-check only.
    return { src: f.src, hasWindow: !!f.contentWindow };
  })()`);
  console.log(`  ${blocked ? 'BLOCKED ' : 'allowed '} ${label}`);
  console.log(`            policy: ${policy}`);
  if (!blocked) console.log(`            frame src still: ${loaded.src}`);
}
server.close();
p.close();
