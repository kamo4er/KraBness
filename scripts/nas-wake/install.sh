#!/bin/sh
# Synology helper (optional; the generic way is in README “Waking the PC”). Install / update the wake service on the NAS from the PC (git-bash):
#   sh scripts/nas-wake/install.sh <user@nas-lan-ip> <nas-tailscale-ip> <pc-mac> <pc-lan-ip> <pc-tailscale-ip>
# The PC LAN ip gives the broadcast address; the PC status is checked on its Tailscale ip (the hub listens there).
# Copies the files to ~/kamharn-wake, creates a token once (kept on updates), restarts the service
# and prints the token: put it into KraBness Settings -> “Wake the PC” (address http://<nas-tailscale-ip>:7421)
set -e
TARGET=$1; BIND=$2; MAC=$3; PC=$4; PC_TS=$5
[ -n "$PC_TS" ] || { echo "usage: install.sh user@nas nas-tailscale-ip pc-mac pc-lan-ip pc-tailscale-ip"; exit 1; }
DIR=$(dirname "$0")
ssh "$TARGET" 'mkdir -p kamharn-wake && chmod 700 kamharn-wake'
# scp goes over SFTP, which is off on Synology by default: copy through ssh
for f in wake.py run.sh restart.sh; do ssh "$TARGET" "cat > kamharn-wake/$f" < "$DIR/$f"; done
printf 'BIND=%s\nMAC=%s\nBROADCAST=%s\nPC_HOST=%s\nPC_PORT=7420\n'  "$BIND" "$MAC" "${PC%.*}.255" "$PC_TS" | ssh "$TARGET" 'cat > kamharn-wake/wake.env'
ssh "$TARGET" 'cd kamharn-wake && if [ ! -s token ]; then head -c 32 /dev/urandom | od -An -tx1 | tr -d " \n" > token; chmod 600 token; fi; sh restart.sh; echo "token: $(cat token)"'
