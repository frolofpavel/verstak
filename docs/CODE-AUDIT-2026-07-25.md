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

Продолжение 2.1.10-C выполнено 2026-07-26:

- учёт результата tool-turn вынесен в `runner-tool-outcome.ts`: записи, команды,
  выполненные проверки, review gate и обязательные outcome-флаги считаются отдельно от orchestration;
- verification phase вынесена в `runner-verification.ts`: TypeScript diagnostics, LSP и
  подсказка project verify scripts сохранили прежний приоритет и best-effort семантику;
- `runner-api.ts` сокращён ещё на 69 строк, новые фазы покрыты отдельными unit-тестами и
  characterization agent-loop;
- начата чистка `electron/ipc/ai.ts`: durable daily cost guard вынесен в
  `daily-cost-guard.ts`, получил тесты продолжения счётчика и сброса на новом локальном дне;
- следующий срез: API/CLI envelope и дальнейшая декомпозиция `registerAiIpc`.

Срез D выполнен 2026-07-26:

- входной контракт CLI-runner переведён с 13 позиционных аргументов на именованный
  `PlainRunContext`, симметричный `AgentRunContext` API-пути;
- account rotation и provider fallback в CLI теперь передают envelope через явное
  обновление context, без хрупкого позиционного порядка;
- самостоятельный `ai:count-tokens` вынесен из `registerAiIpc` в
  `ipc/ai-count-tokens.ts`; точный Gemini count, history/system context и rough fallback
  закреплены unit-тестами;
- следующий срез: вынести preflight/route preparation из обработчика `ai:send`, затем
  оставить в `registerAiIpc` только регистрацию независимых IPC-модулей.

Срез E выполнен 2026-07-26:

- из обработчика `ai:send` вынесены четыре связки в `ipc/ai-send/`: Outcome-preflight
  (`outcome-preflight.ts`), выбор провайдера/модели и smart-routing-решение
  (`route-selection.ts`), pre-flight подписочного аккаунта вместе с ранними стопами и
  route-evidence (`account-preflight.ts`), подготовка fallback-маршрута
  (`fallback-route.ts`);
- `ipc/ai.ts` 1569 → 1395 строк, тело `ai:send` ~1020 → 656; порядок событий, ранние
  выходы и точки side-effect не сдвинуты: решения вынесены, эмиссия осталась в хендлере;
- `resolveCodexHome` и `toolsForOutcomePhase` физически переехали, но реэкспортируются из
  `ipc/ai.ts` — публичная поверхность модуля не изменилась;
- fallback-envelope собирается один раз вместо двух литералов (API и CLI ветки) и
  по-прежнему лениво — только когда fallback реально разрешён;
- закреплено тестами: новый `tests/ipc/ai-send-route-selection.test.ts` (15 пинов на
  лестницу провайдера/модели, resume-route и гейты smart-routing);
- попутно починен протухший шпион в `tests/ipc/oneshot-account-route.test.ts`: после
  перевода CLI-runner на envelope (срез D) он читал позиционный аргумент, который стал
  `undefined`, и проверка строгости one-shot аккаунта перестала что-либо доказывать.
  Проверка переведена на поле envelope, добавлен контрольный случай на API-провайдере
  (без аккаунта fallback обязан быть включён) — мутация гарда даёт красный;
- следующий срез: оставить в `registerAiIpc` только регистрацию независимых IPC-модулей
  (кандидаты — resolve-хендлеры подтверждений и блок agent_runs/timeout).

Срез F выполнен 2026-07-26:

- `ai:stop`, `ai:suspend`, `ai:append-context` и три резолвера подтверждений вынесены в
  `ipc/ai-resolve.ts`; `abortSend` передаётся параметром, поэтому модуль не тянет ядро
  `ipc/ai.ts` и рантайм-цикла не возникает;
- три копии одного алгоритма резолва (строгий ключ `${sendId}::${callId}`, иначе скан по
  суффиксу для старого рендерера) свелись к одной функции `resolvePending`;
- durable-бухгалтерия прогона вынесена в `ipc/ai-send/run-bookkeeping.ts`: строка
  `agent_runs` с route-evidence, привязка к открытой `dev_task`, сторож таймаута;
- `ipc/ai.ts` 1395 → 1269 строк; после срезов E+F в `registerAiIpc` остались сборка
  контекста, создание провайдера и диспетчеризация в runner'ы;
- payload'ы runtime-лога сохранены дословно, включая историческое расхождение: в БД
  уходит числовой `chatId`, в лог — сырой строковый (поле `chatIdRaw` в модуле заведено
  ровно для этого, чтобы переезд не поменял содержимое логов);
- закреплено тестами: `tests/ipc/ai-resolve.test.ts` (скоуп по sendId — чужое
  подтверждение не резолвится, совместимость без sendId, порядок пометки suspend до
  abort) и `tests/ipc/ai-run-bookkeeping.test.ts` (best-effort записи, M2-гард сторожа);
  мутация гарда `shouldFireRunTimeout` даёт красный;
- остаток по 2.1.10: тело `ai:send` всё ещё ~610 строк — это уже сборка контекста и
  промпта, отдельный риск-контур, не смешивать с маршрутом.

### 2.1.13 — Memory lifecycle (P1)

Проблема:

- при сжатии контекста начало диалога заменяется одним summary; всё, что в него не
  попало, для следующих ходов исчезает — включая решения, устойчивые факты и долги;
- с другой стороны, автозахват (`ai/memory-hooks.ts`) пишет в память сырой поток tool
  call'ов («Записан файл X (123 символов)»), превращая её в свалку и зашумляя recall.

Срез `pre-compress` выполнен 2026-07-26:

- новый `ai/memory-lifecycle.ts`: промпт извлечения (строгий JSON, явный запрет на
  пересказ), терпимый парсер, нормализация пачки и оркестратор события;
- границы ДО записи: не более 6 записей за событие, до 280 символов каждая, огрызки
  короче 12 символов отбрасываются;
- редакция секретов идёт ДО обрезки и ДО сравнения — иначе обрезанный секрет уехал бы
  в память, а дедуп сравнивал бы разные тексты одного факта;
- дедуп двойной: внутри пачки и против уже сохранённой памяти проекта, по ключу без
  регистра и пунктуации; повторное событие на том же чате близнецов не плодит;
- событию отдаётся итог ПРЕДЫДУЩЕГО сжатия: второе сжатие видит и то, что покрыто
  прошлым снапшотом, и без этого текста те же факты извлеклись бы ещё раз другими
  словами;
- запись пачки атомарна (транзакция в IPC): полупачка хуже, чем ни одной записи;
- событие висит на компакции строго best-effort и ПОСЛЕ успешной записи снапшота: до
  неё сжатие ещё может сорваться, и память копилась бы за каждую неудачную попытку;
  исключение внутри события не меняет результат сжатия;
- граница памяти — проект чата (`chatProjectPath`); нет проекта → модель даже не
  вызывается. Выключатель — настройка `memory_lifecycle`;
- тесты: `tests/ai/memory-lifecycle.test.ts` (26) + 5 сценариев связки в
  `tests/ai/compaction-service.test.ts`.

Остаток пакета:

1. событие `session-end` — не начато;
2. `auto_capture_memory` (сырой захват tool-потока) всё ещё включён по умолчанию и
   работает параллельно с bounded-событием. Отключение — продуктовое решение Павла,
   внутри этого среза не делалось.

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
