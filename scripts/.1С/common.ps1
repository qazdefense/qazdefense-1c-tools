<#
Общая часть для скриптов .1С\*.ps1: чтение config.psd1/bot.config.psd1,
формирование аргументов подключения/авторизации, отправка Telegram-уведомлений.

Подключается через dot-sourcing:
  . (Join-Path $PSScriptRoot "common.ps1")
#>

$ErrorActionPreference = "Stop"

# git/1cv8.exe пишут в stdout в UTF-8. Без этого PowerShell декодирует вывод
# внешних программ через консольную OEM-кодировку (cp866) — кириллица
# превращается в кракозябры ещё до того, как мы её куда-то записали.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$ScriptDir   = $PSScriptRoot
$RepoRoot    = Split-Path -Parent $ScriptDir
$ConfigFile  = Join-Path $ScriptDir "config.psd1"
$ExampleFile = Join-Path $ScriptDir "config.example.psd1"

if (-not (Test-Path $ConfigFile)) {
    throw "Не найден $ConfigFile. Скопируйте $ExampleFile в config.psd1 и заполните своими значениями."
}
$cfg = Import-PowerShellDataFile -Path $ConfigFile

# Несколько баз 1С живут в Configurations/<ИмяБазы>/, каждая как
# Configuration/ (+ Extensions/ у баз с расширениями) — общая обёртка
# Configurations/ нужна, потому что баз со временем станет много и без неё
# корень репозитория разрастался бы плоским списком (см. .1С/Развитие
# агента 1С/13-множественные-базы-и-расширения-1С.md). ConfigBase в
# config.psd1 выбирает, с какой базой работают деплой-скрипты; без явного
# значения — "Болванка" (исторический дефолт, единственная база до
# появления второй).
$ConfigBase  = if ($cfg.ConfigBase) { $cfg.ConfigBase } else { "Болванка" }
$ConfigRoot  = Join-Path $RepoRoot (Join-Path "Configurations" (Join-Path $ConfigBase "Configuration"))
$ExtensionsRoot = Join-Path $RepoRoot (Join-Path "Configurations" (Join-Path $ConfigBase "Extensions"))

# Наличие $ConfigRoot проверяем ЛЕНИВО (через эту функцию), а не сразу при
# dot-source common.ps1: у новой базы (свежий профиль в base-profiles/,
# указывающий на реальную ИБ) выгрузки Configurations/<Имя>/Configuration/
# в репозитории может ещё не быть — а open-designer.ps1/open-enterprise.ps1/
# update-db.ps1 без -Extension она вообще не нужна, им достаточно File/Server
# из config.psd1, чтобы подключиться к самой ИБ. Раньше проверка была
# безусловной здесь же и ломала эти скрипты для такой базы (живая жалоба
# 2026-09-21: "База TEST" настроена и сохранена, а open-designer падает на
# common.ps1, хотя ему ConfigRoot не нужен). Требуют реального существования
# только deploy-to-ib.ps1 (когда грузит саму конфигурацию, не расширение) и
# dump-config.ps1/DumpConfigToFiles в сторону него.
function Get-ConfigRoot {
    if (-not (Test-Path $ConfigRoot)) {
        throw "Не найдена конфигурация базы '$ConfigBase': $ConfigRoot. Проверьте ConfigBase в config.psd1 (или выгрузите конфигурацию через dump-config.ps1)."
    }
    return $ConfigRoot
}

# Расширение — своя папка выгрузки под Configurations/<База>/Extensions/<Имя>/.
# /LoadConfigFromFiles для расширения требует отдельного вызова с флагом
# -Extension <Имя> (отличается от загрузки самой конфигурации) — deploy-to-ib.ps1
# и update-db.ps1 используют этот резолвер вместо жёсткого $ConfigRoot, когда
# передан параметр -Extension.
function Get-ExtensionRoot([string]$Name) {
    $path = Join-Path $ExtensionsRoot $Name
    if (-not (Test-Path $path)) {
        throw "Не найдено расширение '$Name' в '$ExtensionsRoot'. Проверьте имя папки Configurations/$ConfigBase/Extensions/<Имя>/."
    }
    return $path
}

