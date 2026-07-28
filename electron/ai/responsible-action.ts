/**
 * ОТВЕТСТВЕННОЕ ДЕЙСТВИЕ — правило 2 цикла (§1 и §4.4 ТЗ VSK-TASK-FLOW-A1).
 *
 * ЧЕМ ЭТО ОТЛИЧАЕТСЯ ОТ ПРЕЖНЕЙ «ПАУЗЫ». До 29.07 пауза перед платежом,
 * отправкой, публикацией, удалением и сменой прав существовала только как ТЕКСТ
 * в продолжении после approve. Текст обходится четырьмя способами сразу:
 * режимами `auto`/`bypass`, allow-правилом permissions, тумблером
 * авто-подтверждения команд и обычной записью файла в `accept-edits`. Значит
 * механизма не было вовсе — и в аудите это было записано как
 * «заявлено-но-не-построено».
 *
 * ЗДЕСЬ МЕХАНИЗМ. Классификация идёт по ФАКТИЧЕСКИМ аргументам вызова
 * инструмента, а решение принимает `resolveDecision` — общий гейт, через который
 * проходят ВСЕ инструменты (file-ops, command, connectors, execute-code).
 * Модель не может его обойти: она не выбирает, спрашивать ли.
 *
 * ЧТО СОЗНАТЕЛЬНО НЕ СЧИТАЕТСЯ ответственным: обычная запись файла и патч. Иначе
 * сломается правило 1 («одно утверждение на план, между шагами не
 * останавливаемся») — а именно ради него режим после approve остаётся
 * `accept-edits`. Ответственно не «менять проект», а «сделать необратимое
 * наружу»: отправить, опубликовать, заплатить, удалить, раздать права.
 *
 * ЧЕСТНО ПРО ПРИРОДУ: это эвристика по тексту команды, как и существующий
 * denylist (`dangerous-commands.ts`). Разница с прежним «текстом в промпте»
 * принципиальная: там просили модель остановиться, здесь останавливает рантайм
 * по тому, что она РЕАЛЬНО вызвала. Ложное срабатывание стоит одного лишнего
 * вопроса, пропуск — необратимого действия без спроса.
 */

export type ResponsibleKind = 'payment' | 'send' | 'publish' | 'delete' | 'permissions'

export interface ResponsibleVerdict {
  responsible: boolean
  kind?: ResponsibleKind
  /** Человеческая причина для модалки подтверждения и для журнала. */
  why?: string
}

interface Rule {
  kind: ResponsibleKind
  pattern: RegExp
  why: string
}

/**
 * Правила по КОМАНДАМ. Границы слов латиницей работают надёжно (команды пишутся
 * латиницей), поэтому здесь регулярки уместны — в отличие от порога §4.2, где
 * текст шага русский и `\b` по ASCII не срабатывает.
 */
