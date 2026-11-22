# Garde éveillé — helper résident du daemon (reference/conception-zra-veille.md).
#
# SetThreadExecutionState est porté par le processus appelant : ce script doit
# rester vivant tant que la veille est interdite. Le daemon le tue pour relâcher ;
# la mort du processus (crash du daemon compris) relâche l'état de toute façon.
#
# ES_CONTINUOUS | ES_SYSTEM_REQUIRED, sans ES_DISPLAY_REQUIRED : l'écran peut
# s'éteindre, le système reste éveillé.

$ErrorActionPreference = 'Stop'
Add-Type -Namespace Zra -Name Awake -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);
'@
# ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x00000001) = 2147483649.
# Littéral décimal voulu : PowerShell parse 0x80000001 en int négatif, que la
# signature uint refuse (fait mesuré sur ce poste).
[Zra.Awake]::SetThreadExecutionState(2147483649) | Out-Null
while ($true) { Start-Sleep -Seconds 3600 }