# Lanceur du daemon pour la tâche planifiée — `npm run service`.
#
# La tâche l'exécute à l'ouverture de session, dans une console PowerShell
# masquée (-WindowStyle Hidden) : node hérite de cette console invisible, aucune
# fenêtre ne reste à l'écran. On ne passe pas par `conhost --headless`, refusé
# par certaines stratégies d'entreprise.
#
# Le daemon est relancé s'il s'arrête sur une erreur (port pris par un daemon
# de dev, plantage), avec un délai croissant plafonné à une minute. Un arrêt
# propre (code 0 : Ctrl+C, `npm run service -- stop`) termine la boucle.

param(
  [Parameter(Mandatory = $true)] [string] $Node,
  [Parameter(Mandatory = $true)] [string] $Root,
  [Parameter(Mandatory = $true)] [string] $Log
)

$ErrorActionPreference = 'Continue'
$daemon = Join-Path $Root 'zra-daemon\index.js'
$delay = 5

while ($true) {
  $started = Get-Date
  & $Node --no-warnings $daemon --wait-tunnel --log $Log
  $code = $LASTEXITCODE
  if ($code -eq 0) { break }

  # Un daemon qui a tenu plus de cinq minutes repart avec le délai court.
  if (((Get-Date) - $started).TotalMinutes -gt 5) { $delay = 5 }
  $line = '{0} warn  service    daemon arrêté (code {1}) : relance dans {2} s' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'), $code, $delay
  try { Add-Content -Path $Log -Value $line -Encoding utf8 } catch { }
  Start-Sleep -Seconds $delay
  $delay = [Math]::Min($delay * 2, 60)
}
