# TASK: CLI Deep Integration — перевести подписки на уровень Runtime Harness (Verstak 1.9.3 → 2.0)

**Дата:** 2026-07-10 · **Тип:** архитектурная доработка · **Статус:** КАНОН (единая версия)

**Этот документ отменяет и заменяет:**
- `TASK-CLI-DEEP-INTEGRATION-REINFORCED.md` — устарел. Его «Усиление 3 (TLS/HTTP anti-fingerprinting)» и «Усиление 4 (fallback-маскировка)» **запрещены** (см. §9). Файл — в архив, на него не опираться.
- ранняя «Path A direct-API» редакция — поглощена сюда как Mode B/эксперимент.

**Связи:** `docs/CLI_SUBSCRIPTIONS_PLAN_1.9.3-1.9.5.md`, `docs/CURRENT_STATE.md`, `docs/COMPETITOR_AUDIT_HERMES_OPENCLAW_2026-07-06.md`

---

## 0. Одна фраза

Не «подключить подписку как ещё один CLI», а:

```
Subscription Auth Profile → Runtime Harness → Persistent Session
→ Control Envelope (undo + verify + proof + limit) → Capability-Truth UI
```

Подписки Claude / Codex / Grok / Gemini должны ощущаться не как «окно ввода текста», а как управляемый агентный двигатель с видимым состоянием, сессией, доказательством и failover — **и при этом сохранять то, чего нет у Hermes/OpenClaw: наш откат, review-gate и Proof Pack поверх любого runtime.**

---

## 1. Проблема (заземлено в коде)

Сейчас все CLI-провайдеры идут headless one-shot:
- `claude --print --output-format stream-json` (`electron/ai/claude-cli.ts:121`)
- `codex exec` (`electron/ai/codex-cli.ts`)
- `grok -p` (`electron/ai/grok-cli.ts`)
- `gemini` stream-json (`electron/ai/gemini-cli.ts`)

`ipc/ai.ts`: `useToolsPath = descriptor.supportsTools && projectPath` → CLI почти всегда уходит в `runPlainConversation`, который зовёт `provider.send()` без нашего tool-loop. `providerCapabilities()` жёстко режет CLI по `tools/verification/liveTimeline/mcp/delegation/attachments`. `docs/CURRENT_STATE.md` честно помечает CLI как «урезанный контроль».

Уровень сейчас:
```
Verstak UI → serialize prompt → spawn CLI → read text stream → show answer
```

**Две находки, меняющие расклад по цене/риску:**

1. **`claude-cli.ts:192`** парсит `stream-json`, но берёт из `assistant`-события только `text` и `usage`, **а блоки `tool_use`/`tool_result` молча выбрасывает.** То есть «мы не видим, что делает CLI» — не inherent-лимит, а недоделка парсера. Живой tool-таймлайн для CLI-сессии достаётся почти даром.
2. **`undo:checkpoint` / `undo:revertToCheckpoint` уже есть** (`electron/ipc/undo.ts`). Правки CLI идут в реальную ФС → наш per-file undo может обернуть чужой прогон чекпоинтом до/после, не «видя» инструменты изнутри.

Плюс уже в проде (реестр подписок 1.9.3/1.9.4): `electron/storage/subscription-accounts.ts`, `electron/ipc/subscription-accounts.ts`, `electron/ai/subscription-limits.ts`. Phase 0/1 — эволюция, не с нуля.

---

## 2. Целевая архитектура: Subscription Runtime Stack

### 2.1. Четыре понятия

**Auth Profile** — один логин/ключ/подписка.
```ts
type AuthProfile = {
  id: string
  providerId: 'openai' | 'anthropic' | 'google' | 'xai' | 'moonshot' | 'zai' | string
  label: string
  authKind: 'api_key' | 'oauth_owned' | 'oauth_cli_reuse' | 'cli_config_dir' | 'setup_token'
  ownership: 'owned' | 'external_cli' | 'bootstrap'
  secretRef: string | null          // ключ в SafeStorage, НЕ сам токен
  configDir: string | null
  accountId?: string
  scopes?: string[]
  expiresAt?: number
  state: 'healthy' | 'expiring' | 'refreshing' | 'cooling' | 'needs_reauth' | 'revoked' | 'fallback_only'
  lastUsedAt?: number; lastRefreshAt?: number; lastError?: string
}
```

