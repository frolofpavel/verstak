/**
 * Whitelist инструментов по роли субагента (Фаза 1 спринта мультиагентности).
 *
 * Субагенты теперь крутят agent-loop с инструментами, но НЕ полным набором
 * главного агента — каждая роль получает только то, что ей нужно по смыслу.
 * Это и безопасность (researcher не должен писать файлы), и защита от взрыва
 * стоимости/рекурсии (никто не может делегировать дальше).
 *
 * Контракт зафиксирован тестами в tests/ai/role-tools.test.ts — если кто-то
 * случайно даст read-only роли write-tool, тест упадёт.
 */

import { MAX_DELEGATION_DEPTH } from './delegation-limits'

/** Базовый read-only набор — доступен всем ролям. */
const READ_ONLY_TOOLS = [
  'read_file',
  'list_directory',
  'search_project',
  'find_files',
  'get_project_map',
  'impact_analysis'
] as const

/**
 * Дополнительные безопасные read-tools verstak (нет write/команд) — даём
 * researcher'у, чтобы он мог исследовать не только код, но и журнал, документы,
 * память и внешние коннекторы. Все они read-only по природе:
 * - read_journal / conversation_search / memory_search — чтение истории/памяти;
 * - read_spreadsheet / read_document / convert_file — чтение не-текстовых файлов;
 * - list_connectors / connector_query — запрос данных из внешних систем (1С/HTTP),
 *   сам по себе не пишет в проект;
 * - browser_read_page — чтение содержимого открытой страницы встроенного браузера.
 */
const RESEARCH_READ_TOOLS = [
  'read_journal',
  'conversation_search',
  'memory_search',
  'read_spreadsheet',
  'read_document',
  'read_pdf',
  'convert_file',
  'list_connectors',
  'connector_query',
  'browser_read_page'
] as const

/**
 * Артефактные tools verstak (generate_html / generate_docx / render_chart) —
 * пишут только в .verstak/artifacts/, не трогают код проекта. Даём executor'у:
 * узкая подзадача может включать «собери HTML-отчёт / docx / диаграмму».
 */
const ARTIFACT_TOOLS = ['generate_html', 'generate_docx', 'render_chart'] as const

/**
 * TodoGate (Фаза 3, Идея 2): доступ к оркестрационному todo-листу.
 * todo_update/todo_list даём всем ролям-исполнителям — они берут пункты в работу
 * и закрывают их (прозрачность прогресса). todo_create (создание листа) — НЕ
 * субам: лист создаёт главный агент / planner.
 */
const TODO_WORKER_TOOLS = ['todo_update', 'todo_list'] as const

/**
 * Инструменты, которые субагенту НИКОГДА нельзя давать — независимо от роли
 * и глубины. orchestrate / swarm — оркестрация верхнего уровня: декомпозиция
 * большой цели и рой агентов с арбитром. Их вызывает ТОЛЬКО главный агент
 * (depth 0); субам они недоступны всегда — иначе дерево/рой множились бы
 * неконтролируемо.
 *
 * ВНИМАНИЕ: delegate_task / delegate_parallel здесь БОЛЬШЕ НЕТ. В Фазе 4 они
 * стали условно-разрешёнными субам — под лимитом глубины (MAX_DELEGATION_DEPTH)
 * и общего числа агентов. Гейт делегирования вынесен в delegation-limits.ts и
 * применяется в getRoleToolset(role, { depth }) + повторно в самих handler'ах
 * (defence-in-depth). До Фазы 4 они были в этом множестве (см. role-tools.test).
 */
export const SUBAGENT_FORBIDDEN_TOOLS: ReadonlySet<string> = new Set([
  'orchestrate',
  'swarm'
])

/** delegate_* — условно-разрешённые субам инструменты (под лимитом глубины). */
const DELEGATION_TOOLS = ['delegate_task', 'delegate_parallel'] as const

