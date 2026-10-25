#!/usr/bin/env bash
# KraBness: remote access through your own server (VPS), for when Tailscale doesn't work from the phone.
# The hub on your PC keeps an outgoing SSH tunnel to this server; Caddy serves it over HTTPS.
#
# What it does (Debian/Ubuntu, run as root, safe to run again):
#   - installs Caddy (automatic Let's Encrypt certificate) if it's missing;
#   - creates the user "krabtunnel" without a shell; the hub key may only open the tunnel to 127.0.0.1:<port>;
#   - adds a site to /etc/caddy/Caddyfile: https://<domain> -> 127.0.0.1:<port>;
#   - opens ports 80 and 443 in ufw if ufw is active.
# Other sites and services on the server are not touched.
#
# Usage (the command with your key is in KraBness: Settings -> Remote access):
#   curl -fsSL https://raw.githubusercontent.com/kamo4er/KraBness/main/scripts/vps-setup.sh | sudo bash -s -- --key 'ssh-ed25519 AAAA... krabness-hub-tunnel'
# Options:
#   --port N        tunnel port on the server (default 17420)
#   --domain NAME   your own domain pointing to this server (default krab.<ip>.sslip.io)
#   --user NAME     tunnel user (default krabtunnel)
set -euo pipefail

KEY=""
PORT=17420
DOMAIN=""
TUSER=krabtunnel
while [ $# -gt 0 ]; do
  case "$1" in
    --key) KEY="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --user) TUSER="${2:-}"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

fail() { echo "KraBness: $*" >&2; exit 1; }
say() { echo "==> $*"; }