**RuntimeAdapter** — ЕДИНЫЙ контракт исполнителя (это фундамент, без него фазы не параллелятся и security-тесты не пишутся):
```ts
interface RuntimeAdapter {
  id: 'verstak-api' | 'codex-native' | 'claude-cli-session' | 'codex-cli-session'
    | 'grok-cli-session' | 'gemini-cli-session' | 'legacy-one-shot'
  capabilities: RuntimeCapabilities
  start(ctx: RunContext): Promise<RuntimeSession>
  turn(session: RuntimeSession, input: TurnInput): AsyncIterable<RuntimeEvent>
  stop(session: RuntimeSession): Promise<void>
  suspend?(session: RuntimeSession): Promise<void>
  resume?(session: RuntimeSession): Promise<RuntimeSession>
  usage?(session: RuntimeSession): Promise<UsageSnapshot | null>
}
type RuntimeCapabilities = {
  verstakTools: boolean; nativeTools: boolean; liveTimeline: boolean
  resume: boolean; steering: boolean; attachments: boolean
  riskLevel: 'green' | 'yellow' | 'red'   // green=API-key/оф.CLI, yellow=documented OAuth, red=experimental
}
```

**Runtime Session** — связь чата Verstak с родной сессией runtime.
```ts
type RuntimeSession = {
  runId: string; chatId: number; providerId: string; model: string
  authProfileId: string; adapterId: RuntimeAdapter['id']
  nativeThreadId?: string; nativeSessionId?: string
  status: 'accepted' | 'queued' | 'running' | 'waiting' | 'suspended' | 'done' | 'error' | 'needs_reauth' | 'cooling'
}
```

**Control Envelope** — МОАТ. Обёртка гарантий Verstak поверх ЛЮБОГО adapter'а, деградирует изящно даже для one-shot:
```ts
type ControlEnvelope = {
  undoCheckpointId: number        // undo:checkpoint ДО прогона (есть уже)
  verifyAfter: boolean            // review/verify-гейт ПОСЛЕ
  proofProvenance: {              // в Proof Pack, БЕЗ токенов
    adapterId: string; authKind: string; accountLabel: string; nativeSessionId?: string
  }
  limitTracking: boolean          // учёт quota/стоимости профиля
}
```
Даже когда «чужой CLI сам решает» — пользователь получает откат + доказательство + контроль лимита. Ровно этого нет у native-агентов конкурентов.

### 2.2. Capability считается из комбинации, а не из `transport`

Сейчас грубо: `transport === API && supportsTools`. Нужно:
```
capability = provider + model + auth profile + runtime adapter + project mode
```
| Подключение | Итоговая capability |
|---|---|
| Anthropic API key → Verstak API loop | full Verstak tools/proof |
| Claude Max → CLI session harness | native+projected tools, undo-wrap, projected timeline, projected proof |
| ChatGPT OAuth → Codex native harness | subscription-native, rich lifecycle, tools по факту адаптера |
| Grok CLI session | projected tools/timeline + undo-wrap |
| Grok/Gemini one-shot | text only, fallback + undo-wrap |

---

## 3. Четыре режима подключения (в UI и коде, не просто API/CLI)

- **Mode A — API-Controlled.** Наш сильный путь: `Verstak tool loop → provider API → tools → verify → proof`. Полный контроль, обычно платно.
- **Mode B — Subscription-Native Harness.** Подписка через native runtime: `OAuth profile → native backend → structured events → Verstak lifecycle`. Цель для Codex. Глубоко, но рискованно (непубличный протокол).
- **Mode C — CLI Session Harness.** Официальный CLI — исполнитель, Verstak — session supervisor: `persistent CLI session → projected events → pause/resume/stop/status + undo-wrap`. Меньше ToS-риска, ближе к оф. CLI. **Главный рычаг felt-победы.**
- **Mode D — Legacy One-Shot Fallback.** Текущий `spawn per message → text`. Только как fallback + Control Envelope (undo-wrap), не как основной режим подписки.

---

