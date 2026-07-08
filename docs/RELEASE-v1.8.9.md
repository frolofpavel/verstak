# Verstak 1.8.9

Дата: 2026-07-08

## Что изменилось

- Managed worktree lifecycle v1: dirty/unpushed detector, snapshot-before-remove, restore-from-snapshot, lossless remove, no-push regression.
- Worktree registry actions: list, snapshot, restore, delete через IPC/preload/types; в WorktreeBar появилась команда `Снимок`.
- Background process manager v1: `spawn_process`, `process_status`, `read_process`, `stop_process`, bounded/redacted output tail, PID-reuse guard, TTL prune/sweeper.
- `notifyOnExit` процессы попадают в owner-bound completion queue и могут попасть в следующий ход агента без cross-chat leakage.
- Process exit отображается отдельным событием в Runs timeline.

## Проверка

- `npm run test:security` — pass, 24 tests.
- Targeted 1.8.9 suite — pass, 6 files / 69 tests.
- `npm run type` — pass.
- `npm run test:fast` — pass, 2239 tests / 7 skipped.
- `npm run build` — pass.
- `npm run dist:win` — pass.
- Артефакты: `Verstak-Setup-1.8.9-x64.exe` 360,360,483 B; `Verstak-Portable-1.8.9-x64.exe` 209,565,808 B; `latest.yml` version 1.8.9.

## Ограничения

- Полный daemon/multi-channel gateway не входит в 1.8.9.
- Большая отдельная WorktreePanel остаётся polish-задачей, базовый lifecycle уже есть через существующий WorktreeBar и IPC.
- GitHub Release asset может быть дозалит отдельно; публичная download-кнопка уже ведёт на `agi-iri.ru`.
