# Open Design #4 (run-scoped token) — ВЫВОД: в Verstak уже обеспечено, токен не нужен

Одобрено штабом как безопасность. Разобрал — и это НЕ пробел, а уже закрытое свойство.
Строить токен = второй контур рядом с существующим (против принципа штаба). Ниже доказательство.

## Зачем токен нужен Open Design — и почему Verstak другой
OD_TOOL_TOKEN у Open Design нужен, потому что их инструменты ходят по HTTP к демону: агент
МОГ БЫ подсунуть чужой projectId в запросе, и токен нужен, чтобы отклонить подделку
(bind runId+projectId, «rejects request-supplied project overrides»).

В Verstak инструменты исполняются В ПРОЦЕССЕ. Область задаётся `ctx.projectPath` —
полем ToolContext, которое ставит РАНТАЙМ, а не модель. У модели нет способа передать
другой projectId: в аргументах tool-call его просто нет, хендлер читает `ctx.projectPath`.
Подделывать нечего → отклонять нечего. Это компайл-тайм-привязка, сильнее рантайм-токена.

## Векторы «выйти за проект» — все уже пере-scoped и запинены
| Вектор | Где | Как ограничено | Пин |
|---|---|---|---|
| Пути файлов (read/write/patch) | path-policy `safeRealJoin(ctx.projectPath, rel)` | anti-symlink-escape к корню проекта (§8) | `tests/ai/path-policy.test.ts` |
| `spawn_process` cwd (из аргументов модели) | `resolveProcessCwd(ctx, args.cwd)` | резолвит к ctx.projectPath, **бросает** если вне (`sameOrInside`) | `tests/ipc/process-tools.test.ts:140` «rejects cwd outside project» |
| `run_command` cwd | command.ts | `cwd: ctx.projectPath` (не из модели) | command-policy пины |
| Коннекторы (telegram/yandex локальные чтения) | local-read | `ctx.allowedReadRoots` (рантайм) + вечный запрет секрето-файлов | `tests/connectors/local-read-gate.test.ts`, `tests/ipc/connector-gating.test.ts` |
| Секрето-файлы (.env/*.key/creds) | `isForbiddenPath` | вечный запрет write | `tests/ai/tools.test.ts` |

## Вывод
Область прогона (проект + файловая система) в Verstak ограничена ПО ПОСТРОЕНИЮ:
`ctx.projectPath` рантайм-авторитетен, пути идут через safeRealJoin, cwd бросает при
выходе, коннекторы гейтятся allowedReadRoots — и всё это УЖЕ покрыто пинами. Токен
Open Design — их механизм для HTTP-демона; у нас его роль исполняет ctx-привязка, и она
жёстче. Кода не требуется. Если штаб захочет усилить именно ЧАТ-изоляцию (агент чата A
не читает данные чата B в пределах одного проекта) — это отдельная узкая постановка,
не покрытая этим выводом; сейчас межчатовая видимость в пределах проекта допущена сознательно.