# Уведомление о деплое в Telegram — ПОЛНОСТЬЮ ОПЦИОНАЛЬНАЯ часть, рассчитанная
# на многоагентную инфраструктуру деплоя (несколько ботов/исполнителей,
# каждый со своим bots/<Id>.psd1: BotToken, ChatId, опционально
# MessageThreadId/NotifyOn). Если такой папки/файлов нет - $botCfg остаётся
# $null, Send-TelegramNotification ниже молча ничего не делает, и весь этот
# блок можно спокойно игнорировать. Чтобы включить: создать
# .1С/bots/default.psd1 (или своё имя) с BotToken/ChatId и передавать его имя
# через -AgentId в deploy-to-ib.ps1/update-db.ps1 (или $env:QAZDEFENSE_AGENT_ID).
$BotDir        = Join-Path $ScriptDir "bots"
$DeployAgentId = if ($AgentId) { $AgentId } else { $env:QAZDEFENSE_AGENT_ID }
$BotConfigFile = $null
if ($DeployAgentId) {
    $candidate = Join-Path $BotDir "$DeployAgentId.psd1"
    if (Test-Path $candidate) { $BotConfigFile = $candidate }
}
if (-not $BotConfigFile) {
    $BotConfigFile = Join-Path $BotDir "default.psd1"
}
$botCfg = if (Test-Path $BotConfigFile) { Import-PowerShellDataFile -Path $BotConfigFile } else { $null }

$PlatformBin = $cfg.PlatformPath
if (-not (Test-Path $PlatformBin)) {
    throw "Не найден 1cv8.exe по пути из config.psd1: $PlatformBin"
}

$LogDir = Join-Path $ScriptDir "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# Через Start-Process -Wait, а не через "&": вызов оператором & не всегда надёжно
# дожидается завершения 1cv8.exe и подхватывает код возврата в этом окружении.
# Codex/VS Code могут передать процессу одновременно Path и PATH. Windows считает
# имена переменных окружения без учёта регистра, а Start-Process пытается сложить
# их в один словарь и падает до запуска 1С. Нормализуем только окружение этого
# процесса; родительское окружение и пользовательские настройки не меняются.
# Перенесено сюда из deploy-to-ib.ps1 2026-09-21 вместе с Invoke-Designer — нужно
# ДО любого Start-Process, в т.ч. из update-db.ps1.
$effectivePath = [Environment]::GetEnvironmentVariable("Path", "Process")
[Environment]::SetEnvironmentVariable("PATH", $null, "Process")
[Environment]::SetEnvironmentVariable("Path", $effectivePath, "Process")

