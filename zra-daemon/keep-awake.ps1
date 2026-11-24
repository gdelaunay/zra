# Garde éveillé — helper résident du daemon (reference/conception-zra-veille.md).
#
# SetThreadExecutionState est porté par le processus appelant : ce script doit
# rester vivant tant que la veille est interdite. Le daemon le tue pour relâcher ;
# la mort du processus (crash du daemon compris) relâche l'état de toute façon.
# Sous Windows, le tray peut tuer le daemon brutalement (job object) : le helper
# survit alors — il surveille le PID du daemon et sort dès qu'il meurt, sinon
# il tiendrait la veille interdite pour toujours (et verrouillerait le dossier
# d'installation par son cwd).
#
# ES_CONTINUOUS | ES_SYSTEM_REQUIRED, sans ES_DISPLAY_REQUIRED : l'écran peut
# s'éteindre, le système reste éveillé.

param([int]$DaemonPid = 0)
$ErrorActionPreference = 'Stop'
Add-Type -Namespace Zra -Name Awake -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);
'@
# ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x00000001) = 2147483649.
# Littéral décimal voulu : PowerShell parse 0x80000001 en int négatif, que la
# signature uint refuse (fait mesuré sur ce poste).
[Zra.Awake]::SetThreadExecutionState(2147483649) | Out-Null
if ($DaemonPid -gt 0) {
  while (Get-Process -Id $DaemonPid -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 5 }
} else {
  while ($true) { Start-Sleep -Seconds 3600 }
}