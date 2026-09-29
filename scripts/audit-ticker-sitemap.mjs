// IS EVERY URL WE ADVERTISE ACTUALLY THE URL WE SAY IT IS?
//
//   BASE=https://www.catalystpit.com node scripts/audit-ticker-sitemap.mjs [--sample 300]
//
// ⚠️ A SITEMAP IS A SET OF CLAIMS, and each one is checkable: this URL exists, it answers 200 without
// a redirect, it is indexable, and its canonical is itself. A file that advertises redirects, noindex
// pages or URLs that canonicalise elsewhere spends crawl budget teaching Google to trust it less.
//
// Structure is checked over EVERY entry. The per-URL fetches are sampled, because 21,000 requests is
// a load test rather than an audit — the sample is random each run, so a systematic defect surfaces.
const BASE = process.env.BASE || 'https://www.catalystpit.com';
const SAMPLE = Number((/--sample\s+(\d+)/.exec(process.argv.join(' ')) || [])[1] || 300);

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);

const t0 = Date.now();
const res = await fetch(`${BASE}/sitemap.xml`);
const xml = await res.text();
const ms = Date.now() - t0;
console.log(`sitemap: HTTP ${res.status} · ${xml.length.toLocaleString('en-US')} bytes · ${ms}ms`);

const entries = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => {
  const b = m[1];
  const g = (t) => (new RegExp(`<${t}>([^<]*)</${t}>`).exec(b) || [])[1] || null;
  return { loc: g('loc'), lastmod: g('lastmod'), changefreq: g('changefreq'), priority: g('priority') };
});
const tickers = entries.filter((e) => /\/ticker\//.test(e.loc || ''));
const sym = (e) => decodeURIComponent(e.loc.split('/ticker/')[1] || '');
console.log(`entries: ${entries.length} total · ${tickers.length} ticker · ${entries.length - tickers.length} static`);

L('structure, over every entry');
{
  const CANON = /^https:\/\/www\.catalystpit\.com\/ticker\/[A-Z][A-Z0-9.-]{0,9}$/;
  const bad = tickers.filter((e) => !CANON.test(e.loc));
  ok('⚠️ every ticker URL is www, uppercase, bare and canonically shaped', bad.length === 0,
    bad.slice(0, 5).map((e) => e.loc).join(' '));
  const apex = entries.filter((e) => /^https:\/\/catalystpit\.com/.test(e.loc || ''));
  ok('⚠️ no apex URL anywhere in the file', apex.length === 0, `${apex.length}`);
  const seen = new Set(); const dupes = [];
  for (const e of tickers) { if (seen.has(e.loc)) dupes.push(e.loc); seen.add(e.loc); }
  ok('no duplicate ticker URLs', dupes.length === 0, dupes.slice(0, 5).join(' '));
  ok('no query string or fragment', !tickers.some((e) => /[?#]/.test(e.loc)));
  ok('no trailing slash', !tickers.some((e) => /\/$/.test(e.loc)));

  // ⚠️ NO FABRICATED METADATA. changefreq and priority are ignored by Google, and on 20,000-plus
  // entries they were bytes stating the protocol's own defaults.
  ok('⚠️ no changefreq on ticker entries', !tickers.some((e) => e.changefreq));
  ok('⚠️ no priority on ticker entries', !tickers.some((e) => e.priority));

  // lastmod, where present, must be a real past date.
  const withMod = tickers.filter((e) => e.lastmod);
  const today = new Date().toISOString().slice(0, 10);
  ok(`lastmod present on ${withMod.length} of ${tickers.length} ticker entries`, true);
  ok('⚠️ every lastmod is a valid date', withMod.every((e) => !Number.isNaN(Date.parse(e.lastmod))),
    withMod.find((e) => Number.isNaN(Date.parse(e.lastmod)))?.lastmod || '');
  ok('⚠️ no lastmod in the future', !withMod.some((e) => e.lastmod.slice(0, 10) > today),
    withMod.filter((e) => e.lastmod.slice(0, 10) > today).slice(0, 3).map((e) => `${sym(e)}=${e.lastmod}`).join(' '));
  // A build-time timestamp would stamp every entry with the same instant.
  const distinct = new Set(withMod.map((e) => e.lastmod.slice(0, 10))).size;
  ok('⚠️ lastmod is per-page, not one build timestamp', distinct > 30, `${distinct} distinct dates`);

  ok('the file is inside Google\'s 50,000-URL limit', entries.length <= 50000, `${entries.length}`);
  ok('the file is inside Google\'s 50MB uncompressed limit', xml.length <= 50 * 1024 * 1024,
    `${(xml.length / 1048576).toFixed(2)}MB`);
}

L(`each advertised URL is what the file claims (random sample of ${SAMPLE})`);
{
  const pick = [...tickers].sort(() => Math.random() - 0.5).slice(0, SAMPLE);
  const m = (h, re) => (re.exec(h) || [])[1] || null;
  let redirects = 0, noindexed = 0, mismatched = 0, missingIdentity = 0, notOk = 0, checked = 0;
  const bad = { redirect: [], noindex: [], canonical: [], identity: [], status: [] };

  const CONC = 8;
  for (let i = 0; i < pick.length; i += CONC) {
    await Promise.all(pick.slice(i, i + CONC).map(async (e) => {
      let r, html = '';
      try {
        r = await fetch(e.loc, { redirect: 'manual' });
        if (r.status === 200) html = await r.text();
      } catch (err) { notOk++; bad.status.push(`${sym(e)} ${err.message}`); return; }
      checked++;
      if (r.status >= 300 && r.status < 400) { redirects++; bad.redirect.push(`${sym(e)} ${r.status} -> ${r.headers.get('location')}`); return; }
      if (r.status !== 200) { notOk++; bad.status.push(`${sym(e)} ${r.status}`); return; }
      if (/noindex/.test(m(html, /<meta name="robots" content="([^"]*)"/) || '')) { noindexed++; bad.noindex.push(sym(e)); }
      if (m(html, /<link rel="canonical" href="([^"]*)"/) !== e.loc) { mismatched++; bad.canonical.push(`${sym(e)} -> ${m(html, /<link rel="canonical" href="([^"]*)"/)}`); }
      // "Identity" means the page names the security: an h1 carrying more than the bare symbol.
      const h1 = (/<h1[\s\S]*?<\/h1>/.exec(html) || [''])[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (!h1 || h1 === sym(e)) { missingIdentity++; bad.identity.push(sym(e)); }
    }));
  }
  console.log(`  checked ${checked}`);
  ok('⚠️ no advertised URL redirects', redirects === 0, bad.redirect.slice(0, 6).join(' · '));
  ok('⚠️ no advertised URL is noindex', noindexed === 0, bad.noindex.slice(0, 10).join(' '));
  ok('⚠️ every advertised URL canonicalises to itself', mismatched === 0, bad.canonical.slice(0, 6).join(' · '));
  ok('no advertised URL fails to answer 200', notOk === 0, bad.status.slice(0, 6).join(' · '));
  // Not a hard failure: a named security with no datasets is a thin page, not a broken one. Reported
  // so the number is visible rather than assumed.
  console.log(`  pages whose heading is the bare symbol: ${missingIdentity} of ${checked}`
    + `${bad.identity.length ? ' — ' + bad.identity.slice(0, 12).join(' ') : ''}`);
}

L('robots agrees with the file');
{
  const rb = await (await fetch(`${BASE}/robots.txt`)).text();
  ok('⚠️ the sitemap is declared on the canonical www host',
    /Sitemap:\s*https:\/\/www\.catalystpit\.com\/sitemap\.xml/.test(rb), rb.match(/Sitemap:.*/)?.[0] || '');
  ok('⚠️ Host, where present, is the canonical www host',
    !/^Host:/m.test(rb) || /Host:\s*https:\/\/www\.catalystpit\.com/.test(rb), rb.match(/Host:.*/)?.[0] || '');
  ok('⚠️ /_next/ is not blocked — the renderer needs the CSS and JS', !/Disallow:\s*\/_next/.test(rb));
  ok('⚠️ nothing blocks /ticker/', !/Disallow:\s*\/ticker/.test(rb));
  for (const p of ['/api/', '/account', '/settings/', '/sign-in', '/sign-up', '/u/'])
    ok(`private area still disallowed: ${p}`, new RegExp(`Disallow:\\s*${p.replace(/[/]/g, '\\/')}`).test(rb));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
