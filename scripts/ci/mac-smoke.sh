#!/bin/bash
# CI on a Mac: the installed hub runs under launchd, is supervised, restarts from the UI, stops and starts.
#   bash scripts/ci/mac-smoke.sh <install dir>
set -euo pipefail
DIR="$1"
URL="http://127.0.0.1:7420"
K="$DIR/scripts/krabness"
NODE="$DIR/runtime/node/bin/node"
pass=0
check() { if eval "$2"; then echo "ok  $1"; pass=$((pass + 1)); else echo "FAIL $1"; exit 1; fi; }
json() { curl -fsS --max-time 5 "$URL$1" | "$NODE" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(String($2))})"; }
up() { for _ in $(seq 1 "${1:-60}"); do curl -fsS --max-time 2 "$URL/api/health" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }

check "hub answers" "up 30"
check "supervised (restart and updates from the UI work)" '[ "$(json /api/hub j.supervised)" = true ]'
check "platform is darwin" '[ "$(json /api/hub j.platform)" = darwin ]'
check "can sleep (pmset)" '[ "$(json /api/hub j.canSleep)" = true ]'
check "autostart plist in LaunchAgents" '[ -f "$HOME/Library/LaunchAgents/dev.krabness.hub.plist" ]'
check "launchd agent loaded" 'launchctl print "gui/$(id -u)/dev.krabness.hub" >/dev/null'
check "install folder is private (700)" '[ "$(stat -f %Lp "$DIR")" = 700 ]'
# the agents the installer put next to its Node are found by the hub under launchd's bare PATH
engine() { json /api/engines "j.find(e=>e.id==='$1')?.$2"; }
claude_found() { for _ in $(seq 1 30); do [ "$(engine claude auth?.installed)" = true ] && return 0; sleep 2; done; return 1; }
opencode_up() { for _ in $(seq 1 60); do [ "$(engine opencode available)" = true ] && return 0; sleep 2; done; return 1; }
check "Claude Code CLI found by the hub" claude_found
check "opencode started by the hub" opencode_up

# restart from the UI: the hub exits with 75, the supervisor starts it again with a new startedAt
before="$(json /api/hub j.startedAt)"
curl -fsS -X POST -H 'content-type: application/json' -d '{"delaySec":0}' "$URL/api/hub/restart" >/dev/null
sleep 3
check "back after restart from the UI" "up 60"
after="$(json /api/hub j.startedAt)"
check "it is a new hub process ($before -> $after)" '[ "$after" != "$before" ]'
check "supervisor saw exit code 75" 'grep -q "hub exited with code 75" "$DIR/data/logs/supervisor.log"'

# control from the command line: status, stop, start, restart
check "krabness status" '"$K" status > /tmp/krab-status.txt && grep -q "hub: answers" /tmp/krab-status.txt'
"$K" stop
sleep 2
check "stopped" '! curl -fsS --max-time 2 "$URL/api/health" >/dev/null 2>&1'
check "no hub processes left" '! pgrep -f "apps/hub|src/main.ts" >/dev/null'
"$K" start
check "started again" "up 60"
"$K" restart
sleep 2
check "restart from the command line" "up 60"
echo "$pass checks passed"
