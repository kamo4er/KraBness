# KraBness installer for Windows. One command in PowerShell:
#
#   irm https://github.com/kamo4er/KraBness/releases/latest/download/install.ps1 | iex
#
# It checks Node.js, downloads the latest release, installs dependencies, builds the web UI,
# asks about the firewall rule for Tailscale and autostart, starts the hub and opens it in the browser.
# Options (environment variables, set them before running):
#   KRABNESS_DIR        install folder (default: %USERPROFILE%\KraBness)
#   KRABNESS_PORT       hub port (default: 7420)
#   KRABNESS_TOKEN      GitHub token, only while the repository is private
#   KRABNESS_REPO       owner/name (default: kamo4er/KraBness)
#   KRABNESS_AUTOSTART  1 or 0: start with Windows (asked if not set)
#   KRABNESS_FIREWALL   1 or 0: allow phones over Tailscale, needs admin (asked if not set)
#   KRABNESS_ZIP        a local release zip instead of downloading (for testing)
#   KRABNESS_OPEN       0: don't open the browser at the end
#   KRABNESS_NODE       1 or 0: install Node.js if it is missing (asked if not set)
#   KRABNESS_OPENCODE, KRABNESS_CLAUDE, KRABNESS_TAILSCALE   1 or 0: install them if missing (asked if not set)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Say($m) { Write-Host $m -ForegroundColor Cyan }
function Ok($m) { Write-Host "  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "`n$m" -ForegroundColor Red; throw "KraBness: $m" }
function Ask($question, $envValue) {
  if ($envValue -eq '1') { return $true }
  if ($envValue -eq '0') { return $false }
  $a = Read-Host "$question [Y/n]"
  return ($a -eq '' -or $a -match '^[yY]')
}
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

# Node.js LTS from nodejs.org without winget: the official MSI, checked against SHASUMS256.txt, installed with admin rights
function Install-NodeMsi($curl) {
  $list = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json'
  $rel = $list | Where-Object { $_.lts -and $_.version -like 'v24.*' } | Select-Object -First 1
  if (-not $rel) { Fail 'Could not find Node.js 24 LTS on nodejs.org' }
  $v = $rel.version
  $name = "node-$v-x64.msi"
  $msi = Join-Path $env:TEMP $name
  Ok "downloading $name"
  & $curl -fsSL -o $msi "https://nodejs.org/dist/$v/$name"
  if ($LASTEXITCODE -ne 0) { Fail "Download of $name failed (curl code $LASTEXITCODE)" }
  $sums = (& $curl -fsSL "https://nodejs.org/dist/$v/SHASUMS256.txt") -split "`n"
  $want = ($sums | Where-Object { $_ -match [regex]::Escape($name) } | Select-Object -First 1) -replace '\s.*$', ''
  $have = (Get-FileHash -Algorithm SHA256 $msi).Hash.ToLower()
  if (-not $want -or $want.ToLower() -ne $have) { Remove-Item -Force $msi; Fail "Checksum of $name doesn't match, not installing" }
  Ok 'checksum ok, installing (a window with progress may appear)'
  $p = Start-Process msiexec.exe -Verb RunAs -Wait -PassThru -ArgumentList '/i', "`"$msi`"", '/passive', '/norestart'
  Remove-Item -Force $msi -ErrorAction SilentlyContinue
  if ($p.ExitCode -ne 0) { Fail "Node.js installer exited with code $($p.ExitCode)" }
}

# Tailscale without winget: the official MSI from pkgs.tailscale.com, checked against its .sha256, installed with admin rights
function Install-TailscaleMsi($curl) {
  $msi = Join-Path $env:TEMP 'tailscale-setup.msi'
  Ok 'downloading Tailscale'
  # -w %{url_effective}: the "latest" link redirects to the versioned file, its .sha256 sits next to it
  $final = & $curl -fsSL -o $msi -w '%{url_effective}' 'https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi'
  if ($LASTEXITCODE -ne 0) { Fail "Download of Tailscale failed (curl code $LASTEXITCODE)" }
  $want = ((& $curl -fsSL "$final.sha256") -split '\s')[0]
  $have = (Get-FileHash -Algorithm SHA256 $msi).Hash.ToLower()
  if (-not $want -or $want.ToLower() -ne $have) { Remove-Item -Force $msi; Fail "Checksum of the Tailscale installer doesn't match, not installing" }
  Ok 'checksum ok, installing'
  $p = Start-Process msiexec.exe -Verb RunAs -Wait -PassThru -ArgumentList '/i', "`"$msi`"", '/passive', '/norestart'
  Remove-Item -Force $msi -ErrorAction SilentlyContinue
  if ($p.ExitCode -ne 0) { Warn "Tailscale installer exited with code $($p.ExitCode)" }
}