const COMMAND_RULES: readonly Rule[] = [
  // Публикация и выкладка наружу
  { kind: 'publish', pattern: /\bgit\s+push\b/i, why: 'git push — изменения уезжают в общий репозиторий' },
  { kind: 'publish', pattern: /\bnpm\s+publish\b|\byarn\s+publish\b|\bpnpm\s+publish\b/i, why: 'публикация пакета в реестр' },
  { kind: 'publish', pattern: /\b(?:vercel|netlify|fly|heroku|gh)\s+(?:deploy|release)\b|\bdeploy\.(?:sh|ps1|cmd)\b/i, why: 'деплой наружу' },
  { kind: 'publish', pattern: /\bgh\s+release\s+(?:create|upload)\b/i, why: 'публикация релиза на GitHub' },
  // Отправка другому человеку / на чужой хост
  { kind: 'send', pattern: /\b(?:scp|rsync)\b[^\n]*\s\S+@\S+:/i, why: 'копирование на удалённый хост' },
  { kind: 'send', pattern: /\bssh\b\s+\S+@\S+/i, why: 'выполнение команды на чужой машине' },
  { kind: 'send', pattern: /\b(?:mail|sendmail|mailx|msmtp)\b/i, why: 'отправка почты' },
  { kind: 'send', pattern: /\bcurl\b[^\n]*\s-X\s*(?:POST|PUT|PATCH|DELETE)\b|\bcurl\b[^\n]*\s(?:-d|--data)\b/i, why: 'запрос, изменяющий внешнюю систему' },
  { kind: 'send', pattern: /\bInvoke-(?:RestMethod|WebRequest)\b[^\n]*-Method\s*(?:POST|PUT|PATCH|DELETE)\b/i, why: 'запрос, изменяющий внешнюю систему' },
  // Удаление данных
  { kind: 'delete', pattern: /\brm\b(?:\s+-\S+)*\s+\S/i, why: 'удаление файлов' },
  { kind: 'delete', pattern: /\b(?:del|erase|rmdir|rd)\b\s+\S/i, why: 'удаление файлов' },
  { kind: 'delete', pattern: /\bRemove-Item\b/i, why: 'удаление файлов' },
  { kind: 'delete', pattern: /\bgit\s+(?:clean\s+-\S*f|reset\s+--hard)\b/i, why: 'необратимая потеря локальных изменений' },
  { kind: 'delete', pattern: /\bDROP\s+(?:TABLE|DATABASE)\b|\bTRUNCATE\s+TABLE\b/i, why: 'удаление данных в БД' },
  // Права доступа
  { kind: 'permissions', pattern: /\b(?:chmod|chown|icacls|takeown|setfacl)\b/i, why: 'изменение прав доступа' },
  // Платёж
  { kind: 'payment', pattern: /\bstripe\b[^\n]*\b(?:charge|payment|payout)\b|\bpayout\b/i, why: 'операция с деньгами' },
]

/**
 * Коннекторы, чьё назначение — отправка или публикация. Для них ответственность
 * определяется САМИМ коннектором, а не текстом запроса: телеграм-бот существует,
 * чтобы писать людям.
 */
const RESPONSIBLE_CONNECTORS: Record<string, { kind: ResponsibleKind; why: string }> = {
  telegram: { kind: 'send', why: 'сообщение уйдёт человеку в Telegram' },
  'social-publish': { kind: 'publish', why: 'публикация в социальной сети' },
  sendpulse: { kind: 'send', why: 'рассылка подписчикам' },
  unisender: { kind: 'send', why: 'рассылка подписчикам' },
  bitrix24: { kind: 'send', why: 'изменение в CRM видно другим людям' },
  amocrm: { kind: 'send', why: 'изменение в CRM видно другим людям' },
  'yandex-disk': { kind: 'publish', why: 'файл станет доступен по ссылке' },
  yookassa: { kind: 'payment', why: 'операция с платежами' },
}

const asText = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * Ответственное ли это действие. Вызов идёт из `resolveDecision`, то есть на
 * каждый инструмент — цена одна регулярка по строке аргумента.
 */
export function classifyResponsibleAction(
  toolName: string,
  args: Record<string, unknown> | undefined,
): ResponsibleVerdict {
  if (toolName === 'run_command' || toolName === 'execute_code') {
    const command = asText(args?.command) || asText(args?.code)
    if (!command) return { responsible: false }
    for (const rule of COMMAND_RULES) {
      if (rule.pattern.test(command)) return { responsible: true, kind: rule.kind, why: rule.why }
    }
    return { responsible: false }
  }
  if (toolName === 'connector_query') {
    const id = asText(args?.connector) || asText(args?.id)
    const hit = RESPONSIBLE_CONNECTORS[id.toLowerCase()]
    return hit ? { responsible: true, kind: hit.kind, why: hit.why } : { responsible: false }
  }
  // Запись файла и патч ответственными НЕ считаются — см. шапку модуля.
  return { responsible: false }
}