## 4. Приоритет (ПЕРЕВЁРНУТ относительно ранних редакций)

Ранний план ставил Codex Native первым «как безопасный». Это ошибка: native app-server/Responses — реверс непубличного протокола, **самый большой лифт и самый высокий риск поломки**, а боль Павла трогает последним.

**Правильный порядок:**
1. **Control Envelope + RuntimeAdapter-контракт + capability-truth UI** — фундамент, убирает «обман интерфейса».
2. **Mode C для Claude+Codex+Grok разом** — через проекцию `stream-json` tool-событий (которые сейчас выбрасываются) + undo-wrap. Минимум ToS-риска, максимум felt-эффекта, дёшево (парсер уже есть).
3. **Health/failover-пул подписок.**
4. **Codex Native Harness (Mode B)** — глубокий и рискованный, ПОСЛЕДНИМ, за экспериментальным гейтом.

Direct-OAuth Claude/Grok/Gemini вне оф. CLI — только после отдельного policy-решения (§9), по умолчанию выключено.

---

## 5. Роадмап по версиям

### 1.9.3 — Фундамент правды (P0)
**Цель:** единый контракт + честный UI, конец «обмана интерфейса».
- `electron/ai/runtime-adapter.ts` (новый) — интерфейс `RuntimeAdapter` + `RuntimeCapabilities`.
- `electron/ai/runtime-capabilities.ts` (новый) — capability из `provider+model+auth+adapter+mode`, не из `transport`.
- `electron/ai/control-envelope.ts` (новый) — обёртка: undo-checkpoint до, verify-гейт после, proof-provenance, limit-tracking. Применяется ко ВСЕМ путям, включая текущий one-shot.
- Рефактор: `runPlainConversation`/`runApiConversation` вызываются ЧЕРЕЗ Control Envelope.
- UI: `ModelPicker` и `AgentRunInspector` показывают режим — `Full API control` / `Subscription native` / `CLI session` / `One-shot fallback` + capability-badge.
- i18n `src/i18n/ru.ts`, `en.ts`.
- **Done:** Павел видит `Grok Build — one-shot fallback`, а не «Grok Build»; любой прогон (даже one-shot) делает undo-checkpoint и пишет provenance в Proof.
- **Тест:** CLI НЕ может отобразиться как full control; Control Envelope ставит checkpoint до one-shot прогона.

### 1.9.4 — Mode C: живые CLI-сессии (P1) ← felt-победа
**Цель:** Claude Code, Codex, Grok перестают быть «текстовым окном».
- `electron/ai/runtime-harnesses/cli-session.ts` (новый, общий) — session supervisor поверх оф. CLI.
- **Проекция tool-таймлайна:** в `claude-cli.ts` (и аналогах) достать из `stream-json` блоки `tool_use`/`tool_result` (сейчас выбрасываются на `:192`) → эмитить как `ChatEvent` tool-события → живой Timeline.
- **Undo-wrap:** `undo:checkpoint` до сессии, видимый revert после (ФС правится реально — наш per-file undo уже умеет).
- **Lifecycle:** stop/suspend/resume как состояния (не только kill process); где CLI стабильно держит `--resume`/`--session-id` — переиспользовать сессию вместо пере-сериализации истории каждый ход.
- Стоимость в cost-controller = $0 (подписка).
- Честный ярлык: `Native CLI tools + projected proof`, НЕ `full Verstak tools`.
- Файлы: `electron/ai/claude-cli.ts`, `codex-cli.ts`, `grok-cli.ts`, `electron/ipc/ai.ts` (ветка на cli-session adapter), `AgentRunInspector.tsx`.
- **Done:** повторный ход не шлёт всю историю плоским prompt; в Timeline видны tool-события; stop/resume работают; Proof знает, какой runtime сделал работу.
- **Тест:** проекция tool_use из фикстуры stream-json; undo revert откатывает файлы после CLI-сессии.