function Install-KraBness {
  $dir = if ($env:KRABNESS_DIR) { $env:KRABNESS_DIR } else { Join-Path $HOME 'KraBness' }
  $port = if ($env:KRABNESS_PORT) { [int]$env:KRABNESS_PORT } else { 7420 }
  $repo = if ($env:KRABNESS_REPO) { $env:KRABNESS_REPO } else { 'kamo4er/KraBness' }
  $token = $env:KRABNESS_TOKEN
  $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
  $tar = Join-Path $env:SystemRoot 'System32\tar.exe'

  Write-Host ''
  Write-Host '  KraBness: AI coding agents on your PC, controlled from your phone' -ForegroundColor White
  Write-Host ''

  if (Test-Path (Join-Path $dir 'package.json')) {
    # finished = dependencies installed and the web UI built; otherwise a previous run stopped halfway
    $done = (Test-Path (Join-Path $dir 'node_modules\.package-lock.json')) -and (Test-Path (Join-Path $dir 'apps\web\dist\index.html'))
    if ($done) { Fail "KraBness is already installed in $dir. Updates install from the UI: Settings -> Updates." }
    if (Test-Path (Join-Path $dir 'data\kamharn.db')) { Fail "$dir has KraBness data but the installation is incomplete. Move the folder away and run the installer again." }
    Warn "The previous installation in $dir was not finished, starting over"
    Remove-Item -Recurse -Force $dir
  }

  # 1. Node.js 22+
  Say '1/6  Node.js'
  $node = Get-Command node -ErrorAction SilentlyContinue
  $major = 0
  if ($node) { $major = [int]((& node -v) -replace '^v(\d+).*', '$1') }
  if ($major -lt 22) {
    if ($major) { Warn "Node.js $(& node -v) is too old, 22 or newer is needed (24 LTS recommended)" } else { Warn 'Node.js is not installed' }
    if (Ask 'Download and install Node.js 24 LTS now? (Windows asks for admin rights)' $env:KRABNESS_NODE) {
      if (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
      } else {
        Install-NodeMsi $curl
      }
      Refresh-Path
      if (Get-Command node -ErrorAction SilentlyContinue) { $major = [int]((& node -v) -replace '^v(\d+).*', '$1') }
    }
    if ($major -lt 22) { Fail 'Install Node.js 24 LTS from https://nodejs.org and run this installer again.' }
  }
  Ok "node $(& node -v)"

  # 2. Download the release
  Say '2/6  Downloading KraBness'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $zip = Join-Path $env:TEMP "krabness-$PID.zip"
  if ($env:KRABNESS_ZIP) {
    Copy-Item $env:KRABNESS_ZIP $zip
    Ok "local zip $env:KRABNESS_ZIP"
  } else {
    $headers = @{ 'User-Agent' = 'KraBness-installer'; Accept = 'application/vnd.github+json' }
    if ($token) { $headers.Authorization = "Bearer $token" }
    try {
      $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers $headers
    } catch {
      Fail "Can't get the latest release of $repo from GitHub: $($_.Exception.Message)"
    }
    $asset = $rel.assets | Where-Object { $_.name -like 'krabness-*.zip' } | Select-Object -First 1
    if (-not $asset) { Fail "The release $($rel.tag_name) has no krabness-*.zip" }
    # curl drops the Authorization header on the redirect to the download host, PowerShell 5 does not
    $a = @('-fsSL', '-H', 'Accept: application/octet-stream', '-H', 'User-Agent: KraBness-installer', '-o', $zip)
    if ($token) { $a += @('-H', "Authorization: Bearer $token") }
    & $curl @a "https://api.github.com/repos/$repo/releases/assets/$($asset.id)"
    if ($LASTEXITCODE -ne 0) { Fail "Download failed (curl code $LASTEXITCODE)" }
    Ok "$($rel.tag_name) ($([math]::Round((Get-Item $zip).Length / 1MB, 1)) MB)"
  }
  & $tar -xf $zip -C $dir
  if ($LASTEXITCODE -ne 0) { Fail 'Unpacking failed' }
  Remove-Item -Force $zip
  # the first update needs to know which files came with the release
  $entries = @(Get-ChildItem -Force $dir | ForEach-Object { $_.Name } | Where-Object { $_ -notin @('data', 'config', 'node_modules') })
  $version = (Get-Content -Raw (Join-Path $dir 'package.json') | ConvertFrom-Json).version
  New-Item -ItemType Directory -Force -Path (Join-Path $dir 'data\updates') | Out-Null
  [IO.File]::WriteAllText((Join-Path $dir 'data\updates\installed.json'), (@{ version = $version; entries = $entries } | ConvertTo-Json -Compress))

  # config: port and token (the rest are defaults, editable in the UI)
  $cfg = @{}
  if ($port -ne 7420) { $cfg.port = $port }
  if ($token) { $cfg.updates = @{ token = $token } }
  if ($cfg.Count) {
    New-Item -ItemType Directory -Force -Path (Join-Path $dir 'config') | Out-Null
    [IO.File]::WriteAllText((Join-Path $dir 'config\kamharn.json'), ($cfg | ConvertTo-Json -Depth 5))
  }

  # 3. Dependencies and the web UI
  Say '3/6  Installing dependencies (a minute or two)'
  # npm.cmd, not npm: Node also ships npm.ps1, and with the default execution policy PowerShell refuses to run it
  $npm = (Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
  if (-not $npm) { Fail 'npm not found next to Node.js. Reinstall Node.js 24 LTS from https://nodejs.org' }
  Push-Location $dir
  try {
    & $npm ci --no-audit --no-fund --loglevel=error
    if ($LASTEXITCODE -ne 0) { Fail 'npm ci failed' }
    # with 'Stop', PowerShell 5 turns redirected stderr lines (vite warnings) into errors
    $ErrorActionPreference = 'Continue'
    $build = & $npm run web:build --silent 2>&1
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($code -ne 0) { $build | Write-Host; Fail 'Building the web UI failed' }
  } finally { Pop-Location }
  Ok 'done'

  # 4. Agents and Tailscale
  Say '4/6  Agents and Tailscale'
  $engines = 0
  # -CommandType Application: .exe/.cmd only; npm-installed tools also have a .ps1 shim that the execution policy blocks
  $app = { param($n) (Get-Command $n -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source }
  # npm -g puts tools into %APPDATA%\npm: no admin rights needed, the hub finds the exe there
  $npmGlobal = {
    param($pkg)
    # Out-Host: npm output must not become the return value of this block
    & $npm install -g $pkg --no-audit --no-fund --loglevel=error | Out-Host
    $ok = $LASTEXITCODE -eq 0
    Refresh-Path
    $env:Path = "$env:APPDATA\npm;$env:Path"
    return $ok
  }
  if (-not (& $app 'opencode')) {
    Warn 'opencode is not installed (free and local models, any API key)'
    if ((Ask 'Install opencode now?' $env:KRABNESS_OPENCODE) -and (& $npmGlobal 'opencode-ai')) { Ok 'opencode installed' }
  }
  if (& $app 'opencode') { Ok 'opencode found'; $engines++ } else { Warn 'opencode not found: npm i -g opencode-ai' }
  if (-not (& $app 'claude')) {
    Warn 'Claude Code is not installed (needs a Claude subscription or an Anthropic API key)'
    if ((Ask 'Install Claude Code now?' $env:KRABNESS_CLAUDE) -and (& $npmGlobal '@anthropic-ai/claude-code')) { Ok 'Claude Code installed' }
  }
  $claude = & $app 'claude'
  if ($claude) {
    $engines++
    $st = $null
    $ErrorActionPreference = 'Continue'
    try { $st = (& $claude auth status --json 2>$null | Out-String) | ConvertFrom-Json } catch { }
    $ErrorActionPreference = 'Stop'
    if ($st -and $st.loggedIn) { Ok 'Claude Code found, signed in' }
    else {
      Ok 'Claude Code found'
      Warn 'Claude Code is not signed in: run "claude auth login", or later in KraBness: Settings -> Engines -> Sign in on the PC'
    }
  } else { Warn 'Claude Code not found: npm i -g @anthropic-ai/claude-code   then sign in: claude auth login' }
  if (-not $engines) { Warn 'Install at least one of them, KraBness needs an agent to run.' }
  $tsExe = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
  $ts = (Get-Command tailscale -ErrorAction SilentlyContinue) -or (Test-Path $tsExe)
  if (-not $ts) {
    Warn 'Tailscale is not installed (it connects the phone to this PC, privately)'
    if (Ask 'Install Tailscale now? (Windows asks for admin rights)' $env:KRABNESS_TAILSCALE) {
      if (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install -e --id Tailscale.Tailscale --accept-source-agreements --accept-package-agreements
      } else {
        Install-TailscaleMsi $curl
      }
      $ts = Test-Path $tsExe
      if ($ts) {
        Ok 'Tailscale installed'
        Warn 'Sign in to Tailscale: the Tailscale icon in the tray -> Log in (use the same account on the phone)'
        $ipn = Join-Path $env:ProgramFiles 'Tailscale\tailscale-ipn.exe'
        if (Test-Path $ipn) { try { Start-Process $ipn } catch { } }
      }
    }
  }
  if ($ts) { Ok 'Tailscale found' } else { Warn 'Tailscale not found: https://tailscale.com/download (needed to connect the phone)' }

  # 5. Firewall and autostart
  Say '5/6  Firewall and autostart'
  if (Ask 'Allow your phone to connect over Tailscale? (a firewall rule, Windows asks for admin rights)' $env:KRABNESS_FIREWALL) {
    $fw = Join-Path $dir 'scripts\firewall-tailscale.ps1'
    try {
      Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$fw`" -Port $port"
      Ok 'firewall rule added'
    } catch { Warn "skipped: $($_.Exception.Message)" }
  }
  if (Ask 'Start KraBness automatically when you log in to Windows?' $env:KRABNESS_AUTOSTART) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir 'scripts\autostart.ps1') | Out-Null
    Ok 'autostart on'
  }

  # 6. Start
  Say '6/6  Starting the hub'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir 'scripts\hub-service.ps1') -Detach -Port $port | Out-Null
  $url = "http://127.0.0.1:$port"
  $up = $false
  for ($i = 0; $i -lt 60 -and -not $up; $i++) {
    Start-Sleep -Seconds 1
    try { $up = (Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 2).ok } catch { }
  }
  if (-not $up) { Fail "The hub didn't start. Log: $dir\data\logs\hub.log" }
  Ok "KraBness $version is running: $url"
  if ($env:KRABNESS_OPEN -ne '0') { Start-Process $url }

  Write-Host ''
  Write-Host '  Next: connect your phone' -ForegroundColor White
  Write-Host '   1. Install Tailscale on the phone, same account as on the PC.'
  Write-Host "   2. Get the Android app: Settings -> Android app -> Download APK, or the release page on GitHub."
  Write-Host '   3. In the web UI: Settings -> Connect a device, then scan the QR code with the app.'
  Write-Host ''
  Write-Host "  Stop: $dir\scripts\hub-service.ps1 -Stop    Folder: $dir"
  Write-Host ''
}

# Fail already printed the reason in red; the PowerShell error record on top of it only scares people.
# Run as a file -> exit code 1; run via "irm | iex" -> no exit, it would close the user's window.
$fileRun = [bool]$MyInvocation.MyCommand.Path
try { Install-KraBness } catch {
  if ($_.FullyQualifiedErrorId -notmatch '^(KraBness: )') { Write-Host "`n$($_.Exception.Message)" -ForegroundColor Red }
  if ($fileRun) { exit 1 }
}
