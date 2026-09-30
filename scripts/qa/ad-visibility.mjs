// Does allowing the AdSense loader actually put an ad on the page?
//
// ⚠️ THIS IS THE QUESTION THAT DECIDES WHETHER THE CSP CHANGE IS SAFE TO SHIP. Terms section 10 says
// "We do not display advertising on the Service at this time." If unblocking the script causes auto-ads
// to render, the CSP change makes that sentence false — which is the owner's call, not mine.
//
// An aswift iframe existing is not the same as an ad being shown: AdSense creates a 0x0 container when
// nothing fills. So this measures rendered geometry and visibility, not presence.
import { attach, newTab } from './cdp.mjs';

const p = await attach(await newTab());
await p.viewport(1440, 900, false);
await p.send('Page.setBypassCSP', { enabled: true });   // the state the CSP change would create

for (const path of ['/', '/screener', '/ticker/AAPL']) {
  await p.goto('https://www.catalystpit.com' + path, { settleMs: 2500, ceilingMs: 30_000 });
  await new Promise((r) => setTimeout(r, 6000));   // auto-ads fill late
  const r = await p.eval(`(() => {
    const frames = [...document.querySelectorAll('iframe')].filter((f) => /aswift|google_ads/i.test(f.id + ' ' + (f.name || '') + ' ' + (f.src || '')));
    const ins = [...document.querySelectorAll('ins.adsbygoogle')];
    const box = (e) => { const b = e.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; };
    const visible = frames.filter((f) => { const b = f.getBoundingClientRect(); return b.width > 20 && b.height > 20; });
    return {
      adFrames: frames.length,
      adFrameSizes: frames.map(box),
      insSlots: ins.length,
      visibleAdFrames: visible.length,
      visibleSizes: visible.map(box),
      pageHeight: document.documentElement.scrollHeight,
    };
  })()`);
  console.log(`${path}`);
  console.log('   ' + JSON.stringify(r));
}
p.close();
