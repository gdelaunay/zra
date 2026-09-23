# Certificat Let's Encrypt pour le daemon, par validation DNS-01 — DEPLOY.md §2.
#
# Le domaine pointe l'IP privée du tunnel (10.77.0.1) : Let's Encrypt ne peut
# pas la joindre, d'où la validation par un enregistrement TXT du DNS. Le
# module Posh-ACME s'en charge, avec le plugin de ton hébergeur DNS (Cloudflare,
# OVH, Gandi… liste : Get-PAPlugin) ou à la main (plugin Manual : il affiche
# l'enregistrement à créer, et ce sera à refaire à chaque renouvellement).
#
#   pwsh scripts/cert.ps1 -Domain zra.exemple.fr -Contact moi@exemple.fr -Plugin Cloudflare -PluginArgs @{ CFToken = (Read-Host -AsSecureString) }
#   pwsh scripts/cert.ps1 -Renew        # à planifier : renouvelle s'il est dû (30 j avant l'échéance)
#
# Le certificat est copié dans .zra/tls/ (ignoré par git) :
#   "tls": { "cert": ".zra/tls/zra.crt", "key": ".zra/tls/zra.key" }   dans zra.config.json
# Le daemon relit ces fichiers à chaud : pas de redémarrage au renouvellement.
#
# Prérequis, une fois (installe un module PowerShell pour l'utilisateur courant) :
#   Install-Module Posh-ACME -Scope CurrentUser

param(
  [string] $Domain,
  [string] $Contact,
  [string] $Plugin = 'Manual',
  [hashtable] $PluginArgs = @{},
  [switch] $Renew,
  # Environnement de test de Let's Encrypt : certificats non reconnus, quotas larges.
  [switch] $Staging
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root '.zra\tls'

if (-not (Get-Module -ListAvailable -Name Posh-ACME)) {
  Write-Host "Posh-ACME absent. Pour l'installer (utilisateur courant, sans admin) :"
  Write-Host "  Install-Module Posh-ACME -Scope CurrentUser"
  exit 2
}
Import-Module Posh-ACME
Set-PAServer ($(if ($Staging) { 'LE_STAGE' } else { 'LE_PROD' }))

function Export-ZraCert($cert) {
  New-Item -ItemType Directory -Force -Path $out | Out-Null
  # Copie puis renommage : le daemon ne voit jamais un fichier à moitié écrit.
  Copy-Item $cert.KeyFile (Join-Path $out 'zra.key.tmp') -Force
  Copy-Item $cert.FullChainFile (Join-Path $out 'zra.crt.tmp') -Force
  Move-Item (Join-Path $out 'zra.key.tmp') (Join-Path $out 'zra.key') -Force
  Move-Item (Join-Path $out 'zra.crt.tmp') (Join-Path $out 'zra.crt') -Force
  Write-Host "✓ certificat $($cert.Subject) valable jusqu'au $($cert.NotAfter) → $out"
}

if ($Renew) {
  $cert = Submit-Renewal -AllOrders
  if ($cert) { $cert | ForEach-Object { Export-ZraCert $_ } }
  else { Write-Host 'rien à renouveler (échéance à plus de 30 jours)' }
  exit 0
}

if (-not $Domain -or -not $Contact) {
  Write-Host 'usage : scripts/cert.ps1 -Domain <domaine> -Contact <e-mail> [-Plugin <hébergeur DNS>] [-PluginArgs @{…}] [-Staging]'
  exit 2
}

$cert = New-PACertificate $Domain -AcceptTOS -Contact $Contact -Plugin $Plugin -PluginArgs $PluginArgs
Export-ZraCert $cert
Write-Host ''
Write-Host 'zra.config.json :'
Write-Host '  "tls": { "cert": ".zra/tls/zra.crt", "key": ".zra/tls/zra.key" }'
Write-Host "Puis dans la PWA : https://$($Domain):7777"
