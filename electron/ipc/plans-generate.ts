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

/** Итог генерации для renderer'а. */
export interface PlanGenerateResult {
  ok: boolean
  planId?: number
  /** Причина отказа человеческим языком (§5.1: не голое «не удалось»). */
  error?: string
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
}) => Promise<{ ok: boolean; text: string; error?: string }>

export interface PlanGenerateDeps {
  plans: Plans
  runPlanning: PlanGenerateRunner
  /** Проверка, что путь принадлежит открытому проекту (§3.2). */
  isKnownProject: (projectPath: string) => boolean
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
    'Изучи контекст проекта read-only инструментами и сохрани результат ОДНИМ вызовом create_plan.',
    'Шаги — с конкретными файлами и критерием готовности. Ничего не меняй: это только планирование.',
  )
  return lines.join('\n')
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

  const ctrl = new AbortController()
  activeByProject.set(projectPath, ctrl)
  const sendId = nextGenerationSendId()
  try {
    const run = await deps.runPlanning({
      projectPath,
      prompt: buildGenerationPrompt({ ...req, projectPath, title, taskDescription: task }),
      sendId,
      signal: ctrl.signal,
    })
    // Создан ли план — спрашиваем РЕЕСТР ПРОГОНА, а не текст модели. Тот же
    // реестр закрывает §5.4: повторный create_plan вернул бы существующий id.
    const planId = getPlanForRun(sendId)
    if (planId != null && deps.plans.get(planId)) {
      // Отмена уже после сохранения плана — план настоящий, врать о нём нельзя.
      return { ok: true, planId }
    }
    if (ctrl.signal.aborted) {
      return { ok: false, error: 'Генерация отменена. План не создан.' }
    }
    if (!run.ok) {
      return { ok: false, error: run.error?.trim() || 'Не удалось сформировать план.' }
    }
    // §5.1: агент закончил без create_plan. Ноль строк в БД и ЧЕЛОВЕЧЕСКАЯ
    // причина — короткое объяснение самой модели, а не голое «не удалось».
    const why = run.text.trim().replace(/\s+/g, ' ').slice(0, 400)
    return {
      ok: false,
      error: why ? `Не удалось сформировать план. ${why}` : 'Не удалось сформировать план: модель не создала план.',
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
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
