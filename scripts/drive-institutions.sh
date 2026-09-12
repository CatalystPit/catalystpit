#!/bin/bash
# Drives the 13F ingest continuously against the local dev server until every registered filer has
# holdings. Independent of the Vercel cron. Each pass is bounded server-side; this just keeps
# calling it. Idempotent, so an interrupted pass costs nothing.
LOG="${1:-/tmp/drive-13f.log}"
for i in $(seq 1 2000); do
  curl -s -m 600 -H "x-vercel-cron: 1" \
    "http://localhost:3000/api/cron/institutions-universe?indexes=1&ingestCap=120&tickerCap=0" \
    -o /tmp/pass.json 2>/dev/null
  echo "$(date +%H:%M:%S) pass $i $(head -c 200 /tmp/pass.json 2>/dev/null)" >> "$LOG"
  sleep 3
done
