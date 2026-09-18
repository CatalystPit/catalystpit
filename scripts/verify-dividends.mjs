// THE DIVIDEND CALENDAR: normalisation, and the promises the product makes about it.
//
// Two things are under test here and they matter for different reasons.
//
// The first is the ADAPTER BOUNDARY: a provider's JSON goes in, a canonical event comes out, and no
// vendor field name survives the crossing. That is what makes replacing Polygon an adapter change
// rather than a product rewrite, and it is only true while these assertions hold.
//
// The second is the ACCURACY RULE: nothing is ever inferred. A missing payment date stays missing, a
// company that has paid quarterly for thirty years gets no row for next quarter, and an event with
// no declaration behind it is never shown as confirmed. Those are promises to a reader who is about
// to trade on the date in front of them.
//
// Pure: no database, no network, no credentials. The ingestion tests use an injected fetch.
//
// Run: node scripts/verify-dividends.mjs

import {
  canonicalEvent, isAnnounced, eventTiming, dividendYieldPct, frequencyLabel, asDate, DIVIDEND_TYPES,
} from '../src/lib/dividends/dividend-event.mjs';
import { toCanonical, fetchWindow, SOURCE_ID } from '../src/lib/dividends/providers/polygon-dividends.mjs';
import { activeDividendProvider, dividendsPublicEnabled, dividendsVisible, dividendsDisplayMode, PROVIDERS } from '../src/lib/dividends/providers/index.mjs';
import { rangeFor, stepFor, sortEvents, groupByDate, calendarQuery, numParam, EMPTY_FILTERS } from '../src/lib/dividends/dividend-view.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) pass++; else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

const TODAY = '2026-09-18';

// A Polygon row, exactly as the endpoint returns one.
const polyRow = (over = {}) => ({
  ticker: 'AAPL', cash_amount: 0.27, currency: 'USD',
  declaration_date: '2026-07-30', ex_dividend_date: '2026-08-10',
  record_date: '2026-08-10', pay_date: '2026-08-13',
  dividend_type: 'CD', frequency: 4,
  id: 'E1e778b36bcedb4d1589a970be52c16294ad4bc89c8627d56a3b970f6cf2a6e10',
  ...over,
});

console.log('\n=== the adapter translates, and nothing vendor-shaped survives ===');
{
  const e = toCanonical(polyRow(), { asOf: TODAY });
  ok('ticker carries over', e.ticker === 'AAPL');
  ok('ex-dividend date', e.exDividendDate === '2026-08-10');
  ok('record date', e.recordDate === '2026-08-10');
  ok('declaration date', e.declarationDate === '2026-07-30');
  // The rename that matters: pay_date -> paymentDate, in the adapter and nowhere else.
  ok('pay_date becomes paymentDate', e.paymentDate === '2026-08-13');
  ok('cash amount', e.cashAmount === 0.27);
  ok('currency', e.currency === 'USD');
  ok('frequency stays a number', e.frequency === 4);
  ok('the provider id is recorded', e.source === SOURCE_ID && e.sourceEventId === polyRow().id);
  ok('annualised = amount x frequency', e.annualizedAmount === 1.08, String(e.annualizedAmount));

  // NO VENDOR FIELD NAMES on the canonical object. This is the assertion that keeps the boundary.
  const keys = Object.keys(e);
  const vendorish = keys.filter((k) => ['cash_amount', 'ex_dividend_date', 'pay_date', 'record_date', 'declaration_date', 'dividend_type', 'id'].includes(k));
  ok('no snake_case vendor keys leak into the canonical event', vendorish.length === 0, vendorish.join(', '));
  ok('type is our word, not a two-letter code', e.dividendType === 'regular');
}

