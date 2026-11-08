#!/bin/bash
# KraBness installer for macOS (beta). One command in Terminal:
#
#   curl -fsSL https://github.com/kamo4er/KraBness/releases/latest/download/install.sh | bash
#
# No sudo and no Homebrew: Node.js comes as the official archive from nodejs.org (checked against SHASUMS256.txt)
# into the KraBness folder, the agents are installed with that Node, the hub runs as a launchd agent.
# Options (environment variables, set them before running):
#   KRABNESS_DIR        install folder (default: ~/KraBness)
#   KRABNESS_PORT       hub port (default: 7420)
#   KRABNESS_TOKEN      GitHub token, only for a private repository
#   KRABNESS_REPO       owner/name (default: kamo4er/KraBness)
#   KRABNESS_AUTOSTART  1 or 0: start with every login (asked if not set)
#   KRABNESS_ZIP        a local release zip instead of downloading (for testing)
#   KRABNESS_OPEN       0: don't open the browser at the end
#   KRABNESS_OPENCODE, KRABNESS_CLAUDE   1 or 0: install them if missing (asked if not set)
set -euo pipefail

DIR="${KRABNESS_DIR:-$HOME/KraBness}"
PORT="${KRABNESS_PORT:-7420}"
REPO="${KRABNESS_REPO:-kamo4er/KraBness}"
TOKEN="${KRABNESS_TOKEN:-}"

say() { printf '\033[36m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m%s\033[0m\n' "$*"; }
warn() { printf '  \033[33m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
# curl | bash: stdin is the script itself, questions go to the terminal; no terminal (CI) — the default "yes"
ask() {
  local q="$1" v="${2:-}" a=""
  [ "$v" = 1 ] && return 0
  [ "$v" = 0 ] && return 1
  if [ -r /dev/tty ] && [ -w /dev/tty ]; then
    printf '%s [Y/n] ' "$q" >/dev/tty
    read -r a </dev/tty || a=""
  fi
  [ -z "$a" ] || [[ $a =~ ^[yY] ]]
}

case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  *) fail "This installer is for macOS. On Windows use install.ps1 (see the README)." ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) fail "Unsupported processor: $(uname -m)" ;;
esac
command -v curl >/dev/null || fail "curl is required"
command -v unzip >/dev/null || fail "unzip is required"

echo
printf '  \033[1mKraBness: AI coding agents on your computer, controlled from your phone\033[0m\n\n'

if [ -f "$DIR/package.json" ]; then
  # finished = dependencies installed and the web UI built; otherwise a previous run stopped halfway
  if [ -f "$DIR/node_modules/.package-lock.json" ] && [ -f "$DIR/apps/web/dist/index.html" ]; then
    fail "KraBness is already installed in $DIR. Updates install from the UI: Settings -> Updates."
  fi
  [ -f "$DIR/data/kamharn.db" ] && fail "$DIR has KraBness data but the installation is incomplete. Move the folder away and run the installer again."
  warn "The previous installation in $DIR was not finished, starting over"
  rm -rf "$DIR"
fi
mkdir -p "$DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 1. Node.js 24 LTS into $DIR/runtime/node
say "1/6  Node.js"
NODE_DIR="$DIR/runtime/node"
if [ ! -x "$NODE_DIR/bin/node" ]; then
  BASE="https://nodejs.org/dist/latest-v24.x"
  curl -fsSL -o "$TMP/SHASUMS256.txt" "$BASE/SHASUMS256.txt" || fail "Can't reach nodejs.org"
  LINE="$(grep -E " node-v[0-9.]+-$OS-$ARCH\.tar\.gz$" "$TMP/SHASUMS256.txt" | head -1)"
  [ -n "$LINE" ] || fail "No Node.js 24 build for $OS-$ARCH on nodejs.org"
  WANT="${LINE%% *}"
  NAME="${LINE##* }"
  ok "downloading $NAME"
  curl -fsSL -o "$TMP/$NAME" "$BASE/$NAME" || fail "Download of $NAME failed"
  HAVE="$(shasum -a 256 "$TMP/$NAME" | cut -d' ' -f1)"
  [ "$HAVE" = "$WANT" ] || fail "Checksum of $NAME doesn't match, not installing"
  mkdir -p "$DIR/runtime"
  tar -xzf "$TMP/$NAME" -C "$TMP"
  mv "$TMP/${NAME%.tar.gz}" "$NODE_DIR"
fi
export PATH="$NODE_DIR/bin:$PATH"
NODE="$NODE_DIR/bin/node"
NPM="$NODE_DIR/bin/npm"
ok "node $("$NODE" -v) ($NODE_DIR)"

# 2. The release
say "2/6  Downloading KraBness"
ZIP="$TMP/krabness.zip"
if [ -n "${KRABNESS_ZIP:-}" ]; then
  cp "$KRABNESS_ZIP" "$ZIP"
  ok "local zip $KRABNESS_ZIP"
