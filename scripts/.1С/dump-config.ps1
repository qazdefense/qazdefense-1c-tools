<#
Выгружает конфигурацию (или расширение) тестовой ИБ в XML-файлы
(/DumpConfigToFiles) в указанную папку — для дамп-сверки после деплоя:
exit 0 у /LoadConfigFromFiles и /UpdateDBCfg не доказывает, что изменения
реально легли в базу — надёжнее сверить дамп с тем, что должно было уйти.

Настройки берутся из .1С\config.psd1 (см. config.example.psd1 как шаблон).

Использование:
  .\.1С\dump-config.ps1 -OutDir .\dump-20260917
  .\.1С\dump-config.ps1 -OutDir .\dump -Extension МоёРасширение
  # затем сверка (пример): git diff --no-index Configurations\МояБаза\Configuration .\dump-20260917
#>

param(
    # Папка выгрузки. Создаётся, если нет; существующее содержимое перезаписывается.
    [Parameter(Mandatory = $true)]
    [string]$OutDir,
    # Имя расширения (Configurations/<База>/Extensions/<Имя>/). Пусто = основная конфигурация.
    [string]$Extension = ""
)

. (Join-Path $PSScriptRoot "common.ps1")

if ($Extension) {
    [void](Get-ExtensionRoot $Extension)
}

$OutDir = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $OutDir))
if (-not (Test-Path $OutDir)) {
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
}

$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$dumpLog = Join-Path $LogDir "dump_$stamp.log"

$cmdArgs = @("DESIGNER")
$cmdArgs += Get-ConnectionArgs
$cmdArgs += Get-AuthArgs
$cmdArgs += @("/DisableStartupDialogs", "/DisableStartupMessages")
$cmdArgs += ('/DumpConfigToFiles"' + $OutDir + '"')
if ($Extension) {
    $cmdArgs += @("-Extension", $Extension)
}
$cmdArgs += ('/Out"' + $dumpLog + '"')

Write-Host "Запуск: `"$PlatformBin`" $($cmdArgs -join ' ')"
$proc = Start-Process -FilePath $PlatformBin -ArgumentList $cmdArgs -PassThru -Wait -WindowStyle Normal
$exitCode = $proc.ExitCode

Write-Host ""
Write-Host "Лог ($dumpLog):"
if (Test-Path $dumpLog) {
    Get-Content $dumpLog -Encoding OEM
} else {
    Write-Host "  (файл лога не создан)"
}

if ($exitCode -ne 0) {
    Write-Warning "1cv8.exe завершился с кодом $exitCode"
} else {
    Write-Host "Выгрузка: $OutDir"
}

exit $exitCode
