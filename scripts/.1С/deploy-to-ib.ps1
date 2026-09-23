<#
Загружает изменённые объекты конфигурации 1С (текущая папка выгрузки) обратно
в тестовую информационную базу через Конфигуратор командной строки.

Настройки берутся из .1С\config.psd1 (см. config.example.psd1 как шаблон).

Использование:
  .\.1С\deploy-to-ib.ps1                # загрузить изменённые объекты
  .\.1С\deploy-to-ib.ps1 -UpdateDb       # + обновить конфигурацию базы данных
  .\.1С\deploy-to-ib.ps1 -Base HEAD~1    # сравнить не с HEAD, а с другим коммитом
  .\.1С\deploy-to-ib.ps1 -All            # загрузить всю конфигурацию целиком
  .\.1С\deploy-to-ib.ps1 -Extension tkz_test           # то же самое, но для
                                                         # расширения вместо
                                                         # основной конфигурации
  .\.1С\deploy-to-ib.ps1 -Extension tkz_test -All -UpdateDb
  .\.1С\deploy-to-ib.ps1 -Extension tkz_test -FileListPath .\_scratch\deploy-files.txt -PlanOnly
  .\.1С\deploy-to-ib.ps1 -Extension tkz_test -FileListPath .\_scratch\deploy-files.txt -UpdateDb
  .\.1С\deploy-to-ib.ps1 -UpdateDb -AgentId myBot     # Telegram-уведомление
                                                        # уйдёт от бота
                                                        # .1С\bots\myBot.psd1

Перед /UpdateDBCfg (когда указан -UpdateDb) автоматически запускаются два
гейта:
1. /CheckModules -Server -ThinClient — статический синтаксис-контроль ВСЕЙ
   конфигурации/расширения, ~25-30 с. Находит ошибку до того, как она
   попадёт в применяемую к базе конфигурацию, а не по факту сбоя
   UpdateDBCfg или в рантайме у пользователя. Для расширений диагностика
   "Переменная не определена" на член расширяемого объекта — известное
   ложное срабатывание (см. базу знаний, статья про CheckModules) и не
   блокирует; любая другая диагностика блокирует деплой. Отключить:
   -SkipCheckModules.
2. /CheckConfig -ConfigLogIntegrity — платформенная проверка логической
   целостности конфигурации (ссылки метаданных/права/формы, без разбора
   BSL), ~5-10 с. Отключить: -SkipCheckConfig.
#>

param(
    [string]$Base = "HEAD",
    [switch]$UpdateDb,
    # Не коммитить каталог базы после успешного деплоя (по умолчанию коммитим:
    # задеплоенное состояние становится базой для следующего частичного деплоя).
    [switch]$NoCommit,
    [switch]$All,
    # Явный список файлов задачи. Пути могут быть абсолютными,
    # от корня репозитория или от корня выгрузки. Это безопасный
    # режим для агентов в общем dirty-worktree.
    [string[]]$Files = @(),
    # То же, но один путь на строку: удобнее и надёжнее из CLI.
    [string]$FileListPath = "",
    # Предохранитель от случайного деплоя чужих изменений.
    [ValidateRange(1, 100000)]
    [int]$MaxObjects = 200,
    [switch]$AllowWideDeploy,
    # Показать точный план, но не запускать 1cv8.exe.
    [switch]$PlanOnly,
    # scaffold = первая фаза нового объекта: только корневой XML-дескриптор,
    # без форм, модулей и макетов. implementation = обычное наполнение.
    [ValidateSet("implementation", "scaffold")]
    [string]$Phase = "implementation",
    # Имя папки под Configurations/<База>/Extensions/<Имя>/ — деплоится это
    # расширение отдельным вызовом /LoadConfigFromFiles -Extension <Имя>,
    # вместо основной конфигурации. Пусто (по умолчанию) = как раньше,
    # деплоится сама конфигурация.
    [string]$Extension = "",
    # Пропустить /CheckModules перед /UpdateDBCfg (см. описание выше). По
    # умолчанию включена - выключать только осознанно (например, конфигурация
    # заведомо огромная и 25-30 с статического анализа неприемлемы для этого
    # конкретного вызова).
    [switch]$SkipCheckModules,
    [string[]]$CheckModulesModes = @("-Server", "-ThinClient"),
    # Пропустить /CheckConfig -ConfigLogIntegrity перед /UpdateDBCfg (см.
    # Invoke-CheckConfigGate в common.ps1) - платформенная проверка логической
    # целостности конфигурации, отдельная от /CheckModules (тот - только BSL).
    [switch]$SkipCheckConfig,
    # Опционально: имя файла .1С/bots/<AgentId>.psd1 с Telegram-настройками —
    # уведомление о результате деплоя уйдёт от этого бота (см. common.ps1,
    # $DeployAgentId). Пусто/нет такого файла = уведомление не шлётся вовсе.
    [string]$AgentId = ""
)

