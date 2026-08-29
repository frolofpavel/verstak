/**
 * Каталог готовых MCP-серверов — данные, не инфраструктура (P8, 12.08).
 *
 * Каждая запись проверена по живому реестру (npm registry / PyPI / README
 * репозитория) 12.08.2026: пакет существует, не deprecated, имена env-переменных
 * взяты из документации сервера, а не придуманы. Если правишь запись — проверь
 * источник заново: каталог с выдуманной командой хуже пустого.
 *
 * Секретов здесь НЕТ и быть не может: каталог описывает ПОЛЯ для ключей
 * (key/label/hint), а значения человек вводит в UI, и они уезжают в env
 * конфигурации сервера (mcp_servers → settings secret → safeStorage).
 * В промпт модели env не попадает никогда (в tool defs уходят только
 * name/description/schema — см. runner-api.ts).
 */

export interface McpCatalogEnvField {
  /** Имя переменной окружения — точно как в документации сервера. */
  key: string
  /** Подпись поля для человека. */
  label: string
  /** Без этого поля сервер не заработает. */
  required: boolean
  /** Значение — секрет: поле ввода прячет символы. */
  secret: boolean
  /** Короткая подсказка: где взять значение. */
  hint?: string
}

export interface McpCatalogEntry {
  /** Стабильный слаг записи каталога. */
  id: string
  name: string
  /** Кто пишет и сопровождает сервер (не Verstak). */
  vendor: string
  description: string
  group: 'russian' | 'world'
  /** Рантайм-подсказка: npx → нужен Node.js, uvx → нужен Python + uv. */
  runtime: 'npx' | 'uvx'
  command: string
  args: string[]
  env: McpCatalogEnvField[]
  /** Подключается без ключа — можно пробовать сразу. */
  noKey: boolean
  /** Где взять ключ / документация сервера. */
  docsUrl?: string
}