### 1.9.5 — Здоровье и failover пула подписок (P2)
**Цель:** пул подписок как эластичная ёмкость (differentiator для соло-разработчика).
- `electron/ai/subscription-limits.ts` — расширить: парсеры quota/rate-limit/reset ETA из ответов и CLI-вывода.
- **Token-bucket роутинг:** «2 ChatGPT + 1 Claude Max + API-ключ = одна health-aware ёмкость»; фоновые агенты не упираются мгновенно в лимит одного аккаунта.
- Account state machine: `healthy → expiring → refreshing → cooling → needs_reauth → revoked`.
- Failover: Profile A cooling → Profile B → API-key backup → ask re-auth.
- Status рядом с cost-controller: active / cooling until HH:MM / needs re-auth / fallback only.
- Композит с 1.9.4 авто-свитчем аккаунтов — уже на runtime-пути.
- **Done:** «аккаунт упал → переключился» работает и ВНУТРИ подписочного провайдера, в UI видно почему и куда.

### 2.0 — Codex Native Harness (Mode B, P3) — за экспериментальным гейтом
**Цель:** Codex через ChatGPT-подписку как native session, а не `codex exec`.
- `electron/ai/runtime-harnesses/codex-native.ts` (новый) — адаптер под ChatGPT/Codex backend (Responses/app-server), SSE/WebSocket где доступно, `chatgpt-account-id` из auth-profile, нормализация в `RuntimeEvent`.
- Строго за флагом `subscription_direct_oauth_experimental` (по умолчанию OFF) + risk-badge `red` + плашка ToS.
- Формулировка: `openai provider + chatgpt oauth + codex-native runtime`, НЕ «openai API».
- **Done:** длинная native-сессия Codex; lifecycle-события в Timeline; при лимите → cooling → switch профиля.

---

## 6. Security Regression Pack (сквозной, растёт с каждой фазой)

Тесты:
- OAuth/токен НИКОГДА не появляется в: runtime logs, Debug Packet, Proof Pack, agent output, error messages.
- refresh под lock — два чата не сжигают один refresh token (double-spend).
- revoked token → quarantine, нет бесконечной петли одинаковых auth-fail.
- CLI config-dir не выходит за profile root.
- один чат не переключается на другой аккаунт без события.
- fallback НЕ понижает restricted worktree до full project root.
- команда в UI == исполненная команда.
- native runtime не заявляет full Verstak tools, если capability adapter'а этого не даёт.
- Control Envelope ставит undo-checkpoint даже на one-shot и пишет provenance без секретов.

Файлы: `tests/security/subscription-auth.test.ts`, `tests/ai/runtime-capabilities.test.ts`, `tests/ai/control-envelope.test.ts`, `tests/ai/runtime-harness-cli-session.test.ts`, `tests/ai/runtime-harness-codex.test.ts`, `tests/storage/auth-profiles.test.ts`.

---

## 7. Decision Gates (ToS) + clean-by-default

**Дефолтный билд везёт ТОЛЬКО чистые пути:** API-ключ + официальная CLI-сессия (Mode C) + документированный Codex OAuth. Всё «серое» — за `subscription_direct_oauth_experimental=false` с явной плашкой «риск бана — твой аккаунт».

Разрешено без отдельного решения: API keys; официальная CLI-сессия/reuse; ChatGPT/Codex OAuth где путь документирован; импорт CLI-кредов только как bootstrap.

Требует решения Павла: direct Anthropic OAuth вне оф. Claude Code; direct Grok OAuth из `~/.grok/auth.json`; direct Gemini OAuth из CLI-файлов; любой непубличный endpoint.

**ЗАПРЕЩЕНО (жёстко):** TLS-fingerprint spoofing; маскировка под чужой клиент ради обхода блокировок; скрытая отправка подписочного токена в сторонний proxy; refresh token в plain text. *(Именно это было в REINFORCED-редакции — отменено.)*

**Product DNA:** если runtime не даёт full control — не притворяемся. Язык: `Full API control` / `Subscription native` / `CLI session, limited control` / `One-shot fallback`.

---

## 8. UX: что почувствует Павел

**Было:** выбрал Grok Build / Claude Code / Codex → написал задачу → «ждёт модель» → внутри непонятно что делает, где сессия, что продолжить.

