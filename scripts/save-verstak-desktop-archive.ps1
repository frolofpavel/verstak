# Архив работы по Verstak на рабочий стол
$ErrorActionPreference = 'Stop'
$now = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
$dateTag = Get-Date -Format 'yyyy-MM-dd'
$desktop = [Environment]::GetFolderPath('Desktop')
$zipName = "Verstak-work-archive-$dateTag.zip"
$zipPath = Join-Path $desktop $zipName
$staging = Join-Path $env:TEMP "verstak-archive-$dateTag"
$grok = Join-Path $env:USERPROFILE '.grok'
$verstak = 'C:\Users\RAYNER\verstak'
$sessionId = '019ee346-7e04-7360-bcc2-58057aa6a786'
$sessionDir = Join-Path $grok "sessions\C%3A%5CUsers%5CRAYNER\$sessionId"

function Ensure-Dir($p) {
  if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null }
}

if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
Ensure-Dir $staging

# Транскрипт сессии
$trans = Join-Path $staging 'transcript'
Ensure-Dir $trans
foreach ($f in @('updates.jsonl','chat_history.jsonl','summary.json','events.jsonl')) {
  $src = Join-Path $sessionDir $f
  if (Test-Path $src) { Copy-Item $src (Join-Path $trans $f) -Force }
}
if (Test-Path (Join-Path $sessionDir 'terminal')) {
  Copy-Item (Join-Path $sessionDir 'terminal') (Join-Path $trans 'terminal') -Recurse -Force
}
@{ sessionId = $sessionId; sessionDir = $sessionDir; copiedAt = $now } | ConvertTo-Json | Set-Content (Join-Path $trans 'session-info.json') -Encoding UTF8

# Skill
$skillDst = Join-Path $staging 'skill\verstak'
Ensure-Dir $skillDst
$skillSrc = Join-Path $grok 'skills\verstak\SKILL.md'
if (Test-Path $skillSrc) { Copy-Item $skillSrc $skillDst -Force }

# Журнал
$journalDst = Join-Path $staging 'journal'
Ensure-Dir $journalDst
$journalSrc = 'D:\PROGRAMMS\VERSTAK\Verstak - Журнал изменений.docx'
if (Test-Path $journalSrc) { Copy-Item $journalSrc $journalDst -Force }

# Проект: git + ключевые файлы
$proj = Join-Path $staging 'project'
Ensure-Dir $proj
Push-Location $verstak
try {
  git status --short | Out-File (Join-Path $proj 'git-status.txt') -Encoding UTF8
  git log --oneline -20 | Out-File (Join-Path $proj 'git-log.txt') -Encoding UTF8
  git rev-parse HEAD | Out-File (Join-Path $proj 'git-head.txt') -Encoding UTF8
  git diff HEAD | Out-File (Join-Path $proj 'git-diff.patch') -Encoding UTF8
} finally { Pop-Location }

$tree = Join-Path $proj 'tree'
Ensure-Dir $tree
$copyPaths = @(
  'electron\updater.ts','electron\update-staging.ts','electron\update-install.ts','electron\updater-cache.ts',
  'electron\update-remote.ts','electron\system-node.ts','electron\update-payload-extract.ts',
  'scripts\apply-silent-update.cjs','scripts\sync-verstak-changelog.cjs','scripts\deploy-local.cjs',
  'src\components\UpdatesSettings.tsx','src\components\UpdateReadyToast.tsx',
  'src\lib\staging-step-label.ts','src\lib\updater-error.ts',
  'tests\update-staging.test.ts','tests\apply-silent-update.test.ts','tests\update-install.test.ts'
)
foreach ($rel in $copyPaths) {
  $src = Join-Path $verstak $rel
  if (Test-Path $src) {
    $dst = Join-Path $tree $rel
    Ensure-Dir (Split-Path $dst -Parent)
    Copy-Item $src $dst -Force
  }
}
Get-ChildItem (Join-Path $verstak 'scripts\test-electron-*.cjs') -ErrorAction SilentlyContinue | ForEach-Object {
  $dst = Join-Path $tree "scripts\$($_.Name)"
  Ensure-Dir (Join-Path $tree 'scripts')
  Copy-Item $_.FullName $dst -Force
}