export const MCP_CATALOG: McpCatalogEntry[] = [
  // ── Российские сервисы ────────────────────────────────────────────────────
  {
    id: 'moex',
    name: 'Московская Биржа (MOEX)',
    vendor: 'cyberash-dev',
    description: 'Котировки, история торгов, свечи, индексы, дивиденды, курсы валют через ISS API. 20 инструментов, только чтение.',
    group: 'russian',
    runtime: 'npx',
    command: 'npx',
    args: ['-y', 'moex-mcp'],
    env: [],
    noKey: true,
    docsUrl: 'https://github.com/cyberash-dev/moex-mcp'
  },
  {
    id: 'cbr',
    name: 'Центральный Банк РФ',
    vendor: 'theYahia',
    description: 'Курсы валют, ключевая ставка и её история, драгоценные металлы, конвертация. Без авторизации.',
    group: 'russian',
    runtime: 'npx',
    command: 'npx',
    args: ['-y', '@theyahia/cbr-mcp'],
    env: [],
    noKey: true,
    docsUrl: 'https://github.com/theYahia/cbr-mcp'
  },
  {
    id: 'hh',
    name: 'HeadHunter (hh.ru)',
    vendor: 'theYahia',
    description: 'Поиск вакансий, работодатели, зарплатная статистика, справочники. 19 инструментов; без ключа работает поиск, ключ добавляет резюме.',
    group: 'russian',
    runtime: 'npx',
    command: 'npx',
    args: ['-y', '@theyahia/hh-mcp'],
    env: [
      { key: 'HH_ACCESS_TOKEN', label: 'OAuth-токен hh.ru (необязательно)', required: false, secret: true, hint: 'dev.hh.ru/admin — нужен только для работы с резюме' }
    ],
    noKey: true,
    docsUrl: 'https://github.com/theYahia/hh-mcp'
  },
  {
    id: '2gis',
    name: '2ГИС',
    vendor: 'theYahia',
    description: 'Поиск организаций, геокодирование, маршруты, общественный транспорт, отзывы. Только чтение.',
    group: 'russian',
    runtime: 'npx',
    command: 'npx',
    args: ['-y', '@theyahia/2gis-mcp'],
    env: [
      { key: 'TWOGIS_API_KEY', label: 'API-ключ 2ГИС', required: true, secret: true, hint: 'dev.2gis.com — демо-ключ выдаётся бесплатно' }
    ],
    noKey: false,
    docsUrl: 'https://github.com/theYahia/2gis-mcp'
  },
  {
    id: 'kontur-focus',
    name: 'Контур.Фокус',
    vendor: 'theYahia',
    description: 'Проверка контрагентов: поиск компаний, реквизиты, финансы.',
    group: 'russian',
    runtime: 'npx',
    command: 'npx',
    args: ['-y', '@theyahia/kontur-focus-mcp'],
    env: [
      { key: 'KONTUR_FOCUS_API_KEY', label: 'API-ключ Контур.Фокус', required: true, secret: true, hint: 'focus.kontur.ru — ключ из личного кабинета' }
    ],
    noKey: false,
    docsUrl: 'https://github.com/theYahia/kontur-focus-mcp'
  },
  {
    id: 'vk',
    name: 'ВКонтакте',
    vendor: 'bulatko',
    description: 'API ВКонтакте: сообщества, стены, публикации. Что доступно — зависит от типа токена.',
    group: 'russian',
    runtime: 'npx',
    command: 'npx',
    args: ['-y', 'vk-mcp-server'],
    env: [
      { key: 'VK_ACCESS_TOKEN', label: 'VK access token', required: true, secret: true, hint: 'Токен сообщества: Управление → Работа с API → Ключи доступа' }
    ],
    noKey: false,
    docsUrl: 'https://github.com/bulatko/vk-mcp-server'
  },
  {
    id: 'amocrm',
    name: 'amoCRM',
    vendor: 'nourpups',
    description: 'Чтение сделок, контактов и воронок через REST API v4. Только чтение.',
    group: 'russian',
    runtime: 'npx',
    command: 'npx',
    args: ['-y', 'amocrm-mcp'],
    env: [
      { key: 'AMOCRM_SUBDOMAIN', label: 'Поддомен amoCRM', required: true, secret: false, hint: 'из адреса кабинета: <поддомен>.amocrm.ru' },
      { key: 'AMOCRM_ACCESS_TOKEN', label: 'Долгоживущий токен', required: true, secret: true, hint: 'Интеграции → Ключи и доступы → Сгенерировать долгосрочный токен' }
    ],
    noKey: false,
    docsUrl: 'https://github.com/nourpups/amo-mcp'
  },
  {
    id: 'avito',
    name: 'Авито',
    vendor: 'elchin92',
    description: 'API Авито: объявления, сообщения, статистика. Опасные действия сервер сам держит за подтверждением и dry-run.',
    group: 'russian',
    runtime: 'npx',
    command: 'npx',
    args: ['-y', 'avito-mcp'],
    env: [
      { key: 'Client_id', label: 'Client ID приложения Авито', required: true, secret: false, hint: 'кабинет разработчика Авито' },
      { key: 'Client_secret', label: 'Client secret', required: true, secret: true },
      { key: 'Profile_id', label: 'Номер профиля', required: true, secret: false, hint: 'числовой ID профиля Авито' }
    ],
    noKey: false,
    docsUrl: 'https://github.com/elchin92/avito-mcp'
  },
  {
    id: '1c-odata',
    name: '1С:Предприятие (OData)',
    vendor: 'evilbruce666',
    description: 'Вопросы к базе 1С на естественном языке через стандартный OData: должники, продажи, налоги. Чтение по умолчанию, запись — отдельным флагом на стороне сервера.',
    group: 'russian',
    runtime: 'npx',
    command: 'npx',
    args: ['-y', '1c-odata-mcp'],
    env: [
      { key: 'ODATA_BASE_URL', label: 'Адрес OData базы', required: true, secret: false, hint: 'https://<сервер>/<база>/odata/standard.odata/' },
      { key: 'ODATA_USERNAME', label: 'Пользователь 1С', required: true, secret: false },
      { key: 'ODATA_PASSWORD', label: 'Пароль', required: true, secret: true }
    ],
    noKey: false,
    docsUrl: 'https://github.com/evilbruce666/1c-odata-mcp'
  },
  {
    id: 'yandex-tracker',
    name: 'Яндекс Трекер',
    vendor: 'aikts',
    description: 'Задачи и очереди Яндекс Трекера. Нужен Python: сервер ставится через uvx.',
    group: 'russian',
    runtime: 'uvx',
    command: 'uvx',
    args: ['yandex-tracker-mcp@latest'],
    env: [
      { key: 'TRACKER_TOKEN', label: 'OAuth-токен Трекера', required: true, secret: true, hint: 'OAuth-токен API Яндекс Трекера' },
      { key: 'TRACKER_CLOUD_ORG_ID', label: 'ID организации Yandex Cloud', required: false, secret: false, hint: 'для облачных организаций; для Яндекс 360 задай TRACKER_ORG_ID' },
      { key: 'TRACKER_ORG_ID', label: 'ID организации Яндекс 360', required: false, secret: false }
    ],
    noKey: false,
    docsUrl: 'https://github.com/aikts/yandex-tracker-mcp'
  },
  // ── Рекламный и торговый стек (добавлено 29.08.2026) ──────────────────────
  // Имена env взяты НЕ из README и не из поиска, а из кода самих пакетов
  // (npm pack + grep process.env). Поиск при этом дважды предложил пакеты,
  // которых в реестре нет вовсе (@rezlazy/yandex-metrika-mcp, ru-marketplace-mcp)
  // — ровно поэтому здесь и стоит правило «проверять по живому реестру».
  {
    id: 'yandex-metrika',
    name: 'Яндекс Метрика',
    vendor: 'theYahia',
    description: 'Веб-аналитика: счётчики, цели, отчёты, выгрузка логов. 15 инструментов, ТОЛЬКО ЧТЕНИЕ.',
    group: 'russian',
    runtime: 'npx',
    command: 'npx',
    args: ['-y', '@theyahia/yandex-metrika-mcp'],
    env: [
      { key: 'YANDEX_METRIKA_TOKEN', label: 'OAuth-токен Метрики', required: true, secret: true, hint: 'oauth.yandex.ru → приложение с доступом «Яндекс.Метрика: чтение статистики»' }
    ],
    noKey: false,
    docsUrl: 'https://github.com/theYahia/yandex-metrika-mcp'
  },
  {
    id: 'yandex-direct',
    name: 'Яндекс Директ',
    vendor: 'theYahia',
    description: 'Рекламные кампании: группы, объявления, ключевые фразы, ставки. 20 инструментов. ВНИМАНИЕ: сервер умеет НЕ ТОЛЬКО читать — он создаёт и меняет кампании и ставки, то есть влияет на расход. Для знакомства включите песочницу.',
    group: 'russian',
    runtime: 'npx',
    command: 'npx',
    args: ['-y', '@theyahia/yandex-direct-mcp'],
    env: [
      { key: 'YANDEX_DIRECT_TOKEN', label: 'OAuth-токен Директа', required: true, secret: true, hint: 'OAuth-приложение с доступом к API Директа + заявка на доступ в интерфейсе Директа' },
      { key: 'YANDEX_DIRECT_SANDBOX', label: 'Песочница (1 — да)', required: false, secret: false, hint: 'поставьте 1, чтобы работать на тестовом сервере и не тратить деньги' },
      { key: 'YANDEX_DIRECT_LOGIN', label: 'Логин клиента', required: false, secret: false, hint: 'нужен только для агентских токенов' }
    ],
    noKey: false,
    docsUrl: 'https://github.com/theYahia/yandex-direct-mcp'
  },
  {
    id: 'bitrix24',
    name: 'Битрикс24',
    vendor: 'theYahia',
    description: 'CRM: сделки, контакты, задачи через входящий вебхук.',
    group: 'russian',
    runtime: 'npx',
    command: 'npx',
    args: ['-y', '@theyahia/bitrix24-mcp'],
    env: [
      { key: 'BITRIX24_WEBHOOK_URL', label: 'URL входящего вебхука', required: true, secret: true, hint: 'Битрикс24 → Разработчикам → Другое → Входящий вебхук' }
    ],
    noKey: false,
    docsUrl: 'https://www.npmjs.com/package/@theyahia/bitrix24-mcp'
  },
  {
    id: 'wildberries',
    name: 'Wildberries',
    vendor: 'theYahia',
    description: 'Кабинет продавца: товары, заказы, продажи, остатки, цены.',
    group: 'russian',
    runtime: 'npx',
    command: 'npx',
    args: ['-y', '@theyahia/wildberries-mcp'],
    env: [
      { key: 'WB_API_TOKEN', label: 'Токен API продавца', required: true, secret: true, hint: 'Личный кабинет WB → Настройки → Доступ к API' },
      { key: 'WB_TIMEOUT_MS', label: 'Таймаут запроса, мс', required: false, secret: false }
    ],
    noKey: false,
    docsUrl: 'https://www.npmjs.com/package/@theyahia/wildberries-mcp'
  },
  {
    id: 'dadata',
    name: 'DaData',
    vendor: 'theYahia',
    description: 'Проверка и подсказки: организации по ИНН, адреса, банки, ФИО.',
    group: 'russian',
    runtime: 'npx',
    command: 'npx',
    args: ['-y', '@theyahia/dadata-mcp'],
    env: [
      { key: 'DADATA_API_KEY', label: 'API-ключ', required: true, secret: true, hint: 'dadata.ru → личный кабинет → API-ключи' },
      { key: 'DADATA_SECRET_KEY', label: 'Секретный ключ', required: false, secret: true, hint: 'нужен только для методов очистки данных' }
    ],
    noKey: false,
    docsUrl: 'https://www.npmjs.com/package/@theyahia/dadata-mcp'
  },
  // ── Мировые ───────────────────────────────────────────────────────────────
  {
    id: 'playwright',
    name: 'Браузер (Playwright)',
    vendor: 'Microsoft',
    description: 'Открытие страниц, клики, формы, скриншоты — управление настоящим браузером.',
    group: 'world',
    runtime: 'npx',
    command: 'npx',
    args: ['-y', '@playwright/mcp'],
    env: [],
    noKey: true,
    docsUrl: 'https://github.com/microsoft/playwright-mcp'
  },
  {
    id: 'fetch',
    name: 'Чтение веб-страниц (Fetch)',
    vendor: 'Model Context Protocol',
    description: 'Скачивает страницу и отдаёт её текст модели. Нужен Python: сервер ставится через uvx.',
    group: 'world',
    runtime: 'uvx',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    env: [],
    noKey: true,
    docsUrl: 'https://github.com/modelcontextprotocol/servers'
  },
  {
    id: 'notion',
    name: 'Notion',
    vendor: 'Notion (официальный)',
    description: 'Страницы и базы Notion: чтение, поиск, создание.',
    group: 'world',
    runtime: 'npx',
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server'],
    env: [
      { key: 'NOTION_TOKEN', label: 'Токен интеграции Notion', required: true, secret: true, hint: 'notion.so/profile/integrations — internal integration token (ntn_…)' }
    ],
    noKey: false,
    docsUrl: 'https://github.com/makenotion/notion-mcp-server'
  },
  {
    id: 'context7',
    name: 'Документация библиотек (Context7)',
    vendor: 'Upstash',
    description: 'Свежая документация и примеры кода по библиотекам и фреймворкам — прямо в контекст модели.',
    group: 'world',
    runtime: 'npx',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
    env: [],
    noKey: true,
    docsUrl: 'https://github.com/upstash/context7'
  },
  {
    id: 'memory',
    name: 'Память агента (Memory)',
    vendor: 'Model Context Protocol',
    description: 'Простой граф знаний: агент запоминает факты между разговорами.',
    group: 'world',
    runtime: 'npx',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    env: [],
    noKey: true,
    docsUrl: 'https://github.com/modelcontextprotocol/servers'
  }
]
