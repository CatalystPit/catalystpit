const TICKERS = process.argv.slice(2);
const pad = (s, n) => String(s ?? '—').padEnd(n);
console.log(pad('TICKER', 8) + pad('NEXT', 13) + pad('BASIS', 11) + pad('METHOD', 17) + pad('SERIES', 12) + pad('IMMIN', 7) + 'SPREAD');
for (const t of TICKERS) {
  const r = await fetch(`https://www.catalystpit.com/api/earnings?ticker=${t}`);
  const j = await r.json();
  const n = j.next;
  console.log(pad(t, 8) + pad(n?.date, 13) + pad(n?.basis, 11) + pad(n?.method, 17)
    + pad(n?.series, 12) + pad(n ? String(!!n.imminent) : '—', 7)
    + (n?.spreadDays != null ? `±${n.spreadDays}d` : '—')
    + (j.meta?.announcements != null ? `   ann=${j.meta.announcements}` : '')
    + (j.next === undefined ? '   <-- OLD BUILD (no next field)' : ''));
}