# Changelog entries (json)
$changelogJs = Join-Path $verstak 'scripts\sync-verstak-changelog.cjs'
if (Test-Path $changelogJs) { Copy-Item $changelogJs (Join-Path $proj 'sync-verstak-changelog.cjs') -Force }

$summary = @"
# Verstak — архив работы ($dateTag)

Собрано: $now  
Сессия: $sessionId  
Проект: C:\Users\RAYNER\verstak  
База git: 61e6ccb (локальные правки без push)  
Установлено: tree 1.5.17, целевое обновление upstream 1.5.21  
Деплой: %LOCALAPPDATA%\Programs\Verstak

## Тема сессии
Тихие фоновые обновления Verstak: скачивание, staging (распаковка), кнопка «Установить», toast.

## Проблемы пользователя (хронология)
1. Тихая установка не работала: 0% при старте, авто-закрытие после скачки, установка не шла.
2. Зависание на «Подготовка v1.5.21 завершена… 100%» — нет кнопки «Установить».
3. «Повреждён payload: пустой файл resources\app.asar» после распаковки.

## Корневые причины
- **Job Object Electron**: spawn 7za из потомка Verstak → app.asar 0 байт.
- **poll staging**: завершение по progress 100% без проверки payload на диске.
- **PS return / exit 0**: wrapper не писал exit-файл, runStagePayload висел до 15 мин.
- **Медленное скачивание**: fallback вместо electron-updater, sha512 вторым проходом.

## Что сделано (итог)
- Фоновое скачивание + staging + фаза ready + toast «Готово» + установка только по кнопке.
- PowerShell Start-Process для 7za/node (вне Job Object).
- Валидация app.asar ≥ 10 МБ; spawnSync в node fallback.
- Прогресс staging по этапам; recovery таймер + get-state.
- Убрана кнопка «Очистить кэш» (ломала staging).
- Оптимизация fallback download (pipeline 2 МБ, sha512 на лету).
- Несколько деплоев: test → dist:win → deploy:local → журнал docx.

## Ключевые файлы
- electron/updater.ts, update-staging.ts, update-install.ts
- scripts/apply-silent-update.cjs
- src/components/UpdatesSettings.tsx, UpdateReadyToast.tsx

## Секреты
Токены и auth **не включены**.

## Содержимое архива
- transcript/ — полный чат (updates.jsonl, chat_history.jsonl, terminal logs)
- skill/verstak/ — SKILL.md
- journal/ — Verstak - Журнал изменений.docx
- project/ — git diff, status, копия изменённых файлов
"@
$summary | Set-Content (Join-Path $staging 'SUMMARY.md') -Encoding UTF8

$restore = @"
# Как использовать в другой программе

1. Распакуй zip на диск.
2. Прочитай SUMMARY.md — контекст всей работы.
3. Для полного чата: transcript/updates.jsonl и transcript/chat_history.jsonl.
4. Для кода: project/git-diff.patch или project/tree/.
5. Для процедур деплоя: skill/verstak/SKILL.md.
6. Для истории сборок: journal/Verstak - Журнал изменений.docx.

В новом агенте можно написать:
«Прочитай SUMMARY.md и project/git-diff.patch из архива Verstak, продолжим обновления».
"@
$restore | Set-Content (Join-Path $staging 'RESTORE.md') -Encoding UTF8

$manifest = @{
  builtAt = $now
  topic = 'Verstak silent updates / staging'
  sessionId = $sessionId
  projectPath = $verstak
  gitHead = '61e6ccb'
  deployedTo = "$env:LOCALAPPDATA\Programs\Verstak"
  excludes = @('secrets','auth.json','node_modules')
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $staging 'MANIFEST.json') -Encoding UTF8

Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zipPath -Force
Remove-Item $staging -Recurse -Force

$item = Get-Item $zipPath
Write-Output "OK: $($item.FullName)"
Write-Output "SizeMB: $([math]::Round($item.Length / 1MB, 2))"
Write-Output "Built: $now"