. (Join-Path $PSScriptRoot "common.ps1")

$LoadRoot = if ($Extension) { Get-ExtensionRoot $Extension } else { Get-ConfigRoot }
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$LoadRoot = [IO.Path]::GetFullPath($LoadRoot)

$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$deployStartedAt = [DateTime]::UtcNow

function Get-ChangedFiles([string]$Root) {
    Push-Location $Root
    try {
        $hasHead = $true
        try { git rev-parse --verify $Base 2>$null | Out-Null } catch { $hasHead = $false }
        if (-not $?) { $hasHead = $false }

        # --relative обязателен для git diff (в отличие от git ls-files, у
        # которого это и так поведение по умолчанию): без него git diff из
        # подпапки репозитория (после переноса конфигурации в Configuration/)
        # отдаёт пути от КОРНЯ РЕПОЗИТОРИЯ целиком - в список попали бы
        # posторонние изменения вне Configuration/ (например, правки
        # bot-server), а у настоящих объектов метаданных путь начинался бы с
        # лишнего "Configuration\", которое Convert-ToObjectDescriptors не
        # ожидает и не смогло бы разобрать.
        $files = @()
        if ($hasHead) {
            $files += git diff --name-only --relative --diff-filter=ACMR $Base
        }
        $files += git diff --name-only --relative --cached --diff-filter=ACMR
        $files += git ls-files --others --exclude-standard
        return ($files | Where-Object { $_ } | Sort-Object -Unique)
    } finally {
        Pop-Location
    }
}

function Test-IsNewObjectDescriptor([string]$RelativePath, [string]$Root) {
    Push-Location $Root
    try {
        $prefix = (git rev-parse --show-prefix 2>$null).Trim()
        if (-not $?) { throw "Не удалось определить git-префик для '$Root'." }
        $gitPath = ($prefix + ($RelativePath -replace '\\', '/'))
        $entry = git ls-tree $Base -- $gitPath 2>$null
        if (-not $?) { throw "Не удалось проверить '$gitPath' в '$Base'." }
        return (-not [bool]$entry)
    } finally {
        Pop-Location
    }
}

