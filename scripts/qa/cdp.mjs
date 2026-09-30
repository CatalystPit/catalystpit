// A minimal Chrome DevTools Protocol driver for production user-journey QA.
//
// ⚠️ WHY A REAL BROWSER AND NOT curl + A REGEX. Almost every Catalyst Pit surface is client-rendered:
// the ticker page, Pit Scan, the Terminal, the Screener and the Politicians board all paint from
// fetches that run after hydration. Fetching HTML and string-matching reports a page as broken when it
// is fine, and — far worse — reports it as fine when the client threw. This executes the page.
//
// No new dependency: Chrome is already installed and Node has a global WebSocket.

const HOST = '127.0.0.1:9222';

export async function targets() {
  return (await (await fetch(`http://${HOST}/json/list`)).json()).filter((t) => t.type === 'page');
}

export async function newTab() {
  const r = await fetch(`http://${HOST}/json/new?about:blank`, { method: 'PUT' });
  return r.json();
}

/** One page session. Collects console errors, page errors and failed requests as it goes. */
export async function attach(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  const events = [];
  const collected = { consoleErrors: [], pageErrors: [], failed: [], requests: [], responses: [] };

  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id != null) {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result); }
      return;
    }
    events.push(msg);
    const { method, params } = msg;
    // ⚠️ EXCEPTIONS AND CONSOLE ERRORS ARE DIFFERENT SIGNALS. A React hydration mismatch arrives as a
    // console error; an uncaught throw arrives as an exception. Missing either hides a real defect.
    if (method === 'Runtime.consoleAPICalled' && (params.type === 'error' || params.type === 'assert')) {
      collected.consoleErrors.push(params.args?.map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 400));
    }
    if (method === 'Runtime.exceptionThrown') {
      const d = params.exceptionDetails;
      collected.pageErrors.push(String(d?.exception?.description || d?.text || 'error').slice(0, 400));
    }
    if (method === 'Log.entryAdded' && params.entry?.level === 'error') {
      collected.consoleErrors.push(String(params.entry.text).slice(0, 400));
    }
    if (method === 'Network.requestWillBeSent') {
      collected.requests.push({ url: params.request.url, id: params.requestId, at: params.timestamp });
    }
    if (method === 'Network.responseReceived') {
      collected.responses.push({ url: params.response.url, status: params.response.status, id: params.requestId });
      if (params.response.status >= 400) collected.failed.push(`${params.response.status} ${params.response.url}`);
    }
    if (method === 'Network.loadingFailed' && !params.canceled) {
      collected.failed.push(`FAILED ${params.errorText} ${collected.requests.find((r) => r.id === params.requestId)?.url || ''}`);
    }
  };

  const send = (method, params = {}) => new Promise((res, rej) => {
    const myId = ++id;
    pending.set(myId, { res, rej });
    ws.send(JSON.stringify({ id: myId, method, params }));
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); rej(new Error(`${method} timed out`)); } }, 45_000);
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Log.enable');

  return {
    send, collected, events,
    close: () => ws.close(),

    /** Emulate a device. 390px is the iPhone-class width the QA brief names. */
    async viewport(width, height, mobile = false) {
      await send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: mobile ? 3 : 1, mobile,
        screenWidth: width, screenHeight: height,
      });
      if (mobile) await send('Emulation.setUserAgentOverride', {
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      });
    },

    /**
     * Navigate and wait for the page to actually settle.
     *
     * ⚠️ `load` IS NOT SETTLED FOR THIS PRODUCT. Every surface paints from post-hydration fetches, so
     * the honest wait is "no new network request for a quiet period, or a hard ceiling". Measuring to
     * `load` would report every page as fast and every client-rendered panel as empty.
     */
    async goto(url, { settleMs = 900, ceilingMs = 20_000 } = {}) {
      collected.consoleErrors.length = 0; collected.pageErrors.length = 0;
      collected.failed.length = 0; collected.requests.length = 0; collected.responses.length = 0;
      const t0 = Date.now();
      await send('Page.navigate', { url });
      let lastCount = -1, quietSince = Date.now(), domReady = null;
      while (Date.now() - t0 < ceilingMs) {
        await new Promise((r) => setTimeout(r, 150));
        if (domReady == null) {
          const ready = await this.eval('document.readyState');
          if (ready === 'complete') domReady = Date.now() - t0;
        }
        if (collected.requests.length !== lastCount) { lastCount = collected.requests.length; quietSince = Date.now(); }
        else if (domReady != null && Date.now() - quietSince > settleMs) break;
      }
      return { ms: Date.now() - t0, domReadyMs: domReady, requests: collected.requests.length };
    },

    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval threw');
      return r.result?.value;
    },

    async screenshot(path) {
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const { writeFileSync } = await import('node:fs');
      writeFileSync(path, Buffer.from(r.data, 'base64'));
      return path;
    },

    /** Click the first element matching a selector, by dispatching a real click at its centre. */
    async click(selector) {
      const box = await this.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
      })()`);
      if (!box) return false;
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      return true;
    },
  };
}

/** The page-level checks every surface gets, so a defect cannot be missed by forgetting to look. */
export const PAGE_HEALTH = `(() => {
  const de = document.documentElement;
  const overflow = de.scrollWidth - de.clientWidth;
  // Elements whose box extends past the viewport: the cause of a horizontal scrollbar.
  const wide = [...document.querySelectorAll('body *')].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.right > de.clientWidth + 2 && getComputedStyle(el).position !== 'fixed';
  }).slice(0, 6).map((el) => (el.tagName + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').filter(Boolean).slice(0,2).join('.') : '')).slice(0, 70));
  // Images that resolved to nothing.
  const brokenImgs = [...document.images].filter((i) => i.complete && i.naturalWidth === 0)
    .map((i) => (i.currentSrc || i.src || '').slice(0, 90)).slice(0, 6);
  const text = (document.body.innerText || '');
  return {
    title: document.title,
    h1: [...document.querySelectorAll('h1')].map((h) => h.innerText.trim()).slice(0, 3),
    overflowPx: overflow,
    wideEls: wide,
    brokenImgs,
    imgCount: document.images.length,
    textLen: text.length,
    // Loading/failure words a real reader would see. Checked as text because that is what they read.
    skeletons: document.querySelectorAll('[class*="skel"],[class*="Skel"]').length,
    sawLoading: /Loading|loading…/.test(text),
    sawError: /(something went wrong|unavailable right now|could not load|failed to load|unexpected error)/i.test(text),
    // Any claim of live data, so it can be checked against entitlement.
    saysRealtime: /REAL-TIME|Real-time|LIVE\\b/.test(text),
    saysDelayed: /DELAYED|Delayed|delayed/.test(text),
    saysTiingo: /Tiingo/i.test(text),
  };
})()`;
