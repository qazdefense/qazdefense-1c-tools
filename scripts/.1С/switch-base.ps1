<#
Переключает активную базу деплоя (.1С\config.psd1) между заранее
подготовленными профилями в .1С\base-profiles\<Имя>.psd1 — без ручного
редактирования config.psd1 при каждом переходе между базами.

Каждый профиль — самостоятельный файл того же формата, что и config.psd1
(см. config.example.psd1): свой ConfigBase, свой путь/сервер ИБ, свой логин
и пароль (не у всех баз они вообще есть — пустая строка допустима).
Профили, как и сам config.psd1, в .gitignore — там может быть пароль.

Использование:
  .\.1С\switch-base.ps1 -List                 # какие профили есть, какой активен
  .\.1С\switch-base.ps1 -Name Болванка         # сделать активным base-profiles\Болванка.psd1
  .\.1С\switch-base.ps1 -List -Json            # то же самое, но JSON (для дашборда)

Как завести новый профиль:
  1. Скопировать .1С\config.example.psd1 → .1С\base-profiles\<Имя>.psd1
  2. Заполнить ConfigBase/ConnectionType/File или Server/Auth
  3. .\.1С\switch-base.ps1 -Name <Имя>
#>

param(
    [string]$Name = "",
    [switch]$List,
    [switch]$Json
)

$ErrorActionPreference = "Stop"

# Вывод скрипта читает Python как UTF-8. Без этой строки Windows
# PowerShell 5.1 пишет stdout в OEM-кодировку консоли (cp866 на русской
# Windows), и в дашборде имена баз и пути с кириллицей приезжали
# кракозябрами: «Кабинет сотрудника/eo» превращалось в мусор. В части
# хостов потоки уже перенаправлены и присваивание бросает — тогда просто
# работаем как раньше.
try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch { }

$ScriptDir = $PSScriptRoot
$ActiveFile = Join-Path $ScriptDir "config.psd1"
$ProfilesDir = Join-Path $ScriptDir "base-profiles"

function Get-ProfileSummary([System.IO.FileInfo]$File, [string]$ActiveHash) {
    $profileName = $File.BaseName
    try {
        $cfg = Import-PowerShellDataFile -Path $File.FullName
        $target = if ($cfg.ConnectionType -eq "Server") {
            "$($cfg.Server.Server)\$($cfg.Server.Ref)"
        } else {
            $cfg.File.Path
        }
        $hash = (Get-FileHash -Path $File.FullName -Algorithm SHA256).Hash
        return [pscustomobject]@{
            name            = $profileName
            config_base     = $cfg.ConfigBase
            connection_type = $cfg.ConnectionType
            target          = $target
            has_auth        = [bool]($cfg.Auth.User)
            # Активный профиль определяется по СОДЕРЖИМОМУ (хеш), не по имени
            # или ConfigBase — это единственный способ точно знать, что
            # config.psd1 прямо сейчас является копией именно этого файла.
            active          = ($ActiveHash -and $hash -eq $ActiveHash)
            error           = $null
        }
    } catch {
        return [pscustomobject]@{
            name = $profileName; config_base = $null; connection_type = $null
            target = $null; has_auth = $false; active = $false
            error = $_.Exception.Message
        }
    }
}

function Get-AllProfiles {
    if (-not (Test-Path $ProfilesDir)) {
        return @()
    }
    $activeHash = $null
    if (Test-Path $ActiveFile) {
        $activeHash = (Get-FileHash -Path $ActiveFile -Algorithm SHA256).Hash
    }
    $files = Get-ChildItem -Path $ProfilesDir -Filter "*.psd1" -File
    return @($files | ForEach-Object { Get-ProfileSummary $_ $activeHash })
}

if ($Name) {
    $profilePath = Join-Path $ProfilesDir "$Name.psd1"
    if (-not (Test-Path $profilePath)) {
        throw "Нет профиля '$profilePath'. Сначала: Copy-Item .1С\config.example.psd1 '.1С\base-profiles\$Name.psd1' и заполнить его."
    }
    Copy-Item -Path $profilePath -Destination $ActiveFile -Force
    $cfg = Import-PowerShellDataFile -Path $ActiveFile
    $target = if ($cfg.ConnectionType -eq "Server") { "$($cfg.Server.Server)\$($cfg.Server.Ref)" } else { $cfg.File.Path }
    if ($Json) {
        [pscustomobject]@{ ok = $true; switched_to = $Name; config_base = $cfg.ConfigBase; target = $target } |
            ConvertTo-Json -Compress
    } else {
        Write-Host "Активная база переключена на '$Name': ConfigBase=$($cfg.ConfigBase), $($cfg.ConnectionType) -> $target" -ForegroundColor Green
    }
    exit 0
}

if ($List -or -not $Name) {
    $profiles = Get-AllProfiles
    if ($Json) {
        # ConvertTo-Json в Windows PowerShell 5.1 "разворачивает" массив из
        # ОДНОГО элемента в голый объект, даже если он лежит вложенным
        # свойством (не только на верхнем уровне пайплайна) - без ручной
        # проверки на стороне дашборда JS сломался бы именно на случае
        # "ровно один профиль" (самый частый случай на старте). -AsArray
        # тут недоступен (появился только в PowerShell 7+).
        $profilesJson = if (@($profiles).Count -eq 0) {
            "[]"
        } else {
            $raw = ConvertTo-Json -InputObject @($profiles) -Depth 5 -Compress
            if ($raw.TrimStart()[0] -ne '[') { "[$raw]" } else { $raw }
        }
        Write-Output ('{"ok":true,"profiles":' + $profilesJson + '}')
    } else {
        if (-not $profiles) {
            Write-Host "Профилей не найдено. Скопируйте config.example.psd1 в base-profiles\<Имя>.psd1, чтобы завести первый."
        } else {
            $profiles | Format-Table -Property @(
                @{ Label = "Профиль"; Expression = { $_.name } },
                @{ Label = "Активен"; Expression = { if ($_.active) { "*" } else { "" } } },
                @{ Label = "ConfigBase"; Expression = { $_.config_base } },
                @{ Label = "Тип"; Expression = { $_.connection_type } },
                @{ Label = "Куда"; Expression = { $_.target } },
                @{ Label = "Логин задан"; Expression = { $_.has_auth } }
            ) -AutoSize
        }
    }
    exit 0
}
