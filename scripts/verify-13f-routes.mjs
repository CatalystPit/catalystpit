// READING A FILING'S INDEX PAGE WHEN THE DIRECTORY LISTING IS UNAVAILABLE.
//
// EDGAR returns 503 "File Unavailable" per OBJECT, not per host — probed with the crawler stopped
// while SEC answered 200 everywhere else, individual URLs still failed persistently, and which one
// fails varies inside a single accession:
//
//   CIK 2039437  index.json 503 …but -index.htm and the .txt submission both 200
//   CIK 902367   index.json 200 …but the infotable.xml it names 503
//   CIK 2006218  index.json 503 …but the .txt submission 200, info table intact
//
// So fetchHoldings tries three independent objects. This covers the parsing half of route 2, which
// is the part that can fail silently: a regex that matches nothing does not throw, it just makes the
// route contribute no candidates, and the filing becomes a permanent hole that looks like a filer
// with nothing to report.
//
// Verified against the live failures the fallback was written for: CIK 938076 stored 2,223
// positions, 902367 stored 1,821, and 1962457 stored 104 — all previously recorded unreadable.
//
// Run: node --import ./scripts/real-db-register.mjs scripts/verify-13f-routes.mjs

import { documentNamesFromIndexHtml } from '../src/lib/institutions-universe.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.error(`  FAIL ${n}`); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Taken from the real page for accession 0001214659-24-017366.
const REAL = `
<a href="/Archives/edgar/data/2039437/000121465924017366/xslForm13F_X02/primary_doc.xml">primary_doc.xml</a>
<a href="/Archives/edgar/data/2039437/000121465924017366/primary_doc.xml">primary_doc.xml</a>
<a href="/Archives/edgar/data/2039437/000121465924017366/xslForm13F_X02/infotable.xml">infotable.xml</a>
<a href="/Archives/edgar/data/2039437/000121465924017366/infotable.xml">infotable.xml</a>`;

console.log('\n=== the real page yields the documents, each once ===');
{
  const names = documentNamesFromIndexHtml(REAL);
  ok('finds the info table', names.includes('infotable.xml'));
  ok('the xsl rendering collapses onto the raw file', names.filter((n) => n === 'infotable.xml').length === 1);
  ok('exactly the two distinct documents', eq(names, ['primary_doc.xml', 'infotable.xml']));
}

console.log('\n=== only the basename is taken ===');
{
  // The caller joins these onto the accession directory, so a path here would build a broken URL.
  const names = documentNamesFromIndexHtml(REAL);
  ok('no path separators survive', names.every((n) => !n.includes('/')));
  ok('no xsl prefix survives', names.every((n) => !/xsl/i.test(n)));
}

console.log('\n=== case and quoting variations still parse ===');
{
  ok('uppercase extension', documentNamesFromIndexHtml('<a HREF="/a/b/FORM13F.XML">x</a>').includes('FORM13F.XML'));
  ok('hyphens and digits in the name',
    documentNamesFromIndexHtml('<a href="/a/b/0001-info_table2.xml">x</a>').includes('0001-info_table2.xml'));
}

console.log('\n=== nothing is invented ===');
{
  ok('non-xml documents are ignored',
    eq(documentNamesFromIndexHtml('<a href="/a/b/doc.txt">t</a><a href="/a/b/i.htm">h</a>'), []));
  ok('a page with no links yields nothing', eq(documentNamesFromIndexHtml('<html>no links</html>'), []));
  ok('empty string yields nothing', eq(documentNamesFromIndexHtml(''), []));
  ok('a non-string yields nothing, not a crash',
    eq(documentNamesFromIndexHtml(null), []) && eq(documentNamesFromIndexHtml(undefined), []) &&
    eq(documentNamesFromIndexHtml(42), []));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
