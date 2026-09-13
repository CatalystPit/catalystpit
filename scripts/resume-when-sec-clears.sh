#!/bin/bash
# Waits for SEC to lift the 403 block, then restarts the 13F ingest driver.
# Probes ONCE every 10 minutes with a single request: polling harder is what extends a block.
LOG=/tmp/sec-resume.log
for i in $(seq 1 144); do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 20 \
    -H "User-Agent: CatalystPit contact@catalystpit.com" \
    "https://data.sec.gov/submissions/CIK0001067983.json" 2>/dev/null)
  echo "$(date +%H:%M:%S) probe $i -> $CODE" >> $LOG
  if [ "$CODE" = "200" ]; then
    echo "$(date +%H:%M:%S) SEC CLEARED, restarting driver" >> $LOG
    nohup bash /c/Users/bcogh/Documents/dev/catalystpit/scripts/drive-institutions.sh /tmp/drive-13f.log > /dev/null 2>&1 &
    echo "SEC BLOCK CLEARED after $i probes; 13F driver restarted"
    exit 0
  fi
  sleep 600
done
echo "SEC still blocking after 24 hours"
