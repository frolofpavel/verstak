# Verstak — аудит и план наведения порядка в коде

Дата: 2026-07-25
База аудита: `main` после 2.1.4–2.1.8 (`704cf0f`)

## Что проверено

- полный ESLint по `electron/`, `src/`, `shared/`, `mobile/`, `scripts/`, `tests/`;
- TypeScript strict;
- симметрия IPC handler ↔ preload (`ipcMain.handle/on` против `ipcRenderer.invoke/send`);
- Git worktrees, ветки, untracked/ignored артефакты;
- дубли имён и реальные ссылки на модули, включая lazy/dynamic imports;
- TODO/FIXME/заглушки вне тестов, changelog и документации;
- прямые npm-зависимости, `npm ls`, `npm audit` для production и dev;
- крупнейшие и самые сложные файлы.

## Уже исправлено этим пакетом

1. Полный lint: **21 ошибка → 0**.
   - закрыты floating/misused Promise в Auth, Resume, Scheduler, Tasks и installer;
   - nullable switch теперь обработаны явно;
   - тесты больше не бросают не-Error значения.
2. Удалён доказанный дубль старой вкладки коннекторов в `Settings.tsx` (~250 строк). В продукте используется только V3.
3. Удалены мёртвые imports, локальные функции, состояния и UI-хвосты:
   - старый Goal Cycle prompt без кнопки;
   - запрос suggestions, результат которого нигде не отображался;
   - context-compaction toast, который никто не мог установить;
   - неиспользуемый relogin/helper старого UI;
   - десятки imports, оставшихся после распила `ai.ts`/`runner-api.ts`.
4. Предупреждения ESLint: **589 → 485**, `no-unused-vars`: **103 → 0**.
5. Удалены неиспользуемые npm-пакеты: `@fontsource/geist-sans`, `@fontsource/geist-mono`, `@eslint/js`.
6. Безопасные semver-обновления npm применены через `npm audit fix` без `--force`.
7. Устаревшая документация Codex account routing обновлена под фактическую 2.1.3.

## Что НЕ оказалось мусором

- одинаковые имена `storage/*.ts` и `ipc/*.ts` — это разные слои, не дубли;
- lazy/dynamic модули (`BrowserView`, `Settings`, `charts`, `sub-agent-loop`, release notes) реально подключены;
- отдельный worktree `verstak-extension` — самостоятельный Browser Employee, его не трогаем;
- `node_modules/` — локальные зависимости, не попадают в Git; `npm prune
  --dry-run` не нашёл лишних пакетов;
- `build/` и оставшиеся `resources/` — входы установщика и приложения, а не
  результаты сборки;
- отдельный worktree `verstak-extension` остаётся изолированным Browser
  Employee и в эту чистку не входит.

## Чистка структуры 2026-07-25

- удалены локальные пересобираемые `out/` и `.verstak-data/model-gym`;
- удалены завершённый outcome-план, старый BMP установщика, два одноразовых
  provider smoke и выполненный мигратор `.grok/clients`;
- Mobile Remote подтверждён как часть `main`; из `mobile/AGENTS.md` удалены
  несуществующие ветка/worktree и датированные отчёты;
- удалены пять test-only foundation, которые не были достижимы ни от одной
  production-точки: отдельный Codex SSE reducer, skill install guard, mobile
  pairing/attachment primitives и Model Gym TS contract вместе с тестами,
  создававшими ложное ощущение работающей функции;
- граф импортов после чистки: все production-модули `electron/src/shared/mobile`
  достижимы от Electron, renderer, installer или mobile entry point.

## Открытые риски и следующий порядок

### 2.1.9 — Supply-chain и локальная речь (P0)

Проблема: runtime audit после безопасных обновлений всё ещё показывает 17 advisory:

- critical-цепочка `@xenova/transformers → onnxruntime-web → protobufjs`;
- high в старой ветке `sharp/libvips`;
- архивные цепочки `exceljs/archiver`;
- `onnxruntime-node/adm-zip`.

Почему не исправлено `--force`: npm предлагает несовместимые откаты (`transformers 1.x`, `exceljs 3.x`, `onnxruntime 1.21`) и способен сломать STT/артефакты.

План:

1. characterization-тест локального STT и XLSX generate/edit;
2. миграция `@xenova/transformers` на поддерживаемый `@huggingface/transformers`;
3. убрать прямой `onnxruntime-node`, если новый runtime приносит совместимую версию сам;
4. отдельно закрыть `sharp` и проверить packaging native assets;
5. проверить замену/изоляцию ExcelJS archive path;
6. `npm audit --omit=dev`, STT smoke, XLSX smoke, build и packaged-path test.

Готово когда: нет critical runtime advisory; оставшийся advisory имеет документированный недостижимый путь или отдельный pinned debt.

Срез A выполнен 2026-07-25:

