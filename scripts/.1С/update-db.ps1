<#
Обновляет конфигурацию базы данных тестовой ИБ (/UpdateDBCfg) без загрузки
файлов конфигурации — для случая, когда конфигурация в ИБ уже актуальна
(например, после ручных правок в Конфигураторе) и нужно просто применить
её к базе данных.

Перед /UpdateDBCfg автоматически запускаются два гейта (те же, что у
deploy-to-ib.ps1):
1. /CheckModules -Server -ThinClient — статический синтаксис-контроль ВСЕЙ
   конфигурации/расширения, ~25-30 с (см. Invoke-CheckModulesGate в
   common.ps1). Для расширений диагностика "Переменная не определена" на
   член расширяемого объекта — известное ложное срабатывание (см. базу
   знаний, статья про CheckModules) и не блокирует; любая другая
   диагностика блокирует. Отключить: -SkipCheckModules.
2. /CheckConfig -ConfigLogIntegrity — платформенная проверка логической
   целостности конфигурации, ~5-10 с (см. Invoke-CheckConfigGate в
   common.ps1). Отключить: -SkipCheckConfig.

Настройки берутся из .1С\config.psd1 (см. config.example.psd1 как шаблон).

Использование:
  .\.1С\update-db.ps1
  .\.1С\update-db.ps1 -Extension tkz_test   # применить изменения расширения,
                                              # а не основной конфигурации
  .\.1С\update-db.ps1 -SkipCheckModules -SkipCheckConfig   # без гейтов
#>

param(
    # Имя папки под Configurations/<База>/Extensions/<Имя>/ — см. deploy-to-ib.ps1.
    # Пусто (по умолчанию) = обновляется сама конфигурация.
    [string]$Extension = "",
    # Опционально: имя файла .1С/bots/<AgentId>.psd1 с Telegram-настройками —
    # уведомление уйдёт от этого бота (см. common.ps1, $DeployAgentId).
    # Пусто/нет такого файла = уведомление не шлётся вовсе.
    [string]$AgentId = "",
    # Пропустить /CheckModules перед /UpdateDBCfg (см. описание выше).
    [switch]$SkipCheckModules,
    [string[]]$CheckModulesModes = @("-Server", "-ThinClient"),
    # Пропустить /CheckConfig -ConfigLogIntegrity перед /UpdateDBCfg.
    [switch]$SkipCheckConfig
)

. (Join-Path $PSScriptRoot "common.ps1")

if ($Extension) {
    # Только проверка, что папка расширения существует - сама выгрузка файлов
    # для /UpdateDBCfg не нужна (он применяет уже загруженные ранее изменения).
    [void](Get-ExtensionRoot $Extension)
}

$stamp = Get-Date -Format "yyyyMMdd_HHmmss"

$checkModulesResult = $null
$checkConfigResult = $null
$exitCode = 0
if (-not $SkipCheckModules) {
    $checkModulesLog = Join-Path $LogDir "checkmodules_$stamp.log"
    $checkModulesResult = Invoke-CheckModulesGate -LogPath $checkModulesLog -Extension $Extension -Modes $CheckModulesModes
    if (-not $checkModulesResult.Ok) {
        $exitCode = if ($checkModulesResult.ExitCode -ne 0) { $checkModulesResult.ExitCode } else { 1 }
        Write-Warning "CheckModules нашёл блокирующие диагностики - UpdateDBCfg пропущен (лог: $checkModulesLog)."
        foreach ($item in $checkModulesResult.Blocking) { Write-Host "  $($item.Line)" }
    } elseif ($checkModulesResult.Downgraded.Count -gt 0) {
        Write-Host "CheckModules: $($checkModulesResult.Downgraded.Count) диагностик(и) понижены как известный ложноположительный класс (см. базу знаний)."
    }
}
if (-not $SkipCheckConfig -and $exitCode -eq 0) {
    $checkConfigLog = Join-Path $LogDir "checkconfig_$stamp.log"
    $checkConfigResult = Invoke-CheckConfigGate -LogPath $checkConfigLog -Extension $Extension
    if (-not $checkConfigResult.Ok) {
        $exitCode = if ($checkConfigResult.ExitCode -ne 0) { $checkConfigResult.ExitCode } else { 1 }
        Write-Warning "CheckConfig нашёл нарушения целостности - UpdateDBCfg пропущен (лог: $checkConfigLog)."
        foreach ($item in $checkConfigResult.Blocking) { Write-Host "  $($item.Line)" }
    }
}

$updateLog = $null
if ($exitCode -eq 0) {
    $updateLog = Join-Path $LogDir "update_$stamp.log"
    $updateArgs = @("/UpdateDBCfg")
    if ($Extension) { $updateArgs += @("-Extension", $Extension) }
    $exitCode = Invoke-Designer $updateArgs $updateLog
}

if ($exitCode -ne 0) {
    Write-Warning "1cv8.exe завершился с кодом $exitCode"
}

$success = ($exitCode -eq 0)
$statusLine = if ($success) { "OK" } else { "ОШИБКА (код $exitCode)" }
$notifyText = @"
1С обновление БД$(if ($Extension) { " расширения '$Extension'" }) [$statusLine]
База: $($cfg.ConnectionType) $(if ($cfg.ConnectionType -eq 'File') { $cfg.File.Path } else { "$($cfg.Server.Server)\$($cfg.Server.Ref)" })
Время: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")
"@
Send-TelegramNotification -Text $notifyText -Success $success

exit $exitCode
