<#
Открывает Конфигуратор 1С (GUI) для тестовой информационной базы.
Настройки берутся из .1С\config.psd1 (см. config.example.psd1 как шаблон).

Использование:
  .\.1С\open-designer.ps1
#>

. (Join-Path $PSScriptRoot "common.ps1")

$cmdArgs = @("DESIGNER")
$cmdArgs += Get-ConnectionArgs
$cmdArgs += Get-AuthArgs

Start-1CGuiProcess -LockName "designer" -ProcessArgs $cmdArgs -Description "Конфигуратор 1С"