- `@xenova/transformers` заменён на поддерживаемый `@huggingface/transformers` 4.x;
- удалён прямой pin `onnxruntime-node`, runtime теперь принадлежит Transformers.js;
- старый `quantized: true` заменён на актуальный `dtype: 'q8'`;
- cache/local-model/thread policy закреплена unit-тестами, packaging — отдельным тестом;
- production audit: **critical 1 → 0**, всего runtime advisory **17 → 14**.

Остаток среза B: high advisory в `onnxruntime-node/adm-zip`, `sharp/libvips` и `exceljs/archiver`. Автоматический `--force` запрещён: npm предлагает несовместимые откаты. Закрывать через обновление upstream/замену XLSX backend с отдельными smoke-тестами.

### 2.1.10 — Декомпозиция agent runtime (P1)

Проблема:

- `runner-api.ts`: ~1700 строк, основной метод ~1150 строк, complexity ~335;
- `electron/ipc/ai.ts`: ~1600 строк;
- `runner-plain.ts` отстаёт по parity.

План:

1. зафиксировать characterization matrix: tool loop, fallback, quota rotation, compaction, review gate, timeout, crash resume;
2. вынести чистые state transitions и attempt lifecycle без изменения IPC;
3. разделить provider attempt / tool turn / verification-finalization;
4. унифицировать общий envelope API/CLI, не объединяя транспорты насильно;
5. после каждого среза — targeted + full suite, diff на отсутствие contract drift.

Готово когда: orchestration-функции читаются по фазам, критичные ветки покрыты, поведение и публичные контракты не изменились.

Срез A выполнен 2026-07-25:

- терминальная логика API-runner вынесена из общего `finally` в `runner-finalize.ts`;
- журнал, защищённое session-summary, Timeline, usage, итоговый статус и checkpoint
  теперь имеют одну тестируемую точку применения;
- отдельно закреплены completed / failed / suspended / run без storage;
- основной метод сокращён на 64 строки, complexity 335 → 306 без изменения IPC;
- следующий срез B: provider attempt + account/fallback lifecycle.

Срез B выполнен 2026-07-25:

- provider fallback и подписочная account rotation вынесены в `runner-attempt.ts`;
- в одном контроллере закреплены pinned-policy, bounded attempts, выбор модели,
  перенос истории, route evidence и durable account lineage;
- legacy `getNextProvider` сохранён без ложной перезаписи accountId;
- основной метод сокращён ещё на 35 строк, три сложных вложенных callback удалены;
- следующий срез C: tool-turn dispatch и verification phase.

Срез C выполнен 2026-07-25:

- полный цикл одного tool-turn вынесен в `runner-tool-turn.ts`;
- PreToolUse hooks, fail-closed блокировка, разделение parallel-read /
  sequential / confirm-write и PostToolUse hooks теперь имеют одну точку входа;
- тестами закреплены порядок результатов и запрет выполнения/пост-хука после
  PreToolUse block;
- основной agent loop больше не содержит внутренний планировщик инструментов;
- следующий срез D: verification phase и выравнивание API/CLI envelope.

### 2.1.11 — Декомпозиция renderer (P1)

Проблема:

- `Settings.tsx` до чистки был ~5000 строк;
- `Chat.tsx` ~3900 строк;
- `layout.css` ~21000 строк;
- часть store-проекций ещё поддерживает старую и новую модель состояния одновременно.

План:

1. Settings: вынести Connectors / Providers / Models в отдельные компоненты с props-контрактами;
2. Chat: вынести composer state, stream rendering и pipeline controls;
3. завершить PerChatState 4.4 и удалить только доказанно неиспользуемые compatibility projections;
4. CSS делить по компонентным секциям без переименования классов в том же срезе;
5. добавить UI smoke на основные маршруты.

Готово когда: ни один новый компонент не меняет поведение, а основные экраны проходят characterization и build.

Срез A выполнен 2026-07-25:

- `PolicyTab` целиком вынесен из `Settings.tsx` в самостоятельный компонент;
- добавлены прямые UI-тесты матрицы прав и сохранения расширенной политики;
- `Settings.tsx` уменьшен примерно на 350 строк без изменения маршрута вкладки;
- удалены два доказанно мёртвых публичных символа: `assertWriteScope` и
  `IconPlug` — по графу проекта у них не было потребителей;
- следующий срез B: Providers/Models либо McpTab — после отдельной
  characterization-сетки, без смешивания с PerChatState 4.4.

### 2.1.12 — Остаточный долг (P2)

- реализовать или снять TODO второй ветки незакрытой review-сессии в
  `agent-runs`;
- убрать неэффективные dynamic imports, которые сборщик всё равно включает
  статически; это не ломает приложение, но маскирует реальную границу чанков.

## Инварианты следующих пакетов

- один пакет — один риск-контур;
- сначала characterization/RED, потом перенос;
- не менять `system-layer.ts`;
- миграции только append-only;
- Browser Employee worktree не смешивать с main;
- обязательные гейты: mojibake, full lint (0 errors), type, full tests, build, diff review;
- commit/push только после зелёных гейтов.