else
  H=(-H "Accept: application/vnd.github+json" -H "User-Agent: KraBness-installer")
  [ -n "$TOKEN" ] && H+=(-H "Authorization: Bearer $TOKEN")
  curl -fsSL "${H[@]}" -o "$TMP/release.json" "https://api.github.com/repos/$REPO/releases/latest" || fail "Can't get the latest release of $REPO from GitHub"
  read -r TAG ASSET < <("$NODE" -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const a=(r.assets||[]).find(x=>/^krabness-.*\.zip$/.test(x.name));console.log(r.tag_name,a?a.id:"")' "$TMP/release.json")
  [ -n "$ASSET" ] || fail "The release $TAG has no krabness-*.zip"
  # curl drops the Authorization header on the redirect to the download host
  curl -fsSL "${H[@]}" -H "Accept: application/octet-stream" -o "$ZIP" "https://api.github.com/repos/$REPO/releases/assets/$ASSET" || fail "Download failed"
  ok "$TAG ($(du -h "$ZIP" | cut -f1 | tr -d ' '))"
fi
unzip -q -o "$ZIP" -d "$DIR" || fail "Unpacking failed"
chmod +x "$DIR/scripts/krabness" "$DIR/scripts/"*.sh 2>/dev/null || true
# the first update needs to know which files came with the release; config: port, token, repository
"$NODE" - "$DIR" "$PORT" "$TOKEN" "${KRABNESS_REPO:-}" <<'JS'
const fs = require("fs"), path = require("path");
const [dir, port, token, repo] = process.argv.slice(2);
const entries = fs.readdirSync(dir).filter((e) => !["data", "config", "node_modules", "runtime"].includes(e));
const version = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version;
fs.mkdirSync(path.join(dir, "data", "updates"), { recursive: true });
fs.writeFileSync(path.join(dir, "data", "updates", "installed.json"), JSON.stringify({ version, entries }));
const cfg = {};
if (Number(port) !== 7420) cfg.port = Number(port);
const upd = {};
if (token) upd.token = token;
if (repo) upd.repo = repo;
if (Object.keys(upd).length) cfg.updates = upd;
if (Object.keys(cfg).length) {
  fs.mkdirSync(path.join(dir, "config"), { recursive: true });
  fs.writeFileSync(path.join(dir, "config", "kamharn.json"), JSON.stringify(cfg, null, 2));
}
JS
VERSION="$("$NODE" -p 'require(process.argv[1]).version' "$DIR/package.json")"

# 3. Dependencies and the web UI
say "3/6  Installing dependencies (a minute or two)"
(cd "$DIR" && "$NPM" ci --no-audit --no-fund --loglevel=error) || fail "npm ci failed"
(cd "$DIR" && "$NPM" run web:build --silent >"$TMP/build.log" 2>&1) || { cat "$TMP/build.log"; fail "Building the web UI failed"; }
ok "done"

# 4. Agents (npm -g with our Node: no sudo, the hub finds them next to its node)
say "4/6  Agents and Tailscale"
found() { command -v "$1" >/dev/null 2>&1 || [ -x "$HOME/.local/bin/$1" ] || [ -x "$HOME/.opencode/bin/$1" ] || [ -x "/opt/homebrew/bin/$1" ]; }
ENGINES=0
if ! found opencode; then
  warn "opencode is not installed (free and local models, any API key)"
  if ask "Install opencode now?" "${KRABNESS_OPENCODE:-}"; then "$NPM" install -g opencode-ai --no-audit --no-fund --loglevel=error && ok "opencode installed"; fi
fi
if found opencode; then ok "opencode found"; ENGINES=$((ENGINES + 1)); else warn "opencode not found: npm i -g opencode-ai"; fi
if ! found claude; then
  warn "Claude Code is not installed (needs a Claude subscription or an Anthropic API key)"
  if ask "Install Claude Code now?" "${KRABNESS_CLAUDE:-}"; then "$NPM" install -g @anthropic-ai/claude-code --no-audit --no-fund --loglevel=error && ok "Claude Code installed"; fi
fi
if found claude; then
  ENGINES=$((ENGINES + 1))
  CLAUDE="$(command -v claude || echo "$HOME/.local/bin/claude")"
  if "$CLAUDE" auth status --json 2>/dev/null | grep -q '"loggedIn": *true'; then ok "Claude Code found, signed in"
  else
    ok "Claude Code found"
    warn 'Claude Code is not signed in: run "claude auth login", or later in KraBness: Settings -> Engines -> Sign in on the computer'
  fi
else warn "Claude Code not found: npm i -g @anthropic-ai/claude-code   then sign in: claude auth login"; fi
[ "$ENGINES" -gt 0 ] || warn "Install at least one of them, KraBness needs an agent to run."
if [ -d /Applications/Tailscale.app ] || command -v tailscale >/dev/null 2>&1; then ok "Tailscale found"
else warn "Tailscale is not installed (it connects the phone to this computer, privately): https://tailscale.com/download/mac"; fi

# 5. Autostart
say "5/6  Autostart"
AUTO=""
if ask "Start KraBness automatically when you log in?" "${KRABNESS_AUTOSTART:-}"; then ok "autostart on"; else AUTO="--no-autostart"; ok "autostart off"; fi

# 6. Start
say "6/6  Starting the hub"
"$DIR/scripts/krabness" start $AUTO >/dev/null
URL="http://127.0.0.1:$PORT"
UP=""
for _ in $(seq 1 90); do
  sleep 1
  if curl -fsS --max-time 2 "$URL/api/health" >/dev/null 2>&1; then UP=1; break; fi
done
[ -n "$UP" ] || fail "The hub didn't start. Log: $DIR/data/logs/hub.log"
ok "KraBness $VERSION is running: $URL"
[ "${KRABNESS_OPEN:-1}" = 0 ] || open "$URL" 2>/dev/null || true

cat <<EOF

  Next: connect your phone
   1. Install Tailscale on the Mac and on the phone, same account.
   2. Get the Android app: Settings -> Android app -> Download APK, or the release page on GitHub.
   3. In the web UI: Settings -> Connect a device, then scan the QR code with the app.

  Control: $DIR/scripts/krabness start|stop|restart|status|logs|uninstall
  macOS will ask for permissions (Screen Recording for screenshots, folder access) the first time they're needed.

EOF
