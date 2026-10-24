# Allows inbound connections to the KraBness hub only from the Tailscale network (needs admin rights).
# Port 7420 by default, the Tailscale interface, tailnet addresses 100.64.0.0/10.
param([int]$Port = 7420)
$name = "KamHarn hub (Tailscale)"
Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port `
  -InterfaceAlias "Tailscale" -RemoteAddress "100.64.0.0/10" -Profile Any | Out-Null
Get-NetFirewallRule -DisplayName $name | Format-List DisplayName, Enabled, Direction, Action, Profile