console.log('\n=== types, including the special dividend ===');
{
  ok('CD is a regular dividend', toCanonical(polyRow({ dividend_type: 'CD' }), { asOf: TODAY }).dividendType === DIVIDEND_TYPES.REGULAR);
  ok('SC is a special dividend', toCanonical(polyRow({ dividend_type: 'SC' }), { asOf: TODAY }).dividendType === DIVIDEND_TYPES.SPECIAL);
  ok('LT is a capital gain', toCanonical(polyRow({ dividend_type: 'LT' }), { asOf: TODAY }).dividendType === DIVIDEND_TYPES.CAPITAL_GAIN);
  ok('ST is a capital gain', toCanonical(polyRow({ dividend_type: 'ST' }), { asOf: TODAY }).dividendType === DIVIDEND_TYPES.CAPITAL_GAIN);
  ok('an unknown code is unknown, not regular',
    toCanonical(polyRow({ dividend_type: 'ZZ' }), { asOf: TODAY }).dividendType === DIVIDEND_TYPES.UNKNOWN);
  ok('a missing code is unknown',
    toCanonical(polyRow({ dividend_type: undefined }), { asOf: TODAY }).dividendType === DIVIDEND_TYPES.UNKNOWN);
}

console.log('\n=== a missing payment date stays missing ===');
{
  const e = toCanonical(polyRow({ pay_date: undefined }), { asOf: TODAY });
  ok('paymentDate is null', e.paymentDate === null);
  // The three ways a system invents one. None of them may happen.
  ok('it is NOT copied from the record date', e.paymentDate !== e.recordDate);
  ok('it is NOT copied from the ex-date', e.paymentDate !== e.exDividendDate);
  ok('and the event is still usable', e.ticker === 'AAPL' && e.cashAmount === 0.27);

  const noRec = toCanonical(polyRow({ record_date: null }), { asOf: TODAY });
  ok('a missing record date is null too', noRec.recordDate === null && noRec.paymentDate === '2026-08-13');
  const noDec = toCanonical(polyRow({ declaration_date: null }), { asOf: TODAY });
  ok('a missing declaration date is null', noDec.declarationDate === null);
}

console.log('\n=== announced vs predicted — the rule the product rests on ===');
{
  // Declared last month, going ex next month: a real upcoming dividend.
  const future = toCanonical(polyRow({ declaration_date: '2026-09-01', ex_dividend_date: '2026-11-10', pay_date: '2026-11-14' }), { asOf: TODAY });
  ok('a declared future dividend is announced', future.announced === true);
  ok('…and is upcoming', eventTiming(future, TODAY) === 'upcoming');

  // NOT declared, but the ex-date is in the future — a schedule, a guess, or a provider artefact.
  const undeclared = toCanonical(polyRow({ declaration_date: null, ex_dividend_date: '2026-11-10' }), { asOf: TODAY });
  ok('an UNDECLARED future dividend is NOT announced', undeclared.announced === false);

  // A declaration dated in the future is not an announcement that has happened yet.
  const later = toCanonical(polyRow({ declaration_date: '2026-12-01', ex_dividend_date: '2026-12-20' }), { asOf: TODAY });
  ok('a future-dated declaration is not yet announced', later.announced === false);

  // A dividend that already went ex is history, and is announced even without a declaration date.
  const past = toCanonical(polyRow({ declaration_date: null, ex_dividend_date: '2026-05-10' }), { asOf: TODAY });
  ok('a past ex-date is announced (it happened)', past.announced === true);
  ok('…and is historical', eventTiming(past, TODAY) === 'historical');
  ok('today is today', eventTiming(toCanonical(polyRow({ ex_dividend_date: TODAY }), { asOf: TODAY }), TODAY) === 'today');

  // The prediction that must never exist: there is no code path that creates an event.
  ok('a quarterly payer produces NO row for next quarter on its own',
    canonicalEvent({ source: 'x', sourceEventId: 'y', ticker: 'KO', frequency: 4, cashAmount: 0.5 }) === null);
}

console.log('\n=== what is refused ===');
{
  ok('no source id, no event', canonicalEvent({ sourceEventId: 'a', ticker: 'X', exDividendDate: TODAY }) === null);
  ok('no source event id, no event', canonicalEvent({ source: 's', ticker: 'X', exDividendDate: TODAY }) === null);
  ok('no ticker, no event', canonicalEvent({ source: 's', sourceEventId: 'a', exDividendDate: TODAY }) === null);
  ok('no ex-date, no event', canonicalEvent({ source: 's', sourceEventId: 'a', ticker: 'X' }) === null);
  ok('a malformed date is refused', asDate('18/09/2026') === null && asDate('2026-9-8') === null && asDate(null) === null);
  ok('a Date object is refused (it carries a zone)', asDate(new Date()) === null);
  ok('a zero or negative amount is null, not zero',
    toCanonical(polyRow({ cash_amount: 0 }), { asOf: TODAY }).cashAmount === null);
  ok('an unusable frequency is null', toCanonical(polyRow({ frequency: 7 }), { asOf: TODAY }).frequency === null);
  ok('…and then nothing is annualised', toCanonical(polyRow({ frequency: 7 }), { asOf: TODAY }).annualizedAmount === null);
  ok('a one-off does not annualise', toCanonical(polyRow({ frequency: 0 }), { asOf: TODAY }).annualizedAmount === null);
}

