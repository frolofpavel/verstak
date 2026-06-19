# Project Brain — мозг проекта

> **Это не memory-фича. Это ядро продукта.**
>
> В обычных AI-инструментах интеллект живёт в **модели**. В Verstak интеллект живёт в **проекте**.

## Идея

Модели сменяемы — DeepSeek, Qwen, Kimi, Claude, GPT, OpenRouter, локальные, бесплатные. Но **Project Brain** конкретного проекта остаётся и копит: контекст, решения, правила, summary файлов, оценку моделей, накопленную экспертизу. Меняешь модель — мозг проекта на месте.

Ключ всего — `project_path` (как Verstak идентифицирует проект).

## Сущности (data layer — `electron/storage/project-brain.ts`, миграция 25)

| Сущность | Что хранит | Статус |
|---|---|---|
| **ProjectBrain** | overview, architectureSummary, importantFiles, entities, projectRules, lastWarmupAt | ✅ MVP |
| **FileSummary** | по файлу: summary, keyExports, keyDependencies, risks, hash, tokenEstimate | ✅ MVP |
| **ContextPack** | сжатый контекст: short / medium / long + sourceFiles + tokenEstimate | ✅ MVP |
| **DecisionRecord** | долговременная память решений (что/почему/риски/возражения/альтернативы/next/confidence/revisit) | ✅ MVP |
| **DecisionBrief** | сжатая карта решения ДО сохранения (вход для save) | тип (transient) |
| **ModelScoreboard** | какие модели лучше под проект (success/cost/latency) | 🔲 stub (схема) |
| **AgencyHiveMind** | перенос опыта между проектами агентства | 🔲 stub (схема) |

## Поток

```
Project Warmup → сканирует проект → FileSummary + overview + ContextPack(short/medium/long)
       ↓
AI-запрос с «Use Project Brain» → инжектит подходящий ContextPack (вместо всего проекта заново)
       ↓
Важный ответ → «Сохранить как решение» → DecisionBrief → DecisionRecord (память проекта)
```

## Как связано с остальным

- **Профиль (Шаг C, `.verstak/profile.json`)** = зачаток `ProjectBrain.overview`.
- **context-pack** = механизм `ContextPack` (Brain делает его персистентным + слоёным).
- **Context Bank / Project Warmup** = наполнение Brain + метрика экономии.
- **Shadow Team** (коллегия ролей) → `DecisionBrief` → `DecisionRecord`.
- **Gateway / Fusion** — модели; Brain — то, что под ними копится.
- **Agency Hive Mind** (будущее) — перенос `DecisionRecord` между проектами агентства.

Будущая цепочка: **Shadow Team → Decision Brief → Decision Record → Agency Hive Mind.**

## Принцип UI (для будущего Shadow Team)
Не «театр агентов» и не длинный чат ролей, а **DecisionBrief** — сжатая карта. 4 уровня: (1) финальный ответ; (2) строка «Shadow Team · 6 ролей · 2 возражения · 1 решение»; (3) краткая карта ролей 1-2 строки; (4) полные логи только в advanced.

## Статус (итерации)
- ✅ **Итер.1** — architecture discovery (карта в STATUS/плане).
- ✅ **Итер.2** — data layer (миграция 25 + `storage/project-brain.ts` + CRUD).
- 🔲 Итер.3 — Project Warmup (скан → summaries → context-packs).
- 🔲 Итер.4 — использование ContextPack в AI-запросах + UI-бейдж.
- 🔲 Итер.5 — Decision Brief/Record + раздел «Decisions».
- 🔲 Итер.6 — UI-принцип Shadow Team (DecisionBrief как артефакт).
- ✅ Итер.7 — этот документ.

## Чего НЕ делаем сейчас
Полноценный Shadow Team, Fusion, billing, сложный ModelScoreboard, полноценный Hive Mind, semantic cache, обучение модели, облачную синхронизацию, enterprise. Сейчас — заложить Project Brain как центральный слой.
