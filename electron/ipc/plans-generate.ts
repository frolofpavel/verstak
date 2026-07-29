/**
 * `plans:generate` — генерация плана из раздела «Планы» (пакет VSK-PLAN-GEN-A2).
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ МЕТОД, А НЕ ОТПРАВКА В ЧАТ. Минимум A1 §7.1 диспатчил из
 * renderer'а событие в чат: renderer сам собирал системный промпт, а провайдер и
 * режим брались у чата. Пакет A2 §3 это запрещает прямо — renderer не формирует
 * промпт, не выбирает провайдера и не зовёт `plans.create`. Здесь намерение
 * уровня продукта: «сформируй план по названию и описанию», всё остальное решает
 * main.
 *
 * ЧТО ПЕРЕИСПОЛЬЗУЕТСЯ, А НЕ СТРОИТСЯ ЗАНОВО (§2 запрещает второй контур):
 *   · тот же agent-loop, что у scheduled-прогона (`runSubAgentLoop`);
 *   · тот же контекст проекта (`prepareSystemContext`) — правила, память, карта;
 *   · тот же инструмент `create_plan` и та же таблица `plans`;
 *   · та же рантайм-идемпотентность по sendId (`getPlanForRun`): она И отвечает
 *     на вопрос «создан ли план», И закрывает §5.4 (повторный вызов в одном
 *     прогоне не плодит дубль) — второй механизм рядом не заводится.
 *
 * ЗАПРЕТ ИЗМЕНЕНИЙ — ШТАТНЫМ ГЕЙТОМ, НЕ СПИСКОМ. `agentMode: 'plan'` означает,
 * что `mode-policy.decide` вернёт `block` на любой write/command, даже если
 * инструмент как-то попадёт в набор. Список инструментов — второй, независимый
 * слой; безопасность держит первый.
 */
import { ipcMain } from 'electron'
import type { Plans } from '../storage/plans'
import type { ToolContext } from './tool-handlers/shared'
import { getPlanForRun } from '../ai/runner-shared'
import type { ProviderId } from '../ai/registry'
import type { PlanProviderChoice } from '../ai/plan-generation-provider'

/** Итог генерации для renderer'а. */
export interface PlanGenerateResult {
  ok: boolean
  planId?: number
  /** Причина отказа человеческим языком (§5.1: не голое «не удалось»). */
  error?: string
  /** Дефект 1 живой приёмки: план собран НЕ на активном провайдере — человек
   *  обязан узнать об этом сам, а не догадаться по счёту за токены. */
  notice?: string
}

export interface PlanGenerateRequest {
  projectPath: string
  title: string
  taskDescription: string
  /** Уточнение пользователя — второй круг той же постановки (§4). */
  clarification?: string
}

/**
 * Запуск прогона. Вынесен параметром, чтобы IPC-слой не тянул за собой весь
 * AiDeps: тестам нужен именно этот шов, а не мок половины приложения.
 */
export type PlanGenerateRunner = (opts: {
  projectPath: string
  prompt: string
  sendId: number
  signal: AbortSignal
  /** Решение принимает `choosePlanProvider`, а не активный чат: у CLI-подписки
   *  инструментов нет, и генерация на ней невозможна физически. */
  providerId: ProviderId
}) => Promise<{
  ok: boolean; text: string; error?: string
  /** Диагностика прогона — чтобы отказ назвал СВОЮ причину (см. explainNoPlan). */
  toolCallCount?: number
  exitReason?: 'completed' | 'max-iterations' | 'aborted' | 'error'
}>

export interface PlanGenerateDeps {
  plans: Plans
  runPlanning: PlanGenerateRunner
  /** Проверка, что путь принадлежит открытому проекту (§3.2). */
  isKnownProject: (projectPath: string) => boolean
  /** На чём генерировать (см. ai/plan-generation-provider.ts). */
  choosePlanProvider: () => PlanProviderChoice
}

/**
 * Один активный запрос НА ПРОЕКТ (§5.3). Guard живёт в main сознательно: в UI он
 * закрывается только от двойного клика по кнопке, а не от второго окна, повторного
 * IPC-вызова или гонки. `AbortController` тут же даёт штатную отмену (§5.7).
 */
const activeByProject = new Map<string, AbortController>()

/** Только для тестов: реестр — модульный синглтон. */
export function __resetPlanGenerationForTests(): void {
  for (const ctrl of activeByProject.values()) ctrl.abort()
  activeByProject.clear()
}

export function isGenerating(projectPath: string): boolean {
  return activeByProject.has(projectPath)
}

/** Отмена активной генерации проекта (§5.7). */
export function cancelPlanGeneration(projectPath: string): boolean {
  const ctrl = activeByProject.get(projectPath)
  if (!ctrl) return false
  ctrl.abort()
  activeByProject.delete(projectPath)
  return true
}

/** sendId генерации: отдельный отрицательный диапазон, чтобы не столкнуться с
 *  ai:send (положительные) и scheduled headless (-1). Ключ реестра планов. */
