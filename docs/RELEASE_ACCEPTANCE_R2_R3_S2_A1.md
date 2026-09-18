# R2 / R3 / S2-A1 — release-candidate acceptance record

**Дата:** 2026-09-18

**Кодовый кандидат:** `9f9924bf` (поверх `7d344997`: финальные bounded-scan исправления)

**Ветка:** `codex/next-r0-r3`

**Публичный релиз:** не выполнялся

Этот файл отделяет доказанное состояние кода и пакетов от живых проверок,
которые требуют внешней авторизации или отсутствующего оборудования. `PASS`
ниже означает наблюдаемое доказательство на точном кандидате; `BLOCKED` нельзя
трактовать как принятый сценарий.

## Общий гейт и пакеты

| Проверка | Результат |
|---|---|
| `check:mojibake` → `lint:full` → `type` → `test:fast` → `build` → `check:performance` → `git diff --check` | PASS |
| Полный тестовый эталон | 7372 total / 7355 passed / 17 skipped / 0 failed |
| Performance bundle | 1 515 483 / 1 600 000 bytes |
| Windows Setup | 336 132 524 bytes, SHA-256 `EC89C18443866B6D1DC7E7B98B9C60BF83FF075139C8255DD9E0F285708FCE87` |
| Windows Portable | 180 955 449 bytes, SHA-256 `9C1E723B9CC3382AEFDB7279C4CEDF6A5A3DBF2C22C7FCE3A356514127F9F627` |
| Packaged / установленный `app.asar` | SHA-256 `2CF47EC67BF298AC8FA3547957BD7CD7BB0C6C0813AD2E676E36C93B2321D599`, точное совпадение |
| Source / packaged / Setup / установленный Computer helper | SHA-256 `9A71D216BA027B11A3F6E0ED26F586444812244C54417E214F804CA21799763D`, точное совпадение |
| Setup payload ↔ `win-unpacked` | PASS, 560 файлов совпали |
| Packaged Computer helper contract/read-only smoke | PASS |
| Setup-extracted helper contract/read-only smoke | PASS |
| Изолированный packaged startup (`startup.ok`, `db.open.ok`) | PASS |

## R2 — Computer Use

| Требование | Доказательство | Статус |
|---|---|---|
| Точная выбранная цель | PID + start time + HWND + generation; pre/post identity, geometry и DPI checks | PASS |
| UIA `type` и независимый результат | Нативный Windows fixture, 5 последовательных серий × 10/10 = 50/50; каждый ввод подтверждён внешним state-file | PASS |
| Security scan и dispatch deadline | Полный fail-closed descendant scan выполняется с bounded 1500 ms; после него exact target повторно проверяется в 50-ms окне перед dispatch | PASS |
| Стабильный postcondition | Два независимых observations через bounded abort-aware settle | PASS |
| Снимок только выбранного окна | `PrintWindow`, exact foreground HWND, 512×384 и 16 KiB caps, повторная identity/geometry/DPI проверка | PASS |
| Защищённые поверхности | password/credential/CAPTCHA/2FA/elevated/protected блокируются fail-closed | PASS |
| Stop | ACK ≤500 ms в нативном canary, после ACK новые actions отсутствуют | PASS |
| Native composer provenance в установленной сборке | Свежий native ticket принят; exact-window `computer_observe` дважды завершён verified | PASS |
| Effectful live-write в установленной сборке | Два `computer_type` остановлены `hardware-input` после нового физического ввода; значение внешнего state-file осталось пустым | BLOCKED fail-closed, write не засчитан |
| DPI 125/150 и второй монитор | На машине один `DISPLAY1`, 1920×1080, DPI 96 / 100% | BLOCKED: оборудования/поверхности нет |
| Реальный desktop-пилот 5/5 | Требует согласованного рабочего приложения и файла результата | BLOCKED: живая среда не выбрана |

## R3 — browser → artifact → Computer

| Требование | Доказательство | Статус |
|---|---|---|
| Fresh composer intent для трёх стадий | Browser/report/artifact/selected-window должны присутствовать в исходной пользовательской команде | PASS |
| Server-owned handoff | Task/run lineage, phase, constraints, confirmed actions, environment и result refs | PASS |
| Artifact proof | Только task directory; SHA-256 и запись в существующий browser proof ledger | PASS |
| Resume без повторной мутации | Checkpoint переживает compaction/explicit resume; browser mutation после `artifact-ready` блокируется | PASS |
| Calltouch read-only 5/5 | Точный ранее использованный отчёт найден, но `my.calltouch.ru` перенаправляет на форму входа | BLOCKED: авторизация истекла |
| Browser → artifact → Windows 5/5 | Зависит от авторизованного Calltouch и реального desktop-пилота | BLOCKED |
| Ограниченные preview-задачи | Выполняются после двух принятых компонентных пилотов | BLOCKED по предыдущим пунктам |

## S2-A1 — DecisionContext / DecisionTrace v1

| Требование | Доказательство | Статус |
|---|---|---|
| Один фасад над legacy policy для первого vertical slice | `run_command` проходит через `evaluatePolicyDecision` поверх `resolveDecision` | PASS |
| Shadow по умолчанию | Candidate записывается, legacy decision остаётся исполняемым | PASS |
| Монотонность | В `enforce` candidate может только усилить; weakening сохраняет legacy deny/confirmation | PASS |
| Identity и lineage | Agent, активный profile owner, task/job/run и capability id/version/trust | PASS |
| Нет raw args/output | Target и stdout/stderr представлены SHA-256 digest; compact trace parseable ≤500 chars | PASS |
| До/после исполнения | Decision trace записывается до эффекта, санитизированный result readback — после | PASS |

## Mutation proof

На чистом кандидате каждый ключевой защитный пин был намеренно сломан отдельно,
его точный тест обязан был стать красным, затем исходный код восстановлен:

1. R2: принятие только первого post-action observation →
   `stable-postcondition.test.ts` отвергло ошибочный `verified`.
2. R3: разрешение browser mutation после `artifact-ready` →
   `runner-tool-turn.test.ts` обнаружило replay.
3. S2-A1: разворот сравнения strictness →
   `policy-decision.test.ts` обнаружило ослабление `deny` до `allow`.

После восстановления совместный targeted-прогон: **3 files / 33 tests / 0 failed**;
`git diff --check` и рабочее дерево — чистые.

## Оставшиеся внешние действия

1. На авторизованном точном отчёте выполняется Calltouch 5/5; пароль/2FA при
   необходимости вводит Павел, секреты агент не читает и не извлекает.
2. На спокойном desktop-пилоте без нового физического ввода между observe и
   effect выполняется R2 write 5/5 с внешним readback.
3. На машине с DPI 125/150 и вторым монитором выполняется физическая R2-матрица
   и реальный desktop-пилот 5/5.
4. После этого выполняются объединённая R3-цепочка 5/5 и ограниченный preview.

До выполнения этих пунктов кодовый кандидат готов, но весь пользовательский
релиз не считается живьём принятым.
