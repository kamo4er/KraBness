# Hub port on the home network only for your reverse proxy (a NAS or a router with a public IP), needs admin rights.
# Allows TCP <Port> from -Proxy and blocks it from every other address on that network interface:
# Windows often has a broad "Node.js JavaScript Runtime" allow rule, and a block rule wins over it.
# Example: scripts\firewall-lan.ps1 -Proxy 192.168.0.10
param([Parameter(Mandatory = $true)][string]$Proxy, [int]$Port = 7420, [string]$Interface = "")
$ErrorActionPreference = "Stop"
$ip = [System.Net.IPAddress]::Parse($Proxy)
if ($ip.AddressFamily -ne "InterNetwork") { throw "-Proxy must be an IPv4 address" }
if (-not $Interface) {
  # the interface whose subnet contains the proxy
  $b = $ip.GetAddressBytes()
  foreach ($a in Get-NetIPAddress -AddressFamily IPv4) {
    $mask = [uint32]0
    if ($a.PrefixLength -gt 0) { $mask = [uint32]([math]::Pow(2, 32) - [math]::Pow(2, 32 - $a.PrefixLength)) }
    $x = [System.Net.IPAddress]::Parse($a.IPAddress).GetAddressBytes()
    $n1 = ([uint32]$b[0] -shl 24) -bor ([uint32]$b[1] -shl 16) -bor ([uint32]$b[2] -shl 8) -bor [uint32]$b[3]
    $n2 = ([uint32]$x[0] -shl 24) -bor ([uint32]$x[1] -shl 16) -bor ([uint32]$x[2] -shl 8) -bor [uint32]$x[3]
    if ($a.IPAddress -notlike "127.*" -and (($n1 -band $mask) -eq ($n2 -band $mask)) -and $a.PrefixLength -ge 8) { $Interface = $a.InterfaceAlias; break }
  }
  if (-not $Interface) { throw "no network interface in the same subnet as $Proxy, pass -Interface" }
}
# everything except the proxy address
$o = $ip.GetAddressBytes()
$n = ([uint32]$o[0] -shl 24) -bor ([uint32]$o[1] -shl 16) -bor ([uint32]$o[2] -shl 8) -bor [uint32]$o[3]
function ToIp([uint32]$v) { "{0}.{1}.{2}.{3}" -f (($v -shr 24) -band 255), (($v -shr 16) -band 255), (($v -shr 8) -band 255), ($v -band 255) }
$others = @()
if ($n -gt 0) { $others += "0.0.0.0-" + (ToIp ($n - 1)) }
if ($n -lt [uint32]::MaxValue) { $others += (ToIp ($n + 1)) + "-255.255.255.255" }

$allow = "KraBness hub (LAN proxy)"
$block = "KraBness hub (LAN block)"
foreach ($name in @($allow, $block)) { Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule }
New-NetFirewallRule -DisplayName $allow -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -InterfaceAlias $Interface -RemoteAddress $Proxy -Profile Any | Out-Null
New-NetFirewallRule -DisplayName $block -Direction Inbound -Action Block -Protocol TCP -LocalPort $Port -InterfaceAlias $Interface -RemoteAddress $others -Profile Any | Out-Null
Write-Host "Port $Port on '$Interface': allowed from $Proxy, blocked from everyone else."