function Get-ExplicitFiles([string[]]$InputFiles, [string]$InputListPath, [string]$Root) {
    $requested = @($InputFiles | Where-Object { $_ -and $_.Trim() })
    if ($InputListPath) {
        $resolvedList = if ([IO.Path]::IsPathRooted($InputListPath)) {
            [IO.Path]::GetFullPath($InputListPath)
        } else {
            [IO.Path]::GetFullPath((Join-Path (Get-Location) $InputListPath))
        }
        if (-not (Test-Path -LiteralPath $resolvedList -PathType Leaf)) {
            throw "Файл списка деплоя не найден: $resolvedList"
        }
        $requested += Get-Content -LiteralPath $resolvedList -Encoding UTF8 |
            Where-Object { $_ -and $_.Trim() -and -not $_.Trim().StartsWith("#") }
    }
    if (-not $requested) { return @() }

    $rootPrefix = $Root.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $result = @()
    foreach ($item in $requested) {
        $raw = $item.Trim()
        $candidates = if ([IO.Path]::IsPathRooted($raw)) {
            @($raw)
        } else {
            @((Join-Path $RepoRoot $raw), (Join-Path $Root $raw))
        }
        $fullPath = $null
        foreach ($candidate in $candidates) {
            $candidateFull = [IO.Path]::GetFullPath($candidate)
            if (Test-Path -LiteralPath $candidateFull -PathType Leaf) {
                $fullPath = $candidateFull
                break
            }
        }
        if (-not $fullPath) {
            throw "Файл из явного списка деплоя не найден: $raw"
        }
        if (-not $fullPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Файл '$raw' не входит в выбранную выгрузку '$Root'. Проверьте -Extension."
        }
        $result += $fullPath.Substring($rootPrefix.Length).Replace('\', '/')
    }
    return @($result | Sort-Object -Unique)
}

function Convert-ToObjectDescriptors($files) {
    $set = New-Object System.Collections.Generic.HashSet[string]
    foreach ($f in $files) {
        # Игнорируем служебные папки репозитория — это не объекты метаданных 1С.
        if ($f -like ".1С/*" -or $f -like ".1С\*") { continue }
        if ($f -like ".vscode/*" -or $f -like ".vscode\*") { continue }
        if ($f -like ".claude/*" -or $f -like ".claude\*") { continue }
        if ($f -like ".git/*" -or $f -like ".git\*") { continue }
        # ConfigDumpInfo.xml — служебный файл, обновляется сам через -updateConfigDumpInfo,
        # его не нужно (и нельзя) передавать как объект для загрузки.
        if ($f -eq "ConfigDumpInfo.xml") { continue }

        $norm = $f -replace '/', '\'
        # git diff --relative считает пути от $Root (Push-Location выше), а не
        # от корня репозитория - файл, изменённый ГДЕ-ТО ЕЩЁ (например, в
        # bot-server или в другой базе Configurations/), попадёт сюда с
        # ведущими "..\": без явного отсева он ошибочно превратился бы в
        # мусорный объект метаданных вида "..\<что-то>.xml" (особенно
        # реально для расширения — Extensions/<Имя>/ вложена на уровень
        # глубже, чем Configuration/, и чаще собирает соседние "..\" пути).
        if ($norm.StartsWith("..")) { continue }
        $parts = $norm -split '\\'
        if ($parts.Count -eq 1) {
            # Из корневых файлов объектом метаданных является только Configuration.xml.
            if ($parts[0] -eq "Configuration.xml") {
                [void]$set.Add($parts[0])
            }
            continue
        }
        if ($parts[0] -eq "Ext") {
            # Ext\*.bsl в корне выгрузки — общие модули самой конфигурации
            # (ExternalConnectionModule.bsl, ManagedApplicationModule.bsl,
            # SessionModule.bsl и т.п.), не отдельный объект метаданных.
            # Живой баг: попадали сюда как "Documents\X\Ext\..." (второе
            # звено пути — тип объекта), и превращались в мусорный
            # дескриптор "Ext\ИмяФайла.bsl.xml" — такого файла не существует,
            # 1cv8.exe падал с "Файл не обнаружен". Правильный объект для
            # изменения в корневом Ext\ — сама конфигурация.
            [void]$set.Add("Configuration.xml")
            continue
        }
        $type = $parts[0]
        $second = $parts[1]
        if ($second -match '\.xml$') {
            [void]$set.Add("$type\$second")
        } else {
            [void]$set.Add("$type\$second.xml")
        }
    }
    return $set
}

function Convert-ToLongPath([string]$Path) {
    $fullPath = [IO.Path]::GetFullPath($Path)
    if ($fullPath.StartsWith('\\')) {
        return '\\?\UNC\' + $fullPath.Substring(2)
    }
    return '\\?\' + $fullPath
}

function Test-DeploymentInputs($ChangedFiles, $ObjectDescriptors, [string]$Root) {
    foreach ($object in $ObjectDescriptors) {
        $objectPath = Convert-ToLongPath (Join-Path $Root $object)
        if (-not [IO.File]::Exists($objectPath)) {
            throw "Рассчитанный объект метаданных не найден: $object. Деплой остановлен до запуска 1С."
        }
    }

    $validatedXml = 0
    $validatedBsl = 0
    $xmlSettings = New-Object System.Xml.XmlReaderSettings
    $xmlSettings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
    $xmlSettings.XmlResolver = $null
    $strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
    foreach ($relativePath in $ChangedFiles) {
        $fullPath = Convert-ToLongPath (Join-Path $Root $relativePath)
        $extension = [IO.Path]::GetExtension($relativePath).ToLowerInvariant()
        if ($extension -eq '.xml') {
            $reader = $null
            $stream = $null
            try {
                $stream = [IO.File]::OpenRead($fullPath)
                $reader = [System.Xml.XmlReader]::Create($stream, $xmlSettings)
                while ($reader.Read()) { }
                $validatedXml++
            } catch {
                throw "Некорректный XML '$relativePath': $($_.Exception.Message). Деплой остановлен до запуска 1С."
            } finally {
                if ($reader) { $reader.Dispose() }
                if ($stream) { $stream.Dispose() }
            }
        } elseif ($extension -eq '.bsl') {
            try {
                $bytes = [IO.File]::ReadAllBytes($fullPath)
                if ([Array]::IndexOf($bytes, [byte]0) -ge 0) {
                    throw "обнаружен нулевой байт"
                }
                [void]$strictUtf8.GetString($bytes)
                $validatedBsl++
            } catch {
                throw "Модуль BSL '$relativePath' не является корректным UTF-8 текстом: $($_.Exception.Message). Деплой остановлен до запуска 1С."
            }
        }
    }
    Write-Host "Preflight: объектов $($ObjectDescriptors.Count), XML проверено $validatedXml, BSL UTF-8 проверено $validatedBsl."
}

function Write-DeployReceipt([int]$LoadExitCode, $UpdateExitCode, [string]$LoadLogPath, [string]$UpdateLogPath, $CheckModulesResult, $CheckConfigResult) {
    $receiptDir = Join-Path $LogDir "deploy-receipts"
    New-Item -ItemType Directory -Force -Path $receiptDir | Out-Null
    $taskId = if ($env:QAZDEFENSE_TASK_ID -match '^\d{1,20}$') { $env:QAZDEFENSE_TASK_ID } else { $null }
    $receiptName = if ($taskId) { "task-$taskId-$Phase-$stamp.json" } else { "manual-$Phase-$stamp.json" }
    $receiptPath = Join-Path $receiptDir $receiptName
    $temporaryPath = "$receiptPath.tmp"
    $checkModulesField = if ($null -eq $CheckModulesResult) {
        [ordered]@{ ran = $false }
    } else {
        [ordered]@{
            ran = $true
            ok = $CheckModulesResult.Ok
            exit_code = $CheckModulesResult.ExitCode
            log = [IO.Path]::GetFileName($CheckModulesResult.LogPath)
            blocking = @($CheckModulesResult.Blocking | ForEach-Object { $_.Line })
            downgraded = @($CheckModulesResult.Downgraded | ForEach-Object { $_.Line })
        }
    }
    $checkConfigField = if ($null -eq $CheckConfigResult) {
        [ordered]@{ ran = $false }
    } else {
        [ordered]@{
            ran = $true
            ok = $CheckConfigResult.Ok
            exit_code = $CheckConfigResult.ExitCode
            log = [IO.Path]::GetFileName($CheckConfigResult.LogPath)
            blocking = @($CheckConfigResult.Blocking | ForEach-Object { $_.Line })
        }
    }
    $receipt = [ordered]@{
        schema_version = 1
        task_id = $taskId
        agent_id = if ($DeployAgentId) { $DeployAgentId } else { $null }
        started_at = $deployStartedAt.ToString("o")
        finished_at = [DateTime]::UtcNow.ToString("o")
        success = ($LoadExitCode -eq 0 -and ($null -eq $CheckModulesResult -or $CheckModulesResult.Ok) -and ($null -eq $CheckConfigResult -or $CheckConfigResult.Ok) -and ($null -eq $UpdateExitCode -or $UpdateExitCode -eq 0))
        phase = $Phase
        base = $ConfigBase
        target = if ($Extension) { "extension" } else { "configuration" }
        extension = if ($Extension) { $Extension } else { $null }
        update_db = [bool]$UpdateDb
        all = [bool]$All
        explicit_files = [bool]$hasExplicitFiles
        files = if ($All) { @() } else { @($changed) }
        objects = if ($All) { @("*") } else { @($objects | Sort-Object) }
        load_exit_code = $LoadExitCode
        check_modules = $checkModulesField
        check_config = $checkConfigField
        update_exit_code = $UpdateExitCode
        load_log = [IO.Path]::GetFileName($LoadLogPath)
        update_log = if ($UpdateLogPath) { [IO.Path]::GetFileName($UpdateLogPath) } else { $null }
    }
    $json = $receipt | ConvertTo-Json -Depth 5
    [IO.File]::WriteAllText($temporaryPath, $json, (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temporaryPath -Destination $receiptPath -Force
    Write-Host "Отчёт деплоя: $receiptPath"
    return $receiptPath
}

$loadLog = Join-Path $LogDir "load_$stamp.log"
$loadArgs = @()
$hasExplicitFiles = ($Files.Count -gt 0) -or [bool]$FileListPath

if ($All -and $hasExplicitFiles) {
    throw "-All нельзя совмещать с -Files или -FileListPath."
}
if ($Phase -eq "scaffold" -and ($All -or -not $hasExplicitFiles)) {
    throw "Фаза scaffold требует точный -Files/-FileListPath и несовместима с -All."
}
if ($Phase -eq "scaffold" -and $UpdateDb) {
    throw "Фаза scaffold только загружает болванку в конфигурацию. /UpdateDBCfg выполняется после наполнения, в фазе implementation."
}

if ($All) {
    Write-Host "Загружается ВСЯ $(if ($Extension) { "выгрузка расширения '$Extension'" } else { "конфигурация" }) из $LoadRoot"
    # Путь в кавычках - живой баг: Start-Process -ArgumentList склеивает
    # элементы массива ПРОБЕЛОМ без автоматического экранирования, а
    # $LoadRoot может содержать пробел (например "Configurations\IVI
    # EXPRESS\Configuration") - без кавычек 1cv8.exe обрезал бы путь на
    # первом пробеле и не находил базу ("Файл не обнаружен ...\IVI"),
    # проверено вручную. Та же причина, что у Get-ConnectionArgs в
    # common.ps1.
    $loadArgs += @("/LoadConfigFromFiles", ('"' + $LoadRoot + '"'))
    if (-not $Extension) {
        # -updateConfigDumpInfo только для основной конфигурации - в паре с
        # -Extension эта комбинация не документирована и на практике даёт
        # "Ошибка в параметрах командной строки" (проверено живьём).
        $loadArgs += "-updateConfigDumpInfo"
    }
} else {
    $changed = if ($hasExplicitFiles) {
        Get-ExplicitFiles $Files $FileListPath $LoadRoot
    } else {
        Get-ChangedFiles $LoadRoot
    }
    if (-not $changed) {
        Write-Host "Изменённых файлов не найдено (относительно $Base, staged, untracked)."
        exit 0
    }

    $objects = Convert-ToObjectDescriptors $changed
    if (-not $objects -or $objects.Count -eq 0) {
        Write-Host "После фильтрации не осталось объектов метаданных для загрузки."
        exit 0
    }

    if (-not $AllowWideDeploy -and $objects.Count -gt $MaxObjects) {
        throw "Защита от широкого деплоя: найдено $($objects.Count) объектов, лимит $MaxObjects. Сократите -FileListPath/-Files до файлов этой задачи или осознанно укажите -AllowWideDeploy."
    }

    Test-DeploymentInputs $changed $objects $LoadRoot

    if ($Phase -eq "scaffold") {
        $descriptorSet = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach ($object in $objects) { [void]$descriptorSet.Add(($object -replace '\\', '/')) }
        $invalidScaffoldFiles = @($changed | Where-Object { -not $descriptorSet.Contains(($_ -replace '\\', '/')) })
        if ($invalidScaffoldFiles) {
            throw "Фаза scaffold разрешает только корневые XML-дескрипторы объектов. Формы, модули, макеты и прочие вложенные файлы добавляются только после успешной загрузки болванки. Лишние: $($invalidScaffoldFiles -join ', ')"
        }
        # Configuration.xml — исключение: 1cv8.exe отказывается добавлять
        # новый корневой объект метаданных без "родителя" ("нельзя добавлять
        # объекты метаданных без загрузки родительского объекта", проверено
        # живьём) - родитель для DataProcessor/Catalog/... верхнего уровня
        # это сама конфигурация, и её ChildObjects обязательно должен
        # содержать ссылку на новый объект уже в scaffold-фазе. Сам
        # Configuration.xml никогда не бывает "новым" (он один на
        # конфигурацию), поэтому его отдельно исключаем из проверки
        # новизны - остальные файлы scaffold-фазы (сами объекты) по-прежнему
        # обязаны быть новыми.
        $notNewDescriptors = @($changed | Where-Object {
            $_ -ne "Configuration.xml" -and -not (Test-IsNewObjectDescriptor $_ $LoadRoot)
        })
        if ($notNewDescriptors) {
            throw "Фаза scaffold предназначена только для новых объектов, которых нет в '$Base'. Уже существуют: $($notNewDescriptors -join ', ')"
        }
    }

    Write-Host "Изменённые файлы:"
    $changed | ForEach-Object { Write-Host "  $_" }
    Write-Host ""
    Write-Host "Будут загружены объекты метаданных:"
    $objects | ForEach-Object { Write-Host "  $_" }

    # Список объектов передаём через файл (-ListFile), а не прямо в командной строке:
    # при большом числе изменённых объектов аргумент командной строки может превысить
    # лимит длины, который ОС отводит на вызов процесса, и обрежется посреди пути.
    # 1cv8.exe читает -ListFile как Unicode-текст (UTF-16LE с BOM).
    if (-not $PlanOnly) {
        $listFile = Join-Path $LogDir "files_$stamp.txt"
        # Явный -Files/-FileListPath: при частичной загрузке 1cv8.exe не
        # подхватывает сам дочерние объекты (Forms/Templates), которых ещё
        # нет в конфигурации ИБ, если в -ListFile передан только корневой XML
        # родителя - падает с "Неизвестный объект метаданных ...Form..."
        # (проверено живьём при первом добавлении формы к DataProcessor и
        # макета к Report). Поэтому в explicit-режиме пишем в -ListFile
        # реальный запрошенный список файлов $changed (уже провалидирован
        # Get-ExplicitFiles), а не свёрнутый до корневых дескрипторов
        # $objects. В implicit-режиме (диф с $Base) оставляем $objects - там
        # $changed может содержать посторонние пути вне объектов метаданных,
        # которые Convert-ToObjectDescriptors намеренно отфильтровывает.
        $listFileContent = if ($hasExplicitFiles) { $changed } else { $objects }
        Set-Content -Path $listFile -Value $listFileContent -Encoding Unicode
        $loadArgs += @("/LoadConfigFromFiles", ('"' + $LoadRoot + '"'), "-ListFile", ('"' + $listFile + '"'))
        if (-not $Extension) {
            $loadArgs += "-updateConfigDumpInfo"
        }
    }
}
if ($Extension) {
    # Отдельный флаг /LoadConfigFromFiles для расширения - без него платформа
    # попыталась бы применить эти файлы как правку самой конфигурации, а не
    # расширения.
    $loadArgs += @("-Extension", $Extension)
}

if ($PlanOnly) {
    Write-Host ""
    Write-Host "PLAN ONLY: 1cv8.exe не запускался."
    Write-Host "Цель: $(if ($Extension) { "расширение '$Extension'" } else { "основная конфигурация" })"
    Write-Host "Обновление БД: $([bool]$UpdateDb)"
    Write-Host "Фаза: $Phase"
    exit 0
}

$loadExitCode = Invoke-Designer $loadArgs $loadLog
$exitCode = $loadExitCode
$checkModulesResult = $null
$checkConfigResult = $null
$updateExitCode = $null
$updateLog = $null

# Перед /UpdateDBCfg - статический синтаксис-контроль ВСЕЙ конфигурации/
# расширения через /CheckModules (см. Invoke-CheckModulesGate в common.ps1).
# Ловит синтаксические/семантические ошибки модулей ДО того, как правка
# попадёт в структуру рабочей БД, а не по факту сбоя UpdateDBCfg или в
# рантайме у пользователя. Гейт применяется только когда реально собираемся
# обновлять БД - иначе это лишние ~25-30 с на каждой загрузке без апдейта.
if ($UpdateDb -and -not $SkipCheckModules -and $exitCode -eq 0) {
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

# Платформенная проверка логической целостности конфигурации (см.
# Invoke-CheckConfigGate в common.ps1) - отдельная от /CheckModules команда:
# та смотрит только BSL, эта - ссылки метаданных/права/формы без разбора
# кода модулей. Быстрее CheckModules (5-10 с против 25-30), поэтому идёт
# после него без отдельной оговорки по времени.
if ($UpdateDb -and -not $SkipCheckConfig -and $exitCode -eq 0) {
    $checkConfigLog = Join-Path $LogDir "checkconfig_$stamp.log"
    $checkConfigResult = Invoke-CheckConfigGate -LogPath $checkConfigLog -Extension $Extension
    if (-not $checkConfigResult.Ok) {
        $exitCode = if ($checkConfigResult.ExitCode -ne 0) { $checkConfigResult.ExitCode } else { 1 }
        Write-Warning "CheckConfig нашёл нарушения целостности - UpdateDBCfg пропущен (лог: $checkConfigLog)."
        foreach ($item in $checkConfigResult.Blocking) { Write-Host "  $($item.Line)" }
    }
}

# /UpdateDBCfg всегда отдельным вызовом 1cv8.exe, а не дописанным в
# командную строку /LoadConfigFromFiles - для расширений это документированно
# обязательно (см. комментарий ниже), а для основной конфигурации так сделано
# ради единообразия: между load и update теперь всегда может встать гейт
# CheckModules.
#
# Для расширения /UpdateDBCfg -Extension <Имя> обязан идти ОТДЕЛЬНЫМ
# вызовом 1cv8.exe, не дописанным в командную строку /LoadConfigFromFiles -
# живой источник (форум Инфостарт, тема про пакетное обновление расширений
# из хранилища): "с расширениями это не работает - должно быть две команды
# последовательно - первая только загружает расширение из файла, вторая
# только применяет".
if ($UpdateDb -and $exitCode -eq 0) {
    $updateLog = Join-Path $LogDir $(if ($Extension) { "update_ext_$stamp.log" } else { "update_$stamp.log" })
    $updateArgs = @("/UpdateDBCfg")
    if ($Extension) { $updateArgs += @("-Extension", $Extension) }
    $updateExitCode = Invoke-Designer $updateArgs $updateLog
    $exitCode = $updateExitCode
}

[void](Write-DeployReceipt $loadExitCode $updateExitCode $loadLog $updateLog $checkModulesResult $checkConfigResult)

# Успешный деплой фиксируем коммитом каталога базы: список файлов для
# следующего деплоя считается от git HEAD, и без коммита каждый запуск
# грузил бы все накопленные объекты заново (живая жалоба 2026-09-18: один
# макет — 10 минут). Коммитится только Configurations/<База>/, чужие правки
# по другим базам не трогаем.
if ($exitCode -eq 0 -and -not $NoCommit -and -not $PlanOnly) {
    $basePath = "Configurations/" + $ConfigBase.Replace("\", "/")
    & git -C $RepoRoot add -A -- $basePath 2>$null
    $staged = & git -C $RepoRoot diff --cached --name-only -- $basePath 2>$null
    if ($staged) {
        $what = if ($All) { "полная загрузка" } else { "$(@($objects).Count) объект(ов)" }
        $msg = "$ConfigBase`: деплой $(Get-Date -Format 'yyyy-MM-dd HH:mm') ($what)$(if ($Extension) { ", расширение $Extension" })$(if ($UpdateDb) { ", обновление БД" })"
        & git -C $RepoRoot -c core.quotepath=false commit -q -m $msg -- $basePath 2>$null
        Write-Host "Коммит: $msg"
    }
}

# Уведомление шлём только когда реально обновлялась база (/UpdateDBCfg), а не
# при обычной загрузке объектов в конфигурацию — это ещё не изменение базы.
if ($UpdateDb) {
    $success = ($exitCode -eq 0)
    $objectsSummary = if ($All) { if ($Extension) { "всё расширение '$Extension'" } else { "вся конфигурация" } } else { ($objects | Sort-Object) -join ", " }
    $statusLine = if ($success) { "OK" } else { "ОШИБКА (код $exitCode)" }
    $notifyText = @"
1С деплой$(if ($Extension) { " расширения '$Extension'" }) + обновление БД [$statusLine]
База: $($cfg.ConnectionType) $(if ($cfg.ConnectionType -eq 'File') { $cfg.File.Path } else { "$($cfg.Server.Server)\$($cfg.Server.Ref)" })
Объекты: $objectsSummary
Время: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")
"@
    Send-TelegramNotification -Text $notifyText -Success $success
}

exit $exitCode