console.log('\n=== ETFs, REITs and ADRs are just events ===');
{
  // Nothing special-cases a security type: if the provider supplies an event, it becomes one.
  const etf = toCanonical(polyRow({ ticker: 'SPY', cash_amount: 1.888834, pay_date: '2026-10-30', frequency: 4 }), { asOf: TODAY });
  ok('an ETF event is canonical', etf.ticker === 'SPY' && etf.paymentDate === '2026-10-30');
  const reit = toCanonical(polyRow({ ticker: 'O', frequency: 12, cash_amount: 0.2715 }), { asOf: TODAY });
  ok('a monthly REIT keeps frequency 12', reit.frequency === 12 && frequencyLabel(reit.frequency) === 'Monthly');
  ok('…and annualises over twelve payments', reit.annualizedAmount === 3.258, String(reit.annualizedAmount));
  const adr = toCanonical(polyRow({ ticker: 'BTI', currency: 'USD', pay_date: '2027-02-08' }), { asOf: TODAY });
  ok('an ADR paying next year keeps its payment date', adr.paymentDate === '2027-02-08');
  const foreign = toCanonical(polyRow({ ticker: 'ACOPF', currency: 'NZD' }), { asOf: TODAY });
  ok('a non-USD event keeps its own currency', foreign.currency === 'NZD');
  // And nothing is created for a security the provider says nothing about.
  ok('a non-payer yields no event', toCanonical({ ticker: 'PLTR' }, { asOf: TODAY }) === null);
}

console.log('\n=== yield comes from stored numbers or not at all ===');
{
  ok('a real yield', dividendYieldPct(1.08, 200) === 0.54, String(dividendYieldPct(1.08, 200)));
  ok('no price, no yield', dividendYieldPct(1.08, null) === null);
  ok('no annualised amount, no yield', dividendYieldPct(null, 200) === null);
  ok('a zero price does not divide', dividendYieldPct(1.08, 0) === null);
  ok('a negative price is refused', dividendYieldPct(1.08, -5) === null);
  // A yield over 100% is a corporate action or a stale price, not income.
  ok('an absurd yield is withheld', dividendYieldPct(500, 10) === null);
  ok('frequency labels read in English', frequencyLabel(4) === 'Quarterly' && frequencyLabel(12) === 'Monthly'
    && frequencyLabel(0) === 'One-time' && frequencyLabel(null) === '—');
}

console.log('\n=== ingestion: paginated, bounded, and offline in a test ===');
{
  // An injected fetch — the suite never touches the network, and the ingestion path is still real.
  const page = (rows, next) => ({ ok: true, json: async () => ({ results: rows, next_url: next || undefined }) });
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (calls.length === 1) return page([polyRow(), polyRow({ id: 'B', ticker: 'MSFT' })], 'https://next');
    return page([polyRow({ id: 'C', ticker: 'KO' })]);
  };
  const out = await fetchWindow({ from: '2026-09-01', to: '2026-12-01', apiKey: 'k', fetchImpl, asOf: TODAY });
  ok('pagination is followed', out.pages === 2 && calls.length === 2, JSON.stringify({ pages: out.pages }));
  ok('every page is normalised', out.events.length === 3 && out.events.every((e) => e.source === SOURCE_ID));
  ok('the window is passed to the provider', calls[0].includes('ex_dividend_date.gte=2026-09-01') && calls[0].includes('ex_dividend_date.lte=2026-12-01'));
  ok('the api key never appears in a canonical event', !JSON.stringify(out.events).includes('k='));

  // A run is bounded: a provider that always returns next_url cannot spin forever.
  const endless = async () => page([polyRow()], 'https://next');
  const bounded = await fetchWindow({ from: '2026-01-01', to: '2026-02-01', apiKey: 'k', fetchImpl: endless, maxPages: 3 });
  ok('maxPages bounds the run', bounded.pages === 3, String(bounded.pages));

  // A failed page reports rather than pretending.
  const failing = async () => ({ ok: false, status: 429, json: async () => ({}) });
  const failed = await fetchWindow({ from: '2026-01-01', to: '2026-02-01', apiKey: 'k', fetchImpl: failing });
  ok('a provider failure is reported, not swallowed', failed.error === 'http 429' && failed.events.length === 0);
  ok('no api key means no request at all', (await fetchWindow({ from: 'a', to: 'b', apiKey: null })).error === 'no api key');

  // An unusable row is dropped, never patched into shape.
  const dirty = async () => page([polyRow(), { ticker: 'X' }, polyRow({ id: 'D', ex_dividend_date: null })]);
  const cleaned = await fetchWindow({ from: 'a', to: 'b', apiKey: 'k', fetchImpl: dirty, asOf: TODAY });
  ok('rows that cannot be made canonical are dropped', cleaned.events.length === 1, String(cleaned.events.length));
}

