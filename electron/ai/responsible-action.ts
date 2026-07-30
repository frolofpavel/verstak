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

import { canonicalConnectorId } from './connector-id'
import { deobfuscateShellWord } from './dangerous-commands'

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
/** Глобальные флаги git между `git` и субкомандой: `-C <path>`, `--git-dir=…`,
 *  `-c k=v`, `--work-tree=…`. Без них `git -C ../repo push` не узнавался. */
const GIT_GLOBAL_FLAGS = String.raw`(?:\s+(?:-C\s+\S+|-c\s+\S+|--git-dir=\S+|--work-tree=\S+|--namespace=\S+|--exec-path=\S+|-p|--paginate|--no-pager)){0,4}`

const COMMAND_RULES: readonly Rule[] = [
  // Публикация и выкладка наружу
  { kind: 'publish', pattern: new RegExp(String.raw`\bgit${GIT_GLOBAL_FLAGS}\s+(?:subtree\s+)?push\b`, 'i'), why: 'git push — изменения уезжают в общий репозиторий' },
  { kind: 'publish', pattern: /\b(?:npm|yarn|pnpm)\s+publish\b/i, why: 'публикация пакета в реестр' },
  { kind: 'publish', pattern: /\b(?:vercel|netlify|fly|flyctl|heroku|gh|wrangler|firebase|surge|now)\s+(?:deploy|release)\b|\bdeploy\.(?:sh|ps1|cmd|bat)\b/i, why: 'деплой наружу' },
  { kind: 'publish', pattern: /\bgh\s+release\s+(?:create|upload)\b/i, why: 'публикация релиза на GitHub' },
  // Скриптовая выкатка: `npm run deploy` и товарищи. Самый частый способ выкатки
  // в JS-проектах, и до 30.07 он не ловился вовсе, хотя `npm publish` ловился —
  // совпадение было чисто лексическим.
  { kind: 'publish', pattern: /\b(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?(?:deploy|release|publish|ship)\b/i, why: 'скрипт выкатки наружу' },
  { kind: 'publish', pattern: /\bmake\s+(?:deploy|release|publish)\b/i, why: 'скрипт выкатки наружу' },
  { kind: 'publish', pattern: /\bnpx\s+semantic-release\b/i, why: 'автоматическая публикация релиза' },
  // Образы, кластеры, облачные хранилища
  { kind: 'publish', pattern: /\bdocker(?:\s+compose)?\s+push\b/i, why: 'образ уезжает в реестр' },
  { kind: 'publish', pattern: /\bhelm\s+(?:upgrade|install)\b/i, why: 'выкатка в кластер' },
  { kind: 'publish', pattern: /\bkubectl\s+(?:apply|create|delete|replace|patch|rollout)\b/i, why: 'изменение состояния кластера' },
  { kind: 'publish', pattern: /\baws\s+s3\s+(?:cp|sync|mv|rm)\b/i, why: 'запись в облачное хранилище' },
  { kind: 'publish', pattern: /\bterraform\s+(?:apply|destroy)\b/i, why: 'изменение инфраструктуры' },
  // GitHub CLI: создание видимых другим сущностей
  { kind: 'publish', pattern: /\bgh\s+(?:pr|repo|gist|issue)\s+(?:create|merge)\b/i, why: 'создание видимой другим сущности на GitHub' },
  { kind: 'publish', pattern: /\bgh\s+workflow\s+run\b/i, why: 'запуск чужого workflow' },
  // Отправка другому человеку / на чужой хост
  { kind: 'send', pattern: /\b(?:scp|rsync)\b[^\n]*\s\S+@\S+:/i, why: 'копирование на удалённый хост' },
  // …и та же отправка по АЛИАСУ хоста из ~/.ssh/config, где `user@` нет вовсе.
  // Требуем двоеточие после имени — иначе `rsync -av a b` (локальная копия)
  // ложно считалась бы отправкой.
  { kind: 'send', pattern: /\b(?:scp|rsync)\b[^\n]*\s[\w.-]+:(?:\/|~|\s|$)/i, why: 'копирование на удалённый хост' },
  { kind: 'send', pattern: /\bssh\b\s+\S+@\S+/i, why: 'выполнение команды на чужой машине' },
  // ssh по алиасу: `ssh prod <команда>`. Опции с аргументом пропускаем, флаги
  // справки/версии — нет, иначе `ssh --help` стал бы вопросом.
  { kind: 'send', pattern: /\bssh\s+(?:-\w+\s+\S+\s+)*(?!-)[\w.-]+\s+\S/i, why: 'выполнение команды на чужой машине' },
  { kind: 'send', pattern: /\b(?:mail|sendmail|mailx|msmtp)\b/i, why: 'отправка почты' },
  { kind: 'send', pattern: /\bcurl\b[^\n]*\s-X\s*(?:POST|PUT|PATCH|DELETE)\b|\bcurl\b[^\n]*\s(?:-d|--data)\b/i, why: 'запрос, изменяющий внешнюю систему' },
  // Выгрузка файла наружу мимо -X/-d: -T, --upload-file, -F (multipart),
  // --data-binary. Ровно так утекает дамп или .env.
  { kind: 'send', pattern: /\bcurl\b[^\n]*\s(?:-T|--upload-file|-F|--form|--data-binary|--data-raw|--data-urlencode)\b/i, why: 'выгрузка данных наружу' },
  { kind: 'send', pattern: /\bwget\b[^\n]*\s--(?:post-data|post-file|body-data|body-file)\b/i, why: 'запрос, изменяющий внешнюю систему' },
  { kind: 'send', pattern: /\bInvoke-(?:RestMethod|WebRequest)\b[^\n]*-Method\s*(?:POST|PUT|PATCH|DELETE)\b/i, why: 'запрос, изменяющий внешнюю систему' },
  // Удаление данных
  { kind: 'delete', pattern: /\brm\b(?:\s+-\S+)*\s+\S/i, why: 'удаление файлов' },
  { kind: 'delete', pattern: /\b(?:del|erase|rmdir|rd)\b\s+\S/i, why: 'удаление файлов' },
  { kind: 'delete', pattern: /\bRemove-Item\b/i, why: 'удаление файлов' },
  // `git clean`: флаг силы может быть объединён (`-fd`, `-xfd`) или длинным
  // (`--force`). Прежняя форма `-\S*f\b` требовала границы слова сразу за `f` и
  // потому промахивалась мимо `-fd` — измерено.
  { kind: 'delete', pattern: /\bgit\s+clean\b[^\n]*(?:\s-\w*f|\s--force)/i, why: 'необратимая потеря локальных изменений' },
  { kind: 'delete', pattern: /\bgit\s+reset\s+--hard\b/i, why: 'необратимая потеря локальных изменений' },
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
  // ВНИМАНИЕ: ключи — РЕАЛЬНЫЕ id из реестра коннекторов, не человеческие имена.
  // `yandex_disk` здесь стоял через дефис и не совпадал ни с чем: правило было
  // мёртвым, публикация файла по ссылке паузы не давала (аудит 30.07).
  yandex_disk: { kind: 'publish', why: 'файл станет доступен по ссылке' },
  yookassa: { kind: 'payment', why: 'операция с платежами' },
}

/**
 * Коннекторы, у которых ответственность задаёт ОПЕРАЦИЯ, а не сам коннектор.
 *
 * Таблица выше верна для телеграма: бот существует, чтобы писать людям. Но
 * `ssh`, `http` и `gsheets` — универсальные: чтение через них рутина, а
 * `run_remote`, `POST`/`DELETE` и `append_row` — тот же акт, что пойманные
 * `ssh user@host` и `curl -X POST`, только другим каналом. Предпосылка
 * «ответственность определяется коннектором» для них неверна, и до 30.07 они не
 * спрашивали вовсе.
 */
const RESPONSIBLE_CONNECTOR_OPS: Record<string, (args: Record<string, unknown>) => { kind: ResponsibleKind; why: string } | null> = {
  ssh: (a) => /^(?:run_remote|run_python_script|exec|run)$/i.test(asText(a.op))
    ? { kind: 'send', why: 'команда выполнится на чужой машине' }
    : null,
  http: (a) => /^(?:POST|PUT|PATCH|DELETE)$/i.test(asText(a.method))
    ? { kind: 'send', why: 'запрос изменит внешнюю систему' }
    : null,
  gsheets: (a) => /^(?:append_row|update_cell|write|clear|delete_row)$/i.test(asText(a.op))
    ? { kind: 'send', why: 'запись в чужую таблицу' }
    : null,
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
    // ДВЕ КОПИИ, КАК У ДЕНИЛИСТА-БЛИЗНЕЦА (SEC-CMD-09). Раньше здесь матчилась
    // только СЫРАЯ строка, тогда как `detectDangerousCommand` матчит ещё и
    // деобфусцированную. Подход переняли, несущую предпосылку — нормализацию —
    // нет, и `"git" push` с `g^it push` проходили мимо паузы, хотя shell
    // исполняет их как обычный `git push`. Нормализация переиспользуется, а не
    // копируется: иначе каждый новый паттерн пришлось бы писать в двух формах.
    const deobfuscated = deobfuscateShellWord(command)
    for (const rule of COMMAND_RULES) {
      if (rule.pattern.test(command)) return { responsible: true, kind: rule.kind, why: rule.why }
      if (deobfuscated !== command && rule.pattern.test(deobfuscated)) {
        return { responsible: true, kind: rule.kind, why: rule.why }
      }
    }
    return { responsible: false }
  }
  if (toolName === 'connector_query') {
    // Имя берём ровно там же, где его возьмёт исполнитель (SEC-CMD-05): иначе
    // вердикт выносится про один коннектор, а запрос уходит в другой.
    const id = canonicalConnectorId(args)
    // Сначала универсальные коннекторы, где решает операция (SEC-CMD-09).
    const byOp = RESPONSIBLE_CONNECTOR_OPS[id]?.(args ?? {})
    if (byOp) return { responsible: true, kind: byOp.kind, why: byOp.why }
    const hit = RESPONSIBLE_CONNECTORS[id]
    return hit ? { responsible: true, kind: hit.kind, why: hit.why } : { responsible: false }
  }
  // Запись файла и патч ответственными НЕ считаются — см. шапку модуля.
  return { responsible: false }
}
