#!/bin/sh
# Runs wake.py and restarts it if it dies. One instance only (flock).
# Autostart on Synology: Control Panel -> Task Scheduler -> Create -> Triggered Task -> User-defined script,
# user: the owner of this folder, event: Boot-up, command: sh /var/services/homes/<user>/kamharn-wake/run.sh
cd "$(dirname "$0")" || exit 1
exec 9>run.lock
flock -n 9 || exit 0
echo $$ > run.pid
. ./wake.env
while true; do
  [ -f wake.log ] && [ "$(wc -c < wake.log)" -gt 1000000 ] && mv -f wake.log wake.log.1
  python3 wake.py --bind "$BIND" --mac "$MAC" --broadcast "$BROADCAST" --pc-host "$PC_HOST" --pc-port "$PC_PORT" --token-file token >> wake.log 2>&1 &
  echo $! > wake.pid
  wait $!
  sleep 5
done
