#!/bin/sh
# Stop the running wake service (if any) and start it detached. Run on the NAS.
cd "$(dirname "$0")" || exit 1
for f in run.pid wake.pid; do
  [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null
done
sleep 1
setsid nohup sh "$PWD/run.sh" > /dev/null 2>&1 < /dev/null &
sleep 3
tail -n 2 wake.log
