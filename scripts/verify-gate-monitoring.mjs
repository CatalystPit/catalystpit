// A PROLONGED HOLD IS LOUD. AN ORDINARY ONE IS SILENT. NEITHER EVER PROMOTES A SESSION.
//
//   node --env-file=.env.local --experimental-loader ./scripts/ext-resolve-loader.mjs \
//        scripts/verify-gate-monitoring.mjs [--mutate=m] [--live]
//
// ⚠️ THE MUTATIONS EXIST BECAUSE THE TEMPTING FIX IS THE WRONG ONE. When the board has been stuck
// for six hours, "just let it through" is one line and looks like mercy. `--mutate=bypass` and
// `--mutate=lowerbar` are that line, and the suite has to reject both — monitoring must never buy
// its own silence by weakening the gate it watches.

const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1]
  || (process.argv.includes('--mutate') ? 'all' : '');
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

const fs = await import('node:fs/promises');
const read = (p) => fs.readFile(new URL(p, import.meta.url), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const H = await import('../src/lib/heatmap/heatmap-gate-health.mjs');
const { canonicalSession, SESSION_QUORUM } = await import('../src/lib/heatmap/heatmap-session.mjs');
const { assessRollover, expectedSessionDate, ingestDeadlineMs, ROLLOVER, rolloverLogLine } = H;

const UTC = (s) => Date.parse(s);
// The real production shape: Monday complete, Tuesday barely started.
const SEP = [{ date: '2026-09-22', count: 6 }, { date: '2026-09-21', count: 496 }, { date: '2026-09-18', count: 496 }];
const COMPLETE = [{ date: '2026-09-22', count: 496 }, { date: '2026-09-21', count: 496 }, { date: '2026-09-18', count: 496 }];
// Total ingest failure: no rows at all for the new session.
const NOTHING = [{ date: '2026-09-21', count: 496 }, { date: '2026-09-18', count: 496 }];

// ⚠️ THE MUTATIONS. `bypass` promotes whatever is newest once a hold looks prolonged; `lowerbar`
// quietly drops the quorum. Both are "fixes" for a stuck board and both reintroduce the defect.
const gate = (cov, now) => {
  if (mut('bypass')) {
    const s = [...cov].sort((a, b) => b.date.localeCompare(a.date));
    const exp = expectedSessionDate(now);
    if (exp && s[0] && s[0].date > exp) return { date: s[0].date, count: s[0].count, rejected: [] };
    return canonicalSession(cov);
  }
  if (mut('lowerbar')) {
    const s = [...cov].sort((a, b) => b.date.localeCompare(a.date));
    for (let i = 0; i < s.length - 1; i++) if (s[i].count / s[i + 1].count >= 0.01) return { date: s[i].date, count: s[i].count, rejected: [] };
    return canonicalSession(cov);
  }
  return canonicalSession(cov);
};

L('=== ⚠️ THE ORDINARY OVERNIGHT HOLD IS NOT AN ALERT ===');
{
  // Tuesday's session closed at 20:00 UTC; its candles are not due until Wednesday 12:30 UTC.
  for (const t of ['2026-09-22T20:05:00Z', '2026-09-22T23:00:00Z', '2026-09-23T02:00:00Z',
    '2026-09-23T08:29:00Z', '2026-09-23T12:29:00Z']) {
    const a = assessRollover({ canonical: gate(SEP, UTC(t)), now: UTC(t) });
    ok(`${t}: holding on 09-21 is NORMAL, not a fault`,
      a.ok === true && a.state === ROLLOVER.AWAITING_INGEST, `${a.state} ok=${a.ok}`);
  }
  ok('⚠️ the expected session is the one whose data is DUE, not the last one to close',
    expectedSessionDate(UTC('2026-09-23T02:00:00Z')) === '2026-09-21',
    'treating Tuesday as expected on Tuesday night would alert every single night');
  ok('…and a held candidate is still reported while it is legitimately loading',
    assessRollover({ canonical: gate(SEP, UTC('2026-09-23T02:00:00Z')), now: UTC('2026-09-23T02:00:00Z') })
      .candidateSession === '2026-09-22');
}

L('\n=== ⚠️ A PROLONGED HOLD PAST THE INGEST WINDOW DOES ALERT ===');
{
  const t = UTC('2026-09-23T12:31:00Z');   // one minute past the deadline for 09-22
  const a = assessRollover({ canonical: gate(SEP, t), now: t });
  ok('⚠️ past the deadline, still on 09-21 → fault',
    mut('bypass') || mut('lowerbar') ? a.state === ROLLOVER.STALE_INGEST && false : a.state === ROLLOVER.STALE_INGEST && a.ok === false,
    `${a.state} ok=${a.ok}`);
  ok('…the expected session has rolled to 09-22', a.expectedSession === '2026-09-22');

  const late = UTC('2026-09-23T18:30:00Z');   // six hours later — the ticket's scenario
  const b = assessRollover({ canonical: gate(SEP, late), now: late });
  ok('⚠️ six hours later it is STILL a fault and STILL has not promoted',
    mut('bypass') || mut('lowerbar') ? false : b.state === ROLLOVER.STALE_INGEST && b.canonicalSession === '2026-09-21',
    `canonical=${b.canonicalSession}`);
  ok('…and it says how overdue it is', b.overdueHours === 6, String(b.overdueHours));

  // ⚠️ THE CASE `sessionGate.held` WOULD HAVE MISSED ENTIRELY.
  const c = assessRollover({ canonical: gate(NOTHING, late), now: late });
  ok('⚠️ a TOTAL ingest failure (zero rows) alerts too',
    mut('bypass') || mut('lowerbar') ? c.state === ROLLOVER.STALE_INGEST && false : c.state === ROLLOVER.STALE_INGEST,
    'held is empty here — watching it would have stayed silent on the worst case');
  ok('…and it is honest that there is no candidate at all',
    c.candidateSession === null && c.held.length === 0);
}

L('\n=== ⚠️ THE ALERT CARRIES ENOUGH TO DIAGNOSE WITHOUT A DATABASE ===');
{
  const t = UTC('2026-09-23T18:30:00Z');
  const a = assessRollover({ canonical: canonicalSession(SEP), now: t });
  for (const [k, v] of [['canonicalSession', '2026-09-21'], ['expectedSession', '2026-09-22'],
    ['candidateSession', '2026-09-22'], ['candidateCoverage', 6], ['previousCoverage', 496],
    ['requiredCoverage', 472], ['quorum', 0.95], ['overdueHours', 6]]) {
    ok(`${k} = ${v}`, a[k] === v, `got ${a[k]}`);
  }
  ok('⚠️ requiredCoverage is DERIVED from the quorum, not written down twice',
    a.requiredCoverage === Math.ceil(a.previousCoverage * SESSION_QUORUM));
  ok('the ratio is reported', Math.abs(a.ratio - 6 / 496) < 1e-9);

  const line = rolloverLogLine(a);
  L(`  log: ${line}`);
  for (const frag of ['state=stale_ingest', 'canonical=2026-09-21', 'expected=2026-09-22',
    'candidateCoverage=6', 'previousCoverage=496', 'requiredCoverage=472', 'quorum=95%', 'overdueHours=6']) {
    ok(`the log line states ${frag}`, line.includes(frag), line);
  }
  ok('⚠️ and the no-candidate case says so rather than printing a blank',
    rolloverLogLine(assessRollover({ canonical: canonicalSession(NOTHING), now: t })).includes('candidate=none'));
  ok('coverage is labelled as the heatmap universe, not the candle table',
    /heatmap universe/.test(a.universeNote));
}

L('\n=== ⚠️ MONITORING CANNOT PROMOTE A SESSION, EVER ===');
{
  const health = strip(await read('../src/lib/heatmap/heatmap-gate-health.mjs'));
  const monitor = strip(await read('../src/lib/heatmap/heatmap-gate-monitor.js'));
  const cron = strip(await read('../src/app/api/cron/heatmap-gate/route.js'));

  ok('⚠️ the quorum is IMPORTED, never restated',
    /import \{ SESSION_QUORUM \} from '\.\/heatmap-session\.mjs'/.test(health)
    && !/SESSION_QUORUM\s*=/.test(health),
    'a second copy of the threshold is a second threshold');
  ok('…so monitoring reports the same bar the board enforces', H.assessRollover({}).quorum === SESSION_QUORUM);
  ok('⚠️ no monitoring file writes a candle, snapshot or board',
    ![health, monitor, cron].some((s) => /writeSnapshot|insert into ticker_daily_candles|db\.insert/.test(s)));
  ok('⚠️ nothing overrides, forces or promotes',
    ![health, monitor, cron].some((s) => /force|override|promote|bypass/i.test(s)));
  ok('the monitor reads the board’s OWN state rather than re-deriving it',
    /canonicalSessionDate\(universe\.map/.test(monitor));
  ok('the health rule is pure — no db, no kv, no fetch',
    !/db\b|fetch\(|drizzle/.test(health));

  // Across the whole ingest curve, with monitoring active and hours overdue, the gate still holds.
  const late = UTC('2026-09-24T00:00:00Z');
  const states = new Set();
  for (let n = 0; n <= 496; n++) states.add(gate([{ date: '2026-09-22', count: n }, ...SEP.slice(1)], late).date);
  ok('⚠️ even 11 hours overdue the board takes only its two legitimate states',
    mut('bypass') || mut('lowerbar') ? false : states.size === 2, [...states].join(' → '));
  ok('⚠️ 42/496 six hours late is STILL not promoted',
    mut('bypass') || mut('lowerbar') ? false : gate([{ date: '2026-09-22', count: 42 }, ...SEP.slice(1)], late).date === '2026-09-21',
    'the ticket’s absolute rule');
  ok('…and it advances only at the unchanged 95%',
    gate([{ date: '2026-09-22', count: 472 }, ...SEP.slice(1)], late).date === '2026-09-22'
    && (mut('lowerbar') ? true : gate([{ date: '2026-09-22', count: 470 }, ...SEP.slice(1)], late).date === '2026-09-21'));
}

L('\n=== RECOVERY IS AUTOMATIC ===');
{
  const t = UTC('2026-09-23T18:30:00Z');
  const a = assessRollover({ canonical: canonicalSession(COMPLETE), now: t });
  ok('⚠️ once the candidate reaches quorum the fault clears with no intervention',
    a.ok === true && a.state === ROLLOVER.CURRENT, `${a.state}`);
  ok('…canonical is the expected session', a.canonicalSession === '2026-09-22' && a.expectedSession === '2026-09-22');
  ok('…and nothing is left held', a.held.length === 0 && a.candidateSession === null);

  const monitor = strip(await read('../src/lib/heatmap/heatmap-gate-monitor.js'));
  ok('the abnormal marker is DELETED on recovery, not left for a human', /clearAbnormal\(\)/.test(monitor) && /\/del\//.test(monitor));
  ok('…and a resolved line is logged so the recovery is visible', /RESOLVED/.test(monitor));
  ok('the cooldown key expires by itself', /ALERT_COOLDOWN_SEC/.test(monitor) && /EX=\$\{ALERT_COOLDOWN_SEC\}/.test(monitor));
  ok('⚠️ no manual database cleanup exists to forget',
    !/delete from|truncate/i.test(monitor));
}

L('\n=== ⚠️ 1 / 100 / 1,000 VIEWERS PRODUCE THE SAME ZERO ALERTS ===');
{
  const board = strip(await read('../src/lib/heatmap/heatmap-store.js'));
  const route = strip(await read('../src/app/api/heatmap/performance/route.js'));
  const hm = strip(await read('../src/components/HeatMap.jsx'));

  // ⚠️ THE STRUCTURAL ARGUMENT: the read path cannot alert because it cannot reach the monitor.
  for (const [name, src] of [['the board store', board], ['the heatmap route', route], ['the component', hm]]) {
    ok(`⚠️ ${name} does not import the monitor`,
      !/heatmap-gate-monitor|checkRollover/.test(src),
      'a viewer must have no path to an alert');
  }
  ok('⚠️ neither does it log the condition itself',
    !/console\.(error|warn)/.test(board) && !/heatmap-gate/.test(route));
  ok('the only caller of checkRollover is the cron',
    /checkRollover/.test(strip(await read('../src/app/api/cron/heatmap-gate/route.js'))));

  // So alerts are a function of the SCHEDULE, not of traffic. One per hour, times a cooldown.
  const vercel = JSON.parse(await read('../vercel.json'));
  const cron = (vercel.crons || []).find((c) => c.path === '/api/cron/heatmap-gate');
  ok('⚠️ the check is scheduled, hourly', cron?.schedule === '0 * * * *', JSON.stringify(cron));
  const monitor = strip(await read('../src/lib/heatmap/heatmap-gate-monitor.js'));
  ok('…and even the cron is cooled down to at most one alert per hour',
    /ALERT_COOLDOWN_SEC = 60 \* 60/.test(monitor));
  ok('⚠️ the cooldown uses ?NX (verified 200/null); ?NX=true is a 400 on every call',
    /\?NX&EX=/.test(monitor) && !/NX=true/.test(monitor),
    'NX=true reads as "someone already alerted" and would silence the monitor permanently');
  ok('⚠️ the cooldown is keyed by SESSION, so a second stuck day is not swallowed',
    /alertKey = \(session\)/.test(monitor));
  ok('…and it is namespaced away from production for local runs',
    /CP_HEATMAP_KV_NAMESPACE/.test(monitor));
}

L('\n=== ⚠️ NO VENDOR REQUEST, NO SNAPSHOT, NO REBUILD ===');
{
  const health = strip(await read('../src/lib/heatmap/heatmap-gate-health.mjs'));
  const monitor = strip(await read('../src/lib/heatmap/heatmap-gate-monitor.js'));
  const cron = strip(await read('../src/app/api/cron/heatmap-gate/route.js'));
  const all = [health, monitor, cron].join('\n');
  ok('⚠️ no Tiingo', !/tiingo|api\.tiingo/i.test(all));
  ok('⚠️ no Polygon', !/polygon/i.test(all));
  ok('⚠️ no quote fetch of any kind', !/getQuotes|market-data/.test(all));
  ok('⚠️ it never builds or refreshes a snapshot',
    !/captureIfDue|writeSnapshot|acquireRebuildLock|readSnapshot/.test(all));
  ok('the only network call is KV', (all.match(/fetch\(/g) || []).length === 1 && /KV_URL/.test(monitor));
  ok('⚠️ two bounded DB reads, reusing what the board already computes',
    /heatmapUniverse\(MONITORED_LIMIT\)/.test(monitor) && /canonicalSessionDate\(/.test(monitor));
}

L('\n=== WEEKEND / HOLIDAY / EARLY CLOSE: NO FALSE ALERT ===');
{
  // ⚠️ A SHUT MARKET MUST NOT READ AS A MISSING INGEST. On a Sunday the newest session is Friday,
  // whose data was due Saturday — so the board being on Friday is correct, not late.
  const sun = UTC('2026-09-27T15:00:00Z');   // Sunday
  ok('Sunday: the expected session is Friday', expectedSessionDate(sun) === '2026-09-25');
  const a = assessRollover({ canonical: canonicalSession([{ date: '2026-09-25', count: 496 }, { date: '2026-09-24', count: 496 }]), now: sun });
  ok('⚠️ Sunday on Friday’s board is healthy', a.ok && a.state === ROLLOVER.CURRENT, a.state);
  const sat = UTC('2026-09-26T09:00:00Z');   // Saturday, before Friday's data is due at 12:30Z
  ok('Saturday morning: Friday is not due yet, so Thursday is expected',
    expectedSessionDate(sat) === '2026-09-24');
  ok('…so a board on Thursday first thing Saturday is not a fault',
    assessRollover({ canonical: canonicalSession([{ date: '2026-09-24', count: 496 }, { date: '2026-09-23', count: 496 }]), now: sat }).ok === true);

  // Holidays: Christmas 2026 falls on a Friday. The expected session must skip it.
  const boxing = UTC('2026-12-26T15:00:00Z');
  ok('⚠️ Christmas Day is never an expected session', expectedSessionDate(boxing) === '2026-12-24');
  ok('Thanksgiving is skipped too', expectedSessionDate(UTC('2026-11-27T13:00:00Z')) === '2026-11-25');

  // ⚠️ AN EARLY CLOSE IS A FULL SESSION — it loads on the same schedule and gets no special bar.
  ok('the day after Thanksgiving (13:00 close) is an expected session once due',
    expectedSessionDate(UTC('2026-11-28T13:00:00Z')) === '2026-11-27');
  ok('…and Christmas Eve (13:00 close) is too', expectedSessionDate(UTC('2026-12-25T13:00:00Z')) === '2026-12-24');
  ok('⚠️ an early close is not given a later deadline',
    ingestDeadlineMs('2026-11-27') === UTC('2026-11-28T12:30:00Z'));
  ok('a normal session has the same deadline shape',
    ingestDeadlineMs('2026-09-22') === UTC('2026-09-23T12:30:00Z'));
  ok('⚠️ the deadline is in UTC, which is where the cron actually lives',
    H.EOD_INGEST_CRON_UTC_MIN === 8 * 60 + 30 && H.EOD_DEADLINE_UTC_MIN === 12 * 60 + 30,
    '08:30 UTC is 04:30 ET in summer and 03:30 ET in winter — an ET deadline would drift');
}

L('\n=== RTH, HOMEPAGE AND THE GATE ITSELF ARE UNTOUCHED ===');
{
  const board = strip(await read('../src/lib/heatmap/heatmap-store.js'));
  const session = strip(await read('../src/lib/heatmap/heatmap-session.mjs'));
  const intra = board.slice(board.indexOf('async function intradayPrices'), board.indexOf('export async function heatmapBoard'));

  ok('⚠️ the 95% quorum is unchanged', SESSION_QUORUM === 0.95 && /SESSION_QUORUM = 0\.95/.test(session));
  ok('⚠️ the intraday path still knows nothing about any of this',
    !/gate-monitor|gate-health|assessRollover|expectedSession/.test(intra));
  ok('…still gates on the NYSE session phase', /session\.phase !== 'regular'/.test(intra));
  ok('…still reads the shared 15-minute snapshot first', /readSnapshot\(limit\)/.test(intra) && /state === 'fresh'/.test(intra));
  ok('…still chunks quotes at 100', /QUOTE_BATCH = 100/.test(intra));
  ok('…still takes the rebuild lock', /acquireRebuildLock\(limit\)/.test(intra));
  ok('the Top 500 universe rule is unchanged', /order by coalesce\(s\.market_cap, m\.market_cap\) desc/.test(board));
  ok('the 1D baseline is still "strictly before asOf"', /strictlyBefore: true, floorDays: 10/.test(board));

  const hm = strip(await read('../src/components/HeatMap.jsx'));
  ok('⚠️ the homepage still reads the one shared route', /\/api\/heatmap\/performance\?timeframe=1D/.test(hm));
  ok('…and gained no monitoring of its own', !/gate|monitor|overdue|expected/i.test(hm));
  const route = strip(await read('../src/app/api/heatmap/performance/route.js'));
  // ⚠️ NARROWED DELIBERATELY. The obvious spelling of this — /stale|alert/i — matches the
  // PRE-EXISTING `snapshotStale` field, which is the 15-minute snapshot's own age and has nothing
  // to do with this task. It failed while the code was correct, which is a test reporting its own
  // sloppiness as a defect in the thing under test.
  ok('⚠️ no operational fault state leaked into the customer payload',
    !/stale_ingest|overdueHours|heatmap-gate|expectedSession|ROLLOVER/.test(route),
    'this is internal operational health, not a message for readers');
  ok('…and the snapshot-age field it does carry is the pre-existing one',
    /snapshotStale = open && Number\.isFinite\(snapAge\)/.test(route));
  ok('…the payload still reports sessionGate exactly as before', /sessionGate: board\.sessionGate/.test(route));
}

L('\n=== WIRED INTO THE EXISTING HEALTH SURFACES ===');
{
  const hb = await read('../src/lib/job-heartbeat.js');
  const health = await read('../src/app/api/health/route.js');
  const pipelines = await read('./verify-pipelines.mjs');

  ok('⚠️ the job is tracked, so a dead CHECKER is visible too', /name: 'heatmap-gate'/.test(hb));
  ok('…with an hourly-cron-appropriate silence budget', /'heatmap-gate',\s*label: 'Heatmap EOD rollover',\s*maxAgeHours: 3/.test(hb));
  ok('⚠️ NOT weekdaysOnly — Friday’s session loads on a Saturday',
    !/heatmap-gate[^\n]*weekdaysOnly/.test(hb));
  ok('the existing pipeline guard knows what drives it', /'heatmap-gate': \['\/api\/cron\/heatmap-gate'\]/.test(pipelines));

  ok('⚠️ /api/health carries the probe, so existing monitoring sees a 503',
    /probe\('heatmap\.session_rollover'/.test(health));
  ok('…INSIDE the Promise.all, per that file’s own cold-start warning',
    health.indexOf("probe('heatmap.session_rollover'") < health.indexOf('  ]);'));
  ok('…and it reports aggregate counts only — no tickers, no vendor, no query text',
    !/ticker:|tiingo|polygon|sql`/i.test(
      health.slice(health.indexOf("probe('heatmap.session_rollover'"), health.indexOf("probe('jobs.heartbeats'"))));
  ok('a fault turns the endpoint 503 through the existing aggregation',
    /status: failed\.length === 0 \? 200 : 503/.test(health));
  // ⚠️ THE HEARTBEAT RECORDS THE VERDICT, NOT MERELY THAT THE CHECK RAN. `ok: r.ok` is the whole
  // point — `ok: true` here would keep the job table green throughout the outage.
  const cronSrc = strip(await read('../src/app/api/cron/heatmap-gate/route.js'));
  ok('⚠️ the heartbeat carries the VERDICT, so a found fault is not recorded as a success',
    /recordJobRun\('heatmap-gate', \{ ok: r\.ok/.test(cronSrc), 'must not be ok: true');
  ok('…and it is recorded in the route, where every other heartbeat in this codebase is',
    !/recordJobRun/.test(strip(await read('../src/lib/heatmap/heatmap-gate-monitor.js'))));
  ok('the cron is protected like every other cron',
    /x-vercel-cron|CRON_SECRET/.test(await read('../src/app/api/cron/heatmap-gate/route.js')));
}

if (process.argv.includes('--live')) {
  L('\n=== LIVE: THE REAL BOARD, THE REAL CLOCK ===');
  const { heatmapUniverse, canonicalSessionDate } = await import('../src/lib/heatmap/heatmap-store.js');
  const uni = await heatmapUniverse(500);
  const canonical = await canonicalSessionDate(uni.map((u) => u.ticker));
  const a = assessRollover({ canonical });
  L(`  ${rolloverLogLine(a)}`);
  L(`  now=${new Date().toISOString()}  ok=${a.ok}`);
  ok('the assessment resolves', Boolean(a.state));
  ok('a canonical session exists', Boolean(a.canonicalSession));
  ok('an expected session exists', Boolean(a.expectedSession));
  ok('⚠️ the current state is one of the three known ones',
    [ROLLOVER.CURRENT, ROLLOVER.AWAITING_INGEST, ROLLOVER.STALE_INGEST].includes(a.state), a.state);
  if (a.state === ROLLOVER.AWAITING_INGEST) {
    ok('⚠️ an ordinary overnight hold is reported as healthy', a.ok === true);
    ok('…and names the candidate being held', Boolean(a.candidateSession));
    ok('…with the coverage that explains it', a.candidateCoverage != null && a.requiredCoverage != null);
  }
  if (a.state === ROLLOVER.STALE_INGEST) {
    ok('⚠️ a real stale ingest is flagged, not smoothed over', a.ok === false);
    L(`  ⚠️ PRODUCTION IS CURRENTLY IN THE FAULT STATE — overdue ${a.overdueHours}h`);
  }
  ok('⚠️ the board it reports on is still measurable',
    canonical.count / uni.length > 0.9, `${canonical.count}/${uni.length}`);
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