let generationSendId = -1000
const nextGenerationSendId = () => --generationSendId

/**
 * Промпт генерации. Живёт в MAIN (§3): renderer его не формирует и не может
 * подменить. Алгоритм планирования не дублируется — он в общем системном слое,
 * который приезжает через `prepareSystemContext`; здесь только постановка.
 */
export function buildGenerationPrompt(req: PlanGenerateRequest): string {
  const lines = [
    `Составь план работы «${req.title.trim()}».`,
    '',
    'Что нужно сделать (словами пользователя):',
    req.taskDescription.trim(),
  ]
  if (req.clarification?.trim()) {
    lines.push('', 'Уточнение пользователя:', req.clarification.trim())
    // Второй круг вопросов запрещён (§4): либо план с шагами добора, либо честный отказ.
    lines.push('', 'Это ответ на твой уточняющий вопрос. Больше вопросов не задавай:')
    lines.push('либо составь план (недостающее закрой шагами добора), либо честно объясни, почему план невозможен.')
  }
  lines.push(
    '',
    `Проект: ${req.projectPath}`,
    'Изучи контекст проекта read-only инструментами и сохрани результат ОДНИМ вызовом create_plan.',
    'Шаги — с конкретными файлами и критерием готовности. Ничего не меняй: это только планирование.',
    // «Задача не про этот проект» — случай реальный: человек держит открытым один
    // проект, а спрашивает про другой. АВТОМАТИЧЕСКИ отличить его нельзя без
    // угадывания, зато его знает тот, кто уже посмотрел содержимое. Поэтому не
    // эвристика в коде, а прямое разрешение остановиться и сказать. Без него
    // модель ищет до упора и упирается в потолок времени, а человек получает
    // «опишите конкретнее» там, где формулировка ни при чём.
    'Если в этом проекте нет ничего по теме задачи — не продолжай поиск. Скажи об этом одной фразой '
      + 'и укажи, что, возможно, открыт не тот проект.',
  )
  return lines.join('\n')
}

/**
 * Отказ, который НАЗЫВАЕТ СВОЮ ПРИЧИНУ (29.07, живая проверка).
 *
 * До этого «инструмент не дали», «модель не захотела» и «модель работала, но
 * плана не сохранила» давали человеку одну и ту же строку «модель не создала
 * план» — а лечатся они по-разному. Диагностику отдаёт сам прогон
 * (`toolCallCount` / `exitReason`), догадки здесь не строятся.
 */
export function explainNoPlan(run: { toolCallCount?: number; exitReason?: string }): string {
  if (run.exitReason === 'max-iterations') {
    return 'Не удалось сформировать план: модель не уложилась в отведённые шаги. '
      + 'Опишите задачу конкретнее или разбейте её на части.'
  }
  if ((run.toolCallCount ?? 0) === 0) {
    return 'Не удалось сформировать план: модель не обратилась ни к одному инструменту и плана не сохранила. '
      + 'Попробуйте ещё раз или уточните описание задачи.'
  }
  return 'Не удалось сформировать план: модель изучила проект, но план не сохранила. '
    + 'Попробуйте ещё раз или уточните описание задачи.'
}

export async function generatePlan(deps: PlanGenerateDeps, req: PlanGenerateRequest): Promise<PlanGenerateResult> {
  const projectPath = (req.projectPath ?? '').trim()
  const title = (req.title ?? '').trim()
  const task = (req.taskDescription ?? '').trim()
  // §4: пробельные значения не принимаются. Проверка в main, потому что UI —
  // не граница безопасности: тот же IPC можно позвать мимо формы.
  if (!title || !task) {
    return { ok: false, error: 'Заполните название плана и описание задачи.' }
  }
  if (!projectPath || !deps.isKnownProject(projectPath)) {
    return { ok: false, error: 'Проект не открыт или путь не зарегистрирован — генерация отменена.' }
  }
  if (activeByProject.has(projectPath)) {
    return { ok: false, error: 'Генерация плана для этого проекта уже идёт.' }
  }
  // Провайдер выбирается ДО захвата guard'а и до единого сетевого байта: если
  // генерировать не на чем, человек получает инструкцию, а не занятый слот.
  const choice = deps.choosePlanProvider()
  if (!choice.providerId) {
    return { ok: false, error: choice.error ?? 'Нет провайдера, на котором можно собрать план.' }
  }
  const notice = choice.notice ?? undefined

  const ctrl = new AbortController()
  activeByProject.set(projectPath, ctrl)
  const sendId = nextGenerationSendId()
  // Верхняя граница по времени: обрываем сами, но НЕ выдаём это за отмену человеком.
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; ctrl.abort() }, PLAN_GENERATION_TIME_BUDGET_MS)
  try {
    const run = await deps.runPlanning({
      projectPath,
      prompt: buildGenerationPrompt({ ...req, projectPath, title, taskDescription: task }),
      sendId,
      signal: ctrl.signal,
      providerId: choice.providerId,
    })
    // Создан ли план — спрашиваем РЕЕСТР ПРОГОНА, а не текст модели. Тот же
    // реестр закрывает §5.4: повторный create_plan вернул бы существующий id.
    const planId = getPlanForRun(sendId)
    if (planId != null && deps.plans.get(planId)) {
      // Отмена уже после сохранения плана — план настоящий, врать о нём нельзя.
      return { ok: true, planId, notice }
    }
    if (ctrl.signal.aborted) {
      return {
        ok: false,
        error: timedOut
          ? `Не удалось сформировать план: работа заняла больше ${Math.round(PLAN_GENERATION_TIME_BUDGET_MS / 60_000)} минут и была остановлена. `
            + 'Опишите задачу конкретнее или разбейте её на части.'
          : 'Генерация отменена. План не создан.',
        notice,
      }
    }
    if (!run.ok) {
      return { ok: false, error: run.error?.trim() || 'Не удалось сформировать план.', notice }
    }
    // §5.1: агент закончил без create_plan. Ноль строк в БД и ЧЕЛОВЕЧЕСКАЯ
    // причина — короткое объяснение самой модели, а не голое «не удалось».
    const why = run.text.trim().replace(/\s+/g, ' ').slice(0, 400)
    return {
      ok: false,
      error: why ? `Не удалось сформировать план. ${why}` : explainNoPlan(run),
      notice,
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), notice }
  } finally {
    clearTimeout(timer)
    activeByProject.delete(projectPath)
  }
}