**Стало (с 1.9.4):** выбрал Claude Code (CLI session) → видно `Auth = Claude Pavel, Runtime = cli-session, Mode = CLI session` → run открывается управляемой сессией → Timeline показывает tool-события → stop/suspend/resume → при лимите видно cooling и fallback → Proof Pack знает, какой runtime сделал работу, и лежит undo-checkpoint для отката.

UI-элементы: `ModelPicker` (provider/model/auth profile/runtime mode/capability badge); Status bar (active profile / health-limit / fallback chain); `AgentRunInspector` (harness / native session id / events / capability truth / proof scope); Settings → Subscription Hub (auth profiles + runtime mode preference: prefer full API / subscription native / official CLI session / allow one-shot).

---

## 9. Критерии готовности (Done для всего блока)

Закрыто НЕ когда «CLI отвечает», а когда:
- любой прогон обёрнут Control Envelope: undo-checkpoint до, verify после, proof-provenance без секретов;
- Claude/Codex/Grok в Mode C — живая сессия с projected tool-таймлайном, stop/resume, $0 в cost (1.9.4);
- у каждого запуска в UI виден runtime mode и честная capability;
- подписочные аккаунты имеют health-state и failover-пул (1.9.5);
- one-shot остался fallback, не основной сценарий;
- Codex native — за экспериментальным гейтом, не в дефолте (2.0);
- **felt-тест:** сценарий из N ходов на подписке — (а) не пере-шлёт всю историю каждый ход, (б) показывает live tool-timeline, (в) stop/resume, (г) выдаёт Proof Pack; замер до/после зафиксирован;
- `npm run type` + focused security/runtime tests зелёные; секреты только SafeStorage + scanText;
- `docs/CURRENT_STATE.md` обновлён честной формулировкой.

---

## 10. Что НЕ делаем

- НЕ строим Hermes Portal / OpenClaw Gateway целиком — берём только auth-profile/token-sink, adapter-абстракцию, lifecycle-события, session continuity, health/failover, security-тесты.
- НЕ делаем TLS/HTTP anti-fingerprinting и маскировку (отменённый REINFORCED).
- НЕ обещаем full tools там, где провайдер не отдаёт tool-calls в управляемом формате.
- НЕ копируем refresh-токены между профилями без ownership-модели.
- НЕ называем CLI «полным контролем», пока он идёт через one-shot.
- НЕ ставим Codex Native первым — он последний.

---

## 11. Открытые вопросы (проверить до старта соответствующей фазы)

1. Насколько стабилен `--resume`/`--session-id` у Claude Code и есть ли аналог у Grok CLI (определяет глубину Mode C).
2. Codex: Responses API vs app-server — что реально доступно с ChatGPT-подпиской и как часто вендор меняет (для 2.0).
3. Grok подписка: OAuth (`~/.grok/auth.json` под динамическим ключом) — рефреш только через фоновый оф. CLI, не хардкод endpoint'ов.
4. Решение Павла по ToS-гейту для Mode B / direct-OAuth (по умолчанию — не трогаем, clean-by-default).

---

## 12. Источники

Локальные: `docs/COMPETITOR_AUDIT_HERMES_OPENCLAW_2026-07-06.md`, `docs/CLI_SUBSCRIPTIONS_PLAN_1.9.3-1.9.5.md`, `docs/CURRENT_STATE.md`, `electron/ai/registry.ts`, `electron/ipc/ai.ts`, `electron/ai/cli-prompt.ts`, `electron/ai/claude-cli.ts:192` (tool-блоки выбрасываются), `electron/ipc/undo.ts` (checkpoint API), `electron/storage/subscription-accounts.ts`, `electron/ai/subscription-limits.ts`.

Внешние: OpenClaw agent-runtimes / oauth / model-providers / cli-models (docs.openclaw.ai); Hermes configuration / providers (hermes-agent.nousresearch.com); Hermes GitHub (github.com/nousresearch/hermes-agent).

---

## 13. Формула

```
Subscription Auth Profile
→ Native / CLI-Session Runtime Harness (единый RuntimeAdapter)
→ Persistent Runtime Session
→ Control Envelope: undo + verify + proof-provenance + limit   ← наш моат
→ Capability-Truth UI
```
Не «ещё один CLI». Ступень выше — и на голову выше конкурентов там, где у них нет отката и доказательства.