console.log('\n=== a revision updates the same event ===');
{
  // The provider re-sends one id with a corrected amount and a payment date that has now arrived.
  const first = toCanonical(polyRow({ pay_date: null, cash_amount: 0.25 }), { asOf: TODAY });
  const revised = toCanonical(polyRow({ pay_date: '2026-08-13', cash_amount: 0.27 }), { asOf: TODAY });
  ok('the identity is unchanged across a revision',
    first.source === revised.source && first.sourceEventId === revised.sourceEventId);
  ok('…so the upsert key matches and the row is updated, not duplicated',
    `${first.source}:${first.sourceEventId}` === `${revised.source}:${revised.sourceEventId}`);
  ok('the revised values differ', first.cashAmount === 0.25 && revised.cashAmount === 0.27
    && first.paymentDate === null && revised.paymentDate === '2026-08-13');

  // Two genuinely different events must NOT collide.
  const other = toCanonical(polyRow({ id: 'OTHER' }), { asOf: TODAY });
  ok('a different event has a different key', other.sourceEventId !== first.sourceEventId);
}

console.log('\n=== the provider registry is the swap point ===');
{
  ok('polygon is registered', PROVIDERS.polygon?.id === 'polygon');
  ok('it is flagged as temporary', PROVIDERS.polygon.temporary === true);
  ok('the active provider is configurable', activeDividendProvider({ DIVIDEND_PROVIDER: 'polygon' }).id === 'polygon');
  ok('an unknown provider falls back rather than crashing', activeDividendProvider({ DIVIDEND_PROVIDER: 'nope' }).id === 'polygon');
  ok('every provider implements the interface',
    Object.values(PROVIDERS).every((p) => typeof p.fetchWindow === 'function' && typeof p.id === 'string'));

  // THE GATE HAS THREE STATES, because "who is looking" is the question, not on-versus-off.
  ok('unset is pre-launch — the real calendar on real data', dividendsDisplayMode({}) === 'prelaunch');
  ok('true is cleared for public commercial display', dividendsDisplayMode({ DIVIDENDS_PUBLIC_ENABLED: 'true' }) === 'public');
  ok('false is the kill switch', dividendsDisplayMode({ DIVIDENDS_PUBLIC_ENABLED: 'false' }) === 'off');

  // The COMMERCIAL gate still fails closed. This is the one that must never open by accident, so it
  // takes the exact literal `true` and nothing that merely looks affirmative.
  ok('public display is OFF unless explicitly approved', dividendsPublicEnabled({}) === false);
  ok('pre-launch is NOT public approval', dividendsPublicEnabled({ DIVIDENDS_PUBLIC_ENABLED: '' }) === false);
  ok('"TRUE" does not open the commercial gate', dividendsPublicEnabled({ DIVIDENDS_PUBLIC_ENABLED: 'TRUE' }) === false);
  ok('"yes" does not open it either', dividendsPublicEnabled({ DIVIDENDS_PUBLIC_ENABLED: 'yes' }) === false);
  ok('the literal string opens it', dividendsPublicEnabled({ DIVIDENDS_PUBLIC_ENABLED: 'true' }) === true);

  // Visibility renders pre-launch and public, never when killed — and the kill switch must not be
  // defeated by a capital letter or a stray space.
  ok('the calendar renders pre-launch', dividendsVisible({}) === true);
  ok('…and when public', dividendsVisible({ DIVIDENDS_PUBLIC_ENABLED: 'true' }) === true);
  ok('…and NOT when killed', dividendsVisible({ DIVIDENDS_PUBLIC_ENABLED: 'false' }) === false);
  ok('the kill switch survives casing and whitespace',
    dividendsVisible({ DIVIDENDS_PUBLIC_ENABLED: ' FALSE ' }) === false
    && dividendsVisible({ DIVIDENDS_PUBLIC_ENABLED: 'False' }) === false);
}

