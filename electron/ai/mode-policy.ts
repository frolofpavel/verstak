/**
 * Agent mode — глобальная политика как обрабатывать write/command действия AI.
 * По аналогии с Claude Code (Ask / Accept / Plan / Auto / Bypass).
 *
 * Применяется ВО ВСЕХ местах где AI пытается изменить файлы или запустить
 * команды. Проверяется в tool-handlers перед dispatching.
 */

export type AgentMode = 'ask' | 'accept-edits' | 'plan' | 'auto' | 'bypass'

export const AGENT_MODES: Array<{ id: AgentMode; label: string; description: string; icon: string }> = [
  { id: 'ask',          label: 'Запрос разрешений',   description: 'Подтверждение на каждое изменение файла и команду. По умолчанию.', icon: '🛡' },
  { id: 'accept-edits', label: 'Принимать правки',    description: 'File edits авто-принимаются. Команды всё ещё через подтверждение.', icon: '✏' },
  { id: 'plan',         label: 'Режим планирования',  description: 'Только чтение и планирование. Никаких изменений файлов и команд.', icon: '📋' },
  { id: 'auto',         label: 'Авто-режим',          description: 'Всё авто-принимается. Команды и правки без подтверждения. Осторожно.', icon: '⚡' },
  { id: 'bypass',       label: 'Без подтверждения',   description: 'Никаких диалогов. Для опытных пользователей или CI.', icon: '🚀' }
]

/** Decision for a single tool call given the active mode. */
export type ToolDecision =
  | 'confirm'      // show diff/command modal and wait for user
  | 'auto-accept'  // execute immediately, no UI prompt
  | 'block'        // refuse with a message back to the model

/**
 * Per-tool auto-approve (ось 3 I) — пользовательские категорийные тумблеры поверх mode.
 * Повышают confirm→auto-accept для ДОВЕРЕННОЙ категории (без перехода в полный auto/
 * bypass). НЕ перекрывают block — plan-режим остаётся строгим. Гранулярный контроль:
 * «доверяю правкам, но команды подтверждаю» и наоборот.
 */
export interface AutoApprove {
  edits?: boolean     // write_file / apply_patch / propose_edits / edit_spreadsheet
  commands?: boolean  // run_command / connector_query / execute_code
}

/**
 * Returns what to do with a tool call under the given mode. Used by
 * tool-handlers to short-circuit the diff/command modals.
 *
 * Logic:
 * - write_file/apply_patch/propose_edits = "edits"
 * - run_command/connector_query = "commands"
 * - read_file/list_directory/search_project/get_project_map/etc = always allowed
 *
 * connector_query гейтится как команда: коннекторы (SSH, HTTP POST/PUT/DELETE,
 * Telegram, Битрикс24, публикация) дают side-effects на внешних системах, поэтому
 * в plan-режиме («только чтение») они должны блокироваться, а в ask — подтверждаться.
 */
/**
 * Браузерные инструменты, МЕНЯЮЩИЕ чужую систему. Список, а не литерал в
 * условии, — намеренно: `browser_click` проехал мимо гейта именно потому, что
 * категории для него не существовало, и следующий `browser_type` проехал бы так
 * же. Новый мутирующий инструмент попадает под режим, как только его имя
 * появится здесь, а не когда автор правки о нём вспомнит.
 *
 * Читающие (`browser_read_page`, `browser_screenshot`) сюда НЕ входят: режим
 * `plan` существует ради чтения, и запрет смотреть страницу сделал бы его
 * бесполезным.
 */
// VSK-BROWSER-B1 этап 1: клик ПО НОМЕРУ — тот же класс мутации чужой системы, что и
// browser_click, поэтому в ТУ ЖЕ категорию (иначе новый путь проехал бы мимо
// SEC-CMD-06 ровно как когда-то проезжал сам клик — расширяемость сторожит пин
// «категория — СПИСОК» в tests/security/browser-plan-mode.test.ts).
// Д3 (приёмка 10.08): browser_press_key — Enter отправляет форму залогиненной
// страницы, то есть меняет чужую систему ровно как клик. В категорию — сразу,
// а не «когда автор правки вспомнит»: ради этого она и заведена списком.
export const MUTATING_BROWSER_TOOLS: readonly string[] = ['browser_click', 'browser_click_by_number', 'browser_type_by_number', 'browser_press_key']

/**
 * Инструменты, СОЗДАЮЩИЕ ФАЙЛ на диске (артефакты): все три реально пишут в проект
 * (render_chart → .svg, generate_html → .html, generate_docx → .docx). Седьмой обход
 * гейта (08.08): их не было ни в одной категории → auto-accept во ВСЕХ режимах, включая
 * plan, где запись запрещена. Гейтим как браузерную мутацию (block в plan, иначе
 * auto-accept), а НЕ как isEdit: полноценный isEdit требует confirm в ask, а модалки
 * подтверждения для артефактов нет — classify-как-isEdit без неё дал бы ЛОЖНЫЙ Policy
 * Center (матрица decide() показывала бы confirm, а хендлер писал бы молча). Confirm в
 * ask («файл есть файл») — отдельная задача с pending-flow, вынесена штабу/Павлу.
 * Список, а не литерал: новый артефактный инструмент попадает под режим сразу.
 */
export const ARTIFACT_TOOLS: readonly string[] = ['generate_docx', 'generate_html', 'render_chart', 'create_proof_video']