/**
 * Вернуть список разрешённых tool-имён для роли субагента.
 *
 * - researcher → read-only + безопасные read-tools verstak (журнал, документы,
 *   память, коннекторы, страница браузера). Анализ без записи и команд.
 * - critic / planner → строго READ-ONLY (анализ кода, без записи и команд).
 * - verifier → read-only + check_diagnostics + run_command (но run_command
 *   ограничен whitelist'ом проверочных команд в command-policy.isVerifierCommand).
 * - executor → read-only + apply_patch + write_file (через mode-policy.decide) +
 *   run_command (через command-policy denylist, как у главного агента) +
 *   артефактные tools (html/docx/chart — пишут только в .verstak/artifacts).
 * - роль не задана (delegate_task без роли) → безопасный read-only default.
 *
 * Фаза 4 (Идея 3): delegate_task / delegate_parallel добавляются субу-исполнителю
 * (executor / researcher / planner) ТОЛЬКО если его глубина позволяет делегировать
 * дальше (depth < MAX_DELEGATION_DEPTH). На предельной глубине — не добавляются
 * (суб «листовой»). orchestrate / swarm субам недоступны всегда. Лимит общего числа
 * агентов проверяется отдельно — в самих handler'ах через SessionAgentCounter.
 *
 * @param opts.depth — глубина субагента (главный=0, его суб=1, …). По умолчанию 1
 *   (любой суб глубже корня), чтобы без явного depth поведение совпадало с прежним
 *   (делегирование на 1+ зависит от MAX_DELEGATION_DEPTH).
 */
export function getRoleToolset(role?: string | null, opts?: { depth?: number }): string[] {
  let tools: string[]
  switch (role) {
    case undefined:
    case null:
      tools = [...READ_ONLY_TOOLS, 'todo_list']
      break
    case 'executor':
      // executor берёт пункты todo в работу и закрывает + сохраняет находки в память.
      tools = [...READ_ONLY_TOOLS, ...RESEARCH_READ_TOOLS, ...TODO_WORKER_TOOLS, 'apply_patch', 'write_file', 'run_command', 'check_diagnostics', ...ARTIFACT_TOOLS, 'memory_save']
      break
    case 'verifier':
      // verifier отмечает прогресс по todo + фиксирует выводы верификации в память (Идея 8).
      tools = [...READ_ONLY_TOOLS, ...TODO_WORKER_TOOLS, 'check_diagnostics', 'run_command', 'memory_save']
      break
    case 'researcher':
      // researcher берёт/закрывает todo + сохраняет находки в долговременную память (Идея 8).
      tools = [...READ_ONLY_TOOLS, ...RESEARCH_READ_TOOLS, ...TODO_WORKER_TOOLS, 'memory_save']
      break
    case 'planner':
      // planner может создавать todo-лист (декомпозиция) + видеть прогресс.
      tools = [...READ_ONLY_TOOLS, 'todo_create', ...TODO_WORKER_TOOLS]
      break
    case 'critic':
    default:
      // critic и неизвестная/пустая роль — read-only + просмотр прогресса todo.
      tools = [...READ_ONLY_TOOLS, 'todo_list']
      break
  }
  // Фаза 4: на разрешённой глубине дать суб-исполнителю право делегировать
  // дальше. Роли researcher/planner/executor — те, кто реально декомпозирует
  // и распараллеливает работу. critic/verifier остаются «листовыми» (их дело —
  // оценка/проверка, не порождение поддерева).
  const depth = opts?.depth ?? 1
  const canDelegateRole = role === 'executor' || role === 'researcher' || role === 'planner'
  if (canDelegateRole && depth < MAX_DELEGATION_DEPTH) {
    tools = [...tools, ...DELEGATION_TOOLS]
  }
  // Defence-in-depth: orchestrate / swarm вырезаем всегда (только главный агент).
  return tools.filter(t => !SUBAGENT_FORBIDDEN_TOOLS.has(t))
}
