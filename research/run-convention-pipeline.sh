#!/usr/bin/env bash
# Drives the convention repair to completion across hourly vendor quota windows.
#
# Every phase is resumable and idempotent, so if this is interrupted it can simply be re-run: the
# audit skips settled tickers, the vendor cache means no payload is fetched twice, and apply only
# touches rows still carrying the retired source.
#
# It never retries into a 429. When the allocation is spent it waits for the clock hour to roll,
# because that is when the allocation resets.

set -u
cd "$(dirname "$0")/.."
R="node --env-file=.env.local research/convention-repair.mjs"
BATCH="${BATCH:-40}"

wait_for_window() {
  local h0
  h0=$(date -u +%H)
  echo "[pipeline] allocation spent; waiting for the hour to roll (now $(date -u +%H:%M) UTC)"
  while [ "$(date -u +%H)" = "$h0" ]; do sleep 60; done
  sleep 60
  echo "[pipeline] new window at $(date -u +%H:%M) UTC"
}

audit_complete() {
  node -e "
    const fs=require('fs');
    const aff=JSON.parse(fs.readFileSync('research/convention-affected.json','utf8'));
    const a=fs.existsSync('research/convention-audit.json')?JSON.parse(fs.readFileSync('research/convention-audit.json','utf8')):{};
    const settled=aff.filter(x=>a[x.ticker]&&a[x.ticker].status==='audited').length;
    process.exit(settled>=aff.length?0:1);
  "
}

retired_rows_left() {
  node --env-file=.env.local -e "
    (async()=>{
      const { neon }=await import('@neondatabase/serverless');
      const sql=neon(process.env.DATABASE_URL);
      const fs=require('fs');
      const a=JSON.parse(fs.readFileSync('research/convention-audit.json','utf8'));
      const t=Object.entries(a).filter(([,v])=>v.action==='REPAIR'||v.action==='RELABEL_ONLY').map(([k])=>k);
      if(!t.length){console.log(0);return}
      const r=await sql.query(\"select count(*)::int n from ticker_daily_candles where source='tiingo' and ticker = any(\$1)\",[t]);
      console.log(r[0].n);
    })();
  "
}

echo '=== PHASE 1: AUDIT ==='
until audit_complete; do
  $R --phase=audit --max="$BATCH"
  audit_complete && break
  wait_for_window
done
echo '[pipeline] audit complete'

echo '=== PHASE 2: SNAPSHOT ==='
# Runs once, after the audit is complete, so it captures exactly the rows the repair will touch.
if [ ! -f research/convention-run-id.txt ]; then
  $R --phase=snapshot || { echo '[pipeline] snapshot failed — stopping'; exit 1; }
else
  echo "[pipeline] snapshot already exists: $(cat research/convention-run-id.txt)"
fi

echo '=== PHASE 3: APPLY ==='
for _ in 1 2 3 4 5 6 7 8; do
  left=$(retired_rows_left)
  echo "[pipeline] retired rows remaining on repairable tickers: $left"
  [ "$left" = "0" ] && break
  $R --phase=apply --confirm
  left=$(retired_rows_left)
  [ "$left" = "0" ] && break
  wait_for_window
done

echo '=== PHASE 4: VALIDATE ==='
$R --phase=validate

echo '=== PHASE 5: DEPLOYMENT GATE ==='
node --env-file=.env.local research/deployment-gate.mjs
echo "[pipeline] finished at $(date -u +%H:%M) UTC"
