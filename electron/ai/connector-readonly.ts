/**
 * op-level read/write классификация коннекторов для UNATTENDED-прогонов (NL-cron).
 * connector_query — канал во внешние системы: часть op'ов читают (Ozon/WB/Метрика-данные),
 * часть ВЫПОЛНЯЮТ/ПИШУТ (ssh run_remote, telegram send, вебхуки). Без надзора (auto-accept)
 * пишущие op'ы опасны (ревью HIGH) → здесь разрешаем расписанному прогону ТОЛЬКО чтение.
 *
 * FAIL-SAFE: kind НЕ в карте → НЕ read-only (запрет). Урок MCP-ревью: не угадываем по
 * имени op, классифицируем явно. Новый коннектор/op по умолчанию запрещён до классификации.
 *
 * ВНИМАНИЕ: kind со значением true помечен «целиком read-only» по текущему набору op'ов
 * (наш код — чтение поверх официальных API, github-инвариант). Если в такой коннектор
 * добавят ПИШУЩИЙ op — обнови карту (перенеси в per-op), иначе unattended его пропустит.
 */

type ReadOnlyRule = true | ((args: Record<string, unknown>) => boolean)

const opStartsWith = (args: Record<string, unknown>, ...prefixes: string[]): boolean => {
  const op = String(args.op ?? '').toLowerCase()
  return prefixes.some(p => op === p || op.startsWith(p))
}

const POLICY: Record<string, ReadOnlyRule> = {
  // Целиком read-only: CRM/аналитика/маркетплейсы/реестры — только list/get/search/read.
  github: true, jira: true, trello: true, amocrm: true, moysklad: true, yookassa: true,
  'onec-odata': true, vk: true, notion: true,
  ozon: true, ozon_performance: true, wildberries: true, mpstats: true, avito: true,
  dadata: true, kontur_focus: true, ga4: true,
  yandex_direct: true, yandex_metrika: true, yandex_webmaster: true,
  yandex_wordstat: true, yandex_tracker: true,

  // Mixed — read только для конкретных op'ов:
  'http-rest': (a) => { const m = String(a.method ?? 'GET').toUpperCase(); return m === 'GET' || m === 'HEAD' },
  telegram: (a) => opStartsWith(a, 'get_'),                       // get_me/get_updates — read; send/edit/delete — write
  yandex_disk: (a) => opStartsWith(a, 'list'),                    // list_files — read; upload/unpublish/get_public_url — write/share
  bitrix24: (a) => opStartsWith(a, 'list_', 'get_'),             // list_deals/get_deal — read; call (произвольный метод) — запрет
  'social-publish': (a) => opStartsWith(a, 'list_'),             // list_channels — read; publish_text — write
  // gsheets — НЕ целиком read-only: append_row/append_rows/update_cell/update_row ПИШУТ
  // в таблицу (а Google Sheets = SSOT TASK_REGISTRY). Пускаем только чтение (ревью CRITICAL).
  gsheets: (a) => opStartsWith(a, 'read_', 'get_') || String(a.op ?? '').toLowerCase() === 'ping',

  // НЕ в карте (запрещены unattended): ssh (run_remote/run_python — выполнение),
  // sendpulse / unisender (email-отправители) — fail-safe запрет.
}

/** Безопасен ли connector_query для unattended-прогона (только чтение). */
export function isReadOnlyConnectorOp(kind: string, args: Record<string, unknown>): boolean {
  const rule = POLICY[kind]
  if (rule === true) return true
  if (typeof rule === 'function') return rule(args)
  return false // fail-safe: неизвестный/пишущий kind → запрет без надзора
}