console.log('\n=== the calendar\'s date windows ===');
{
  // 2026-09-18 is a Friday; its week runs Mon 14th → Sun 20th.
  ok('today is one day', JSON.stringify(rangeFor('today', TODAY)) === '{"from":"2026-09-18","to":"2026-09-18"}');
  ok('this week runs Monday to Sunday, inclusive',
    JSON.stringify(rangeFor('week', TODAY)) === '{"from":"2026-09-14","to":"2026-09-20"}', JSON.stringify(rangeFor('week', TODAY)));
  ok('next week is the following Monday to Sunday',
    JSON.stringify(rangeFor('next', TODAY)) === '{"from":"2026-09-21","to":"2026-09-27"}', JSON.stringify(rangeFor('next', TODAY)));
  ok('this month is the whole calendar month',
    JSON.stringify(rangeFor('month', TODAY)) === '{"from":"2026-09-01","to":"2026-09-30"}', JSON.stringify(rangeFor('month', TODAY)));
  // Boundaries: a month end, a year end and a leap February.
  ok('a 31-day month ends on the 31st', rangeFor('month', '2026-12-05').to === '2026-12-31');
  ok('February 2028 ends on the 29th', rangeFor('month', '2028-02-10').to === '2028-02-29');
  ok('February 2027 ends on the 28th', rangeFor('month', '2027-02-10').to === '2027-02-28');
  ok('a week spanning a year end stays one week',
    rangeFor('week', '2026-12-31').from === '2026-12-28' && rangeFor('week', '2026-12-31').to === '2027-01-03');
  ok('Monday anchors its own week', rangeFor('week', '2026-09-14').from === '2026-09-14');
  ok('Sunday still belongs to the week that opened it', rangeFor('week', '2026-09-20').from === '2026-09-14');
  // Previous/Next move by what is on screen.
  ok('stepping matches the view', stepFor('today') === 1 && stepFor('week') === 7 && stepFor('next') === 7 && stepFor('month') === 30);
}

console.log('\n=== sorting ===');
{
  const rows = [
    { ticker: 'BBB', company: 'Beta', cashAmount: 0.5, yieldPct: 4.0, paymentDate: '2026-10-02', marketCap: 2e9, frequency: 4 },
    { ticker: 'AAA', company: 'Alpha', cashAmount: 2.0, yieldPct: null, paymentDate: null, marketCap: 9e9, frequency: 12 },
    { ticker: 'CCC', company: 'Gamma', cashAmount: 0.1, yieldPct: 9.5, paymentDate: '2026-09-30', marketCap: null, frequency: 1 },
  ];
  ok('ascending by amount', sortEvents(rows, 'cashAmount', 'asc').map((r) => r.ticker).join() === 'CCC,BBB,AAA');
  ok('descending by amount', sortEvents(rows, 'cashAmount', 'desc').map((r) => r.ticker).join() === 'AAA,BBB,CCC');
  ok('by ticker', sortEvents(rows, 'ticker', 'asc').map((r) => r.ticker).join() === 'AAA,BBB,CCC');
  ok('by company name', sortEvents(rows, 'company', 'asc').map((r) => r.company).join() === 'Alpha,Beta,Gamma');
  // MISSING VALUES SINK, both directions — a blank yield is not the highest yield on the board.
  ok('a missing yield sorts last ascending', sortEvents(rows, 'yieldPct', 'asc').at(-1).ticker === 'AAA');
  ok('…and last descending too', sortEvents(rows, 'yieldPct', 'desc').at(-1).ticker === 'AAA');
  ok('a missing payment date sinks as well', sortEvents(rows, 'paymentDate', 'asc').at(-1).ticker === 'AAA');
  ok('a missing market cap sinks', sortEvents(rows, 'marketCap', 'desc').at(-1).ticker === 'CCC');
  ok('an unknown column leaves the order alone', sortEvents(rows, 'nope').map((r) => r.ticker).join() === 'BBB,AAA,CCC');
  ok('sorting does not mutate the caller\'s array', rows[0].ticker === 'BBB');
  // Ties break on ticker, so the same board renders the same way twice.
  const tied = [{ ticker: 'ZZZ', cashAmount: 1 }, { ticker: 'AAA', cashAmount: 1 }];
  ok('ties break on ticker', sortEvents(tied, 'cashAmount', 'asc').map((r) => r.ticker).join() === 'AAA,ZZZ');
}

