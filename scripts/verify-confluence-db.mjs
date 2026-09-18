// A database double for the confluence suite.
//
// It answers the four queries the board asks and RECORDS what it was asked, which is the point: the
// regression this suite exists to prevent is architectural — the expensive roll-up creeping back
// onto the request path — and that is a fact about which queries run, not about how long they take.
// Timing assertions in CI would be flaky; query shape is not.

const state = {
  calls: [],              // every statement, in order, with when it started and finished
  built: true,            // does fund_qoq have rows for the current quarter?
  holdings: [],           // rows the LIVE roll-up would return
  summary: [],            // rows fund_qoq holds
  insider: [],
  congress: [],
  quarters: { q0: '2026-06-30', q1: '2026-03-31' },
  delayMs: 0,             // per-statement delay, for proving concurrency
};

export const __state = state;
export function reset(over = {}) {
  state.calls = [];
  state.built = true;
  state.holdings = [];
  state.summary = [];
  state.insider = [];
  state.congress = [];
  state.quarters = { q0: '2026-06-30', q1: '2026-03-31' };
  state.delayMs = 0;
  Object.assign(state, over);
}

const textOf = (q) => {
  if (!q) return '';
  if (typeof q === 'string') return q;
  // drizzle sql`` fragments expose their pieces differently depending on how they were built;
  // stringifying the query object is enough to classify it.
  const chunks = q.queryChunks || q.chunks || [];
  const parts = chunks.map((c) => (typeof c === 'string' ? c : c?.value ?? c?.name ?? ''));
  return (parts.join(' ') + ' ' + JSON.stringify(q.sql ?? '')).toLowerCase();
};

function classify(text) {
  if (text.includes('fund_qoq') && text.includes('insert')) return 'fund_qoq_refresh';
  if (text.includes('per_fund')) return 'live_rollup';            // the expensive one
  if (text.includes('fund_qoq')) return text.includes('count(*)') && text.includes('fund_filings')
    ? 'quarters_and_state' : 'fund_qoq_read';
  if (text.includes('fund_filings')) return 'quarters_and_state';
  if (text.includes('insider_trades')) return 'insider';
  if (text.includes('congress_trades')) return 'congress';
  return 'other';
}

async function record(kind, rows, text = '') {
  const call = { kind, text, startedAt: Date.now(), endedAt: null };
  state.calls.push(call);
  if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
  call.endedAt = Date.now();
  return rows;
}

function rowsFor(kind) {
  switch (kind) {
    case 'quarters_and_state':
      return [{ q0: state.quarters.q0, q1: state.quarters.q1, summary_rows: state.built ? state.summary.length : 0 }];
    case 'fund_qoq_read': return state.summary;
    case 'live_rollup': return state.holdings;
    case 'insider': return state.insider;
    case 'congress': return state.congress;
    default: return [];
  }
}

// drizzle's `db.select().from().where().groupBy()` is a thenable builder; this mimics just enough of
// it that confluence.js cannot tell the difference.
function selectBuilder() {
  let kind = 'other';
  const chain = {
    from(table) {
      const name = table?.[Symbol.for('drizzle:Name')] || table?._?.name || String(table?.name || '');
      kind = classify(String(name).toLowerCase());
      return chain;
    },
    where() { return chain; },
    groupBy() { return chain; },
    orderBy() { return chain; },
    limit() { return chain; },
    then(res, rej) { return record(kind, rowsFor(kind)).then(res, rej); },
  };
  return chain;
}

export const db = {
  select: () => selectBuilder(),
  async execute(q) {
    const text = textOf(q);
    const kind = classify(text);
    const rows = await record(kind, rowsFor(kind), text);
    return { rows };
  },
};
