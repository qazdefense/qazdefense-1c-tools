<#
Запускает 1С:Предприятие (GUI) для тестовой информационной базы.
Настройки берутся из .1С\config.psd1 (см. config.example.psd1 как шаблон).

Использование:
  .\.1С\open-enterprise.ps1
#>

. (Join-Path $PSScriptRoot "common.ps1")

$cmdArgs = @("ENTERPRISE")
$cmdArgs += Get-ConnectionArgs
$cmdArgs += Get-AuthArgs

Start-1CGuiProcess -LockName "enterprise" -ProcessArgs $cmdArgs -Description "1С:Предприятие"