# Запуск Конфигуратора в пакетном режиме с готовыми аргументами подключения/
# авторизации — общая точка для deploy-to-ib.ps1 и update-db.ps1 (перенесена
# сюда 2026-09-21, когда update-db.ps1 тоже понадобился /CheckModules).
function Invoke-Designer([string[]]$ExtraArgs, [string]$LogPath) {
    $cmdArgs = @("DESIGNER")
    $cmdArgs += Get-ConnectionArgs
    $cmdArgs += Get-AuthArgs
    $cmdArgs += @("/DisableStartupDialogs", "/DisableStartupMessages")
    $cmdArgs += $ExtraArgs
    $cmdArgs += ('/Out"' + $LogPath + '"')
    Write-Host ""
    Write-Host "Запуск: `"$PlatformBin`" $($cmdArgs -join ' ')"
    # -WindowStyle Normal (не -NoNewWindow) - живая находка 2026-09-01: тот же
    # LoadConfigFromFiles для НОВОГО корневого объекта метаданных виснет
    # headless (флатлайн CPU, MainWindowHandle=0), но проходит без проблем
    # через интерактивный Дизайнер человека. Разница - вся цепочка процессов
    # агента (claude -p -> PowerShell -> 1cv8.exe) стартует с CREATE_NO_WINDOW/
    # SW_HIDE в managed_process.py; -NoNewWindow здесь наследует эту скрытость
    # дальше на 1cv8.exe. Платформа, похоже, где-то на этом пути всё равно
    # пытается показать окно/диалог (не покрытый /DisableStartupDialogs -
    # возможно первый запуск БПО) и зависает, ожидая ответ от невидимого окна.
    # -WindowStyle Normal форсирует нормальное, видимое окно независимо от
    # унаследованной скрытости - проверяется как гипотеза, не подтверждённый
    # фикс (см. базу знаний, статья про StandardAttributes/headless LoadConfigFromFiles).
    $proc = Start-Process -FilePath $PlatformBin -ArgumentList $cmdArgs -PassThru -Wait -WindowStyle Normal
    Write-Host ""
    Write-Host "Лог ($LogPath):"
    if (Test-Path $LogPath) {
        # | Write-Host, а не голый Get-Content: в PowerShell весь непойманный
        # вывод внутри функции (не только явный return) складывается в её
        # возвращаемое значение - без этого $exitCode на стороне вызывающего
        # кода превращался бы в массив [строки лога..., код возврата] вместо
        # самого кода, и все проверки/сравнения ($exitCode -eq 0) молча ломались.
        Get-Content $LogPath -Encoding OEM | Write-Host
    } else {
        Write-Host "  (файл лога не создан)"
    }
    if ($proc.ExitCode -ne 0) {
        Write-Warning "1cv8.exe завершился с кодом $($proc.ExitCode)"
    }
    return $proc.ExitCode
}

# Разобрать текст лога /CheckModules построчно. Формат строки диагностики:
# {Справочник.Х.Форма.Y.Форма(35,1)}: Сообщение (Проверка: Контекст) — путь
# ДО ОБЪЕКТА МЕТАДАННЫХ, не до файла; чистый прогон печатает одну строку
# "Синтаксических ошибок не обнаружено!" без фигурных скобок.
#
# Для РАСШИРЕНИЯ диагностика "Переменная не определена" на имя, являющееся
# членом расширяемого объекта (реквизит/ТЧ базовой конфигурации, которую
# расширение не заимствовало), — известное ложное срабатывание: модуль
# объекта расширения компилируется в общем с базовым пространстве имён
# ТОЛЬКО в рантайме, а статический анализ этой склейки не делает (см. базу
# знаний: «CheckModules и ложное "Переменная не определена"…»). Поэтому для
# расширений именно эту диагностику понижаем до предупреждения; любая другая
# диагностика (реальный синтаксис, опечатка) этому эффекту не подвержена и
# остаётся блокирующей. Для основной конфигурации понижения нет вообще —
# там межпространственной склейки не бывает.
function ConvertFrom-CheckModulesLog([string]$LogText, [bool]$IsExtension) {
    $result = New-Object System.Collections.Generic.List[object]
    foreach ($rawLine in ($LogText -split "`r?`n")) {
        $line = $rawLine.Trim()
        if (-not $line) { continue }
        if ($line -notmatch '^\{(?<obj>[^}]+)\}:\s*(?<msg>.+)$') { continue }
        # Захватываем obj/msg в локальные переменные СРАЗУ - следующая строка
        # сама делает -match (на $msg), а он перезаписывает общую $Matches
        # своими (безымянными) группами; если читать $Matches['obj']/['msg']
        # после этого, для понижаемых диагностик они окажутся пустыми (живой
        # баг, найден и исправлен 2026-09-21).
        $obj = $Matches['obj']
        $msg = $Matches['msg']
        $isDowngraded = $IsExtension -and $msg -match '^Переменная не определена'
        $result.Add([pscustomobject]@{
            MetadataObject = $obj
            Message        = $msg
            Line           = $line
            Blocking       = -not $isDowngraded
        })
    }
    return $result
}

# Гейт статического анализа BSL перед /UpdateDBCfg. /LoadConfigFromFiles
# синтаксис не проверяет вообще — просто сохраняет текст модуля, поэтому
# без отдельного вызова синтаксическая
# ошибка обнаруживалась бы только по факту сбоя UpdateDBCfg (дороже и на
# уже применяемой к базе конфигурации) либо в рантайме на реальном
# пользователе. Живой замер (2026-09-21, платформа 8.3.27.1989): полный
# прогон -Server -ThinClient — 25 с на «Болванке» (BSP-скелет), 31 с на УПр
# (кастомная конфигурация промышленного размера); проверяется ВСЯ
# конфигурация целиком, не только изменённые файлы — /CheckModules другого
# режима не предусматривает. Код возврата: 0 — чисто, ненулевой
# (проверено — 101) — есть диагностики; лог всегда в UTF-8 с BOM (не OEM,
# в отличие от того, как его печатает на экран Invoke-Designer).
function Invoke-CheckModulesGate {
    param(
        [Parameter(Mandatory)][string]$LogPath,
        [string]$Extension = "",
        [string[]]$Modes = @("-Server", "-ThinClient")
    )
    $extraArgs = @("/CheckModules") + $Modes
    if ($Extension) { $extraArgs += @("-Extension", $Extension) }
    $exitCode = Invoke-Designer $extraArgs $LogPath
    $text = if (Test-Path $LogPath) { [IO.File]::ReadAllText($LogPath, [Text.Encoding]::UTF8) } else { "" }
    $parsed = @(ConvertFrom-CheckModulesLog $text ([bool]$Extension))
    $blocking = @($parsed | Where-Object { $_.Blocking })
    $downgraded = @($parsed | Where-Object { -not $_.Blocking })
    # exit=0 - всегда ок. Ненулевой exit без единой блокирующей диагностики
    # прощаем ТОЛЬКО если нашлось хоть одно объяснение (понижённая
    # диагностика расширения) - необъяснённый ненулевой код (сбой вызова,
    # нераспознанный формат лога) не должен молча становиться "зелёным".
    $ok = ($blocking.Count -eq 0) -and (($exitCode -eq 0) -or ($downgraded.Count -gt 0))
    return [pscustomobject]@{
        ExitCode   = $exitCode
        LogPath    = $LogPath
        Blocking   = $blocking
        Downgraded = $downgraded
        Ok         = $ok
    }
}

# Защита от повторного запуска интерактивного GUI-приложения 1С (Предприятие/
# Конфигуратор) двойным нажатием кнопки/хоткея, пока предыдущее окно ещё
# открыто - без -Wait скрипт возвращается мгновенно, и повторный клик просто
# открывает второй независимый процесс/сессию. Лок-файл хранит PID уже
# запущенного процесса; если он всё ещё жив - новый не стартуем.
function Start-1CGuiProcess {
    param(
        [Parameter(Mandatory)][string]$LockName,
        [Parameter(Mandatory)][string[]]$ProcessArgs,
        [Parameter(Mandatory)][string]$Description
    )

    $lockFile = Join-Path $LogDir "$LockName.lock"

    if (Test-Path $lockFile) {
        $existingPid = Get-Content -Path $lockFile -Raw -ErrorAction SilentlyContinue
        if ($existingPid -match '^\d+$') {
            $existingProc = Get-Process -Id ([int]$existingPid) -ErrorAction SilentlyContinue
            if ($existingProc -and $existingProc.Path -eq $PlatformBin) {
                Write-Host "$Description уже запущен (PID $existingPid) - новое окно не открываю."
                return
            }
        }
    }

    Write-Host "Запускается $Description`: `"$PlatformBin`" $($ProcessArgs -join ' ')"
    $proc = Start-Process -FilePath $PlatformBin -ArgumentList $ProcessArgs -NoNewWindow -PassThru
    Set-Content -Path $lockFile -Value $proc.Id -Encoding ASCII
}