export function registerPlanGenerateIpc(deps: PlanGenerateDeps): void {
  ipcMain.handle('plans:generate', (_e, req: PlanGenerateRequest) => generatePlan(deps, req))
  ipcMain.handle('plans:generate-cancel', (_e, projectPath: string) => cancelPlanGeneration(projectPath))
}

/** Набор инструментов генерации: изучение проекта + сохранение плана.
 *  Второй слой поверх `agentMode: 'plan'`, а не вместо него. */
export const PLAN_GENERATION_TOOLS = [
  'read_file', 'list_directory', 'search_project', 'find_files', 'get_project_map',
  'impact_analysis', 'read_journal', 'memory_search', 'conversation_search',
  'find_definition', 'find_references', 'list_connectors', 'web_search', 'web_fetch',
  'create_plan',
]

/** Режим прогона генерации. Вынесено константой, чтобы страж мог проверить: это
 *  `plan`, значит `mode-policy.decide` блокирует любые изменения. */
export const PLAN_GENERATION_MODE: ToolContext['agentMode'] = 'plan'

/**
 * БЮДЖЕТ РАУНДОВ ГЕНЕРАЦИИ — ЗАМЕРЕН, НЕ ПОДОБРАН НА ГЛАЗ (29.07).
 *
 * ПОЧЕМУ НЕ ОБЩИЙ `MAX_SUB_ITERATIONS` (8). Тот дефолт написан под узкую
 * подзадачу — «прочитать пару файлов, применить патч, проверить», это сказано в
 * его же комментарии. Генерация плана начинается с ОСМОТРА проекта, и восьми
 * раундов ей не хватает: живая проверка на постановке «какие тесты в проекте
 * самые долгие и в каком порядке их чинить» упёрлась ровно в этот лимит
 * (exitReason = max-iterations, плана нет).
 *
 * ЗАМЕР. Ту же постановку прошли теми же read-only инструментами, считая
 * ЗАВИСИМЫЕ раунды (независимые вызовы идут в одном раунде):
 *   1) ориентация: дерево tests/ + счёт файлов (482 файла, 15 подкаталогов)
 *   2) конфигурация: vitest.config.ts + явные бюджеты `it(…, N)` в тестах
 *   3) кандидаты: поиск тестов с реальными субпроцессами (15 файлов)
 *   4) чтение двух-трёх найденных файлов, чтобы не гадать
 *   5) create_plan
 * Пол — 5 раундов, и это для исполнителя, который НИ РАЗУ не тратит раунд зря и
 * всегда батчит независимые вызовы. Живая модель на той же задаче израсходовала
 * 8 и не закончила. Значит бюджет должен отличаться КРАТНО, а не на единицу.
 *
 * 24 = 3× от израсходованных-и-недостаточных 8, почти 5× от измеренного пола.
 * Настоящая верхняя граница здесь — не раунды, а время (см. ниже); этот счётчик
 * остаётся страховкой от спирали.
 */
export const PLAN_GENERATION_MAX_TURNS = 24

/**
 * ВЕРХНЯЯ ГРАНИЦА ПО ВРЕМЕНИ. Генерация идёт при живом человеке у экрана, поэтому
 * «много раундов» не должно превращаться в «висит непонятно сколько». Три минуты —
 * граница, после которой ожидание перестаёт читаться как работа и начинает
 * читаться как поломка. Кнопка «Отменить» остаётся, но полагаться на неё нельзя:
 * человек не обязан догадываться, что процесс уже не закончится.
 *
 * Исход по времени НЕ выдаётся за отмену человеком — у него свой текст.
 */
export const PLAN_GENERATION_TIME_BUDGET_MS = 180_000