console.log('\n=== grouping, and a day with nothing on it ===');
{
  const many = [
    { ticker: 'A', exDividendDate: '2026-09-18', paymentDate: '2026-10-01' },
    { ticker: 'B', exDividendDate: '2026-09-18', paymentDate: '2026-10-15' },
    { ticker: 'C', exDividendDate: '2026-09-21', paymentDate: '2026-10-01' },
    { ticker: 'D', exDividendDate: '2026-09-19', paymentDate: null },
  ];
  const byEx = groupByDate(many, 'ex');
  ok('the ex-dividend axis groups by ex-date', byEx.map(([d]) => d).join() === '2026-09-18,2026-09-19,2026-09-21');
  ok('many companies can share one ex-date', byEx[0][1].length === 2, JSON.stringify(byEx[0][1].map((e) => e.ticker)));
  const byPay = groupByDate(many, 'payment');
  ok('the payment axis groups by payment date', byPay[0][0] === '2026-10-01' && byPay[0][1].length === 2);
  // A row whose organising date was never published still belongs on the board — but last.
  ok('an unpublished date sorts last, it is not dropped',
    byPay.at(-1)[0] === 'unknown' && byPay.at(-1)[1][0].ticker === 'D', JSON.stringify(byPay.map(([d]) => d)));
  ok('an empty day is an empty board, not an error', groupByDate([], 'ex').length === 0);
  ok('missing input is handled', groupByDate(null, 'ex').length === 0);
}

console.log('\n=== an absent filter is not a filter of zero ===');
{
  // THE BUG THIS PINS: Number(null) and Number('') are both 0, and 0 is finite — so the obvious
  // coercion turned every ABSENT filter into a real one. In production that meant every request
  // carried minYield/minAmount/minMarketCap of 0, which still demand a known frequency, a stored
  // price and a market cap. The board collapsed from 372 events to 21.
  ok('an absent parameter is null', numParam(null) === null && numParam(undefined) === null);
  ok('an empty control is null', numParam('') === null && numParam('   ') === null);
  ok('a real zero is still zero', numParam(0) === 0 && numParam('0') === 0);
  ok('a real value survives', numParam('4') === 4 && numParam('0.5') === 0.5);
  ok('a negative survives', numParam('-2') === -2);
  ok('nonsense is null, not NaN', numParam('abc') === null && numParam({}) === null);
  // The distinction that matters, stated directly: nothing and zero are different answers.
  ok('nothing and zero are distinguishable', numParam('') !== numParam('0'));
}

console.log('\n=== the query the UI sends ===');
{
  const q = calendarQuery({ from: '2026-09-14', to: '2026-09-20', mode: 'payment',
    filters: { ...EMPTY_FILTERS, q: 'AAPL', sector: 'Technology', minYield: '4' } });
  const p = new URLSearchParams(q);
  ok('the window and mode travel', p.get('from') === '2026-09-14' && p.get('to') === '2026-09-20' && p.get('mode') === 'payment');
  ok('set filters travel', p.get('q') === 'AAPL' && p.get('sector') === 'Technology' && p.get('minYield') === '4');
  // Empty controls must not become blank filters the API then tries to honour.
  ok('empty filters are omitted entirely', !p.has('type') && !p.has('frequency') && !p.has('minAmount'));
  ok('no filters means no filter params',
    [...new URLSearchParams(calendarQuery({ from: 'a', to: 'b' })).keys()].sort().join() === 'from,limit,mode,to');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