[ "$(id -u)" = 0 ] || fail "run as root (sudo bash ...)"
# [[ =~ ]] checks the whole value; grep would accept a second line smuggled into authorized_keys or the Caddyfile
RE_KEY='^ssh-ed25519 [A-Za-z0-9+/=]+( [A-Za-z0-9@._-]+)?$'
RE_PORT='^[0-9]{4,5}$'
RE_USER='^[a-z_][a-z0-9_-]{0,31}$'
RE_IP='^[0-9]{1,3}(\.[0-9]{1,3}){3}$'
RE_DOMAIN='^[A-Za-z0-9.-]+$'
[[ $KEY =~ $RE_KEY ]] || fail "--key must be the hub public key: ssh-ed25519 AAAA... (copy it from KraBness)"
[[ $PORT =~ $RE_PORT ]] && [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || fail "--port must be 1024..65535"
[[ $TUSER =~ $RE_USER ]] || fail "bad --user"

if [ -z "$DOMAIN" ]; then
  IP="$(curl -fsS4 --max-time 10 https://api.ipify.org 2>/dev/null || true)"
  [[ $IP =~ $RE_IP ]] || IP="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+(\.[0-9]+){3}$' | grep -Ev '^(10|127|192\.168|172\.(1[6-9]|2[0-9]|3[01]))\.' | head -1 || true)"
  [[ $IP =~ $RE_IP ]] || fail "couldn't find the public IPv4 of this server, pass --domain"
  DOMAIN="krab.${IP//./-}.sslip.io"
fi
[[ $DOMAIN =~ $RE_DOMAIN ]] || fail "bad --domain"

# ports 80 and 443: Let's Encrypt needs them, and someone else may already listen there
busy="$(ss -ltnpH 2>/dev/null | awk '$4 ~ /:(80|443)$/' | grep -v '"caddy"' || true)"
[ -z "$busy" ] || fail "ports 80/443 are taken by another program, Caddy can't get a certificate:
$busy"

# --- Caddy ---
if ! command -v caddy >/dev/null 2>&1; then
  command -v apt-get >/dev/null 2>&1 || fail "no apt-get here: install Caddy yourself (https://caddyserver.com/docs/install) and run again"
  say "installing Caddy"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg >/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi

# --- tunnel user: no shell, the key can only forward one port ---
NOLOGIN="$(command -v nologin || echo /usr/sbin/nologin)"
if ! id "$TUSER" >/dev/null 2>&1; then
  say "creating user $TUSER"
  useradd --system --create-home --home-dir "/home/$TUSER" --shell "$NOLOGIN" "$TUSER"
fi
HOME_DIR="$(getent passwd "$TUSER" | cut -d: -f6)"
install -d -m 700 -o "$TUSER" -g "$TUSER" "$HOME_DIR/.ssh"
# port-forwarding also allows -L; permitopen to a dead port closes it, so a stolen key can't use the server as a proxy
echo "restrict,port-forwarding,permitlisten=\"127.0.0.1:$PORT\",permitopen=\"127.0.0.1:9\" $KEY" > "$HOME_DIR/.ssh/authorized_keys"
chown "$TUSER:$TUSER" "$HOME_DIR/.ssh/authorized_keys"
chmod 600 "$HOME_DIR/.ssh/authorized_keys"

# sshd settings that would silently block the tunnel
if command -v sshd >/dev/null 2>&1; then
  T="$(sshd -T -C "user=$TUSER,host=localhost,addr=127.0.0.1" 2>/dev/null || true)"
  echo "$T" | grep -qi '^allowtcpforwarding \(no\|local\)' && echo "WARNING: sshd has AllowTcpForwarding no/local, the tunnel won't work. Allow it for $TUSER (Match User $TUSER / AllowTcpForwarding remote)."
  echo "$T" | grep -qi '^allowusers ' && ! echo "$T" | grep -i '^allowusers ' | grep -qw "$TUSER" && echo "WARNING: sshd AllowUsers doesn't include $TUSER, add it."
fi

# --- Caddyfile: our block between markers, everything else stays ---
CF=/etc/caddy/Caddyfile
BLOCK="# >>> krabness ($TUSER)
$DOMAIN {
	reverse_proxy 127.0.0.1:$PORT
}
# <<< krabness ($TUSER)"
[ -f "$CF.krabness-backup" ] || { [ -f "$CF" ] && cp "$CF" "$CF.krabness-backup"; } || true
# the stock Caddyfile is a welcome page on :80; compare it without comments and spaces
STOCK=':80{root*/usr/share/caddyfile_server}'
body="$( [ -f "$CF" ] && grep -v '^[[:space:]]*#' "$CF" | tr -d '[:space:]' || true)"
if [ -z "$body" ] || [ "$body" = "$STOCK" ]; then
  # empty or stock: replaced
  printf '%s\n' "$BLOCK" > "$CF"
else
  awk -v start="# >>> krabness ($TUSER)" -v end="# <<< krabness ($TUSER)" '
    $0 == start { skip = 1; next }
    $0 == end { skip = 0; next }
    !skip { print }' "$CF" > "$CF.tmp"
  if grep -Fq "$DOMAIN" "$CF.tmp"; then
    rm -f "$CF.tmp"
    fail "$DOMAIN is already set up in $CF by hand: remove that site block and run again"
  fi
  # without empty lines at the top on every run
  sed -i -e :a -e '/^\n*$/{$d;N;ba' -e '}' "$CF.tmp"
  [ -n "$(tr -d '[:space:]' < "$CF.tmp")" ] && echo >> "$CF.tmp"
  printf '%s\n' "$BLOCK" >> "$CF.tmp"
  mv "$CF.tmp" "$CF"
fi
out="$(caddy validate --config "$CF" --adapter caddyfile 2>&1)" || fail "Caddyfile check failed (the old one is in $CF.krabness-backup):
$out"
systemctl enable --now caddy >/dev/null 2>&1 || true
systemctl reload caddy || systemctl restart caddy


# --- firewall ---
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  say "ufw: opened 80 and 443"
fi

say "waiting for the certificate"
for _ in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "https://$DOMAIN/" 2>/dev/null || true)"
  [ "$code" != "000" ] && break
  sleep 2
done

SERVER="$(echo "$DOMAIN" | grep -q 'sslip.io$' && echo "${IP:-$DOMAIN}" || echo "$DOMAIN")"
cat <<EOF

Done. In KraBness (Settings -> Remote access) enter:
  Server:          $SERVER
  User:            $TUSER
  Public address:  https://$DOMAIN
EOF
[ "$code" = "000" ] && echo "Note: https://$DOMAIN doesn't answer yet. Check that ports 80 and 443 are open in your hosting panel firewall too."
exit 0