export function decide(toolName: string, mode: AgentMode, autoApprove?: AutoApprove): ToolDecision {
  const isEdit = toolName === 'write_file' || toolName === 'apply_patch' || toolName === 'propose_edits' || toolName === 'edit_spreadsheet'
  const isArtifact = ARTIFACT_TOOLS.includes(toolName)
  // execute_code (PTC) исполняет произвольный JS — vm НЕ граница безопасности, поэтому
  // trust = run_command: confirm в ask, block в plan. Без эскалации привилегий.
  const isCommand = toolName === 'run_command' || toolName === 'connector_query' || toolName === 'execute_code'
  // Клик в залогиненном браузере меняет ЧУЖУЮ систему, а не рабочее дерево,
  // поэтому это своя категория, а не edit и не command: в `plan` блокируется
  // (там «только чтение»), в остальных режимах порог сегодня НЕ ужесточается —
  // его выберет человек по фактическим цифрам, когда они наберутся.
  const isBrowserMutation = MUTATING_BROWSER_TOOLS.includes(toolName)
  // ВОСЬМОЙ ОБХОД (08.08): spawn_task_session ПОРОЖДАЕТ ИСПОЛНЕНИЕ (дочерняя сессия пишет
  // файлы/запускает команды), но не входил ни в одну категорию → auto-accept во всех
  // режимах, включая plan. По эффекту ближе к isCommand, НО confirm ему не даём: модалки
  // подтверждения спавна нет, а classify-как-isCommand дал бы ложный Policy Center (как у
  // артефактов). Поэтому plan→block, иначе auto; а мягкость дочерней сессии закрывает
  // отдельно наследование режима родителя (spawnChildSession), не эта ветка.
  const isSpawn = toolName === 'spawn_task_session'

  // reads + операции с СОБСТВЕННОЙ памятью агента (memory_save/memory_invalidate/
  // core_memory_*) всегда проходят: plan-режим гейтит изменения ПРОЕКТА (файлы/команды),
  // а не курирование агентом своей памяти (дёшево, обратимо, не трогает рабочее дерево).
  if (!isEdit && !isCommand && !isBrowserMutation && !isArtifact && !isSpawn) return 'auto-accept'
  // Браузерная мутация, артефакт (запись файла) и спавн (порождает исполнение): строгость
  // только там, где режим означает «ничего не менять» (plan → block), иначе auto-accept.
  // Confirm сознательно НЕ здесь — модалок подтверждения для них нет (см. ARTIFACT_TOOLS/isSpawn).
  if (isBrowserMutation || isArtifact || isSpawn) return mode === 'plan' ? 'block' : 'auto-accept'

  let decision: ToolDecision
  switch (mode) {
    case 'ask':          decision = 'confirm'; break
    case 'accept-edits': decision = isEdit ? 'auto-accept' : 'confirm'; break
    case 'plan':         decision = 'block'; break
    case 'auto':         decision = 'auto-accept'; break
    case 'bypass':       decision = 'auto-accept'; break
  }
  // Per-tool auto-approve: только повышаем confirm→auto-accept для доверенной категории.
  // block (plan) и без того auto-accept НЕ трогаем.
  if (decision === 'confirm' && autoApprove) {
    if (isEdit && autoApprove.edits) return 'auto-accept'
    if (isCommand && autoApprove.commands) return 'auto-accept'
  }
  return decision
}

/** Human-readable rejection message for the model when a tool is blocked by mode. */
export function blockReason(toolName: string, mode: AgentMode): string {
  if (mode === 'plan') {
    if (MUTATING_BROWSER_TOOLS.includes(toolName)) {
      return `Активен режим "Режим планирования" — действия в браузере, меняющие страницу (клик по кнопке или ссылке), запрещены: ` +
             `страница залогинена, и нажатие может отправить, опубликовать, удалить или оплатить. ` +
             `Смотреть страницу можно: browser_navigate, browser_read_page и browser_screenshot работают. ` +
             `Пользователь сам переключит режим, когда захочет разрешить действия.`
    }
    if (toolName === 'connector_query') {
      return `Активен режим "Режим планирования" — запросы к коннекторам (внешние системы: SSH, HTTP, Telegram, Битрикс24 и т.п.) запрещены, ` +
             `так как они могут менять состояние внешних систем. ` +
             `Сосредоточься на чтении кода (read_file, get_project_map, search_project) и составлении плана через create_plan. ` +
             `Пользователь сам переключит режим когда захочет выполнить запрос к коннектору.`
    }
    if (ARTIFACT_TOOLS.includes(toolName)) {
      return `Активен режим "Режим планирования" — создание файла-артефакта (документ, HTML, диаграмма или видео) ` +
             `запрещено: это ЗАПИСЬ на диск, а планирование ничего не меняет. ` +
             `Сначала опиши содержимое артефакта в ответе/плане; пользователь переключит режим, когда захочет создать файл.`
    }
    if (toolName === 'spawn_task_session') {
      return `Активен режим "Режим планирования" — вынос задачи в отдельную сессию запрещён: ` +
             `дочерняя сессия начнёт ВЫПОЛНЯТЬ действия (файлы, команды), а планирование ничего не меняет. ` +
             `Составь план здесь (create_plan); пользователь переключит режим, когда захочет запустить задачу.`
    }
    return `Активен режим "Режим планирования" — изменение файлов и выполнение команд запрещены. ` +
           `Сосредоточься на чтении кода (read_file, get_project_map, search_project) и составлении плана через create_plan. ` +
           `Пользователь сам переключит режим когда захочет применить изменения.`
  }
  return `Tool "${toolName}" заблокирован активным режимом "${mode}".`
}