function Get-ConnectionArgs {
    # Значение переключателя оборачиваем в литеральные кавычки ("/F"путь"")
    # - живой баг: Start-Process -ArgumentList склеивает элементы массива
    # ПРОБЕЛОМ без автоматического экранирования (проверено вручную - для
    # "D:\BASES\clients\IVI EXPRESS" получалась голая строка
    # "/FD:\BASES\clients\IVI EXPRESS", которую 1cv8.exe разбирает на
    # пробелах как СВОЙ argv и видит путь обрезанным до "...\IVI" - база не
    # находится ("Информационная база не обнаружена!"), хотя PowerShell
    # Test-Path на реальном пути с пробелом отрабатывает верно. Базы без
    # пробела в пути (например "Болванка") эту проблему не показывали.
    switch ($cfg.ConnectionType) {
        "File" {
            if (-not (Test-Path $cfg.File.Path)) {
                throw "Не найдена папка информационной базы: $($cfg.File.Path)"
            }
            return @('/F"' + $cfg.File.Path + '"')
        }
        "Server" {
            if (-not $cfg.Server.Server -or -not $cfg.Server.Ref) {
                throw "Для ConnectionType=Server заполните Server.Server и Server.Ref в config.psd1"
            }
            return @('/S"' + $cfg.Server.Server + '\' + $cfg.Server.Ref + '"')
        }
        default {
            throw "Неизвестный ConnectionType в config.psd1: $($cfg.ConnectionType). Ожидается File или Server."
        }
    }
}

function Get-AuthArgs {
    # Та же причина в кавычках, что у Get-ConnectionArgs выше - логин/пароль
    # тоже могут содержать пробел (например "Администратор баз").
    $result = @()
    if ($cfg.Auth.User) {
        $result += '/N"' + $cfg.Auth.User + '"'
        if ($cfg.Auth.Password) {
            $result += '/P"' + $cfg.Auth.Password + '"'
        }
    }
    return $result
}

function Send-TelegramNotification {
    param(
        [Parameter(Mandatory)][string]$Text,
        [Parameter(Mandatory)][bool]$Success
    )

    if (-not $botCfg -or -not $botCfg.BotToken -or -not $botCfg.ChatId) {
        return
    }

    $notifyOn = if ($botCfg.NotifyOn) { $botCfg.NotifyOn } else { "Always" }
    $shouldSend = switch ($notifyOn) {
        "OnSuccess" { $Success }
        "OnFailure" { -not $Success }
        default     { $true }
    }
    if (-not $shouldSend) {
        return
    }

    $uri = "https://api.telegram.org/bot$($botCfg.BotToken)/sendMessage"
    $body = @{
        chat_id = $botCfg.ChatId
        text    = $Text
    }
    if ($botCfg.MessageThreadId) {
        $body.message_thread_id = $botCfg.MessageThreadId
    }
    try {
        Invoke-RestMethod -Uri $uri -Method Post -Body $body | Out-Null
    } catch {
        Write-Warning "Не удалось отправить уведомление в Telegram: $_"
    }
}
