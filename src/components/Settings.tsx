import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import type { DetectedCli, PolicyMatrixDTO, PolicyDecision, ProviderCatalogStatusDTO } from '../types/api'
import type { ProviderId } from '../hooks/useProvider'
import {
  MOTION_LEVEL_OPTIONS,
  PROJECT_STATUS_DISPLAY_OPTIONS,
  UI_DENSITY_OPTIONS,
  useAppearance
} from '../hooks/useAppearance'
import { useTheme, THEMES } from '../hooks/useTheme'
import { useUiScale, UI_SCALE_PRESETS, MIN_UI_SCALE_PERCENT, MAX_UI_SCALE_PERCENT } from '../hooks/useUiScale'
import {
  NOTIFY_CHANNEL_OPTIONS,
  NOTIFY_EVENT_OPTIONS,
  NOTIFY_MODE_OPTIONS,
  useNotifySettings
} from '../hooks/useNotifySettings'
import { UpdatesSettings } from './UpdatesSettings'
import { SubscriptionsTab } from './settings/SubscriptionsTab'
import { UsageTab } from './settings/UsageTab'
import { SubscriptionAccountsPanel } from './SubscriptionAccountsPanel'
import { ProfilesTab } from './ProfilesTab'
import {
  buildCatalog,
  connectionStatus,
  isProviderAuthorized,
  modelSearchText,
  providerAuthLink,
  resolveModelAvailability,
  type CatalogProvider,
  type CatalogSource,
  type CliAuthId,
  type CliAuthStatus,
  type ConnectionStatus
} from '../lib/model-catalog'
import { useProviderCatalog } from '../hooks/useProviderCatalog'
import { modeControlInfo } from '../lib/runtime-capability'
import {
  IconClaude, Icon1C, IconGoogleSheets, IconTelegram,
  IconSSH, IconBitrix, IconYandexDirect, IconYandexDisk,
  IconSkillsServer, IconHTTP, IconGitHub, IconSocialPublish,
  IconDaData, IconYandexMetrika, IconAvito, IconYandexWebmaster,
  IconYandexWordstat, IconOzon, IconWildberries, IconYooKassa,
  IconVK, IconAmoCrm, IconMoySklad, IconYandexTracker,
  IconSendPulse, IconUniSender, IconGA4, IconNotion,
  IconKonturFocus, IconMpstats, IconOzonPerformance, IconJira, IconTrello
} from './ConnectorIcons'
import { useT } from '../i18n'
import { classifyTool, classifyServer, type McpScope, type McpRisk } from '../lib/mcp-risk'
import { modeModelsKey, parseModeModels, serializeModeModels } from '../lib/mode-model'
import type { AgentMode } from './ModePicker'

/** Провайдер каталога Settings = единый контракт (src/lib/model-catalog CatalogProvider).
 *  Раньше здесь жил хардкод-массив PROVIDERS (~270 строк — второе зеркало реестра с копией
 *  models[], источник дрейфа «UI предлагает модель, которой рантайм не знает»). Убран в срезе
 *  2.0.7-D: каталог грузится из providers:list (useProviderCatalog) — функциональные поля из
 *  main-реестра, презентация из PROVIDER_UI_META. */
type ProviderConfig = CatalogProvider

type Tab = 'appearance' | 'notifications' | 'updates' | 'profiles' | 'providers' | 'models' | 'modelModes' | 'connectors' | 'mcp' | 'policy' | 'subscriptions' | 'usage'
type SettingsNavIconName = 'appearance' | 'notifications' | 'updates' | 'profiles' | 'providers' | 'models' | 'modelModes' | 'connectors' | 'mcp' | 'policy' | 'subscriptions' | 'usage'
type SettingsNavTab = { id: Tab; label: string; icon: SettingsNavIconName; soon?: boolean; disabled?: boolean; keywords?: string }
type SettingsNavGroup = { title: string; tabs: ReadonlyArray<SettingsNavTab> }

function SettingsNavIcon({ name }: { name: SettingsNavIconName }) {
  const svgProps = {
    className: 'gg-settings-nav-svg',
    viewBox: '0 0 24 24',
    fill: 'none',
    xmlns: 'http://www.w3.org/2000/svg'
  }
  const strokeProps = {
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const
  }

  switch (name) {
    case 'appearance':
      return (
        <svg {...svgProps}>
          <rect x="4" y="5" width="16" height="13" rx="3.2" {...strokeProps} />
          <path d="M8 9h5.2M8 12h3.6" {...strokeProps} />
          <circle cx="17" cy="9" r="1.7" {...strokeProps} />
        </svg>
      )
    case 'notifications':
      return (
        <svg {...svgProps}>
          <path d="M7.3 10.4c0-3 1.9-5.1 4.7-5.1s4.7 2.1 4.7 5.1v2.7l1.4 2.2H5.9l1.4-2.2v-2.7Z" {...strokeProps} />
          <path d="M10.2 17.2c.35.95 1 1.45 1.8 1.45s1.45-.5 1.8-1.45" {...strokeProps} />
        </svg>
      )
    case 'updates':
      return (
        <svg {...svgProps}>
          <path d="M7.1 8.2A6.1 6.1 0 0 1 17.8 8l.75 1.15" {...strokeProps} />
          <path d="M18.7 5.9v3.35h-3.35" {...strokeProps} />
          <path d="M16.9 15.8A6.1 6.1 0 0 1 6.2 16l-.75-1.15" {...strokeProps} />
          <path d="M5.3 18.1v-3.35h3.35" {...strokeProps} />
        </svg>
      )
    case 'profiles':
      return (
        <svg {...svgProps}>
          <circle cx="12" cy="8.2" r="3.1" {...strokeProps} />
          <path d="M6.4 18.1c.8-3 2.7-4.45 5.6-4.45s4.8 1.45 5.6 4.45" {...strokeProps} />
        </svg>
      )
    case 'providers':
      return (
        <svg {...svgProps}>
          <path d="M9.1 7.1v4.1c0 2 1.45 3.5 3.35 3.5h.3c1.9 0 3.35-1.5 3.35-3.5V7.1" {...strokeProps} />
          <path d="M10.7 4.9v3M14.5 4.9v3M12.6 14.7v4.4" {...strokeProps} />
          <path d="M9.1 10.1h7" {...strokeProps} />
        </svg>
      )
    case 'models':
      return (
        <svg {...svgProps}>
          <rect x="6" y="6" width="12" height="12" rx="2.7" {...strokeProps} />
          <rect x="9.2" y="9.2" width="5.6" height="5.6" rx="1.3" {...strokeProps} />
          <path d="M9 3.8v2.2M12 3.8v2.2M15 3.8v2.2M9 18v2.2M12 18v2.2M15 18v2.2M3.8 9H6M3.8 12H6M3.8 15H6M18 9h2.2M18 12h2.2M18 15h2.2" {...strokeProps} />
        </svg>
      )
    case 'modelModes':
      return (
        <svg {...svgProps}>
          <rect x="5" y="5.4" width="14" height="13.2" rx="3" {...strokeProps} />
          <path d="M8.2 9h7.6M8.2 12h7.6M8.2 15h7.6" {...strokeProps} />
          <circle cx="10" cy="9" r="1.25" className="gg-settings-nav-fill" />
          <circle cx="14" cy="12" r="1.25" className="gg-settings-nav-fill" />
          <circle cx="11.7" cy="15" r="1.25" className="gg-settings-nav-fill" />
        </svg>
      )
    case 'connectors':
      return (
        <svg {...svgProps}>
          <circle cx="7" cy="8" r="2.5" {...strokeProps} />
          <circle cx="17" cy="7" r="2.5" {...strokeProps} />
          <circle cx="14.5" cy="17" r="2.5" {...strokeProps} />
          <path d="M9.4 7.75h5.2M15.9 9.2l-1.05 5.35M8.8 9.85l3.9 5.1" {...strokeProps} />
        </svg>
      )
    case 'mcp':
      return (
        <svg {...svgProps}>
          <rect x="4.5" y="5.3" width="15" height="13.4" rx="3" {...strokeProps} />
          <path d="M8.3 9.2l2.25 2.05-2.25 2.05M12.1 14.2h3.9" {...strokeProps} />
        </svg>
      )
    case 'policy':
      return (
        <svg {...svgProps}>
          <path d="M12 4.6 17.8 7v4.7c0 3.6-2.15 6-5.8 7.7-3.65-1.7-5.8-4.1-5.8-7.7V7L12 4.6Z" {...strokeProps} />
          <path d="m9.4 12.1 1.7 1.7 3.6-3.75" {...strokeProps} />
        </svg>
      )
    // 2.0.8: «Подписки» — карточка аккаунта; «Расход» — столбики отчёта.
    case 'subscriptions':
      return (
        <svg {...svgProps}>
          <rect x="3.5" y="6" width="17" height="12" rx="2.2" {...strokeProps} />
          <path d="M3.5 10h17" {...strokeProps} />
          <path d="M7 14h3.5" {...strokeProps} />
        </svg>
      )
    case 'usage':
      return (
        <svg {...svgProps}>
          <path d="M4 19.2h16" {...strokeProps} />
          <path d="M7.4 19.2v-5.4" {...strokeProps} />
          <path d="M12 19.2V7.6" {...strokeProps} />
          <path d="M16.6 19.2v-8.3" {...strokeProps} />
        </svg>
      )
    default:
      return null
  }
}

function ProviderSettingsToggleIcon({ open }: { open: boolean }) {
  const svgProps = {
    className: 'gg-provider-settings-svg',
    viewBox: '0 0 24 24',
    fill: 'none',
    xmlns: 'http://www.w3.org/2000/svg'
  }
  const strokeProps = {
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const
  }

  if (open) {
    return (
      <svg {...svgProps}>
        <rect x="5.2" y="10.1" width="13.6" height="3.8" rx="1.9" className="gg-provider-settings-icon-fill" />
        <path d="M8.2 12h7.6" {...strokeProps} />
      </svg>
    )
  }

  return (
    <svg {...svgProps}>
      <path
        className="gg-provider-settings-icon-fill"
        d="M9.7 4.4h4.6l.45 2.1c.45.17.88.42 1.27.73l2.05-.65 2.3 4-1.6 1.43c.04.49.04.98 0 1.47l1.6 1.43-2.3 4-2.05-.65c-.39.31-.82.56-1.27.73l-.45 2.1H9.7l-.45-2.1a6.9 6.9 0 0 1-1.27-.73l-2.05.65-2.3-4 1.6-1.43a8.7 8.7 0 0 1 0-1.47l-1.6-1.43 2.3-4 2.05.65c.39-.31.82-.56 1.27-.73l.45-2.1Z"
      />
      <path d="M9.8 5h4.4l.4 1.85c.5.17.98.45 1.4.8l1.82-.58 2.18 3.78-1.43 1.28a6.5 6.5 0 0 1 0 1.74L20 15.15l-2.18 3.78-1.82-.58c-.42.35-.9.63-1.4.8L14.2 21H9.8l-.4-1.85a6.1 6.1 0 0 1-1.4-.8l-1.82.58L4 15.15l1.43-1.28a6.5 6.5 0 0 1 0-1.74L4 10.85l2.18-3.78 1.82.58c.42-.35.9-.63 1.4-.8L9.8 5Z" {...strokeProps} />
      <circle cx="12" cy="13" r="2.45" {...strokeProps} />
    </svg>
  )
}

function modelKey(providerId: ProviderId, model: string): string {
  return `${providerId}::${model}`
}
/** По умолчанию включена только модель активного провайдера (как при первом входе). */
function defaultEnabledModels(providers: ProviderConfig[], providerId: ProviderId, modelVals: Record<string, string>): Set<string> {
  const p = providers.find(x => x.id === providerId)
  if (!p || p.models.length === 0) return new Set()
  const model = modelVals[providerId] ?? p.defaultModel
  return new Set([modelKey(providerId, model)])
}

interface ConnectorDef {
  id: string
  name: string
  description: string
  icon: React.FC<{ size?: number }>
  configuredKey: string  // settings key to check — if non-empty, connector is "connected"
}

const CONNECTORS: ConnectorDef[] = [
  { id: 'claude-oauth', name: 'Claude Code', description: 'OAuth token для Max подписки', icon: IconClaude, configuredKey: 'claude_code_oauth_token' },
  { id: 'onec', name: '1С OData', description: 'ERP-система, справочники, документы', icon: Icon1C, configuredKey: 'onec_base_url' },
  { id: 'http', name: 'HTTP API', description: 'Произвольные REST endpoints', icon: IconHTTP, configuredKey: '' },
  { id: 'gsheets', name: 'Google Sheets', description: 'Таблицы, данные, отчёты', icon: IconGoogleSheets, configuredKey: 'gsheets_service_account_json' },
  { id: 'telegram', name: 'Telegram', description: 'Бот для уведомлений и команд', icon: IconTelegram, configuredKey: 'telegram_bot_token' },
  { id: 'ssh', name: 'SSH', description: 'Удалённое выполнение команд', icon: IconSSH, configuredKey: 'ssh_default_host' },
  { id: 'bitrix', name: 'Битрикс24', description: 'CRM, сделки, задачи', icon: IconBitrix, configuredKey: 'bitrix24_webhook_url' },
  { id: 'ydirect', name: 'Яндекс.Директ', description: 'Рекламные кампании и отчёты', icon: IconYandexDirect, configuredKey: 'yandex_direct_token' },
  { id: 'ydisk', name: 'Яндекс.Диск', description: 'Файлы и шеринг артефактов', icon: IconYandexDisk, configuredKey: 'yandex_disk_token' },
  { id: 'skills-server', name: 'Сервер скиллов', description: 'Удалённые AI-скиллы', icon: IconSkillsServer, configuredKey: 'skills_server_base' },
  { id: 'github', name: 'GitHub', description: 'Репозитории, issues, PR, code search', icon: IconGitHub, configuredKey: 'github_token' },
  { id: 'social-publish', name: 'Social Publish', description: 'Постинг в Telegram, VK, webhooks', icon: IconSocialPublish, configuredKey: 'social_publish_telegram_channels' },
  { id: 'dadata', name: 'DaData', description: 'Контрагенты по ИНН, адреса, банки', icon: IconDaData, configuredKey: 'dadata_api_key' },
  { id: 'ymetrika', name: 'Яндекс.Метрика', description: 'Веб-аналитика: трафик, источники, цели', icon: IconYandexMetrika, configuredKey: 'yandex_metrika_token' },
  { id: 'avito', name: 'Avito', description: 'Объявления, статистика, баланс', icon: IconAvito, configuredKey: 'avito_client_id' },
  { id: 'ywebmaster', name: 'Яндекс.Вебмастер', description: 'SEO: ИКС, проблемы, запросы', icon: IconYandexWebmaster, configuredKey: 'yandex_webmaster_token' },
  { id: 'ywordstat', name: 'Яндекс.Wordstat', description: 'Частотность ключевых слов', icon: IconYandexWordstat, configuredKey: 'yandex_wordstat_token' },
  { id: 'ozon', name: 'Ozon Seller', description: 'Товары, остатки, аналитика, финансы', icon: IconOzon, configuredKey: 'ozon_client_id' },
  { id: 'wildberries', name: 'Wildberries', description: 'Продажи, заказы, остатки', icon: IconWildberries, configuredKey: 'wildberries_token' },
  { id: 'yookassa', name: 'ЮКасса', description: 'Платежи и возвраты (чтение)', icon: IconYooKassa, configuredKey: 'yookassa_shop_id' },
  { id: 'vk', name: 'VK', description: 'Сообщества, стена, пользователи', icon: IconVK, configuredKey: 'vk_access_token' },
  { id: 'amocrm', name: 'amoCRM', description: 'Сделки, контакты, воронки', icon: IconAmoCrm, configuredKey: 'amocrm_subdomain' },
  { id: 'moysklad', name: 'МойСклад', description: 'Товары, заказы, остатки', icon: IconMoySklad, configuredKey: 'moysklad_token' },
  { id: 'yandex_tracker', name: 'Яндекс.Трекер', description: 'Задачи, очереди', icon: IconYandexTracker, configuredKey: 'yandex_tracker_token' },
  { id: 'sendpulse', name: 'SendPulse', description: 'Email/SMS-рассылки', icon: IconSendPulse, configuredKey: 'sendpulse_client_id' },
  { id: 'unisender', name: 'UniSender', description: 'Email/SMS-рассылки', icon: IconUniSender, configuredKey: 'unisender_api_key' },
  { id: 'ga4', name: 'Google Analytics 4', description: 'Веб-аналитика', icon: IconGA4, configuredKey: 'ga4_access_token' },
  { id: 'notion', name: 'Notion', description: 'Базы, страницы, поиск', icon: IconNotion, configuredKey: 'notion_token' },
  { id: 'kontur_focus', name: 'Контур.Фокус', description: 'Контрагенты, риск-аналитика', icon: IconKonturFocus, configuredKey: 'kontur_focus_api_key' },
  { id: 'mpstats', name: 'MPSTATS', description: 'Аналитика маркетплейсов', icon: IconMpstats, configuredKey: 'mpstats_token' },
  { id: 'ozon_performance', name: 'Ozon Performance', description: 'Реклама Ozon', icon: IconOzonPerformance, configuredKey: 'ozon_perf_client_id' },
  { id: 'jira', name: 'Jira', description: 'Задачи, проекты, JQL', icon: IconJira, configuredKey: 'jira_base_url' },
  { id: 'trello', name: 'Trello', description: 'Доски, списки, карточки', icon: IconTrello, configuredKey: 'trello_api_key' },
]

// ─── MCP Tab ─────────────────────────────────────────────────────────────────

type ConnectorCategory = 'ads' | 'analytics' | 'crm' | 'data' | 'dev' | 'marketplace' | 'notify' | 'payments' | 'tasks'
type ConnectorFilter = ConnectorCategory | 'all' | 'configured' | 'errors'
type ConnectorSafetyMode = 'read' | 'confirm' | 'write'

const CONNECTOR_FILTERS: Array<{ id: ConnectorFilter; label: string }> = [
  { id: 'all', label: 'Все' },
  { id: 'configured', label: 'Подключённые' },
  { id: 'errors', label: 'С ошибкой' },
  { id: 'ads', label: 'Реклама' },
  { id: 'analytics', label: 'Аналитика' },
  { id: 'crm', label: 'CRM' },
  { id: 'data', label: 'Данные' },
  { id: 'marketplace', label: 'Маркетплейсы' },
  { id: 'notify', label: 'Уведомления' },
  { id: 'dev', label: 'Разработка' },
  { id: 'tasks', label: 'Задачи' },
  { id: 'payments', label: 'Оплата' }
]

const CONNECTOR_META: Record<string, {
  category: ConnectorCategory
  label: string
  capabilities: string[]
  search: string
}> = {
  'claude-oauth': { category: 'dev', label: 'Внешний агент', capabilities: ['Запуск Claude Code', 'OAuth-токен', 'Работа через CLI'], search: 'claude code oauth max подписка cli внешний агент' },
  onec: { category: 'data', label: 'Учёт', capabilities: ['Справочники', 'Документы', 'OData'], search: '1с odata erp учет склад документы справочники' },
  http: { category: 'dev', label: 'Универсальный API', capabilities: ['REST-запросы', 'Авторизация', 'Ограничение путей'], search: 'http api rest webhook endpoint интеграция' },
  gsheets: { category: 'data', label: 'Таблицы', capabilities: ['Чтение таблиц', 'Обновление строк', 'Отчёты'], search: 'google sheets таблицы отчеты данные spreadsheet' },
  telegram: { category: 'notify', label: 'Сообщения', capabilities: ['Бот', 'Уведомления', 'Whitelist чатов'], search: 'telegram бот уведомления чат сообщения' },
  ssh: { category: 'dev', label: 'Сервер', capabilities: ['Удалённые команды', 'SSH host', 'Ключ доступа'], search: 'ssh сервер команды terminal remote' },
  bitrix: { category: 'crm', label: 'CRM', capabilities: ['Сделки', 'Задачи', 'Контакты'], search: 'битрикс bitrix24 crm сделки задачи webhook' },
  ydirect: { category: 'ads', label: 'Реклама', capabilities: ['Кампании', 'Статистика', 'Правки РК'], search: 'яндекс директ direct реклама кампании рк ставки минусация' },
  ydisk: { category: 'data', label: 'Файлы', capabilities: ['Файлы', 'Публикация', 'Артефакты'], search: 'яндекс диск файлы шаринг документы' },
  'skills-server': { category: 'dev', label: 'Скиллы', capabilities: ['Удалённые скиллы', 'Base URL', 'Подключение сервера'], search: 'скиллы skills server удаленные навыки' },
  github: { category: 'dev', label: 'Код', capabilities: ['Репозитории', 'Issues', 'Pull requests'], search: 'github git репозиторий issue pr code search' },
  'social-publish': { category: 'notify', label: 'Публикации', capabilities: ['Telegram', 'VK', 'Webhooks'], search: 'постинг публикации telegram vk webhook social' },
  dadata: { category: 'crm', label: 'Данные компаний', capabilities: ['ИНН', 'Адреса', 'Контрагенты'], search: 'dadata дадата инн адрес контрагент компания' },
  ymetrika: { category: 'analytics', label: 'Веб-аналитика', capabilities: ['Трафик', 'Цели', 'Источники'], search: 'яндекс метрика цели конверсии аудит аналитика' },
  avito: { category: 'marketplace', label: 'Объявления', capabilities: ['Объявления', 'Статистика', 'Баланс'], search: 'avito авито объявления статистика баланс' },
  ywebmaster: { category: 'analytics', label: 'SEO', capabilities: ['ИКС', 'Проблемы сайта', 'Поисковые запросы'], search: 'яндекс вебмастер seo икс сайт запросы' },
  ywordstat: { category: 'ads', label: 'Семантика', capabilities: ['Частотность', 'Ключевые слова', 'Wordstat API'], search: 'wordstat вордстат семантика ключевые слова частотность ядро' },
  ozon: { category: 'marketplace', label: 'Маркетплейс', capabilities: ['Товары', 'Остатки', 'Финансы'], search: 'ozon seller озон товары остатки заказы финансы' },
  wildberries: { category: 'marketplace', label: 'Маркетплейс', capabilities: ['Продажи', 'Заказы', 'Остатки'], search: 'wildberries wb вайлдберриз продажи заказы остатки' },
  yookassa: { category: 'payments', label: 'Платежи', capabilities: ['Платежи', 'Возвраты', 'Shop ID'], search: 'юкасса yookassa платежи возвраты оплата' },
  vk: { category: 'notify', label: 'Соцсеть', capabilities: ['Сообщества', 'Стена', 'Пользователи'], search: 'vk вк сообщества стена пользователи' },
  amocrm: { category: 'crm', label: 'CRM', capabilities: ['Сделки', 'Контакты', 'Воронки'], search: 'amocrm amo crm сделки контакты воронки' },
  moysklad: { category: 'data', label: 'Склад', capabilities: ['Товары', 'Заказы', 'Остатки'], search: 'мойсклад склад товары заказы остатки' },
  yandex_tracker: { category: 'tasks', label: 'Задачи', capabilities: ['Очереди', 'Задачи', 'Организация'], search: 'яндекс трекер tracker задачи очереди' },
  sendpulse: { category: 'notify', label: 'Рассылки', capabilities: ['Email', 'SMS', 'Client ID'], search: 'sendpulse рассылки email sms' },
  unisender: { category: 'notify', label: 'Рассылки', capabilities: ['Email', 'SMS', 'API key'], search: 'unisender рассылки email sms' },
  ga4: { category: 'analytics', label: 'Веб-аналитика', capabilities: ['Трафик', 'События', 'Property ID'], search: 'google analytics ga4 события трафик аналитика' },
  notion: { category: 'data', label: 'База знаний', capabilities: ['Базы', 'Страницы', 'Поиск'], search: 'notion база знания страницы поиск' },
  kontur_focus: { category: 'crm', label: 'Проверка компаний', capabilities: ['Контрагенты', 'Риски', 'API key'], search: 'контур фокус контрагенты риски инн' },
  mpstats: { category: 'marketplace', label: 'Аналитика МП', capabilities: ['Ниши', 'Товары', 'Маркетплейсы'], search: 'mpstats маркетплейсы аналитика товары ниши' },
  ozon_performance: { category: 'ads', label: 'Реклама Ozon', capabilities: ['Кампании', 'Статистика', 'Client secret'], search: 'ozon performance реклама кампании статистика' },
  jira: { category: 'tasks', label: 'Задачи', capabilities: ['Проекты', 'JQL', 'Задачи'], search: 'jira atlassian задачи проекты jql' },
  trello: { category: 'tasks', label: 'Доски', capabilities: ['Доски', 'Списки', 'Карточки'], search: 'trello доски списки карточки задачи' }
}

const CONNECTOR_SETTING_KEYS: Record<string, string[]> = {
  'claude-oauth': ['claude_code_oauth_token'],
  onec: ['onec_base_url', 'onec_username', 'onec_password'],
  http: Array.from({ length: 4 }, (_, i) => i + 1).flatMap(i => [
    `http_endpoint_${i}_name`,
    `http_endpoint_${i}_base`,
    `http_endpoint_${i}_auth`,
    `http_endpoint_${i}_paths`
  ]),
  gsheets: ['gsheets_service_account_json'],
  telegram: ['telegram_bot_token', 'telegram_chat_whitelist', 'telegram_notify_chat_id'],
  ssh: ['ssh_default_host', 'ssh_key_path'],
  bitrix: ['bitrix24_webhook_url'],
  ydirect: ['yandex_direct_token', 'yandex_direct_login'],
  ydisk: ['yandex_disk_token'],
  'skills-server': ['skills_server_base'],
  github: ['github_token'],
  'social-publish': ['social_publish_telegram_channels', 'social_publish_vk_token', 'social_publish_vk_group_id', 'social_publish_webhooks'],
  dadata: ['dadata_api_key', 'dadata_secret'],
  ymetrika: ['yandex_metrika_token'],
  avito: ['avito_client_id', 'avito_client_secret'],
  ywebmaster: ['yandex_webmaster_token'],
  ywordstat: ['yandex_wordstat_token', 'yandex_wordstat_auth_type', 'yandex_wordstat_folder_id'],
  ozon: ['ozon_client_id', 'ozon_api_key'],
  wildberries: ['wildberries_token'],
  yookassa: ['yookassa_shop_id', 'yookassa_secret_key'],
  vk: ['vk_access_token'],
  amocrm: ['amocrm_subdomain', 'amocrm_access_token'],
  moysklad: ['moysklad_token'],
  yandex_tracker: ['yandex_tracker_token', 'yandex_tracker_org_id'],
  sendpulse: ['sendpulse_client_id', 'sendpulse_client_secret'],
  unisender: ['unisender_api_key'],
  ga4: ['ga4_access_token', 'ga4_property_id'],
  notion: ['notion_token'],
  kontur_focus: ['kontur_focus_api_key'],
  mpstats: ['mpstats_token'],
  ozon_performance: ['ozon_perf_client_id', 'ozon_perf_client_secret'],
  jira: ['jira_base_url', 'jira_email', 'jira_api_token'],
  trello: ['trello_api_key', 'trello_token']
}

const COST_CAP_RUB_PER_USD = 100
type CostCapCurrency = 'USD' | 'RUB'

function costCapToUsd(value: string, currency: CostCapCurrency): string {
  const amount = Number.parseFloat(value.replace(',', '.'))
  if (!Number.isFinite(amount) || amount <= 0) return ''
  const usd = currency === 'RUB' ? amount / COST_CAP_RUB_PER_USD : amount
  return usd.toFixed(2).replace(/\.?0+$/, '')
}

function connectorMeta(id: string) {
  return CONNECTOR_META[id] ?? {
    category: 'data' as ConnectorCategory,
    label: 'Интеграция',
    capabilities: ['Подключение', 'Проверка доступа'],
    search: ''
  }
}

import type { McpServerEntry, McpTool, PopularMcpServer } from '../types/api'

// ── MCP Hardening — review-before-trust helpers ──────────────────────────────

/** Бейдж scope: иконка + русская подпись + класс цвета. */
const SCOPE_META: Record<McpScope, { icon: string; label: string }> = {
  read:    { icon: '', label: 'Чтение' },
  write:   { icon: '', label: 'Запись' },
  network: { icon: '', label: 'Сеть' },
  command: { icon: '', label: 'Команда' },
  unknown: { icon: '', label: 'Неясно' }
}

/** Человекочитаемая сводка по scope-ам сервера, напр. «3 чтение · 2 запись · 1 команда». */
function scopeSummary(scopes: Record<McpScope, number>): string {
  const order: McpScope[] = ['read', 'write', 'network', 'command', 'unknown']
  return order
    .filter(s => scopes[s] > 0)
    .map(s => `${scopes[s]} ${SCOPE_META[s].label}`)
    .join(' · ')
}

/** Манифест сервера, собранный после connect + классификации. */
interface McpManifest {
  tools: Array<McpTool & { scope: McpScope }>
  risk: McpRisk
  scopes: Record<McpScope, number>
  toolCount: number
  /** Имена env-переменных из конфига сервера + флаг «пусто». */
  env: Array<{ key: string; empty: boolean }>
}

/** Парсит env-JSON сервера в список требований. */
function parseEnvRequirements(envJson: string): Array<{ key: string; empty: boolean }> {
  try {
    const obj = JSON.parse(envJson || '{}') as Record<string, unknown>
    return Object.keys(obj).map(key => ({
      key,
      empty: !String(obj[key] ?? '').trim()
    }))
  } catch {
    return []
  }
}

function pluralRu(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10
  const mod100 = count % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}

function mcpActionCountLabel(count: number): string {
  return `${count} ${pluralRu(count, 'действие', 'действия', 'действий')}`
}

function mcpToolCountLabel(count: number): string {
  return `${count} ${pluralRu(count, 'инструмент', 'инструмента', 'инструментов')}`
}

function mcpServerArgs(entry: Pick<McpServerEntry, 'args'>): string[] {
  try {
    const parsed = JSON.parse(entry.args || '[]')
    return Array.isArray(parsed) ? parsed.map(v => String(v)) : []
  } catch {
    return []
  }
}

function mcpTemplateInfo(template: PopularMcpServer): { label: string; useCase: string; caution: string } {
  const name = template.name.toLowerCase()
  if (name.includes('github')) {
    return {
      label: 'Разработка',
      useCase: 'Когда агенту нужно работать с репозиториями, задачами, pull request или файлами в GitHub',
      caution: 'Нужен GitHub token с подходящими правами'
    }
  }
  if (name.includes('postgres')) {
    return {
      label: 'Данные',
      useCase: 'Когда агенту нужно читать таблицы из PostgreSQL без отдельного коннектора',
      caution: 'Нужна строка подключения к базе'
    }
  }
  if (name.includes('брауз') || name.includes('puppeteer')) {
    return {
      label: 'Проверки',
      useCase: 'Когда агенту нужно открыть страницу, сделать скриншот или проверить интерфейс',
      caution: 'Может открывать браузер и ходить по сайтам'
    }
  }
  if (name.includes('файл') || name.includes('filesystem')) {
    return {
      label: 'Файлы',
      useCase: 'Когда агенту нужен доступ к файлам через отдельный внешний инструмент',
      caution: 'Ограничивай папку, чтобы не дать лишний доступ'
    }
  }
  return {
    label: 'Шаблон',
    useCase: template.description,
    caution: template.envHint ? 'Потребуется ключ доступа' : 'Перед подключением проверь возможности'
  }
}

function mcpScopeHuman(scope: McpScope): string {
  if (scope === 'read') return 'Только читает'
  if (scope === 'write') return 'Может менять данные'
  if (scope === 'network') return 'Ходит в сеть'
  if (scope === 'command') return 'Запускает команды'
  return 'Нужно проверить'
}

function mcpErrorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  if (/ENOENT|not found|Cannot find/i.test(raw)) return 'Не удалось запустить команду. Проверь, что Node.js, npm или нужная программа установлены'
  if (/timed out|timeout/i.test(raw)) return 'Инструмент не ответил вовремя. Проверь ключи, сеть и команду запуска'
  if (/API key|token|unauthorized|forbidden|401|403/i.test(raw)) return 'Не хватает доступа. Проверь ключ или права в сервисе'
  return raw
}

// === Policy Center ===
// Read-only экран «что разрешено агенту»: матрица decide(tool, mode) по 5 режимам
// + опасные команды. Логика НЕ дублируется — данные приходят из policy:matrix.

const POLICY_CATEGORY_LABELS: Record<string, string> = {
  read: 'Чтение',
  edit: 'Правка файлов',
  command: 'Команды',
  connector: 'Коннекторы'
}

const POLICY_TOOL_LABELS: Record<string, string> = {
  read_file: 'Чтение файлов',
  write_file: 'Запись файлов',
  apply_patch: 'Патчи',
  run_command: 'Команды',
  connector_query: 'Коннекторы'
}

const POLICY_DECISION_META: Record<PolicyDecision, { label: string; cls: string; description: string }> = {
  'auto-accept': { label: 'Без подтверждения', cls: 'auto', description: 'Модель выполнит действие сразу' },
  'confirm':     { label: 'Нужно подтверждение', cls: 'confirm', description: 'Verstak спросит перед действием' },
  'block':       { label: 'Заблокировано', cls: 'block', description: 'Действие выполнить нельзя' }
}

const POLICY_MODE_TABLE_LABELS: Record<string, string> = {
  ask: 'Запрос разрешений',
  'accept-edits': 'Правки',
  plan: 'Планирование',
  auto: 'Авто',
  bypass: 'Без подтверждения'
}

function PolicyTab() {
  const [matrix, setMatrix] = useState<PolicyMatrixDTO | null>(null)
  const [dodMode, setDodMode] = useState<string>('warn')
  const [allowlist, setAllowlist] = useState<string>('')
  const [allowedWriteRoots, setAllowedWriteRoots] = useState<string>('')
  const [planGate, setPlanGate] = useState(false)
  const [autoEdits, setAutoEdits] = useState(false)
  const [autoCommands, setAutoCommands] = useState(false)
  const [hooksOn, setHooksOn] = useState(false)
  const [hooksProjectOn, setHooksProjectOn] = useState(false)
  const [webAccess, setWebAccess] = useState(false)
  const [outputStyle, setOutputStyle] = useState('default')
  const [outputStyleList, setOutputStyleList] = useState<Array<{ id: string; name: string; scope: string }>>([])

  useEffect(() => {
    void (async () => {
      const m = await window.api.policy.matrix()
      setMatrix(m)
      const dm = await window.api.settings.getKey('dod_mode')
      setDodMode(dm || 'warn')
      const al = await window.api.settings.getKey('bash_allowlist')
      setAllowlist(al || '')
      const awr = await window.api.settings.getKey('allowed_write_roots')
      setAllowedWriteRoots(awr || '')
      const pg = await window.api.settings.getKey('plan_approval_gate')
      setPlanGate(pg === 'true')
      setAutoEdits((await window.api.settings.getKey('auto_approve_edits')) === 'true')
      setAutoCommands((await window.api.settings.getKey('auto_approve_commands')) === 'true')
      setHooksOn((await window.api.settings.getKey('hooks_enabled')) === 'true')
      setHooksProjectOn((await window.api.settings.getKey('hooks_project_enabled')) === 'true')
      setWebAccess((await window.api.settings.getKey('web_access')) === 'true')
      setOutputStyle((await window.api.settings.getKey('output_style')) || 'default')
      try { setOutputStyleList(await window.api.settings.outputStyles(null)) } catch { /* список стилей — best-effort */ }
    })()
  }, [])

  const changeAutoEdits = async (v: boolean) => { setAutoEdits(v); await window.api.settings.setKey('auto_approve_edits', v ? 'true' : 'false') }
  const changeAutoCommands = async (v: boolean) => { setAutoCommands(v); await window.api.settings.setKey('auto_approve_commands', v ? 'true' : 'false') }
  const changeHooks = async (v: boolean) => { setHooksOn(v); await window.api.settings.setKey('hooks_enabled', v ? 'true' : 'false') }
  const changeHooksProject = async (v: boolean) => { setHooksProjectOn(v); await window.api.settings.setKey('hooks_project_enabled', v ? 'true' : 'false') }
  const changeWebAccess = async (v: boolean) => { setWebAccess(v); await window.api.settings.setKey('web_access', v ? 'true' : 'false') }
  const changeOutputStyle = async (v: string) => { setOutputStyle(v); await window.api.settings.setKey('output_style', v) }

  const changeDod = async (v: string) => {
    setDodMode(v)
    await window.api.settings.setKey('dod_mode', v)
  }

  const changePlanGate = async (v: boolean) => {
    setPlanGate(v)
    await window.api.settings.setKey('plan_approval_gate', v ? 'true' : 'false')
  }

  const changeAllowlist = async (v: string) => {
    setAllowlist(v)
    await window.api.settings.setKey('bash_allowlist', v)
  }

  const changeAllowedWriteRoots = async (v: string) => {
    setAllowedWriteRoots(v)
    await window.api.settings.setKey('allowed_write_roots', v)
  }

  if (!matrix) {
    return <div className="gg-settings-extra"><div className="gg-settings-hint">Загрузка политики…</div></div>
  }

  const trustedCommandCount = allowlist.split(/\r?\n/).map(line => line.trim()).filter(Boolean).length
  const writeRootCount = allowedWriteRoots.split(/\r?\n/).map(line => line.trim()).filter(Boolean).length
  const policyGridStyle = {
    gridTemplateColumns: `minmax(108px, 1.05fr) repeat(${matrix.modes.length}, minmax(0, 0.72fr))`
  } as React.CSSProperties
  const policyTableRows = matrix.rows.map(row => ({
    ...row,
    label: POLICY_TOOL_LABELS[row.tool] || POLICY_CATEGORY_LABELS[row.category] || row.tool
  }))

  return (
    <div className="gg-settings-extra gg-policy">
      <section className="gg-policy-block gg-policy-matrix-block">
        <div className="gg-policy-block-head">
          <div>
            <div className="gg-settings-section-title">Карта режимов</div>
            <p>Показывает, какие действия модель выполнит сама, где спросит подтверждение, а что будет заблокировано</p>
          </div>
        </div>
        <div className="gg-policy-led-legend" aria-label="Обозначения прав">
          {(['auto-accept', 'confirm', 'block'] as PolicyDecision[]).map(decision => {
            const meta = POLICY_DECISION_META[decision]
            return (
              <span key={decision} className={`gg-policy-led-legend-item is-${meta.cls}`}>
                <i aria-hidden="true" />
                <b>{meta.label}</b>
              </span>
            )
          })}
        </div>
        <div className="gg-policy-permission-table" role="table" aria-label="Карта режимов">
          <div className="gg-policy-permission-row is-head" role="row" style={policyGridStyle}>
            <div className="gg-policy-permission-action-head" role="columnheader">Действие</div>
            {matrix.modes.map(mode => (
              <div
                key={mode.id}
                className="gg-policy-permission-mode-head"
                role="columnheader"
                title={`${mode.label}: ${mode.description}`}
              >
                {POLICY_MODE_TABLE_LABELS[mode.id] || mode.label}
              </div>
            ))}
          </div>
          {policyTableRows.map(row => (
            <div key={row.tool} className="gg-policy-permission-row" role="row" style={policyGridStyle}>
              <div className="gg-policy-permission-action" role="rowheader" title={row.tool}>
                <span>{row.label}</span>
              </div>
              {matrix.modes.map(mode => {
                const decision = row.decisions[mode.id]
                const meta = POLICY_DECISION_META[decision]
                return (
                  <div
                    key={`${row.tool}-${mode.id}`}
                    className="gg-policy-permission-cell"
                    role="cell"
                    title={`${mode.label}: ${row.label} - ${meta.label}. ${meta.description}`}
                    aria-label={`${mode.label}: ${row.label} - ${meta.label}`}
                  >
                    <span className={`gg-policy-led is-${meta.cls}`} aria-hidden="true" />
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </section>

      <section className="gg-policy-disclaimer">
        <div className="gg-policy-disclaimer-mark" aria-hidden="true" />
        <div>
          <strong>Важно про внешние модели</strong>
          <p>API-модели и встроенные инструменты контролируются Verstak. Внешние CLI-модели могут воспринимать режим только как инструкцию, поэтому для них задачи лучше формулировать явно</p>
        </div>
      </section>

      <details className="gg-policy-danger-details">
        <summary>
          <span>Всегда запрещено</span>
          <small>Действия, которые Verstak блокирует в любом режиме</small>
        </summary>
        <div className="gg-policy-danger-list">
          {matrix.commandDanger.map((d, i) => (
            <span key={i}>{d}</span>
          ))}
        </div>
      </details>

      <details className="gg-policy-advanced">
        <summary>
          <span>Дополнительные настройки</span>
          <small>Внешние папки, авто-одобрение, web-доступ и хуки</small>
        </summary>

        <div className="gg-policy-advanced-note">
          Эти настройки применяются к работе Verstak в целом. Проектные файлы правил могут уточнять поведение внутри конкретного проекта
        </div>

        <div className="gg-policy-advanced-grid">
          <section className="gg-policy-advanced-card">
            <div className="gg-settings-section-title">Внешние папки для записи</div>
            <p>Дополнительные рабочие зоны за пределами проекта</p>
            <span className="gg-policy-count">{writeRootCount ? `${writeRootCount} добавлено` : 'Пусто'}</span>
            <textarea
              className="gg-input"
              value={allowedWriteRoots}
              onChange={e => void changeAllowedWriteRoots(e.target.value)}
              placeholder={'C:\\Users\\User\\Downloads\\verstak-exports\nC:\\Projects\\Client\\_artifacts'}
              spellCheck={false}
              rows={4}
              style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}
            />
          </section>

          <section className="gg-policy-advanced-card">
            <div className="gg-settings-section-title">Доказательство выполнения</div>
            <p>Поведение при не-зелёных проверках перед коммитом</p>
            <select className="gg-input" value={dodMode} onChange={e => void changeDod(e.target.value)}>
              <option value="warn">Предупреждать</option>
              <option value="block">Обязательно</option>
              <option value="off">Выключено</option>
            </select>
          </section>

          <section className="gg-policy-advanced-card">
            <div className="gg-settings-section-title">Одобрение плана</div>
            <p>В режиме планирования агент будет ждать решения перед выполнением</p>
            <label className="gg-theme-square">
              <input type="checkbox" checked={planGate} onChange={e => void changePlanGate(e.target.checked)} />
              <span>Ждать одобрения плана</span>
            </label>
          </section>

          <section className="gg-policy-advanced-card">
            <div className="gg-settings-section-title">Авто-одобрение</div>
            <p>Тонкая настройка поверх выбранного режима</p>
            <label className="gg-theme-square">
              <input type="checkbox" checked={autoEdits} onChange={e => void changeAutoEdits(e.target.checked)} />
              <span>Авто-принимать правки файлов</span>
            </label>
            <label className="gg-theme-square">
              <input type="checkbox" checked={autoCommands} onChange={e => void changeAutoCommands(e.target.checked)} />
              <span>Авто-принимать команды</span>
            </label>
          </section>

          <section className="gg-policy-advanced-card">
            <div className="gg-settings-section-title">Подача ответа</div>
            <p>Стиль форматирования ответа агента</p>
            <select className="gg-input" value={outputStyle} onChange={e => void changeOutputStyle(e.target.value)}>
              {outputStyleList.map(s => (
                <option key={s.id} value={s.id}>{s.name}{s.scope !== 'built-in' ? ` (${s.scope})` : ''}</option>
              ))}
              {outputStyle && !outputStyleList.some(s => s.id === outputStyle) && (
                <option value={outputStyle}>{outputStyle} (не найден)</option>
              )}
            </select>
          </section>

          <section className="gg-policy-advanced-card">
            <div className="gg-settings-section-title">Веб-доступ</div>
            <p>Поиск в интернете и чтение публичных страниц по URL</p>
            <label className="gg-theme-square">
              <input type="checkbox" checked={webAccess} onChange={e => void changeWebAccess(e.target.checked)} />
              <span>Разрешить веб-доступ</span>
            </label>
          </section>

          <section className="gg-policy-advanced-card">
            <div className="gg-settings-section-title">Хуки</div>
            <p>Скрипты на события агента. Включай только для доверенных проектов</p>
            <label className="gg-theme-square">
              <input type="checkbox" checked={hooksOn} onChange={e => void changeHooks(e.target.checked)} />
              <span>Глобальные хуки</span>
            </label>
            <label className="gg-theme-square">
              <input type="checkbox" checked={hooksProjectOn} disabled={!hooksOn} onChange={e => void changeHooksProject(e.target.checked)} />
              <span>Хуки проекта</span>
            </label>
          </section>

          <section className="gg-policy-advanced-card is-wide">
            <div className="gg-settings-section-title">Правила доступа</div>
            <p>Файл <code>.verstak/permissions.json</code> в проекте или <code>~/.verstak/permissions.json</code> глобально. Приоритет: deny, ask, allow</p>
            <pre className="gg-policy-code">{`{
  "allow": ["Bash(npm:*)", "Read(src/**)"],
  "ask":   ["Bash(git push:*)"],
  "deny":  ["Bash(rm:*)", "Read(*.env)"]
}`}</pre>
          </section>

          <section className="gg-policy-advanced-card is-wide">
            <div className="gg-settings-section-title">Web-policy</div>
            <p>Ограничивает домены, которые агенту разрешено читать. Без файла доступны публичные адреса</p>
            <pre className="gg-policy-code">{`{
  "allow": ["python.org", "*.mozilla.org", "github.com"],
  "deny":  ["*.internal"]
}`}</pre>
          </section>

          <section className="gg-policy-advanced-card is-wide">
            <div className="gg-settings-section-title">Hooks.json</div>
            <p>Сценарии, которые выполняются до или после действий агента</p>
            <pre className="gg-policy-code">{`{
  "PreToolUse": [{ "matcher": "run_command", "command": "node guard.js" }],
  "PostToolUse": [{ "matcher": "write_file", "command": "npm run lint" }]
}`}</pre>
          </section>
        </div>
      </details>

      <details className="gg-policy-trusted-details">
        <summary>
          <span>Доверенные действия</span>
          <small>Команды, которые можно выполнять без повторного подтверждения</small>
          <em>{trustedCommandCount ? `${trustedCommandCount} добавлено` : 'Пусто'}</em>
        </summary>
        <div className="gg-policy-trusted-panel">
          <div className="gg-policy-trusted-copy">
            <strong>Что сюда писать</strong>
            <p>Безопасные команды, которые ты часто разрешаешь вручную. Одна команда на строку, лучше точная команда без широких масок</p>
          </div>
          <div className="gg-policy-trusted-examples" aria-label="Примеры доверенных действий">
            <span>git status</span>
            <span>npm test</span>
            <span>npm run build</span>
          </div>
          <p className="gg-policy-trusted-warning">
            Не добавляй удаление файлов, отправку в git, установку пакетов и команды с доступом к ключам
          </p>
        </div>
        <textarea
          className="gg-input"
          value={allowlist}
          onChange={e => void changeAllowlist(e.target.value)}
          placeholder={'git status\nnpm test\nls'}
          spellCheck={false}
          rows={4}
          style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}
        />
      </details>
    </div>
  )
}

// ось 3 A: привязка модели к режиму агента (авто-своп при 1-5). Self-contained.
const MODE_BIND_ROWS: { mode: AgentMode; label: string }[] = [
  { mode: 'plan', label: 'Планирование' },
  { mode: 'accept-edits', label: 'Правки' },
  { mode: 'auto', label: 'Авто' },
]

const MODE_BIND_DESCRIPTIONS: Partial<Record<AgentMode, string>> = {
  plan: 'Для задач, где сначала нужен понятный план и проверка шагов',
  'accept-edits': 'Для аккуратных изменений, когда важнее точность правок',
  auto: 'Для самостоятельного выполнения задачи без лишних уточнений'
}

function ModeModelBinding({ providers }: { providers: ProviderConfig[] }) {
  const [providerId, setProviderId] = useState<string>(providers[0]?.id ?? '')
  const [map, setMap] = useState<Record<string, string>>({})
  const provider = providers.find(p => p.id === providerId)
  const control = provider ? modeControlInfo(provider.id, provider.transport) : null

  useEffect(() => {
    void (async () => setMap(parseModeModels(await window.api.settings.getKey(modeModelsKey(providerId)))))()
  }, [providerId])

  const update = async (mode: string, model: string) => {
    const next = { ...map }
    if (model) next[mode] = model; else delete next[mode]
    setMap(next)
    await window.api.settings.setKey(modeModelsKey(providerId), serializeModeModels(next))
  }

  return (
    <div className="gg-model-modes-panel">
      <div className="gg-model-modes-head">
        <div>
          <div className="gg-model-modes-title">Режимы работы моделей</div>
          <div className="gg-model-modes-desc">
            Закрепи модель за режимом работы. Когда режим меняется в чате, Verstak сам выберет нужную модель. Если оставить «Не менять», текущая модель не изменится
          </div>
        </div>
        <label className="gg-model-modes-provider">
          <span>Провайдер</span>
          <select className="gg-input" value={providerId} onChange={e => setProviderId(e.target.value)}>
            {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      </div>
      {control && (
        <div className={`gg-model-modes-control is-${control.tone}`}>
          <span>{control.label}</span>
          <small>{control.hint}</small>
        </div>
      )}
      <div className="gg-model-mode-list">
        {MODE_BIND_ROWS.map(r => (
          <div className="gg-model-mode-row" key={r.mode}>
            <div className="gg-model-mode-copy">
              <div className="gg-model-mode-label">{r.label}</div>
              <div className="gg-model-mode-desc">{MODE_BIND_DESCRIPTIONS[r.mode] ?? ''}</div>
            </div>
            <select className="gg-input" value={map[r.mode] ?? ''} onChange={e => void update(r.mode, e.target.value)}>
              <option value="">Не менять</option>
              {(provider?.models ?? []).map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        ))}
      </div>
    </div>
  )
}

function McpTab() {
  const [servers, setServers] = useState<McpServerEntry[]>([])
  const [connectedIds, setConnectedIds] = useState<Set<string>>(new Set())
  const [toolCounts, setToolCounts] = useState<Record<string, number>>({})
  const [showAdd, setShowAdd] = useState(false)
  const [popular, setPopular] = useState<PopularMcpServer[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [newForm, setNewForm] = useState({ name: '', command: '', args: '', env: '' })
  // MCP Hardening — превью манифеста сервера (review-before-trust).
  const [manifests, setManifests] = useState<Record<string, McpManifest>>({})
  const [previewBusy, setPreviewBusy] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<Record<string, string>>({})
  // #2: per-tool override scope гейтинга (JSON {toolName: read|write|command|network}).
  const [scopeOverrides, setScopeOverrides] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [showTemplates, setShowTemplates] = useState(false)

  useEffect(() => {
    void loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadAll() {
    try {
      const [svrs, tools, pop] = await Promise.all([
        window.api.mcp.listServers(),
        window.api.mcp.tools(),
        window.api.mcp.popular()
      ])
      setServers(svrs)
      setPopular(pop)
      const ids = new Set<string>()
      const counts: Record<string, number> = {}
      for (const t of tools as McpTool[]) {
        ids.add(t.serverId)
        counts[t.serverId] = (counts[t.serverId] ?? 0) + 1
      }
      setConnectedIds(ids)
      setToolCounts(counts)
      const ov = await window.api.settings.getKey('mcp_scope_overrides')
      setScopeOverrides(ov || '')
    } catch { /* ignore */ }
  }

  const saveScopeOverrides = async (v: string) => {
    setScopeOverrides(v)
    await window.api.settings.setKey('mcp_scope_overrides', v)
  }

  async function handleConnect(id: string) {
    setBusy(id); setError(null)
    try {
      const tools = await window.api.mcp.connect(id) as McpTool[]
      const agg = classifyServer(tools)
      const entry = servers.find(s => s.id === id)
      if (entry) {
        setManifests(prev => ({
          ...prev,
          [id]: {
            tools: tools.map(t => ({ ...t, scope: classifyTool(t).scope })),
            risk: agg.risk,
            scopes: agg.scopes,
            toolCount: agg.toolCount,
            env: parseEnvRequirements(entry.env)
          }
        }))
      }
      setConnectedIds(prev => new Set([...prev, id]))
      setToolCounts(prev => ({ ...prev, [id]: tools.length }))
    } catch (e) {
      setError(mcpErrorText(e))
    } finally { setBusy(null) }
  }

  async function handleDisconnect(id: string) {
    setBusy(id); setError(null)
    try {
      await window.api.mcp.disconnect(id)
      setConnectedIds(prev => { const s = new Set(prev); s.delete(id); return s })
      setToolCounts(prev => { const c = { ...prev }; delete c[id]; return c })
    } catch (e) {
      setError(mcpErrorText(e))
    } finally { setBusy(null) }
  }

  // MCP Hardening — подключиться, перечислить инструменты, классифицировать → манифест.
  async function handlePreview(s: McpServerEntry) {
    if (manifests[s.id]) {
      // toggle — повторный клик сворачивает карточку
      setManifests(prev => { const m = { ...prev }; delete m[s.id]; return m })
      return
    }
    const wasConnected = connectedIds.has(s.id)
    setPreviewBusy(s.id)
    setPreviewError(prev => { const e = { ...prev }; delete e[s.id]; return e })
    try {
      const tools = await window.api.mcp.connect(s.id) as McpTool[]
      const agg = classifyServer(tools)
      const manifest: McpManifest = {
        tools: tools.map(t => ({ ...t, scope: classifyTool(t).scope })),
        risk: agg.risk,
        scopes: agg.scopes,
        toolCount: agg.toolCount,
        env: parseEnvRequirements(s.env)
      }
      setManifests(prev => ({ ...prev, [s.id]: manifest }))
      if (wasConnected) {
        setConnectedIds(prev => new Set([...prev, s.id]))
        setToolCounts(prev => ({ ...prev, [s.id]: tools.length }))
      } else {
        await window.api.mcp.disconnect(s.id)
      }
    } catch (e) {
      setPreviewError(prev => ({ ...prev, [s.id]: mcpErrorText(e) }))
    } finally {
      setPreviewBusy(null)
    }
  }

  async function handleToggle(id: string, enabled: boolean) {
    await window.api.mcp.toggleServer(id, enabled)
    setServers(prev => prev.map(s => s.id === id ? { ...s, enabled } : s))
  }

  async function handleRemove(id: string) {
    if (!confirm('Удалить внешний инструмент?')) return
    await window.api.mcp.removeServer(id)
    setServers(prev => prev.filter(s => s.id !== id))
    setConnectedIds(prev => { const s = new Set(prev); s.delete(id); return s })
    setManifests(prev => { const m = { ...prev }; delete m[id]; return m })
  }

  async function handleAdd() {
    if (!newForm.name.trim() || !newForm.command.trim()) return
    // Validate JSON args/env
    let argsStr = newForm.args.trim() || '[]'
    let envStr = newForm.env.trim() || '{}'
    // If args is a space-separated string, convert to JSON array
    if (!argsStr.startsWith('[')) {
      argsStr = JSON.stringify(argsStr.split(/\s+/).filter(Boolean))
    }
    try { JSON.parse(argsStr) } catch { argsStr = '[]' }
    try { JSON.parse(envStr) } catch { envStr = '{}' }

    const entry = await window.api.mcp.addServer({
      name: newForm.name,
      command: newForm.command,
      args: argsStr,
      env: envStr,
      enabled: true
    })
    setServers(prev => [...prev, entry])
    setNewForm({ name: '', command: '', args: '', env: '' })
    setShowAdd(false)
  }

  function fillFromPopular(p: PopularMcpServer) {
    setNewForm({
      name: p.name,
      command: p.command,
      args: JSON.stringify(p.args),
      env: p.envHint ? `{"${p.envHint}": ""}` : '{}'
    })
    setShowAdd(true)
  }

  return (
    <div className="gg-settings-extra gg-external-tools-tab">
      <section className="gg-external-tools-intro">
        <div className="gg-external-tools-intro-copy">
          <div className="gg-settings-section-title">Продвинутые подключения</div>
          <p>
            Раздел нужен для редких случаев, когда агенту требуется доступ к сервису за пределами обычных коннекторов Verstak: внутреннему API, базе данных, корпоративному инструменту или отдельной рабочей среде
          </p>
        </div>
        <div className="gg-external-tools-intro-rule">
          <div className="gg-external-tools-rule-title">Главное правило</div>
          <p>Если задачу закрывает вкладка Коннекторы или встроенные возможности модели, внешний инструмент подключать не нужно</p>
        </div>
      </section>

      <section className="gg-external-tools-flow" aria-label="Как подключить внешний инструмент">
        <div className="gg-external-tools-flow-item">
          <span>01</span>
          <div>
            <div>Добавь</div>
            <p>Заполни форму вручную или возьми шаблон как основу</p>
          </div>
        </div>
        <div className="gg-external-tools-flow-item">
          <span>02</span>
          <div>
            <div>Проверь</div>
            <p>Verstak временно запустит инструмент и покажет доступные действия</p>
          </div>
        </div>
        <div className="gg-external-tools-flow-item">
          <span>03</span>
          <div>
            <div>Подключи</div>
            <p>После проверки модель сможет использовать инструмент в подходящих задачах</p>
          </div>
        </div>
      </section>

      {error && (
        <div className="gg-external-tools-alert is-error">
          <span>Ошибка</span>
          <p>{error}</p>
        </div>
      )}

      <section className="gg-external-tools-panel">
        <div className="gg-external-tools-panel-head">
          <div>
            <div className="gg-settings-section-title">Подключения</div>
            <p>Инструмент сначала проверяется, потом подключается к работе модели</p>
          </div>
          <button className="gg-btn gg-btn-primary" onClick={() => setShowAdd(true)}>
            Добавить
          </button>
        </div>

        {servers.length === 0 ? (
          <div className="gg-external-tools-empty">
            <div className="gg-external-tools-empty-mark">0</div>
            <div>
              <div className="gg-external-tools-empty-title">Инструменты не добавлены</div>
              <p>Это нормально для обычной работы. Добавляй сюда только специальные подключения, которые нельзя настроить через Коннекторы</p>
            </div>
          </div>
        ) : (
          <div className="gg-external-tools-list">
            {servers.map(s => {
              const connected = connectedIds.has(s.id)
              const count = toolCounts[s.id] ?? 0
              const manifest = manifests[s.id]
              const pError = previewError[s.id]
              const args = mcpServerArgs(s)
              const statusLabel = connected ? `Работает · ${mcpToolCountLabel(count)}` : s.enabled ? 'Не подключён' : 'Выключен'
              return (
                <article key={s.id} className={`gg-external-tools-card ${connected ? 'is-connected' : ''}`}>
                  <div className="gg-external-tools-card-main">
                    <div className="gg-external-tools-card-icon" aria-hidden>
                      {s.name.trim().slice(0, 2).toUpperCase() || 'IT'}
                    </div>
                    <div className="gg-external-tools-card-text">
                      <div className="gg-external-tools-card-title-row">
                        <h4>{s.name}</h4>
                        <span className={`gg-external-tools-status ${connected ? 'is-connected' : s.enabled ? 'is-ready' : 'is-off'}`}>
                          {statusLabel}
                        </span>
                      </div>
                      <div className="gg-external-tools-command" title={`${s.command} ${args.join(' ')}`}>
                        <span>Запуск</span>
                        <code>{s.command} {args.join(' ')}</code>
                      </div>
                    </div>
                  </div>

                  <div className="gg-external-tools-actions">
                    <button
                      className="gg-btn gg-btn-ghost"
                      onClick={() => void handlePreview(s)}
                      disabled={previewBusy === s.id}
                      title="Временно запустить инструмент и показать, что он умеет"
                    >{previewBusy === s.id ? '…' : (manifest ? 'Скрыть проверку' : 'Проверить')}</button>
                    <label className="gg-toggle gg-external-tools-toggle" title="Показывать в списке доступных подключений">
                      <input
                        type="checkbox"
                        checked={s.enabled}
                        onChange={e => void handleToggle(s.id, e.target.checked)}
                      />
                      <span className="gg-toggle-slider" />
                    </label>
                    {connected ? (
                      <button
                        className="gg-btn gg-btn-ghost"
                        onClick={() => void handleDisconnect(s.id)}
                        disabled={busy === s.id}
                      >{busy === s.id ? '…' : 'Отключить'}</button>
                    ) : (
                      <button
                        className="gg-btn gg-btn-primary"
                        onClick={() => void handleConnect(s.id)}
                        disabled={busy === s.id || !s.enabled || !manifest}
                        title={!manifest ? 'Сначала нажми Проверить' : 'Подключить инструмент к работе модели'}
                      >{busy === s.id ? '…' : 'Подключить'}</button>
                    )}
                    <button
                      className="gg-btn gg-btn-ghost gg-external-tools-danger"
                      onClick={() => void handleRemove(s.id)}
                      title="Удалить внешний инструмент"
                    >Удалить</button>
                  </div>

                  {pError && (
                    <div className="gg-external-tools-alert is-error">
                      <span>Проверка не прошла</span>
                      <p>{pError}</p>
                    </div>
                  )}

                  {manifest && (
                    <div className="gg-external-tools-passport">
                      <div className="gg-external-tools-passport-head">
                        <div>
                          <div className="gg-external-tools-passport-title">Паспорт проверки</div>
                          <p>{mcpActionCountLabel(manifest.toolCount)} · {scopeSummary(manifest.scopes) || 'доступ не определён'}</p>
                        </div>
                        <span className={`gg-external-tools-access is-${manifest.risk}`}>
                          {manifest.risk === 'high' ? 'Высокий доступ' : manifest.risk === 'medium' ? 'Средний доступ' : 'Безопасный доступ'}
                        </span>
                      </div>

                      {manifest.risk === 'high' && (
                        <div className="gg-external-tools-alert is-warning">
                          <span>Осторожно</span>
                          <p>Инструмент может выполнять команды или менять данные. Подключай только если доверяешь источнику</p>
                        </div>
                      )}

                      <div className="gg-external-tools-passport-grid">
                        <div className="gg-external-tools-passport-block">
                          <div className="gg-external-tools-block-label">Ключи</div>
                          {manifest.env.length === 0 ? (
                            <p>Не требуются</p>
                          ) : (
                            <div className="gg-external-tools-key-list">
                              {manifest.env.map(e => (
                                <span key={e.key} className={`gg-external-tools-key ${e.empty ? 'is-empty' : ''}`} title={e.empty ? 'Значение пустое — задай перед использованием' : 'Заполнено'}>
                                  <code>{e.key}</code>{e.empty && <em>пусто</em>}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                        <div className="gg-external-tools-passport-block">
                          <div className="gg-external-tools-block-label">Действия</div>
                          <div className="gg-external-tools-action-list">
                            {manifest.tools.map(t => (
                              <div key={t.name} className="gg-external-tools-action-row">
                                <span className={`gg-external-tools-action-scope is-${t.scope}`}>{mcpScopeHuman(t.scope)}</span>
                                <div>
                                  <div className="gg-external-tools-action-name">{t.name}</div>
                                  {t.description && <p>{t.description}</p>}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </article>
              )
            })}
          </div>
        )}
      </section>

      {/* Форма добавления */}
      {showAdd && (
        <section className="gg-external-tools-panel gg-external-tools-form-panel">
          <div className="gg-external-tools-panel-head">
            <div>
              <div className="gg-settings-section-title">Новый внешний инструмент</div>
              <p>Заполняй только если есть команда запуска или инструкция от разработчика</p>
            </div>
          </div>
          <div className="gg-external-tools-form-grid">
            <label>
              <span>Название</span>
              <input className="gg-input" value={newForm.name} onChange={e => setNewForm(f => ({ ...f, name: e.target.value }))} placeholder="GitHub" />
            </label>
            <label>
              <span>Команда</span>
              <input className="gg-input" value={newForm.command} onChange={e => setNewForm(f => ({ ...f, command: e.target.value }))} placeholder="npx" spellCheck={false} />
            </label>
            <label className="is-wide">
              <span>Аргументы</span>
              <input className="gg-input" value={newForm.args} onChange={e => setNewForm(f => ({ ...f, args: e.target.value }))} placeholder='["-y", "@modelcontextprotocol/server-github"]' spellCheck={false} />
            </label>
            <label className="is-wide">
              <span>Ключи и переменные</span>
              <input className="gg-input" value={newForm.env} onChange={e => setNewForm(f => ({ ...f, env: e.target.value }))} placeholder='{"TOKEN_NAME": "your-key"}' spellCheck={false} />
            </label>
          </div>
          <div className="gg-external-tools-form-actions">
            <button className="gg-btn gg-btn-primary" onClick={() => void handleAdd()}>Добавить</button>
            <button className="gg-btn gg-btn-ghost" onClick={() => setShowAdd(false)}>Отмена</button>
          </div>
        </section>
      )}

      {/* Шаблоны подключения */}
      {popular.length > 0 && (
        <section className="gg-external-tools-panel">
          <div className="gg-external-tools-panel-head">
            <div>
              <div className="gg-settings-section-title">Шаблоны для разработчиков</div>
              <p>Это заготовки формы, а не готовые подключения. Рабочим инструмент станет только после проверки</p>
            </div>
            <button className="gg-btn gg-btn-ghost" onClick={() => setShowTemplates(v => !v)}>
              {showTemplates ? 'Скрыть шаблоны' : 'Показать шаблоны'}
            </button>
          </div>
          {showTemplates && (
          <div className="gg-external-tools-template-grid">
            {popular.map(p => {
              const info = mcpTemplateInfo(p)
              return (
                <article key={p.name} className="gg-external-tools-template">
                  <div className="gg-external-tools-template-top">
                    <span>{info.label}</span>
                    {p.envHint && <em>Нужен ключ</em>}
                  </div>
                  <h4>{p.name}</h4>
                  <p>{info.useCase}</p>
                  <div className="gg-external-tools-template-note">{info.caution}</div>
                  <button className="gg-btn gg-btn-ghost" onClick={() => fillFromPopular(p)}>Заполнить форму</button>
                </article>
              )
            })}
          </div>
          )}
        </section>
      )}

      <section className="gg-external-tools-advanced">
        <button className="gg-btn gg-btn-ghost" onClick={() => setShowAdvanced(v => !v)}>
          {showAdvanced ? 'Скрыть расширенные параметры' : 'Расширенные параметры'}
        </button>
        {showAdvanced && (
          <div className="gg-external-tools-advanced-body">
            <label>
              <span>Правила доступа для отдельных действий</span>
              <input
                className="gg-input"
                value={scopeOverrides}
                onChange={e => void saveScopeOverrides(e.target.value)}
                placeholder={'{"some_tool":"read","danger_tool":"command"}'}
                style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}
                spellCheck={false}
              />
            </label>
            <p>Нужны, если внешний инструмент неверно описывает свои действия. Чтение можно разрешить автоматически, запись, сеть и команды требуют подтверждения</p>
          </div>
        )}
      </section>
    </div>
  )
}

export function Settings({ onClose, initialTab }: { onClose: () => void; initialTab?: Tab }) {
  const t = useT()
  const [tab, setTab] = useState<Tab>(initialTab ?? 'appearance')
  const [navSearch, setNavSearch] = useState('')

  // Смысловые блоки левой панели: не техническая свалка, а маршрут пользователя.
  const TAB_GROUPS: ReadonlyArray<SettingsNavGroup> = [
    { title: 'Приложение', tabs: [
      { id: 'appearance', label: t.settings.appearance, icon: 'appearance', keywords: 'theme ui вид внешний вид тема светлая темная тёмная ночь день масштаб размер интерфейс плотность компактно анимации полный выключены оформление шрифт панель' },
      { id: 'notifications', label: t.settings.notifications, icon: 'notifications', keywords: 'toast push telegram уведомления всплывающее всплывающие звук проект тихие часы режим всегда вне фокуса окно проверка сигналы ошибки напоминания ответы' },
      { id: 'updates', label: t.settings.updates, icon: 'updates', keywords: 'release installer автообновление версия обновление обновить патчноут патч ноут список изменений загрузка установка временные файлы очистка кэш кеш диагностика' },
      // 2.0.8-G: живая вкладка (ProfilesTab поверх userProfiles API) — «Скоро»/disabled сняты.
      { id: 'profiles', label: t.settings.profiles, icon: 'profiles', keywords: 'user profile профиль аккаунт пользователь организация команда компания роль доступ участники приглашение почта регистрация' }
    ] },
    { title: 'AI', tabs: [
      { id: 'providers', label: t.settings.providers, icon: 'providers', keywords: 'api key gateway cli ключи провайдеры подключение авторизация токен где взять ключ grok grok build composer chatgpt openai claude codex gemini deepseek kimi qwen openrouter ollama lm studio' },
      { id: 'models', label: t.settings.models, icon: 'models', keywords: 'default fallback reviewer planner picker пресеты модели выбор модель показывать подключенные подключённые рабочий набор текущая чат лимит расходы сутки рубли доллары бюджет стоимость' },
      { id: 'modelModes', label: 'Режимы работы моделей', icon: 'modelModes', keywords: 'режимы модели планирование авто правки привязка стандарт турбо простой поведение подтверждение без подтверждений разрешения задачи' },
      { id: 'policy', label: 'Права модели', icon: 'policy', keywords: 'allowlist permissions bash команды политика права модели доступ что разрешено разрешения запреты запрет доверенные действия папки файлы команды коннекторы подтверждение' },
      // 2.0.8: подписочные аккаунты (состояние/остывание) и история расхода.
      { id: 'subscriptions', label: 'Подписки', icon: 'subscriptions', keywords: 'подписка подписки аккаунт аккаунты claude max codex chatgpt plus вход логин остывание лимит квота готов переключение несколько аккаунтов' },
      { id: 'usage', label: 'Расход', icon: 'usage', keywords: 'расход расходы токены деньги стоимость сколько потратил кэш кеш история статистика отчёт провайдер модель за неделю за месяц' },
    ] },
    { title: 'Интеграции', tabs: [
      { id: 'connectors', label: t.settings.connectors, icon: 'connectors', keywords: 'telegram bitrix bitrix24 битрикс б24 sheets таблицы google github yandex яндекс direct директ metrika метрика wordstat вордстат диск drive http ssh api webhook вебхук токен ключ crm сделки задачи контакты реклама семантика' },
      { id: 'mcp', label: 'Внешние инструменты', icon: 'mcp', keywords: 'mcp model context protocol servers tools внешние инструменты продвинутые подключения серверы инструменты браузер поиск файлы интеграции' }
    ] }
  ]
  const navQuery = navSearch.trim().toLowerCase()
  const visibleTabGroups = TAB_GROUPS
    .map(g => {
      if (!navQuery) return g
      const groupMatched = g.title.toLowerCase().includes(navQuery)
      const tabs = groupMatched
        ? g.tabs
        : g.tabs.filter(x => `${x.label} ${x.id} ${x.keywords ?? ''}`.toLowerCase().includes(navQuery))
      return { ...g, tabs }
    })
    .filter(g => g.tabs.length > 0)
  const activeNavGroup = TAB_GROUPS.find(g => g.tabs.some(x => x.id === tab))
  const activeNavTab = activeNavGroup?.tabs.find(x => x.id === tab)
  // 2.0.7-D: единый каталог провайдеров — модели/транспорт из providers:list (main-реестр),
  // а не из хардкода. bundled-снапшот до прихода live, чтобы список не был пуст на mount.
  const { providers, source: catalogSource } = useProviderCatalog()
  const [activeProvider, setActiveProvider] = useState<ProviderId>('gemini-api')
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [models, setModels] = useState<Record<string, string>>({})
  const [enabledModels, setEnabledModels] = useState<Set<string>>(new Set())
  const [saved, setSaved] = useState(false)
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [settingsDirty, setSettingsDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const savedSnapshotRef = useRef<string | null>(null)
  const [onec, setOneC] = useState({ url: '', user: '', pass: '' })
  const [httpEndpoints, setHttpEndpoints] = useState<Array<{ name: string; base: string; auth: string; paths: string }>>(
    [{ name: '', base: '', auth: '', paths: '' }, { name: '', base: '', auth: '', paths: '' }, { name: '', base: '', auth: '', paths: '' }, { name: '', base: '', auth: '', paths: '' }]
  )
  // V3 — российские коннекторы (раздел 5 плана).
  const [gsheetsJson, setGsheetsJson] = useState('')
  const [telegramBotToken, setTelegramBotToken] = useState('')
  const [telegramWhitelist, setTelegramWhitelist] = useState('')
  const [telegramNotifyChatId, setTelegramNotifyChatId] = useState('')
  const [sshHost, setSshHost] = useState('')
  const [sshKeyPath, setSshKeyPath] = useState('')
  const [bitrixWebhook, setBitrixWebhook] = useState('')
  const [yDirectToken, setYDirectToken] = useState('')
  const [dadataApiKey, setDadataApiKey] = useState('')
  const [dadataSecret, setDadataSecret] = useState('')
  const [yMetrikaToken, setYMetrikaToken] = useState('')
  const [avitoClientId, setAvitoClientId] = useState('')
  const [avitoClientSecret, setAvitoClientSecret] = useState('')
  const [yWebmasterToken, setYWebmasterToken] = useState('')
  const [yWordstatToken, setYWordstatToken] = useState('')
  const [yWordstatAuthType, setYWordstatAuthType] = useState<'api-key' | 'iam'>('api-key')
  const [yWordstatFolderId, setYWordstatFolderId] = useState('')
  const [ozonClientId, setOzonClientId] = useState('')
  const [ozonApiKey, setOzonApiKey] = useState('')
  const [wbToken, setWbToken] = useState('')
  const [yookassaShopId, setYookassaShopId] = useState('')
  const [yookassaSecretKey, setYookassaSecretKey] = useState('')
  const [vkToken, setVkToken] = useState('')
  const [amocrmSubdomain, setAmocrmSubdomain] = useState('')
  const [amocrmToken, setAmocrmToken] = useState('')
  const [moyskladToken, setMoyskladToken] = useState('')
  const [yTrackerToken, setYTrackerToken] = useState('')
  const [yTrackerOrgId, setYTrackerOrgId] = useState('')
  const [sendpulseClientId, setSendpulseClientId] = useState('')
  const [sendpulseClientSecret, setSendpulseClientSecret] = useState('')
  const [unisenderApiKey, setUnisenderApiKey] = useState('')
  const [ga4Token, setGa4Token] = useState('')
  const [ga4PropertyId, setGa4PropertyId] = useState('')
  const [notionToken, setNotionToken] = useState('')
  const [konturFocusKey, setKonturFocusKey] = useState('')
  const [mpstatsToken, setMpstatsToken] = useState('')
  const [ozonPerfClientId, setOzonPerfClientId] = useState('')
  const [ozonPerfClientSecret, setOzonPerfClientSecret] = useState('')
  const [jiraBaseUrl, setJiraBaseUrl] = useState('')
  const [jiraEmail, setJiraEmail] = useState('')
  const [jiraApiToken, setJiraApiToken] = useState('')
  const [trelloApiKey, setTrelloApiKey] = useState('')
  const [trelloToken, setTrelloToken] = useState('')
  const [yDirectLogin, setYDirectLogin] = useState('')
  const [skillsServerBase, setSkillsServerBase] = useState('')
  const [claudeOauthToken, setClaudeOauthToken] = useState('')
  const [yDiskToken, setYDiskToken] = useState('')
  const [githubToken, setGithubToken] = useState('')
  const [socialTgChannels, setSocialTgChannels] = useState('')
  const [socialVkToken, setSocialVkToken] = useState('')
  const [socialVkGroupId, setSocialVkGroupId] = useState('')
  const [socialWebhooks, setSocialWebhooks] = useState('')
  const [costCap, setCostCap] = useState('')
  const [costCapCurrency, setCostCapCurrency] = useState<CostCapCurrency>('USD')
  const [configuredConnectors, setConfiguredConnectors] = useState<Set<string>>(new Set())
  type ConnectorHealth = 'unknown' | 'checking' | 'ok' | 'error'
  type ConnectorCapability = { id: string; label: string; ok: boolean; message?: string }
  const [connectorHealth, setConnectorHealth] = useState<Record<string, ConnectorHealth>>({})
  const [connectorHealthMsg, setConnectorHealthMsg] = useState<Record<string, string>>({})
  const [connectorCapabilities, setConnectorCapabilities] = useState<Record<string, ConnectorCapability[]>>({})
  const [connectorApplying, setConnectorApplying] = useState<string | null>(null)
  const [openConnector, setOpenConnector] = useState<string | null>(null)
  const [connectorSearch, setConnectorSearch] = useState('')
  const [connectorFilter, setConnectorFilter] = useState<ConnectorFilter>('all')
  const [connectorSafety, setConnectorSafety] = useState<Record<string, ConnectorSafetyMode>>({})
  // Форма коннектора раскрывается сразу под карточкой — скроллим к ней при открытии.
  const connectorDetailRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (openConnector) connectorDetailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [openConnector])
  // Custom OpenAI-compatible: base URL + список моделей через запятую.
  // Сохраняется в settings.custom_openai_baseurl / custom_openai_models.
  const [customOpenaiBaseUrl, setCustomOpenaiBaseUrl] = useState('')
  const [customOpenaiModels, setCustomOpenaiModels] = useState('')
  const [currentLang, setCurrentLang] = useState('en')
  const { theme, setTheme } = useTheme()
  const { uiScalePercent, setUiScalePercent } = useUiScale()
  const {
    uiDensity,
    setUiDensity,
    motionLevel,
    setMotionLevel,
    projectStatusDisplay,
    setProjectStatusDisplay,
    resetAppearance
  } = useAppearance()
  const {
    notifyPrefs,
    setNotifyEnabled,
    setNotifyMode,
    setNotifyEventChannel,
    setQuietHoursEnabled,
    setQuietHoursTime,
    testNotification
  } = useNotifySettings()
  const [notifyTestMessage, setNotifyTestMessage] = useState('')

  useEffect(() => {
    void (async () => {
      const provider = await window.api.settings.getKey('provider')
      const valid = providers.some(p => p.id === provider) ? (provider as ProviderId) : 'gemini-api'
      setActiveProvider(valid)
      const keyVals: Record<string, string> = {}
      const modelVals: Record<string, string> = {}
      // Грузим ключи/модели всех провайдеров ПАРАЛЛЕЛЬНО (было последовательно —
      // 18 провайдеров × 2 await = ~36 IPC цепочкой, заметный лаг открытия).
      await Promise.all(providers.map(async p => {
        if (p.secretKey) {
          const v = await window.api.settings.getKey(p.secretKey)
          if (v) keyVals[p.secretKey] = v
        }
        const m = await window.api.settings.getKey(`model_${p.id}`)
        // 2.0.7-D: НЕ перезаписываем молча сохранённую модель на дефолт (карточка, шаг 5 —
        // «молчаливая подмена запрещена»). Устаревшую/отсутствующую в каталоге модель
        // ModelsPage показывает как «недоступна» + Doctor (resolveModelAvailability), а
        // save() ниже её НЕ переписывает обратно в settings. Полноценный блок «stale-модель
        // не уходит в backend» — задача среза 2.0.7-E (Model Doctor); здесь только UI-честность.
        modelVals[p.id] = m ?? p.defaultModel
      }))
      // Аудит: вторичные ключи RU-провайдеров (folder_id / client_secret / tls)
      // живут вне p.secretKey — грузим явно, иначе input пуст после перезагрузки
      // и YandexGPT/GigaChat невозможно настроить (теряется 2-й секрет).
      const [yFolder, gSecret, gTls] = await Promise.all([
        window.api.settings.getKey('yandex_folder_id'),
        window.api.settings.getKey('gigachat_client_secret'),
        window.api.settings.getKey('gigachat_tls_verify')
      ])
      if (yFolder) keyVals['yandex_folder_id'] = yFolder
      if (gSecret) keyVals['gigachat_client_secret'] = gSecret
      if (gTls) keyVals['gigachat_tls_verify'] = gTls
      setKeys(keyVals)
      setModels(modelVals)
      // 1С connector creds
      const url = await window.api.settings.getKey('onec_base_url')
      const user = await window.api.settings.getKey('onec_username')
      const pass = await window.api.settings.getKey('onec_password')
      setOneC({ url: url ?? '', user: user ?? '', pass: pass ?? '' })
      // HTTP endpoints
      const eps: typeof httpEndpoints = []
      for (let i = 1; i <= 4; i++) {
        eps.push({
          name:  (await window.api.settings.getKey(`http_endpoint_${i}_name`))  ?? '',
          base:  (await window.api.settings.getKey(`http_endpoint_${i}_base`))  ?? '',
          auth:  (await window.api.settings.getKey(`http_endpoint_${i}_auth`))  ?? '',
          paths: (await window.api.settings.getKey(`http_endpoint_${i}_paths`)) ?? ''
        })
      }
      setHttpEndpoints(eps)
      // V3 коннекторы
      // Плоские ключи коннекторов/прочего — ОДНОЙ параллельной пачкой. Раньше
      // здесь было ~50 последовательных await getKey (каждый ждёт предыдущего) —
      // главный источник лага открытия Settings после роста до 31 коннектора.
      const FLAT_KEYS = [
        'gsheets_service_account_json', 'telegram_bot_token', 'telegram_chat_whitelist', 'telegram_notify_chat_id',
        'ssh_default_host', 'ssh_key_path', 'bitrix24_webhook_url', 'yandex_direct_token',
        'dadata_api_key', 'dadata_secret', 'yandex_metrika_token', 'avito_client_id',
        'avito_client_secret', 'yandex_webmaster_token', 'yandex_wordstat_token', 'yandex_wordstat_auth_type',
        'yandex_wordstat_folder_id',
        'ozon_client_id', 'ozon_api_key', 'wildberries_token', 'yookassa_shop_id',
        'yookassa_secret_key', 'vk_access_token', 'amocrm_subdomain', 'amocrm_access_token',
        'moysklad_token', 'yandex_tracker_token', 'yandex_tracker_org_id', 'sendpulse_client_id',
        'sendpulse_client_secret', 'unisender_api_key', 'ga4_access_token', 'ga4_property_id',
        'notion_token', 'kontur_focus_api_key', 'mpstats_token', 'ozon_perf_client_id',
        'ozon_perf_client_secret', 'jira_base_url', 'jira_email', 'jira_api_token',
        'trello_api_key', 'trello_token', 'yandex_direct_login', 'skills_server_base',
        'claude_code_oauth_token', 'yandex_disk_token', 'github_token',
        'social_publish_telegram_channels', 'social_publish_vk_token', 'social_publish_vk_group_id',
        'social_publish_webhooks', 'cost_cap_usd_per_day', 'cost_cap_usd_per_session', 'cost_cap_value', 'cost_cap_currency', 'custom_openai_baseurl',
        'custom_openai_models', 'app_language'
      ]
      const F: Record<string, string> = Object.fromEntries(
        await Promise.all(FLAT_KEYS.map(async k => [k, (await window.api.settings.getKey(k)) ?? ''] as const))
      )
      setGsheetsJson(F['gsheets_service_account_json'])
      setTelegramBotToken(F['telegram_bot_token'])
      setTelegramWhitelist(F['telegram_chat_whitelist'])
      setTelegramNotifyChatId(F['telegram_notify_chat_id'])
      setSshHost(F['ssh_default_host'])
      setSshKeyPath(F['ssh_key_path'])
      {
        const storedBitrixWebhook = F['bitrix24_webhook_url']
        const bitrixValidationMessage = validateBitrixWebhookInput(storedBitrixWebhook)
        if (bitrixValidationMessage) {
          await window.api.settings.setKey('bitrix24_webhook_url', '')
          setBitrixWebhook('')
          setConnectorHealth(h => ({ ...h, bitrix: 'error' }))
          setConnectorHealthMsg(m => ({ ...m, bitrix: bitrixValidationMessage }))
          setConnectorCapabilities(c => ({ ...c, bitrix: [] }))
        } else {
          setBitrixWebhook(storedBitrixWebhook)
        }
      }
      setYDirectToken(F['yandex_direct_token'])
      setDadataApiKey(F['dadata_api_key'])
      setDadataSecret(F['dadata_secret'])
      setYMetrikaToken(F['yandex_metrika_token'])
      setAvitoClientId(F['avito_client_id'])
      setAvitoClientSecret(F['avito_client_secret'])
      setYWebmasterToken(F['yandex_webmaster_token'])
      setYWordstatToken(F['yandex_wordstat_token'])
      setYWordstatAuthType(F['yandex_wordstat_auth_type'] === 'iam' ? 'iam' : 'api-key')
      setYWordstatFolderId(F['yandex_wordstat_folder_id'])
      setOzonClientId(F['ozon_client_id'])
      setOzonApiKey(F['ozon_api_key'])
      setWbToken(F['wildberries_token'])
      setYookassaShopId(F['yookassa_shop_id'])
      setYookassaSecretKey(F['yookassa_secret_key'])
      setVkToken(F['vk_access_token'])
      setAmocrmSubdomain(F['amocrm_subdomain'])
      setAmocrmToken(F['amocrm_access_token'])
      setMoyskladToken(F['moysklad_token'])
      setYTrackerToken(F['yandex_tracker_token'])
      setYTrackerOrgId(F['yandex_tracker_org_id'])
      setSendpulseClientId(F['sendpulse_client_id'])
      setSendpulseClientSecret(F['sendpulse_client_secret'])
      setUnisenderApiKey(F['unisender_api_key'])
      setGa4Token(F['ga4_access_token'])
      setGa4PropertyId(F['ga4_property_id'])
      setNotionToken(F['notion_token'])
      setKonturFocusKey(F['kontur_focus_api_key'])
      setMpstatsToken(F['mpstats_token'])
      setOzonPerfClientId(F['ozon_perf_client_id'])
      setOzonPerfClientSecret(F['ozon_perf_client_secret'])
      setJiraBaseUrl(F['jira_base_url'])
      setJiraEmail(F['jira_email'])
      setJiraApiToken(F['jira_api_token'])
      setTrelloApiKey(F['trello_api_key'])
      setTrelloToken(F['trello_token'])
      setYDirectLogin(F['yandex_direct_login'])
      setSkillsServerBase(F['skills_server_base'])
      setClaudeOauthToken(F['claude_code_oauth_token'])
      setYDiskToken(F['yandex_disk_token'])
      setGithubToken(F['github_token'])
      setSocialTgChannels(F['social_publish_telegram_channels'])
      setSocialVkToken(F['social_publish_vk_token'])
      setSocialVkGroupId(F['social_publish_vk_group_id'])
      setSocialWebhooks(F['social_publish_webhooks'])
      const loadedCostCurrency = F['cost_cap_currency'] === 'RUB' ? 'RUB' : 'USD'
      setCostCapCurrency(loadedCostCurrency)
      setCostCap(F['cost_cap_value'] || F['cost_cap_usd_per_day'] || F['cost_cap_usd_per_session'])
      setCustomOpenaiBaseUrl(F['custom_openai_baseurl'])
      setCustomOpenaiModels(F['custom_openai_models'])
      setCurrentLang(F['app_language'] || 'en')
      // Какие модели «включены» в picker'е. Нет ключа = только активный провайдер.
      const em = await window.api.settings.getKey('enabled_models')
      if (em) {
        try {
          const arr = JSON.parse(em) as string[]
          setEnabledModels(Array.isArray(arr) ? new Set(arr) : defaultEnabledModels(providers, valid, modelVals))
        } catch {
          setEnabledModels(defaultEnabledModels(providers, valid, modelVals))
        }
      } else {
        setEnabledModels(defaultEnabledModels(providers, valid, modelVals))
      }
      setSettingsLoaded(true)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const settingsSnapshot = JSON.stringify({
    activeProvider,
    keys,
    models,
    enabledModels: [...enabledModels].sort(),
    onec,
    httpEndpoints,
    gsheetsJson,
    telegramBotToken,
    telegramWhitelist,
    telegramNotifyChatId,
    sshHost,
    sshKeyPath,
    bitrixWebhook,
    yDirectToken,
    dadataApiKey,
    dadataSecret,
    yMetrikaToken,
    avitoClientId,
    avitoClientSecret,
    yWebmasterToken,
    yWordstatToken,
    yWordstatAuthType,
    yWordstatFolderId,
    ozonClientId,
    ozonApiKey,
    wbToken,
    yookassaShopId,
    yookassaSecretKey,
    vkToken,
    amocrmSubdomain,
    amocrmToken,
    moyskladToken,
    yTrackerToken,
    yTrackerOrgId,
    sendpulseClientId,
    sendpulseClientSecret,
    unisenderApiKey,
    ga4Token,
    ga4PropertyId,
    notionToken,
    konturFocusKey,
    mpstatsToken,
    ozonPerfClientId,
    ozonPerfClientSecret,
    jiraBaseUrl,
    jiraEmail,
    jiraApiToken,
    trelloApiKey,
    trelloToken,
    yDirectLogin,
    skillsServerBase,
    claudeOauthToken,
    yDiskToken,
    githubToken,
    socialTgChannels,
    socialVkToken,
    socialVkGroupId,
    socialWebhooks,
    costCap,
    costCapCurrency,
    customOpenaiBaseUrl,
    customOpenaiModels
  })

  useEffect(() => {
    if (!settingsLoaded) return
    if (savedSnapshotRef.current === null) {
      savedSnapshotRef.current = settingsSnapshot
      setSettingsDirty(false)
      return
    }
    setSettingsDirty(savedSnapshotRef.current !== settingsSnapshot)
  }, [settingsLoaded, settingsSnapshot])


  async function isConnectorConfiguredId(c: ConnectorDef): Promise<boolean> {
    if (c.id === 'http') {
      for (let i = 1; i <= 4; i++) {
        const base = await window.api.settings.getKey(`http_endpoint_${i}_base`)
        if (base?.trim()) return true
      }
      return false
    }
    if (c.id === 'social-publish') {
      for (const k of ['social_publish_telegram_channels', 'social_publish_vk_token', 'social_publish_webhooks']) {
        const v = await window.api.settings.getKey(k)
        if (v?.trim()) return true
      }
      return false
    }
    if (c.id === 'ywordstat') {
      const token = await window.api.settings.getKey('yandex_wordstat_token')
      const folderId = await window.api.settings.getKey('yandex_wordstat_folder_id')
      return !!token?.trim() && !!folderId?.trim()
    }
    if (!c.configuredKey) return false
    const val = await window.api.settings.getKey(c.configuredKey)
    return !!val?.trim()
  }

  async function refreshConfiguredConnectors(): Promise<Set<string>> {
    const results = await Promise.all(CONNECTORS.map(async c =>
      (await isConnectorConfiguredId(c)) ? c.id : null
    ))
    const next = new Set(results.filter(Boolean) as string[])
    setConfiguredConnectors(next)
    return next
  }

  async function runConnectorTest(uiId: string): Promise<{ ok: boolean; message: string; capabilities?: ConnectorCapability[] }> {
    setConnectorHealth(h => ({ ...h, [uiId]: 'checking' }))
    try {
      const result = await window.api.connectors.test(uiId)
      setConnectorHealth(h => ({ ...h, [uiId]: result.ok ? 'ok' : 'error' }))
      setConnectorHealthMsg(m => ({ ...m, [uiId]: result.message }))
      setConnectorCapabilities(c => ({ ...c, [uiId]: result.capabilities ?? [] }))
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Ошибка проверки'
      setConnectorHealth(h => ({ ...h, [uiId]: 'error' }))
      setConnectorHealthMsg(m => ({ ...m, [uiId]: message }))
      setConnectorCapabilities(c => ({ ...c, [uiId]: [] }))
      return { ok: false, message }
    }
  }

  async function checkConnectorCurrentInput(uiId: string): Promise<void> {
    setConnectorApplying(uiId)
    try {
      await persistConnector(uiId)
      await window.api.settings.setKey(`connector_mode_${uiId}`, connectorSafety[uiId] ?? 'confirm')
      await refreshConfiguredConnectors()
      await runConnectorTest(uiId)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Не удалось проверить коннектор'
      setConnectorHealth(h => ({ ...h, [uiId]: 'error' }))
      setConnectorHealthMsg(m => ({ ...m, [uiId]: message }))
      setConnectorCapabilities(c => ({ ...c, [uiId]: [] }))
    } finally {
      setConnectorApplying(null)
    }
  }

  function markConnectorDirty(uiId: string): void {
    setConnectorHealth(h => h[uiId] === 'checking' ? h : ({ ...h, [uiId]: 'unknown' }))
    setConnectorHealthMsg(m => ({ ...m, [uiId]: '' }))
    setConnectorCapabilities(c => ({ ...c, [uiId]: [] }))
  }

  function validateBitrixWebhookInput(value: string): string | null {
    const trimmed = value.trim()
    if (!trimmed) return null
    if (/^(y0__|AQVN)/i.test(trimmed)) {
      return '\u0412 \u0411\u0438\u0442\u0440\u0438\u043a\u044124 \u0432\u0441\u0442\u0430\u0432\u043b\u0435\u043d \u0442\u043e\u043a\u0435\u043d \u042f\u043d\u0434\u0435\u043a\u0441\u0430. \u041d\u0443\u0436\u0435\u043d \u043f\u043e\u043b\u043d\u044b\u0439 URL \u0432\u0445\u043e\u0434\u044f\u0449\u0435\u0433\u043e webhook \u0438\u0437 \u0411\u0438\u0442\u0440\u0438\u043a\u044124'
    }
    try {
      const url = new URL(trimmed)
      const parts = url.pathname.split('/').filter(Boolean)
      const restIndex = parts.findIndex(part => part.toLowerCase() === 'rest')
      if (!/^https?:$/.test(url.protocol) || restIndex < 0 || parts.length < restIndex + 3) {
        return '\u0421\u043a\u043e\u043f\u0438\u0440\u0443\u0439 \u043f\u043e\u043b\u043d\u044b\u0439 Bitrix24 webhook URL \u0432\u0438\u0434\u0430 https://...bitrix24.ru/rest/USER_ID/TOKEN/'
      }
    } catch {
      return '\u0421\u043a\u043e\u043f\u0438\u0440\u0443\u0439 \u043f\u043e\u043b\u043d\u044b\u0439 Bitrix24 webhook URL \u0432\u0438\u0434\u0430 https://...bitrix24.ru/rest/USER_ID/TOKEN/'
    }
    return null
  }

  async function persistConnector(uiId: string): Promise<void> {
    switch (uiId) {
      case 'claude-oauth':
        await window.api.settings.setKey('claude_code_oauth_token', claudeOauthToken)
        break
      case 'onec':
        await window.api.settings.setKey('onec_base_url', onec.url)
        await window.api.settings.setKey('onec_username', onec.user)
        await window.api.settings.setKey('onec_password', onec.pass)
        break
      case 'http':
        for (let i = 0; i < httpEndpoints.length; i++) {
          const e = httpEndpoints[i]
          await window.api.settings.setKey(`http_endpoint_${i + 1}_name`, e.name)
          await window.api.settings.setKey(`http_endpoint_${i + 1}_base`, e.base)
          await window.api.settings.setKey(`http_endpoint_${i + 1}_auth`, e.auth)
          await window.api.settings.setKey(`http_endpoint_${i + 1}_paths`, e.paths)
        }
        break
      case 'gsheets':
        await window.api.settings.setKey('gsheets_service_account_json', gsheetsJson)
        break
      case 'telegram':
        await window.api.settings.setKey('telegram_bot_token', telegramBotToken)
        await window.api.settings.setKey('telegram_chat_whitelist', telegramWhitelist)
        await window.api.settings.setKey('telegram_notify_chat_id', telegramNotifyChatId)
        break
      case 'ssh':
        await window.api.settings.setKey('ssh_default_host', sshHost)
        await window.api.settings.setKey('ssh_key_path', sshKeyPath)
        break
      case 'bitrix':
        {
          const validationMessage = validateBitrixWebhookInput(bitrixWebhook)
          if (validationMessage) {
            await window.api.settings.setKey('bitrix24_webhook_url', '')
            setConnectorHealth(h => ({ ...h, bitrix: 'error' }))
            setConnectorHealthMsg(m => ({ ...m, bitrix: validationMessage }))
            setConnectorCapabilities(c => ({ ...c, bitrix: [] }))
            throw new Error(validationMessage)
          }
        }
        await window.api.settings.setKey('bitrix24_webhook_url', bitrixWebhook)
        break
      case 'ydirect':
        await window.api.settings.setKey('yandex_direct_token', yDirectToken)
        await window.api.settings.setKey('yandex_direct_login', yDirectLogin)
        break
      case 'ydisk':
        await window.api.settings.setKey('yandex_disk_token', yDiskToken)
        break
      case 'skills-server':
        await window.api.settings.setKey('skills_server_base', skillsServerBase)
        break
      case 'github':
        await window.api.settings.setKey('github_token', githubToken)
        break
      case 'social-publish':
        await window.api.settings.setKey('social_publish_telegram_channels', socialTgChannels)
        await window.api.settings.setKey('social_publish_vk_token', socialVkToken)
        await window.api.settings.setKey('social_publish_vk_group_id', socialVkGroupId)
        await window.api.settings.setKey('social_publish_webhooks', socialWebhooks)
        break
      case 'dadata':
        await window.api.settings.setKey('dadata_api_key', dadataApiKey)
        await window.api.settings.setKey('dadata_secret', dadataSecret)
        break
      case 'ymetrika':
        await window.api.settings.setKey('yandex_metrika_token', yMetrikaToken)
        break
      case 'avito':
        await window.api.settings.setKey('avito_client_id', avitoClientId)
        await window.api.settings.setKey('avito_client_secret', avitoClientSecret)
        break
      case 'ywebmaster':
        await window.api.settings.setKey('yandex_webmaster_token', yWebmasterToken)
        break
      case 'ywordstat':
        await window.api.settings.setKey('yandex_wordstat_token', yWordstatToken)
        await window.api.settings.setKey('yandex_wordstat_auth_type', yWordstatAuthType)
        await window.api.settings.setKey('yandex_wordstat_folder_id', yWordstatFolderId)
        break
      case 'ozon':
        await window.api.settings.setKey('ozon_client_id', ozonClientId)
        await window.api.settings.setKey('ozon_api_key', ozonApiKey)
        break
      case 'wildberries':
        await window.api.settings.setKey('wildberries_token', wbToken)
        break
      case 'yookassa':
        await window.api.settings.setKey('yookassa_shop_id', yookassaShopId)
        await window.api.settings.setKey('yookassa_secret_key', yookassaSecretKey)
        break
      case 'vk':
        await window.api.settings.setKey('vk_access_token', vkToken)
        break
      case 'amocrm':
        await window.api.settings.setKey('amocrm_subdomain', amocrmSubdomain)
        await window.api.settings.setKey('amocrm_access_token', amocrmToken)
        break
      case 'moysklad':
        await window.api.settings.setKey('moysklad_token', moyskladToken)
        break
      case 'yandex_tracker':
        await window.api.settings.setKey('yandex_tracker_token', yTrackerToken)
        await window.api.settings.setKey('yandex_tracker_org_id', yTrackerOrgId)
        break
      case 'sendpulse':
        await window.api.settings.setKey('sendpulse_client_id', sendpulseClientId)
        await window.api.settings.setKey('sendpulse_client_secret', sendpulseClientSecret)
        break
      case 'unisender':
        await window.api.settings.setKey('unisender_api_key', unisenderApiKey)
        break
      case 'ga4':
        await window.api.settings.setKey('ga4_access_token', ga4Token)
        await window.api.settings.setKey('ga4_property_id', ga4PropertyId)
        break
      case 'notion':
        await window.api.settings.setKey('notion_token', notionToken)
        break
      case 'kontur_focus':
        await window.api.settings.setKey('kontur_focus_api_key', konturFocusKey)
        break
      case 'mpstats':
        await window.api.settings.setKey('mpstats_token', mpstatsToken)
        break
      case 'ozon_performance':
        await window.api.settings.setKey('ozon_perf_client_id', ozonPerfClientId)
        await window.api.settings.setKey('ozon_perf_client_secret', ozonPerfClientSecret)
        break
      case 'jira':
        await window.api.settings.setKey('jira_base_url', jiraBaseUrl)
        await window.api.settings.setKey('jira_email', jiraEmail)
        await window.api.settings.setKey('jira_api_token', jiraApiToken)
        break
      case 'trello':
        await window.api.settings.setKey('trello_api_key', trelloApiKey)
        await window.api.settings.setKey('trello_token', trelloToken)
        break
      default:
        break
    }
  }

  async function applyConnector(uiId: string): Promise<void> {
    setConnectorApplying(uiId)
    try {
      await persistConnector(uiId)
      await window.api.settings.setKey(`connector_mode_${uiId}`, connectorSafety[uiId] ?? 'confirm')
      await refreshConfiguredConnectors()
      await runConnectorTest(uiId)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Не удалось сохранить коннектор'
      setConnectorHealth(h => ({ ...h, [uiId]: 'error' }))
      setConnectorHealthMsg(m => ({ ...m, [uiId]: message }))
      setConnectorCapabilities(c => ({ ...c, [uiId]: [] }))
    } finally {
      setConnectorApplying(null)
    }
  }

  async function saveConnectorOnly(uiId: string): Promise<void> {
    setConnectorApplying(uiId)
    try {
      await persistConnector(uiId)
      await window.api.settings.setKey(`connector_mode_${uiId}`, connectorSafety[uiId] ?? 'confirm')
      await refreshConfiguredConnectors()
      setConnectorHealthMsg(m => ({ ...m, [uiId]: 'Сохранено' }))
      setConnectorHealth(h => ({ ...h, [uiId]: 'unknown' }))
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Не удалось сохранить коннектор'
      setConnectorHealth(h => ({ ...h, [uiId]: 'error' }))
      setConnectorHealthMsg(m => ({ ...m, [uiId]: message }))
      setConnectorCapabilities(c => ({ ...c, [uiId]: [] }))
    } finally {
      setConnectorApplying(null)
    }
  }

  function resetConnectorLocalState(uiId: string): void {
    switch (uiId) {
      case 'claude-oauth': setClaudeOauthToken(''); break
      case 'onec': setOneC({ url: '', user: '', pass: '' }); break
      case 'http': setHttpEndpoints([{ name: '', base: '', auth: '', paths: '' }, { name: '', base: '', auth: '', paths: '' }, { name: '', base: '', auth: '', paths: '' }, { name: '', base: '', auth: '', paths: '' }]); break
      case 'gsheets': setGsheetsJson(''); break
      case 'telegram': setTelegramBotToken(''); setTelegramWhitelist(''); setTelegramNotifyChatId(''); break
      case 'ssh': setSshHost(''); setSshKeyPath(''); break
      case 'bitrix': setBitrixWebhook(''); break
      case 'ydirect': setYDirectToken(''); setYDirectLogin(''); break
      case 'ydisk': setYDiskToken(''); break
      case 'skills-server': setSkillsServerBase(''); break
      case 'github': setGithubToken(''); break
      case 'social-publish': setSocialTgChannels(''); setSocialVkToken(''); setSocialVkGroupId(''); setSocialWebhooks(''); break
      case 'dadata': setDadataApiKey(''); setDadataSecret(''); break
      case 'ymetrika': setYMetrikaToken(''); break
      case 'avito': setAvitoClientId(''); setAvitoClientSecret(''); break
      case 'ywebmaster': setYWebmasterToken(''); break
      case 'ywordstat': setYWordstatToken(''); setYWordstatAuthType('api-key'); setYWordstatFolderId(''); break
      case 'ozon': setOzonClientId(''); setOzonApiKey(''); break
      case 'wildberries': setWbToken(''); break
      case 'yookassa': setYookassaShopId(''); setYookassaSecretKey(''); break
      case 'vk': setVkToken(''); break
      case 'amocrm': setAmocrmSubdomain(''); setAmocrmToken(''); break
      case 'moysklad': setMoyskladToken(''); break
      case 'yandex_tracker': setYTrackerToken(''); setYTrackerOrgId(''); break
      case 'sendpulse': setSendpulseClientId(''); setSendpulseClientSecret(''); break
      case 'unisender': setUnisenderApiKey(''); break
      case 'ga4': setGa4Token(''); setGa4PropertyId(''); break
      case 'notion': setNotionToken(''); break
      case 'kontur_focus': setKonturFocusKey(''); break
      case 'mpstats': setMpstatsToken(''); break
      case 'ozon_performance': setOzonPerfClientId(''); setOzonPerfClientSecret(''); break
      case 'jira': setJiraBaseUrl(''); setJiraEmail(''); setJiraApiToken(''); break
      case 'trello': setTrelloApiKey(''); setTrelloToken(''); break
      default: break
    }
  }

  async function deleteConnectorKeys(uiId: string): Promise<void> {
    setConnectorApplying(uiId)
    try {
      const keysToClear = [...(CONNECTOR_SETTING_KEYS[uiId] ?? []), `connector_mode_${uiId}`]
      await Promise.all(keysToClear.map(key => window.api.settings.setKey(key, '')))
      resetConnectorLocalState(uiId)
      setConnectorSafety(s => {
        const next = { ...s }
        delete next[uiId]
        return next
      })
      await refreshConfiguredConnectors()
      setConnectorHealth(h => ({ ...h, [uiId]: 'unknown' }))
      setConnectorHealthMsg(m => ({ ...m, [uiId]: 'Ключ удалён' }))
    } finally {
      setConnectorApplying(null)
    }
  }

  // Коннекторы: список настроенных + фоновая проверка токенов
  useEffect(() => {
    if (tab !== 'connectors') return
    let cancelled = false
    void (async () => {
      const configured = await refreshConfiguredConnectors()
      if (cancelled) return
      const modes = await Promise.all(CONNECTORS.map(async c => {
        const raw = await window.api.settings.getKey(`connector_mode_${c.id}`)
        const mode = raw === 'read' || raw === 'write' || raw === 'confirm' ? raw : 'confirm'
        return [c.id, mode] as const
      }))
      if (!cancelled) setConnectorSafety(Object.fromEntries(modes))
      await Promise.all([...configured].map(id => runConnectorTest(id)))
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  async function save() {
    setSaving(true)
    try {
    await window.api.settings.setKey('provider', activeProvider)
    for (const p of providers) {
      if (p.secretKey && keys[p.secretKey] !== undefined) {
        await window.api.settings.setKey(p.secretKey, keys[p.secretKey])
      }
      // 2.0.7-D: не «цементируем» устаревшую модель. Если сохранённое значение вне
      // каталога провайдера (показано как «недоступна»), НЕ переписываем его обратно —
      // иначе Save закреплял бы мёртвую модель. Валидную/пользовательскую пишем как есть.
      if (models[p.id] && resolveModelAvailability(p.models, models[p.id]) !== 'unavailable') {
        await window.api.settings.setKey(`model_${p.id}`, models[p.id])
      }
    }
    // Вторичные ключи RU-провайдеров: основной p.secretKey пишется в цикле выше,
    // а второй (folder_id / client_secret / tls) — нет. Без этого YandexGPT и
    // GigaChat невозможно настроить (теряется на перезагрузке).
    if (keys['yandex_folder_id'] !== undefined) await window.api.settings.setKey('yandex_folder_id', keys['yandex_folder_id'])
    if (keys['gigachat_client_secret'] !== undefined) await window.api.settings.setKey('gigachat_client_secret', keys['gigachat_client_secret'])
    if (keys['gigachat_tls_verify'] !== undefined) await window.api.settings.setKey('gigachat_tls_verify', keys['gigachat_tls_verify'])
    await window.api.settings.setKey('onec_base_url', onec.url)
    await window.api.settings.setKey('onec_username', onec.user)
    await window.api.settings.setKey('onec_password', onec.pass)
    for (let i = 0; i < httpEndpoints.length; i++) {
      const e = httpEndpoints[i]
      await window.api.settings.setKey(`http_endpoint_${i + 1}_name`,  e.name)
      await window.api.settings.setKey(`http_endpoint_${i + 1}_base`,  e.base)
      await window.api.settings.setKey(`http_endpoint_${i + 1}_auth`,  e.auth)
      await window.api.settings.setKey(`http_endpoint_${i + 1}_paths`, e.paths)
    }
    // V3 — российские коннекторы и server skills
    await window.api.settings.setKey('gsheets_service_account_json', gsheetsJson)
    await window.api.settings.setKey('telegram_bot_token', telegramBotToken)
    await window.api.settings.setKey('telegram_chat_whitelist', telegramWhitelist)
    await window.api.settings.setKey('telegram_notify_chat_id', telegramNotifyChatId)
    await window.api.settings.setKey('ssh_default_host', sshHost)
    await window.api.settings.setKey('ssh_key_path', sshKeyPath)
    {
      const validationMessage = validateBitrixWebhookInput(bitrixWebhook)
      if (validationMessage) {
        await window.api.settings.setKey('bitrix24_webhook_url', '')
        setConnectorHealth(h => ({ ...h, bitrix: 'error' }))
        setConnectorHealthMsg(m => ({ ...m, bitrix: validationMessage }))
        setConnectorCapabilities(c => ({ ...c, bitrix: [] }))
      } else {
        await window.api.settings.setKey('bitrix24_webhook_url', bitrixWebhook)
      }
    }
    await window.api.settings.setKey('yandex_direct_token', yDirectToken)
    await window.api.settings.setKey('dadata_api_key', dadataApiKey)
    await window.api.settings.setKey('dadata_secret', dadataSecret)
    await window.api.settings.setKey('yandex_metrika_token', yMetrikaToken)
    await window.api.settings.setKey('avito_client_id', avitoClientId)
    await window.api.settings.setKey('avito_client_secret', avitoClientSecret)
    await window.api.settings.setKey('yandex_webmaster_token', yWebmasterToken)
    await window.api.settings.setKey('yandex_wordstat_token', yWordstatToken)
    await window.api.settings.setKey('yandex_wordstat_auth_type', yWordstatAuthType)
    await window.api.settings.setKey('yandex_wordstat_folder_id', yWordstatFolderId)
    await window.api.settings.setKey('ozon_client_id', ozonClientId)
    await window.api.settings.setKey('ozon_api_key', ozonApiKey)
    await window.api.settings.setKey('wildberries_token', wbToken)
    await window.api.settings.setKey('yookassa_shop_id', yookassaShopId)
    await window.api.settings.setKey('yookassa_secret_key', yookassaSecretKey)
    await window.api.settings.setKey('vk_access_token', vkToken)
    await window.api.settings.setKey('amocrm_subdomain', amocrmSubdomain)
    await window.api.settings.setKey('amocrm_access_token', amocrmToken)
    await window.api.settings.setKey('moysklad_token', moyskladToken)
    await window.api.settings.setKey('yandex_tracker_token', yTrackerToken)
    await window.api.settings.setKey('yandex_tracker_org_id', yTrackerOrgId)
    await window.api.settings.setKey('sendpulse_client_id', sendpulseClientId)
    await window.api.settings.setKey('sendpulse_client_secret', sendpulseClientSecret)
    await window.api.settings.setKey('unisender_api_key', unisenderApiKey)
    await window.api.settings.setKey('ga4_access_token', ga4Token)
    await window.api.settings.setKey('ga4_property_id', ga4PropertyId)
    await window.api.settings.setKey('notion_token', notionToken)
    await window.api.settings.setKey('kontur_focus_api_key', konturFocusKey)
    await window.api.settings.setKey('mpstats_token', mpstatsToken)
    await window.api.settings.setKey('ozon_perf_client_id', ozonPerfClientId)
    await window.api.settings.setKey('ozon_perf_client_secret', ozonPerfClientSecret)
    await window.api.settings.setKey('jira_base_url', jiraBaseUrl)
    await window.api.settings.setKey('jira_email', jiraEmail)
    await window.api.settings.setKey('jira_api_token', jiraApiToken)
    await window.api.settings.setKey('trello_api_key', trelloApiKey)
    await window.api.settings.setKey('trello_token', trelloToken)
    await window.api.settings.setKey('yandex_direct_login', yDirectLogin)
    await window.api.settings.setKey('skills_server_base', skillsServerBase)
    await window.api.settings.setKey('claude_code_oauth_token', claudeOauthToken)
    await window.api.settings.setKey('yandex_disk_token', yDiskToken)
    await window.api.settings.setKey('github_token', githubToken)
    await window.api.settings.setKey('social_publish_telegram_channels', socialTgChannels)
    await window.api.settings.setKey('social_publish_vk_token', socialVkToken)
    await window.api.settings.setKey('social_publish_vk_group_id', socialVkGroupId)
    await window.api.settings.setKey('social_publish_webhooks', socialWebhooks)
    await window.api.settings.setKey('cost_cap_value', costCap)
    await window.api.settings.setKey('cost_cap_currency', costCapCurrency)
    await window.api.settings.setKey('cost_cap_usd_per_day', costCapToUsd(costCap, costCapCurrency))
    await window.api.settings.setKey('cost_cap_usd_per_session', '')
    await window.api.settings.setKey('enabled_models', JSON.stringify([...enabledModels]))
    await window.api.settings.setKey('custom_openai_baseurl', customOpenaiBaseUrl)
    await window.api.settings.setKey('custom_openai_models', customOpenaiModels)
    savedSnapshotRef.current = settingsSnapshot
    setSettingsDirty(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
    } finally {
      setSaving(false)
    }
  }

  function renderConnectorForm(id: string): React.ReactNode {
    switch (id) {
      case 'claude-oauth': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Long-lived OAuth token</label>
            <input
              className="gg-input"
              type="password"
              value={claudeOauthToken}
              onChange={e => setClaudeOauthToken(e.target.value)}
              placeholder="sk-ant-oat01-... (из `claude setup-token` в PowerShell)"
              autoComplete="new-password"
            />
          </div>
          <div className="gg-settings-hint">
            Claude Code v2.1+ в headless режиме (через нашу программу) НЕ использует Max OAuth напрямую — требует
            long-lived token. Получи: <code>claude setup-token</code> в PowerShell → подтверди в браузере →
            копируй token сюда. Verstak будет передавать его как env var <code>CLAUDE_CODE_OAUTH_TOKEN</code>
            при запуске claude. Решает «401 Invalid credentials» при выборе провайдера Claude Code.
            Хранится зашифрованным через safeStorage. Действителен 1 год.
          </div>
        </>
      )
      case 'onec': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">1С OData base URL</label>
            <input
              className="gg-input"
              value={onec.url}
              onChange={e => setOneC(s => ({ ...s, url: e.target.value }))}
              placeholder="https://1c.example.com/base/odata/standard.odata"
              spellCheck={false}
            />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Логин</label>
            <input
              className="gg-input"
              value={onec.user}
              onChange={e => setOneC(s => ({ ...s, user: e.target.value }))}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Пароль</label>
            <input
              className="gg-input"
              type="password"
              value={onec.pass}
              onChange={e => setOneC(s => ({ ...s, pass: e.target.value }))}
              autoComplete="new-password"
            />
          </div>
          <div className="gg-settings-hint">
            Кред хранится зашифрованным в Electron safeStorage. AI может звать
            tool <code>connector_query</code> с id=<code>onec</code>; пароль
            никогда не попадает в промпт.
          </div>
        </>
      )
      case 'http': return (
        <>
          {httpEndpoints.map((ep, i) => (
            <div key={i} className="gg-http-endpoint">
              <div className="gg-http-endpoint-head">#{i + 1}</div>
              <div className="gg-settings-row">
                <label className="gg-settings-label">Имя</label>
                <input className="gg-input" value={ep.name} placeholder='напр. "github" или "internal-api"'
                  onChange={e => setHttpEndpoints(arr => arr.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                  spellCheck={false} />
              </div>
              <div className="gg-settings-row">
                <label className="gg-settings-label">Base URL</label>
                <input className="gg-input" value={ep.base} placeholder="https://api.github.com"
                  onChange={e => setHttpEndpoints(arr => arr.map((x, j) => j === i ? { ...x, base: e.target.value } : x))}
                  spellCheck={false} />
              </div>
              <div className="gg-settings-row">
                <label className="gg-settings-label">Authorization</label>
                <input className="gg-input" type="password" value={ep.auth} placeholder='напр. "Bearer ghp_…"'
                  onChange={e => setHttpEndpoints(arr => arr.map((x, j) => j === i ? { ...x, auth: e.target.value } : x))}
                  autoComplete="new-password" />
              </div>
              <div className="gg-settings-row">
                <label className="gg-settings-label">Allow-paths</label>
                <input className="gg-input" value={ep.paths} placeholder="/repos,/user (пусто = всё под base)"
                  onChange={e => setHttpEndpoints(arr => arr.map((x, j) => j === i ? { ...x, paths: e.target.value } : x))}
                  spellCheck={false} />
              </div>
            </div>
          ))}
          <div className="gg-settings-hint">
            AI вызывает <code>connector_query</code> с <code>id="http"</code>,
            <code>endpoint=&lt;имя&gt;</code> и path/method/query/body/headers.
            Auth-заголовок подставляется из настроек, AI его не видит.
            Allow-paths ограничивает к каким путям эндпоинта можно обращаться.
          </div>
        </>
      )
      case 'gsheets': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Service Account JSON</label>
            <textarea
              className="gg-input"
              value={gsheetsJson}
              onChange={e => setGsheetsJson(e.target.value)}
              placeholder='{"type": "service_account", "client_email": "...", "private_key": "-----BEGIN PRIVATE KEY-----\\n...", ...}'
              rows={5}
              style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}
              spellCheck={false}
            />
          </div>
          <div className="gg-settings-hint">
            JSON service account (как в <code>/opt/los/creds.json</code>). Шифруется через safeStorage.
            AI вызывает <code>connector_query</code> с <code>id="gsheets"</code> и <code>op="read_as_records"</code> /
            <code>"update_row"</code> / etc. См. electron/connectors/gsheets.ts.
          </div>
        </>
      )
      case 'telegram': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Bot token</label>
            <input
              className="gg-input"
              type="password"
              value={telegramBotToken}
              onChange={e => setTelegramBotToken(e.target.value)}
              placeholder="1234567890:AAH... (от @BotFather)"
              autoComplete="new-password"
            />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Chat whitelist (JSON)</label>
            <input
              className="gg-input"
              value={telegramWhitelist}
              onChange={e => setTelegramWhitelist(e.target.value)}
              placeholder='["-1003242936373", "@private_chat"]'
              style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}
              spellCheck={false}
            />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Уведомления о прогоне → chat_id</label>
            <input
              className="gg-input"
              value={telegramNotifyChatId}
              onChange={e => setTelegramNotifyChatId(e.target.value)}
              placeholder='123456789 (твой chat_id; пусто = выкл)'
              style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}
              spellCheck={false}
            />
          </div>
          <div className="gg-settings-hint">
            JSON-массив chat_id куда боту разрешено отправлять. Пустая строка = всем (только dev).
            Rate limit 20 send/min на chat_id вшит в коннектор. Read истории — через SSH к Telethon скрипту.
            <br/>Поле «Уведомления о прогоне» (opt-in): запустил агента и ушёл — бот сам пришлёт в этот chat_id, когда прогон завершился / упал / ждёт ревью. Только исходящее. Chat_id должен быть в whitelist.
          </div>
        </>
      )
      case 'ssh': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Default host</label>
            <input
              className="gg-input"
              value={sshHost}
              onChange={e => setSshHost(e.target.value)}
              placeholder="user@server.example.com или alias из ~/.ssh/config"
              spellCheck={false}
            />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Path к private key</label>
            <input
              className="gg-input"
              value={sshKeyPath}
              onChange={e => setSshKeyPath(e.target.value)}
              placeholder="~/.ssh/id_ed25519 (или полный путь к приватному ключу)"
              spellCheck={false}
            />
          </div>
          <div className="gg-settings-hint">
            Whitelist: только default host разрешён для запросов. Команды денилист:
            rm -rf системных корней, mkfs, dd на /dev, passwd, sudo su, systemctl stop, и т.п.
            Через connector_query с <code>id="ssh"</code> и <code>op="run_remote"</code>.
          </div>
        </>
      )
      case 'bitrix': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Incoming webhook URL</label>
            <input
              className="gg-input"
              type="password"
              value={bitrixWebhook}
              onChange={e => { setBitrixWebhook(e.target.value); markConnectorDirty('bitrix') }}
              placeholder="https://your-portal.bitrix24.ru/rest/USER_ID/TOKEN/"
              autoComplete="new-password"
            />
          </div>
          <div className="gg-settings-hint">
            Создать в Битрикс24: Разработчикам → Другое → Входящий вебхук. Полный URL с токеном.
            Denied methods: *.delete (crm.deal/lead/contact/company/user). Allowed prefixes: crm.*, tasks.*, user.*.
          </div>
        </>
      )
      case 'ydirect': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">OAuth token</label>
            <input
              className="gg-input"
              type="password"
              value={yDirectToken}
              onChange={e => setYDirectToken(e.target.value)}
              placeholder="Получить: oauth.yandex.ru, scope: direct:api"
              autoComplete="new-password"
            />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Client-Login (опц.)</label>
            <input
              className="gg-input"
              value={yDirectLogin}
              onChange={e => setYDirectLogin(e.target.value)}
              placeholder="Login проекта в Директе — для агентских аккаунтов"
              spellCheck={false}
            />
          </div>
          <div className="gg-settings-hint">
            Reports API асинхронный — connector polls до 30s. Если отчёт большой,
            возвращается <code>processing: true</code>, повторяй запрос.
          </div>
        </>
      )
      case 'dadata': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">API key</label>
            <input
              className="gg-input"
              type="password"
              value={dadataApiKey}
              onChange={e => setDadataApiKey(e.target.value)}
              placeholder="Token из dadata.ru/profile/#info"
              autoComplete="new-password"
            />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Secret (опц.)</label>
            <input
              className="gg-input"
              type="password"
              value={dadataSecret}
              onChange={e => setDadataSecret(e.target.value)}
              placeholder="Нужен только для clean_address (стандартизация)"
              autoComplete="new-password"
            />
          </div>
          <div className="gg-settings-hint">
            Операции: find_party (контрагент по ИНН/ОГРН), suggest_party, suggest_address,
            suggest_bank, clean_address. Подсказки работают по одному API key; clean_address
            требует Secret.
          </div>
        </>
      )
      case 'ymetrika': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">OAuth token</label>
            <input
              className="gg-input"
              type="password"
              value={yMetrikaToken}
              onChange={e => setYMetrikaToken(e.target.value)}
              placeholder="oauth.yandex.ru, scope metrika:read"
              autoComplete="new-password"
            />
          </div>
          <div className="gg-settings-hint">
            Операции: list_counters, get_traffic (визиты/посетители/отказы по дням),
            get_sources (источники), list_goals. Период — date1/date2 (YYYY-MM-DD или 7daysAgo/today).
          </div>
        </>
      )
      case 'avito': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Client ID</label>
            <input
              className="gg-input"
              value={avitoClientId}
              onChange={e => setAvitoClientId(e.target.value)}
              placeholder="client_id приложения developers.avito.ru"
              spellCheck={false}
            />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Client Secret</label>
            <input
              className="gg-input"
              type="password"
              value={avitoClientSecret}
              onChange={e => setAvitoClientSecret(e.target.value)}
              placeholder="client_secret"
              autoComplete="new-password"
            />
          </div>
          <div className="gg-settings-hint">
            OAuth2 client_credentials — токен получается автоматически и кэшируется.
            Операции: list_items, get_stats (показы/контакты), get_balance.
          </div>
        </>
      )
      case 'ywebmaster': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">OAuth token</label>
            <input
              className="gg-input"
              type="password"
              value={yWebmasterToken}
              onChange={e => setYWebmasterToken(e.target.value)}
              placeholder="oauth.yandex.ru, scope webmaster:hostinfo"
              autoComplete="new-password"
            />
          </div>
          <div className="gg-settings-hint">
            Операции: list_hosts, get_summary (ИКС + проблемы), get_queries (топ запросов
            с показами/кликами). host_id берётся из list_hosts.
          </div>
        </>
      )
      case 'ywordstat': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Авторизация</label>
            <select
              className="gg-input"
              value={yWordstatAuthType}
              onChange={e => { setYWordstatAuthType(e.target.value === 'iam' ? 'iam' : 'api-key'); markConnectorDirty('ywordstat') }}
            >
              <option value="api-key">API-ключ</option>
              <option value="iam">IAM-токен</option>
            </select>
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">{yWordstatAuthType === 'iam' ? 'IAM-токен' : 'API-ключ Yandex AI Studio'}</label>
            <input
              className="gg-input"
              type="password"
              value={yWordstatToken}
              onChange={e => { setYWordstatToken(e.target.value); markConnectorDirty('ywordstat') }}
              placeholder={yWordstatAuthType === 'iam' ? 'Bearer IAM-токен' : 'API-ключ Yandex AI Studio с областью yc.search-api.execute'}
              autoComplete="new-password"
            />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Идентификатор каталога</label>
            <input
              className="gg-input"
              value={yWordstatFolderId}
              onChange={e => { setYWordstatFolderId(e.target.value.trim()); markConnectorDirty('ywordstat') }}
              placeholder="Идентификатор каталога Yandex Cloud"
              autoComplete="off"
            />
          </div>
          <div className="gg-settings-hint">
            Вордстат работает через Search API в Yandex AI Studio. Вставь API-ключ из того же каталога, где подключён Search API, и укажи идентификатор каталога. Для сервисного аккаунта нужна роль search-api.webSearch.user, для API-ключа — область yc.search-api.execute
          </div>
        </>
      )
      case 'moysklad': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Token</label>
            <input className="gg-input" type="password" value={moyskladToken} onChange={e => setMoyskladToken(e.target.value)} placeholder="Bearer-токен МойСклад (Настройки → API)" autoComplete="new-password" />
          </div>
          <div className="gg-settings-hint">Операции: list_products, list_orders, get_stock.</div>
        </>
      )
      case 'yandex_tracker': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">OAuth token</label>
            <input className="gg-input" type="password" value={yTrackerToken} onChange={e => setYTrackerToken(e.target.value)} placeholder="oauth.yandex.ru, доступ к Трекеру" autoComplete="new-password" />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">X-Org-ID</label>
            <input className="gg-input" value={yTrackerOrgId} onChange={e => setYTrackerOrgId(e.target.value)} placeholder="ID организации Трекера" spellCheck={false} />
          </div>
          <div className="gg-settings-hint">Операции: list_queues, list_issues (queue), get_issue.</div>
        </>
      )
      case 'sendpulse': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Client ID</label>
            <input className="gg-input" value={sendpulseClientId} onChange={e => setSendpulseClientId(e.target.value)} placeholder="ID из SendPulse → API" spellCheck={false} />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Client Secret</label>
            <input className="gg-input" type="password" value={sendpulseClientSecret} onChange={e => setSendpulseClientSecret(e.target.value)} placeholder="Secret" autoComplete="new-password" />
          </div>
          <div className="gg-settings-hint">OAuth2 client_credentials (токен кэшируется). Операции: list_mailing_lists, list_campaigns, get_balance.</div>
        </>
      )
      case 'unisender': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">API key</label>
            <input className="gg-input" type="password" value={unisenderApiKey} onChange={e => setUnisenderApiKey(e.target.value)} placeholder="Личный кабинет → Настройки → API" autoComplete="new-password" />
          </div>
          <div className="gg-settings-hint">Операции: get_lists, get_campaigns, get_campaign_stats.</div>
        </>
      )
      case 'ga4': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Access token</label>
            <input className="gg-input" type="password" value={ga4Token} onChange={e => setGa4Token(e.target.value)} placeholder="OAuth Bearer, scope analytics.readonly" autoComplete="new-password" />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Property ID</label>
            <input className="gg-input" value={ga4PropertyId} onChange={e => setGa4PropertyId(e.target.value)} placeholder="Числовой ID ресурса GA4" spellCheck={false} />
          </div>
          <div className="gg-settings-hint">Операции: run_report (metrics/dimensions/период), get_realtime.</div>
        </>
      )
      case 'notion': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Integration token</label>
            <input className="gg-input" type="password" value={notionToken} onChange={e => setNotionToken(e.target.value)} placeholder="notion.so/my-integrations (Internal)" autoComplete="new-password" />
          </div>
          <div className="gg-settings-hint">Подключи интеграцию к нужным страницам. Операции: search, query_database, get_page.</div>
        </>
      )
      case 'kontur_focus': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">API key</label>
            <input className="gg-input" type="password" value={konturFocusKey} onChange={e => setKonturFocusKey(e.target.value)} placeholder="Ключ Focus API 3.0" autoComplete="new-password" />
          </div>
          <div className="gg-settings-hint">Операции: req (реквизиты по ИНН/ОГРН), analytics (риск-маркеры).</div>
        </>
      )
      case 'mpstats': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Token</label>
            <input className="gg-input" type="password" value={mpstatsToken} onChange={e => setMpstatsToken(e.target.value)} placeholder="X-Mpstats-TOKEN" autoComplete="new-password" />
          </div>
          <div className="gg-settings-hint">⚠️ Бета — проверь на своём аккаунте. Операции: аналитика категорий/товаров WB.</div>
        </>
      )
      case 'ozon_performance': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Client ID</label>
            <input className="gg-input" value={ozonPerfClientId} onChange={e => setOzonPerfClientId(e.target.value)} placeholder="client_id Performance API" spellCheck={false} />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Client Secret</label>
            <input className="gg-input" type="password" value={ozonPerfClientSecret} onChange={e => setOzonPerfClientSecret(e.target.value)} placeholder="client_secret" autoComplete="new-password" />
          </div>
          <div className="gg-settings-hint">⚠️ Бета — проверь на аккаунте. Операции: list_campaigns, list_objects.</div>
        </>
      )
      case 'jira': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Base URL</label>
            <input className="gg-input" value={jiraBaseUrl} onChange={e => setJiraBaseUrl(e.target.value)} placeholder="https://company.atlassian.net" spellCheck={false} />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Email</label>
            <input className="gg-input" value={jiraEmail} onChange={e => setJiraEmail(e.target.value)} placeholder="email Atlassian" spellCheck={false} />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">API token</label>
            <input className="gg-input" type="password" value={jiraApiToken} onChange={e => setJiraApiToken(e.target.value)} placeholder="id.atlassian.com → API tokens" autoComplete="new-password" />
          </div>
          <div className="gg-settings-hint">Операции: search_issues (JQL), get_issue, list_projects.</div>
        </>
      )
      case 'trello': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">API key</label>
            <input className="gg-input" value={trelloApiKey} onChange={e => setTrelloApiKey(e.target.value)} placeholder="trello.com/app-key" spellCheck={false} />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Token</label>
            <input className="gg-input" type="password" value={trelloToken} onChange={e => setTrelloToken(e.target.value)} placeholder="токен авторизации Trello" autoComplete="new-password" />
          </div>
          <div className="gg-settings-hint">Операции: list_boards, list_lists (board_id), list_cards (list_id).</div>
        </>
      )
      case 'ozon': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Client-Id</label>
            <input className="gg-input" value={ozonClientId} onChange={e => setOzonClientId(e.target.value)} placeholder="Client-Id продавца" spellCheck={false} />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Api-Key</label>
            <input className="gg-input" type="password" value={ozonApiKey} onChange={e => setOzonApiKey(e.target.value)} placeholder="Api-Key (Seller → Настройки → API-ключи)" autoComplete="new-password" />
          </div>
          <div className="gg-settings-hint">Операции: list_products, get_stocks, get_analytics (date_from/date_to), get_transactions.</div>
        </>
      )
      case 'wildberries': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Token (Статистика)</label>
            <input className="gg-input" type="password" value={wbToken} onChange={e => setWbToken(e.target.value)} placeholder="ЛК WB → Доступ к API → категория «Статистика»" autoComplete="new-password" />
          </div>
          <div className="gg-settings-hint">Операции: get_sales, get_orders, get_stocks (date_from, по умолчанию 7 дней назад).</div>
        </>
      )
      case 'yookassa': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">shopId</label>
            <input className="gg-input" value={yookassaShopId} onChange={e => setYookassaShopId(e.target.value)} placeholder="Идентификатор магазина" spellCheck={false} />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Секретный ключ</label>
            <input className="gg-input" type="password" value={yookassaSecretKey} onChange={e => setYookassaSecretKey(e.target.value)} placeholder="live_… / test_…" autoComplete="new-password" />
          </div>
          <div className="gg-settings-hint">Только чтение: list_payments, get_payment, list_refunds. Создание платежей намеренно недоступно.</div>
        </>
      )
      case 'vk': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Access token</label>
            <input className="gg-input" type="password" value={vkToken} onChange={e => setVkToken(e.target.value)} placeholder="oauth/сервисный токен VK" autoComplete="new-password" />
          </div>
          <div className="gg-settings-hint">Операции: group_info, wall_get (owner_id для группы отрицательный), users_get.</div>
        </>
      )
      case 'amocrm': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Поддомен</label>
            <input className="gg-input" value={amocrmSubdomain} onChange={e => setAmocrmSubdomain(e.target.value)} placeholder="mycompany (без .amocrm.ru)" spellCheck={false} />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Access token</label>
            <input className="gg-input" type="password" value={amocrmToken} onChange={e => setAmocrmToken(e.target.value)} placeholder="long-lived токен интеграции" autoComplete="new-password" />
          </div>
          <div className="gg-settings-hint">Операции: list_leads, list_contacts, list_pipelines, get_lead.</div>
        </>
      )
      case 'ydisk': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">OAuth token</label>
            <input
              className="gg-input"
              type="password"
              value={yDiskToken}
              onChange={e => setYDiskToken(e.target.value)}
              placeholder="oauth.yandex.ru со scope cloud_api:disk.write"
              autoComplete="new-password"
            />
          </div>
          <div className="gg-settings-hint">
            Используется агентом для публичных ссылок на артефакты проекта:
            upload_file → get_public_url → отправка ссылки в TG.
            Загрузка идёт в <code>/Verstak/{`{дата}`}/</code> чтобы не засорять корень Диска.
          </div>
        </>
      )
      case 'skills-server': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Skills server base URL</label>
            <input
              className="gg-input"
              value={skillsServerBase}
              onChange={e => setSkillsServerBase(e.target.value)}
              placeholder="https://your-skills-server.example.com (или пусто для built-in only)"
              spellCheck={false}
            />
          </div>
          <div className="gg-settings-hint">
            Сервер должен предоставлять <code>GET /api/skills</code> возвращающий
            <code>{`{skills: [{id, raw, sourceRef}]}`}</code>. Если недоступен — используются built-in
            (code-review / git-summary / explain-code) + локальные из ~/.verstak/skills/.
          </div>
        </>
      )
      case 'github': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Personal Access Token</label>
            <input
              className="gg-input"
              type="password"
              value={githubToken}
              onChange={e => setGithubToken(e.target.value)}
              placeholder="ghp_... (Settings → Developer settings → Personal access tokens)"
              autoComplete="new-password"
            />
          </div>
          <div className="gg-settings-hint">
            Создать: GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens.
            Нужны scopes: <code>repo</code>, <code>read:org</code>. AI вызывает <code>connector_query</code> с{' '}
            <code>id="github"</code> и <code>op="list_repos"</code> / <code>"list_issues"</code> / etc.
            Хранится зашифрованным через safeStorage.
          </div>
        </>
      )
      case 'social-publish': return (
        <>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Telegram-каналы (JSON)</label>
            <input
              className="gg-input"
              value={socialTgChannels}
              onChange={e => setSocialTgChannels(e.target.value)}
              placeholder='["-1001234567890", "@my_channel"]'
              style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}
              spellCheck={false}
            />
          </div>
          <div className="gg-settings-hint" style={{ marginBottom: 10 }}>
            Переиспользует Bot token из коннектора Telegram (telegram_bot_token). Список chat_id куда постить.
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">VK token</label>
            <input
              className="gg-input"
              type="password"
              value={socialVkToken}
              onChange={e => setSocialVkToken(e.target.value)}
              placeholder="User token со scope wall (vk.com/dev, oauth.vk.com)"
              autoComplete="new-password"
            />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">VK group ID</label>
            <input
              className="gg-input"
              value={socialVkGroupId}
              onChange={e => setSocialVkGroupId(e.target.value)}
              placeholder="Числовой ID группы (без минуса), напр. 123456789"
              spellCheck={false}
            />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Webhooks (JSON)</label>
            <input
              className="gg-input"
              value={socialWebhooks}
              onChange={e => setSocialWebhooks(e.target.value)}
              placeholder='["https://hooks.example.com/abc", "https://n8n.example.com/webhook/xyz"]'
              style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}
              spellCheck={false}
            />
          </div>
          <div className="gg-settings-hint">
            AI вызывает <code>connector_query</code> с <code>id="social-publish"</code> и
            <code>op="publish_text"</code>, <code>text="..."</code>.
            Опционально <code>platforms: ["telegram", "vk", "webhook"]</code> — если не передан, постит во всё настроенное.
          </div>
        </>
      )
      default: return null
    }
  }

  function renderConnectorsTab(): React.ReactNode {
    const configuredCount = CONNECTORS.filter(c => configuredConnectors.has(c.id) && connectorHealth[c.id] === 'ok').length
    const errorCount = CONNECTORS.filter(c => configuredConnectors.has(c.id) && connectorHealth[c.id] === 'error').length
    const checkingCount = CONNECTORS.filter(c => connectorHealth[c.id] === 'checking').length
    const query = connectorSearch.trim().toLowerCase()

    const connectorStatus = (id: string) => {
      const configured = configuredConnectors.has(id)
      const health = connectorHealth[id] ?? 'unknown'
      if (!configured) return { label: 'Не настроен', tone: 'muted' }
      if (health === 'ok') return { label: 'Подключён', tone: 'ok' }
      if (health === 'error') return { label: 'Ошибка подключения', tone: 'error' }
      if (health === 'checking') return { label: 'Проверяется', tone: 'checking' }
      return { label: 'Сохранён, не проверялся', tone: 'warn' }
    }

    const filteredList = CONNECTORS
      .filter(c => {
        const meta = connectorMeta(c.id)
        if (connectorFilter === 'configured' && !configuredConnectors.has(c.id)) return false
        if (connectorFilter === 'errors' && connectorHealth[c.id] !== 'error') return false
        if (connectorFilter !== 'all' && connectorFilter !== 'configured' && connectorFilter !== 'errors' && meta.category !== connectorFilter) return false
        if (!query) return true
        const haystack = `${c.name} ${c.description} ${c.id} ${meta.label} ${meta.search} ${meta.capabilities.join(' ')}`.toLowerCase()
        return haystack.includes(query)
      })
      .sort((a, b) => {
        const aConfigured = configuredConnectors.has(a.id)
        const bConfigured = configuredConnectors.has(b.id)
        if (aConfigured !== bConfigured) return aConfigured ? -1 : 1
        return a.name.localeCompare(b.name, 'ru')
      })

    const renderConnectorDetail = (id: string) => {
      const def = CONNECTORS.find(c => c.id === id)
      const meta = connectorMeta(id)
      const status = connectorStatus(id)
      const safety = connectorSafety[id] ?? 'confirm'
      return (
        <div className="gg-connector-detail" ref={openConnector === id ? connectorDetailRef : undefined}>
          <div className="gg-connector-detail-header">
            {def ? <><def.icon size={20} /><span>{def.name}</span></> : null}
            <span className={`gg-connector-status-text is-${status.tone}`}>{status.label}</span>
            <button className="gg-connector-detail-close" onClick={() => setOpenConnector(null)}>×</button>
          </div>
          <div className="gg-connector-detail-body">
            <div className="gg-connector-detail-intro">
              <div>
                <div className="gg-connector-detail-kicker">{meta.label}</div>
                <div className="gg-connector-detail-desc">{def?.description}</div>
              </div>
              <div className="gg-connector-capabilities">
                {meta.capabilities.map(item => <span key={item} className="gg-connector-capability">{item}</span>)}
              </div>
            </div>

            <div className="gg-connector-safe-block">
              <div>
                <div className="gg-connector-safe-title">Режим доступа</div>
                <div className="gg-connector-safe-desc">Ограничивает, что агенту можно делать через этот коннектор</div>
              </div>
              <div className="gg-connector-safe-modes">
                {([
                  ['read', 'Только чтение'],
                  ['confirm', 'С подтверждением'],
                  ['write', 'Полный доступ']
                ] as Array<[ConnectorSafetyMode, string]>).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    className={`gg-connector-safe-mode${safety === mode ? ' is-active' : ''}`}
                    onClick={() => setConnectorSafety(s => ({ ...s, [id]: mode }))}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {renderConnectorForm(id)}

            <div className="gg-connector-detail-actions">
              {connectorApplying === id && <div className="gg-connector-progress" aria-hidden />}
              <div className="gg-connector-detail-actions-row">
                <button
                  type="button"
                  className="gg-btn gg-btn-primary"
                  disabled={connectorApplying === id}
                  onClick={() => void applyConnector(id)}
                >
                  {connectorApplying === id ? 'Идёт действие' : 'Сохранить и проверить'}
                </button>
                <button
                  type="button"
                  className="gg-btn"
                  disabled={connectorApplying === id}
                  onClick={() => void saveConnectorOnly(id)}
                >
                  Сохранить ключ
                </button>
                <button
                  type="button"
                  className="gg-btn"
                  disabled={connectorApplying === id}
                  onClick={() => void checkConnectorCurrentInput(id)}
                >
                  Проверить
                </button>
                <button
                  type="button"
                  className="gg-btn gg-btn-danger"
                  disabled={connectorApplying === id || !(CONNECTOR_SETTING_KEYS[id]?.length)}
                  onClick={() => void deleteConnectorKeys(id)}
                >
                  Удалить ключи
                </button>
                {connectorHealthMsg[id] && connectorApplying !== id && (
                  <span className={`gg-connector-test-msg ${connectorHealth[id] === 'ok' ? 'is-ok' : connectorHealth[id] === 'error' ? 'is-error' : ''}`}>
                    {connectorHealthMsg[id]}
                  </span>
                )}
                {connectorCapabilities[id]?.length ? (
                  <div className="gg-connector-capability-checks" aria-label="Доступные функции токена">
                    {connectorCapabilities[id].map(item => (
                      <div
                        key={item.id}
                        className={`gg-connector-capability-check ${item.ok ? 'is-ok' : 'is-error'}`}
                        title={item.message}
                      >
                        <span className="gg-connector-capability-dot" aria-hidden />
                        <span>{item.label}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      )
    }

    const renderConnectorItem = (c: ConnectorDef) => {
      const configured = configuredConnectors.has(c.id)
      const health = connectorHealth[c.id] ?? 'unknown'
      const meta = connectorMeta(c.id)
      const status = connectorStatus(c.id)
      const healthTitle = connectorHealthMsg[c.id]
        ?? (health === 'checking' ? t.connectors.healthChecking
          : health === 'ok' ? t.connectors.healthOk
          : health === 'error' ? t.connectors.healthError
          : '')
      const isOpen = openConnector === c.id
      return (
        <div key={c.id} className={`gg-connector-item${isOpen ? ' is-expanded' : ''}`}>
          <button
            type="button"
            className={`gg-connector-card ${status.tone === 'ok' ? 'is-connected' : ''} ${isOpen ? 'is-open' : ''}`}
            onClick={() => setOpenConnector(isOpen ? null : c.id)}
          >
            <div className="gg-connector-card-icon"><c.icon size={32} /></div>
            <div className="gg-connector-card-body">
              <div className="gg-connector-card-top">
                <span className="gg-connector-card-name">{c.name}</span>
                <span className="gg-connector-chip">{meta.label}</span>
              </div>
              <div className="gg-connector-card-desc">{c.description}</div>
              <div className="gg-connector-card-caps">
                {meta.capabilities.slice(0, 3).map(item => <span key={item}>{item}</span>)}
              </div>
            </div>
            <div className="gg-connector-card-status">
              {configured && (
                <span
                  className={`gg-connector-health ${health === 'ok' ? 'is-ok' : health === 'error' ? 'is-error' : health === 'checking' ? 'is-checking' : ''}`}
                  title={healthTitle}
                  aria-label={healthTitle}
                />
              )}
              <span className={`gg-connector-status-text is-${status.tone}`}>{status.label}</span>
            </div>
          </button>
          {isOpen && renderConnectorDetail(c.id)}
        </div>
      )
    }

    const connectedFilteredList = filteredList.filter(c => configuredConnectors.has(c.id))
    const availableFilteredList = filteredList.filter(c => !configuredConnectors.has(c.id))
    const shouldSplitList = connectorFilter !== 'configured' && connectorFilter !== 'errors'
    const renderConnectorSection = (title: string, items: ConnectorDef[]) => {
      if (!items.length) return null
      return (
        <section className="gg-connector-section-v3">
          <div className="gg-connector-section-head-v3">
            <span>{title}</span>
            <span>{items.length}</span>
          </div>
          <div className="gg-connector-list">
            {items.map(renderConnectorItem)}
          </div>
        </section>
      )
    }

    return (
      <div className="gg-connectors-page">
        <div className="gg-connectors-summary">
          <div className="gg-connectors-summary-card"><span>Всего</span><strong>{CONNECTORS.length}</strong></div>
          <div className="gg-connectors-summary-card"><span>Подключено</span><strong>{configuredCount}</strong></div>
          <div className="gg-connectors-summary-card"><span>С ошибкой</span><strong>{errorCount}</strong></div>
          <div className="gg-connectors-summary-card"><span>Проверяется</span><strong>{checkingCount}</strong></div>
        </div>

        <div className="gg-connectors-toolbar">
          <input
            className="gg-input gg-connectors-search"
            value={connectorSearch}
            onChange={e => setConnectorSearch(e.target.value)}
            placeholder="Поиск по коннекторам, задачам и сервисам"
          />
          <div className="gg-connectors-filters">
            {CONNECTOR_FILTERS.map(filter => (
              <button
                key={filter.id}
                type="button"
                className={`gg-connectors-filter${connectorFilter === filter.id ? ' is-active' : ''}`}
                onClick={() => setConnectorFilter(filter.id)}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>

        {filteredList.length > 0 ? (
          shouldSplitList ? (
            <div className="gg-connector-sections-v3">
              {renderConnectorSection('Подключённые', connectedFilteredList)}
              {renderConnectorSection('Не подключены', availableFilteredList)}
            </div>
          ) : (
            <div className="gg-connector-list">
              {filteredList.map(renderConnectorItem)}
            </div>
          )
        ) : (
          <div className="gg-connectors-empty">Ничего не найдено</div>
        )}
      </div>
    )
  }

  function renderConnectorsTabV3(): React.ReactNode {
    const configuredCount = CONNECTORS.filter(c => configuredConnectors.has(c.id) && connectorHealth[c.id] === 'ok').length
    const errorCount = CONNECTORS.filter(c => configuredConnectors.has(c.id) && connectorHealth[c.id] === 'error').length
    const checkingCount = CONNECTORS.filter(c => connectorHealth[c.id] === 'checking').length
    const query = connectorSearch.trim().toLowerCase()

    const connectorStatus = (id: string) => {
      const configured = configuredConnectors.has(id)
      const health = connectorHealth[id] ?? 'unknown'
      if (!configured) return { label: 'Не настроен', tone: 'muted' }
      if (health === 'ok') return { label: 'Подключён', tone: 'ok' }
      if (health === 'error') return { label: 'Ошибка', tone: 'error' }
      if (health === 'checking') return { label: 'Проверяется', tone: 'checking' }
      return { label: 'Сохранён', tone: 'warn' }
    }

    const connectorGuide = (id: string) => {
      const guides: Record<string, { connection: string; check: string; access: string }> = {
        bitrix: {
          connection: 'Вставь webhook-адрес из Битрикс24 с доступом к нужным разделам',
          check: 'Проверяет, отвечает ли CRM по webhook и доступны ли основные методы',
          access: 'Ограничивает, сможет ли агент только смотреть данные или ещё создавать и менять сущности'
        },
        ydirect: {
          connection: 'Укажи OAuth-токен рекламного аккаунта и логин, если он нужен для запросов',
          check: 'Проверяет доступ к рекламному кабинету и базовым методам Директа',
          access: 'Для правок кампаний лучше оставлять подтверждение, чтобы изменения не уходили без контроля'
        },
        ywordstat: {
          connection: 'Укажи API-ключ Yandex AI Studio или IAM-токен и идентификатор каталога',
          check: 'Проверяет запрос Wordstat topRequests через Search API',
          access: 'Нужна роль search-api.webSearch.user и область ключа yc.search-api.execute'
        },
        ymetrika: {
          connection: 'Укажи OAuth-токен Метрики с доступом к нужным счётчикам',
          check: 'Проверяет доступ к счётчикам, целям и отчётам',
          access: 'Для аудита и отчётов обычно достаточно режима чтения'
        },
        ydisk: {
          connection: 'Укажи OAuth-токен Яндекс.Диска для файлов и артефактов',
          check: 'Проверяет доступ к файловому хранилищу',
          access: 'Полный доступ нужен только если агент должен загружать или менять файлы'
        },
        telegram: {
          connection: 'Вставь токен бота и при необходимости список разрешённых чатов',
          check: 'Проверяет, что бот доступен и может отправлять сообщения',
          access: 'Ограничь чаты whitelist-списком, если бот не должен писать куда попало'
        },
        github: {
          connection: 'Вставь GitHub token с нужными правами на репозитории',
          check: 'Проверяет доступ к аккаунту, репозиториям и базовым API GitHub',
          access: 'Для чтения кода хватит read-доступа, для issues и PR нужен режим с правками'
        },
        gsheets: {
          connection: 'Добавь JSON сервисного аккаунта Google Sheets',
          check: 'Проверяет, что ключ читается и Google API принимает запрос',
          access: 'Выбери запись только если агент должен менять таблицы'
        },
        ssh: {
          connection: 'Укажи host и путь к ключу для подключения к серверу',
          check: 'Проверяет, можно ли установить SSH-соединение',
          access: 'Командный доступ лучше держать с подтверждением'
        },
        http: {
          connection: 'Опиши endpoint, авторизацию и разрешённые пути REST API',
          check: 'Проверяет, что базовый адрес отвечает',
          access: 'Разрешай запись только для проверенных endpoint-ов'
        }
      }
      return guides[id] ?? {
        connection: 'Заполни данные доступа, которые выдал сервис',
        check: 'Проверяет, что Verstak может обратиться к сервису и получить корректный ответ',
        access: 'Выбери, насколько свободно агент может работать через этот коннектор'
      }
    }

    const filteredList = CONNECTORS
      .filter(c => {
        const meta = connectorMeta(c.id)
        if (connectorFilter === 'configured' && !configuredConnectors.has(c.id)) return false
        if (connectorFilter === 'errors' && connectorHealth[c.id] !== 'error') return false
        if (connectorFilter !== 'all' && connectorFilter !== 'configured' && connectorFilter !== 'errors' && meta.category !== connectorFilter) return false
        if (!query) return true
        const haystack = `${c.name} ${c.description} ${c.id} ${meta.label} ${meta.search} ${meta.capabilities.join(' ')}`.toLowerCase()
        return haystack.includes(query)
      })
      .sort((a, b) => {
        const aConfigured = configuredConnectors.has(a.id)
        const bConfigured = configuredConnectors.has(b.id)
        if (aConfigured !== bConfigured) return aConfigured ? -1 : 1
        return a.name.localeCompare(b.name, 'ru')
      })

    const renderConnectorDetail = (id: string) => {
      const status = connectorStatus(id)
      const safety = connectorSafety[id] ?? 'confirm'
      const guide = connectorGuide(id)
      const formTitle = 'Данные доступа'
      return (
        <div className="gg-connector-panel-v3" ref={openConnector === id ? connectorDetailRef : undefined} data-connector-id={id}>
          <div className="gg-connector-panel-body">
            <section className="gg-connector-panel-section is-connection">
              <div className="gg-connector-panel-section-head">
                <div>
                  <div className="gg-connector-panel-section-title">Данные подключения</div>
                  <div className="gg-connector-panel-section-desc">Короткий паспорт ключа без лишних дублей</div>
                </div>
                <span className="gg-connector-panel-note">{formTitle}</span>
              </div>
              {renderConnectorForm(id)}
            </section>

            <section className="gg-connector-panel-section is-access">
              <div className="gg-connector-panel-section-head">
                <div>
                  <div className="gg-connector-panel-section-title">Режим доступа</div>
                  <div className="gg-connector-panel-section-desc">{guide.access}</div>
                </div>
              </div>
              <div className="gg-connector-access-v3">
                {([
                  ['read', 'Только чтение'],
                  ['confirm', 'С подтверждением'],
                  ['write', 'Полный доступ']
                ] as Array<[ConnectorSafetyMode, string]>).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    className={`gg-connector-access-option${safety === mode ? ' is-active' : ''}`}
                    onClick={() => setConnectorSafety(s => ({ ...s, [id]: mode }))}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </section>

            <section className="gg-connector-panel-section is-check">
              <div className="gg-connector-panel-section-head">
                <div>
                  <div className="gg-connector-panel-section-title">Что доступно</div>
                  <div className="gg-connector-panel-section-desc">Пользователь сразу видит рабочие и закрытые функции</div>
                </div>
                <span className={`gg-connector-status-v3 is-${status.tone}`}>{status.label}</span>
              </div>
              {connectorHealthMsg[id] && connectorApplying !== id && (
                <div className={`gg-connector-message-v3 ${connectorHealth[id] === 'ok' ? 'is-ok' : connectorHealth[id] === 'error' ? 'is-error' : ''}`}>
                  {connectorHealthMsg[id]}
                </div>
              )}
              {connectorCapabilities[id]?.length ? (
                <div className="gg-connector-capability-checks" aria-label="Доступные функции токена">
                  {connectorCapabilities[id].map(item => (
                    <div
                      key={item.id}
                      className={`gg-connector-capability-check ${item.ok ? 'is-ok' : 'is-error'}`}
                      title={item.message}
                    >
                      <span className="gg-connector-capability-dot" aria-hidden />
                      <span>{item.label}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </section>

            <div className="gg-connector-panel-actions">
              {connectorApplying === id && <div className="gg-connector-progress" aria-hidden />}
              <button
                type="button"
                className="gg-btn gg-btn-primary"
                disabled={connectorApplying === id}
                onClick={() => void applyConnector(id)}
              >
                {connectorApplying === id ? 'Сохраняю' : 'Сохранить'}
              </button>
              <button
                type="button"
                className="gg-btn"
                disabled={connectorApplying === id}
                onClick={() => void checkConnectorCurrentInput(id)}
              >
                Проверить
              </button>
              <button
                type="button"
                className="gg-btn gg-btn-danger"
                disabled={connectorApplying === id || !(CONNECTOR_SETTING_KEYS[id]?.length)}
                onClick={() => void deleteConnectorKeys(id)}
              >
                Удалить ключ
              </button>
            </div>
          </div>
        </div>
      )
    }

    const renderConnectorItem = (c: ConnectorDef) => {
      const configured = configuredConnectors.has(c.id)
      const health = connectorHealth[c.id] ?? 'unknown'
      const meta = connectorMeta(c.id)
      const status = connectorStatus(c.id)
      const healthTitle = connectorHealthMsg[c.id]
        ?? (health === 'checking' ? t.connectors.healthChecking
          : health === 'ok' ? t.connectors.healthOk
          : health === 'error' ? t.connectors.healthError
          : '')
      const isOpen = openConnector === c.id
      return (
        <div key={c.id} className={`gg-connector-item${isOpen ? ' is-expanded' : ''}`}>
          <button
            type="button"
            className={`gg-connector-service-card-v3 is-${status.tone} ${status.tone === 'ok' ? 'is-connected' : ''} ${isOpen ? 'is-open' : ''}`}
            data-connector-id={c.id}
            onClick={() => setOpenConnector(isOpen ? null : c.id)}
          >
            <div className="gg-connector-service-icon-v3"><c.icon size={28} /></div>
            <div className="gg-connector-service-copy-v3">
              <div className="gg-connector-service-head-v3">
                <div className="gg-connector-service-name-v3">{c.name}</div>
                <span
                  className={`gg-connector-status-v3 is-${status.tone} is-dot-only`}
                  title={healthTitle || status.label}
                  aria-label={status.label}
                />
              </div>
              <div className="gg-connector-service-desc-v3">{c.description}</div>
            </div>
          </button>
          {isOpen && renderConnectorDetail(c.id)}
        </div>
      )
    }

    const connectedFilteredList = filteredList.filter(c => configuredConnectors.has(c.id))
    const availableFilteredList = filteredList.filter(c => !configuredConnectors.has(c.id))
    const shouldSplitList = connectorFilter !== 'configured' && connectorFilter !== 'errors'
    const renderConnectorSection = (title: string, items: ConnectorDef[]) => {
      if (!items.length) return null
      return (
        <section className="gg-connector-section-v3">
          <div className="gg-connector-section-head-v3">
            <span>{title}</span>
            <span>{items.length}</span>
          </div>
          <div className="gg-connector-list">
            {items.map(renderConnectorItem)}
          </div>
        </section>
      )
    }

    return (
      <div className="gg-connectors-page">
        <div className="gg-connectors-summary">
          <div className="gg-connectors-summary-card"><span>Всего</span><strong>{CONNECTORS.length}</strong></div>
          <div className="gg-connectors-summary-card"><span>Подключено</span><strong>{configuredCount}</strong></div>
          <div className="gg-connectors-summary-card"><span>Ошибки</span><strong>{errorCount}</strong></div>
          <div className="gg-connectors-summary-card"><span>Проверка</span><strong>{checkingCount}</strong></div>
        </div>

        <div className="gg-connectors-toolbar">
          <input
            className="gg-input gg-connectors-search"
            value={connectorSearch}
            onChange={e => setConnectorSearch(e.target.value)}
            placeholder="Поиск по коннекторам, задачам и сервисам"
          />
          <div className="gg-connectors-filters">
            {CONNECTOR_FILTERS.map(filter => (
              <button
                key={filter.id}
                type="button"
                className={`gg-connectors-filter${connectorFilter === filter.id ? ' is-active' : ''}`}
                onClick={() => setConnectorFilter(filter.id)}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>

        {filteredList.length > 0 ? (
          shouldSplitList ? (
            <div className="gg-connector-sections-v3">
              {renderConnectorSection('Подключённые', connectedFilteredList)}
              {renderConnectorSection('Не подключены', availableFilteredList)}
            </div>
          ) : (
            <div className="gg-connector-list">
              {filteredList.map(renderConnectorItem)}
            </div>
          )
        ) : (
          <div className="gg-connectors-empty">Ничего не найдено</div>
        )}
      </div>
    )
  }

  function renderCostCapCard(): React.ReactNode {
    const usdValue = costCapToUsd(costCap, costCapCurrency)
    return (
      <div className="gg-connector-budget-card gg-models-budget-card">
        <div className="gg-connector-budget-main">
          <div>
            <div className="gg-connector-budget-title">Лимит расходов в сутки</div>
            <div className="gg-connector-budget-desc">
              Считает суммарные расходы API-моделей за текущий день по локальному времени. В 00:00 счётчик сбрасывается. Если лимит превышен, Verstak остановит новые платные ответы. CLI-модели через подписку не учитываются
            </div>
          </div>
          <div className="gg-cost-cap-control">
            <input
              className="gg-input gg-connector-budget-input"
              type="text"
              value={costCap}
              onChange={e => setCostCap(e.target.value.replace(/[^\d.,]/g, ''))}
              placeholder={costCapCurrency === 'RUB' ? 'Например: 500' : 'Например: 5'}
            />
            <div className="gg-cost-cap-currency" role="group" aria-label="Валюта лимита">
              {(['USD', 'RUB'] as CostCapCurrency[]).map(currency => (
                <button
                  key={currency}
                  type="button"
                  className={costCapCurrency === currency ? 'is-active' : ''}
                  onClick={() => setCostCapCurrency(currency)}
                >
                  {currency === 'USD' ? '$' : '₽'}
                </button>
              ))}
            </div>
          </div>
        </div>
        {costCapCurrency === 'RUB' && usdValue && (
          <div className="gg-cost-cap-note">Рубли пересчитываются примерно по 100 ₽ за $1. Для суточного лимита Verstak применит около ${usdValue}</div>
        )}
      </div>
    )
  }

  return (
    <div className="gg-modal-backdrop" onClick={onClose}>
      <div className="gg-modal gg-modal-large gg-settings-modal" onClick={e => e.stopPropagation()}>
        <div className="gg-settings-window-head">
          <div className="gg-settings-window-copy">
            <div className="gg-settings-window-kicker">Параметры Verstak</div>
            <div className="gg-settings-window-title">{t.settings.title}</div>
          </div>
          <div className="gg-settings-window-tools">
            <button className="gg-modal-close gg-settings-window-close" onClick={onClose} aria-label="Закрыть">×</button>
          </div>
        </div>

        <div className="gg-settings-search-row">
          <div className="gg-settings-search-label">Поиск по настройкам</div>
          <div className="gg-settings-search-box">
            <input
              className="gg-input gg-settings-window-search"
              value={navSearch}
              onChange={e => setNavSearch(e.target.value)}
              placeholder="Поиск настроек..."
              spellCheck={false}
            />
            {navSearch && (
              <button
                type="button"
                className="gg-settings-search-clear"
                onClick={() => setNavSearch('')}
                aria-label="Очистить поиск"
              >
                ×
              </button>
            )}
          </div>
        </div>

        <div className={`gg-settings-shell ${tab === 'notifications' ? 'is-notifications' : ''}`}>
          <aside className="gg-settings-nav" role="tablist" aria-label="Разделы настроек">
            {visibleTabGroups.map(g => (
              <div key={g.title} className="gg-settings-nav-group">
                <div className="gg-settings-nav-title">{g.title}</div>
                {g.tabs.map(t => (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={tab === t.id}
                    aria-disabled={t.disabled}
                    disabled={t.disabled}
                    className={`gg-settings-nav-item ${tab === t.id ? 'is-active' : ''} ${t.disabled ? 'is-disabled' : ''}`}
                    onClick={() => {
                      if (!t.disabled) setTab(t.id)
                    }}
                  >
                    <span className="gg-settings-nav-icon" aria-hidden>
                      <SettingsNavIcon name={t.icon} />
                    </span>
                    <span>{t.label}</span>
                    {t.soon && <span className="gg-settings-nav-soon">Скоро</span>}
                  </button>
                ))}
              </div>
            ))}
            {visibleTabGroups.length === 0 && (
              <div className="gg-settings-nav-empty">Ничего не найдено</div>
            )}
          </aside>

          <div className={`gg-settings-content ${tab === 'notifications' ? 'is-notifications' : ''}`}>
            <div className="gg-settings-section-bar">
              <div>
                <h2>{activeNavTab?.label ?? t.settings.title}</h2>
              </div>
              {settingsDirty && <span className="gg-settings-section-state">Есть изменения</span>}
            </div>

        {tab === 'providers' && (
        <ProvidersPage
          providers={providers}
          keys={keys}
          setKeys={setKeys}
          enabledModels={enabledModels}
          setEnabledModels={setEnabledModels}
          models={models}
          setModels={setModels}
          activeProvider={activeProvider}
          setActiveProvider={setActiveProvider}
          customOpenaiBaseUrl={customOpenaiBaseUrl}
          setCustomOpenaiBaseUrl={setCustomOpenaiBaseUrl}
          customOpenaiModels={customOpenaiModels}
          setCustomOpenaiModels={setCustomOpenaiModels}
        />
        )}

        {tab === 'models' && (
        <>
        {renderCostCapCard()}
        <ModelsPage
          providers={providers}
          enabledModels={enabledModels}
          setEnabledModels={setEnabledModels}
          models={models}
          setModels={setModels}
          activeProvider={activeProvider}
          setActiveProvider={setActiveProvider}
          keys={keys}
          customOpenaiBaseUrl={customOpenaiBaseUrl}
          onGoToProviders={() => setTab('providers')}
          catalogSource={catalogSource}
        />
        </>
        )}

        {tab === 'modelModes' && (
        <div className="gg-settings-extra gg-model-modes-page">
        <ModeModelBinding providers={providers} />
        </div>
        )}

        {tab === 'connectors' && (
        <div className="gg-settings-extra">
          {renderConnectorsTabV3()}
          {false && (() => {
            const configuredList = CONNECTORS.filter(c => configuredConnectors.has(c.id))
            const availableList = CONNECTORS.filter(c => !configuredConnectors.has(c.id))

            const renderConnectorDetail = (id: string) => (
              <div
                className="gg-connector-detail"
                ref={openConnector === id ? connectorDetailRef : undefined}
              >
                <div className="gg-connector-detail-header">
                  {(() => {
                    const def = CONNECTORS.find(c => c.id === id)
                    return def ? <><def.icon size={20} /> {def.name}</> : null
                  })()}
                  <button className="gg-connector-detail-close" onClick={() => setOpenConnector(null)}>×</button>
                </div>
                <div className="gg-connector-detail-body">
                  {renderConnectorForm(id)}
                  <div className="gg-connector-detail-actions">
                    {connectorApplying === id && <div className="gg-connector-progress" aria-hidden />}
                    <div className="gg-connector-detail-actions-row">
                      <button
                        type="button"
                        className="gg-btn gg-btn-primary"
                        disabled={connectorApplying === id}
                        onClick={() => void applyConnector(id)}
                      >
                        {connectorApplying === id ? t.connectors.applying : t.connectors.apply}
                      </button>
                      {connectorHealthMsg[id] && connectorApplying !== id && (
                        <span className={`gg-connector-test-msg ${connectorHealth[id] === 'ok' ? 'is-ok' : connectorHealth[id] === 'error' ? 'is-error' : ''}`}>
                          {connectorHealthMsg[id]}
                        </span>
                      )}
                      {connectorCapabilities[id]?.length ? (
                        <div className="gg-connector-capability-checks" aria-label="Доступные функции токена">
                          {connectorCapabilities[id].map(item => (
                            <div
                              key={item.id}
                              className={`gg-connector-capability-check ${item.ok ? 'is-ok' : 'is-error'}`}
                              title={item.message}
                            >
                              <span className="gg-connector-capability-dot" aria-hidden />
                              <span>{item.label}</span>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>
            )

            const renderConnectorItem = (c: ConnectorDef) => {
              const configured = configuredConnectors.has(c.id)
              const health = connectorHealth[c.id] ?? 'unknown'
              const healthTitle = connectorHealthMsg[c.id]
                ?? (health === 'checking' ? t.connectors.healthChecking
                  : health === 'ok' ? t.connectors.healthOk
                  : health === 'error' ? t.connectors.healthError
                  : '')
              const isOpen = openConnector === c.id
              return (
                <div key={c.id} className={`gg-connector-item${isOpen ? ' is-expanded' : ''}`}>
                  <button
                    type="button"
                    className={`gg-connector-card ${connectorHealth[c.id] === 'ok' ? 'is-connected' : ''} ${isOpen ? 'is-open' : ''}`}
                    onClick={() => setOpenConnector(isOpen ? null : c.id)}
                  >
                    <div className="gg-connector-card-icon"><c.icon size={32} /></div>
                    <div className="gg-connector-card-body">
                      <div className="gg-connector-card-name">{c.name}</div>
                      <div className="gg-connector-card-desc">{c.description}</div>
                    </div>
                    <div className="gg-connector-card-status">
                      {configured && (
                        <span
                          className={`gg-connector-health ${health === 'ok' ? 'is-ok' : health === 'error' ? 'is-error' : health === 'checking' ? 'is-checking' : ''}`}
                          title={healthTitle}
                          aria-label={healthTitle}
                        />
                      )}
                      {configured
                        ? <span className="gg-badge-connected">&#10003;</span>
                        : <span className="gg-badge-add">+</span>}
                    </div>
                  </button>
                  {isOpen && renderConnectorDetail(c.id)}
                </div>
              )
            }

            return (
              <>
                {configuredList.length > 0 && (
                  <>
                    <div className="gg-connector-section-title">{t.connectors.sectionConfigured}</div>
                    <div className="gg-connector-list">
                      {configuredList.map(renderConnectorItem)}
                    </div>
                    {availableList.length > 0 && <div className="gg-connector-section-divider" />}
                  </>
                )}
                {availableList.length > 0 && (
                  <>
                    <div className="gg-connector-section-title">{t.connectors.sectionAvailable}</div>
                    <div className="gg-connector-list">
                      {availableList.map(renderConnectorItem)}
                    </div>
                  </>
                )}
              </>
            )
          })()}
        </div>
        )}

        {tab === 'mcp' && (
          <McpTab />
        )}

        {tab === 'policy' && (
          <PolicyTab />
        )}

        {/* 2.0.8: обе вкладки строились standalone (ждали merge ветки дизайнера) —
            merge случился, монтируем, чтобы фичи перестали быть недоступными. */}
        {tab === 'subscriptions' && <SubscriptionsTab />}

        {tab === 'usage' && <UsageTab />}

        {tab === 'updates' && <UpdatesSettings />}

        {tab === 'notifications' && (
        <div className="gg-settings-extra gg-notify-page">
          <section className="gg-notify-section">
            <div className="gg-notify-section-head">
              <div>
                <div className="gg-notify-title">Режим уведомлений</div>
                <p className="gg-notify-desc">Выбери, когда Verstak должен отвлекать от работы</p>
              </div>
              <div className="gg-notify-top-actions">
                <button
                  type="button"
                  role="switch"
                  aria-checked={notifyPrefs.enabled}
                  className={`gg-notify-switch gg-notify-master ${notifyPrefs.enabled ? 'is-on' : ''}`}
                  onClick={() => void setNotifyEnabled(!notifyPrefs.enabled)}
                >
                  <span className="gg-notify-switch-ui" aria-hidden />
                  <span className="gg-notify-switch-text">
                    {notifyPrefs.enabled ? 'Уведомления включены' : 'Уведомления выключены'}
                  </span>
                </button>
                <button
                  type="button"
                  className="gg-btn gg-btn-ghost gg-notify-test-btn"
                  onClick={() => {
                    void (async () => {
                      const ok = await testNotification()
                      setNotifyTestMessage(ok
                        ? 'Проверочная всплывашка отправлена в правый нижний угол'
                        : 'Не удалось показать проверочную всплывашку'
                      )
                      window.setTimeout(() => setNotifyTestMessage(''), 5000)
                    })()
                  }}
                >
                  Проверить
                </button>
              </div>
            </div>
            {notifyTestMessage && <div className="gg-notify-test-note">{notifyTestMessage}</div>}

            <div className="gg-notify-mode-grid" role="group" aria-label="Режим уведомлений">
              {NOTIFY_MODE_OPTIONS.map(option => (
                <button
                  key={option.id}
                  type="button"
                  className={`gg-notify-mode-card ${notifyPrefs.mode === option.id ? 'is-active' : ''}`}
                  onClick={() => void setNotifyMode(option.id)}
                >
                  <span className="gg-notify-mode-title">{option.title}</span>
                  <span className="gg-notify-mode-desc">{option.description}</span>
                  <span className="gg-notify-mode-mark" aria-hidden>{notifyPrefs.mode === option.id ? '✓' : ''}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="gg-notify-section">
            <div className="gg-notify-section-head">
              <div>
                <div className="gg-notify-title">События</div>
                <p className="gg-notify-desc">Настрой, какие сигналы показывать по каждому типу события</p>
              </div>
            </div>

            <div className="gg-notify-channel-help" aria-label="Что означают каналы уведомлений">
              {NOTIFY_CHANNEL_OPTIONS.map(channel => (
                <div className="gg-notify-channel-help-item" key={channel.id}>
                  <span>{channel.label}</span>
                  <p>{channel.description}</p>
                </div>
              ))}
            </div>

            <div className="gg-notify-events">
              {NOTIFY_EVENT_OPTIONS.map(event => (
                <div className="gg-notify-event" key={event.id}>
                  <div className="gg-notify-event-meta">
                    <div className="gg-notify-event-title">{event.title}</div>
                    <div className="gg-notify-event-desc">{event.description}</div>
                  </div>
                  <div className="gg-notify-channel-grid" role="group" aria-label={`Каналы: ${event.title}`}>
                    {NOTIFY_CHANNEL_OPTIONS.map(channel => (
                      <button
                        key={channel.id}
                        type="button"
                        className={`gg-notify-channel ${notifyPrefs.events[event.id][channel.id] ? 'is-active' : ''}`}
                        onClick={() => void setNotifyEventChannel(
                          event.id,
                          channel.id,
                          !notifyPrefs.events[event.id][channel.id]
                        )}
                      >
                        {channel.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="gg-notify-section gg-notify-quiet">
            <div className="gg-notify-section-head">
              <div>
                <div className="gg-notify-title">Тихие часы</div>
                <p className="gg-notify-desc">Только важные сигналы: ошибки, прерванные ответы и напоминания</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={notifyPrefs.quietHours.enabled}
                className={`gg-notify-switch ${notifyPrefs.quietHours.enabled ? 'is-on' : ''}`}
                onClick={() => void setQuietHoursEnabled(!notifyPrefs.quietHours.enabled)}
              >
                <span className="gg-notify-switch-ui" aria-hidden />
                <span className="gg-notify-switch-text">{notifyPrefs.quietHours.enabled ? 'Включено' : 'Выключено'}</span>
              </button>
            </div>
            <div className="gg-notify-time-row">
              <label>
                <span>С</span>
                <input
                  className="gg-input"
                  type="time"
                  value={notifyPrefs.quietHours.from}
                  onChange={(e) => void setQuietHoursTime('from', e.target.value)}
                />
              </label>
              <label>
                <span>До</span>
                <input
                  className="gg-input"
                  type="time"
                  value={notifyPrefs.quietHours.to}
                  onChange={(e) => void setQuietHoursTime('to', e.target.value)}
                />
              </label>
            </div>
          </section>
        </div>
        )}

        {tab === 'profiles' && (<ProfilesTab />)}

        {tab === 'appearance' && (
        <div className="gg-settings-extra gg-appearance-panel">
          <section className="gg-appearance-section">
            <div className="gg-appearance-section-head">
              <div>
                <div className="gg-appearance-title">Тема оформления</div>
                <p className="gg-appearance-desc">Цветовая схема применяется сразу ко всему интерфейсу</p>
              </div>
            </div>
            <div className="gg-theme-grid" role="group" aria-label="Тема оформления">
              {THEMES.map(meta => (
                <button
                  key={meta.id}
                  type="button"
                  className={`gg-theme-card ${theme === meta.id ? 'is-active' : ''}`}
                  onClick={() => void setTheme(meta.id)}
                  aria-pressed={theme === meta.id}
                  title={meta.label}
                >
                  <span className="gg-theme-swatch" aria-hidden style={{ background: meta.swatch[0] }}>
                    <span style={{ background: meta.swatch[1] }} />
                    <span style={{ background: meta.swatch[2] }} />
                  </span>
                  <span className="gg-theme-name">{meta.label}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="gg-appearance-section">
            <div className="gg-appearance-section-head">
              <div>
                <div className="gg-appearance-title">Плотность интерфейса</div>
                <p className="gg-appearance-desc">Меняет плотность панели проектов и основных блоков без изменения размера текста</p>
              </div>
            </div>
            <div className="gg-appearance-choice-grid" role="group" aria-label="Плотность интерфейса">
              {UI_DENSITY_OPTIONS.map(option => (
                <button
                  key={option.id}
                  type="button"
                  className={`gg-appearance-choice ${uiDensity === option.id ? 'is-active' : ''}`}
                  onClick={() => void setUiDensity(option.id)}
                  aria-pressed={uiDensity === option.id}
                >
                  <span className="gg-appearance-choice-main">
                    <span className="gg-appearance-choice-title">{option.label}</span>
                    <span className="gg-appearance-choice-desc">{option.description}</span>
                  </span>
                  <span className="gg-appearance-choice-mark" aria-hidden>{uiDensity === option.id ? '✓' : ''}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="gg-appearance-section">
            <div className="gg-appearance-section-head">
              <div>
                <div className="gg-appearance-title">Анимации</div>
                <p className="gg-appearance-desc">Позволяет оставить интерфейс живым или сделать его спокойнее</p>
              </div>
            </div>
            <div className="gg-appearance-choice-grid" role="group" aria-label="Анимации">
              {MOTION_LEVEL_OPTIONS.map(option => (
                <button
                  key={option.id}
                  type="button"
                  className={`gg-appearance-choice ${motionLevel === option.id ? 'is-active' : ''}`}
                  onClick={() => void setMotionLevel(option.id)}
                  aria-pressed={motionLevel === option.id}
                >
                  <span className="gg-appearance-choice-main">
                    <span className="gg-appearance-choice-title">{option.label}</span>
                    <span className="gg-appearance-choice-desc">{option.description}</span>
                  </span>
                  <span className="gg-appearance-choice-mark" aria-hidden>{motionLevel === option.id ? '✓' : ''}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="gg-appearance-section">
            <div className="gg-appearance-section-head">
              <div>
                <div className="gg-appearance-title">Статусы проектов</div>
                <p className="gg-appearance-desc">Выбери, как показывать работу модели, готовый ответ и ошибки в списке проектов</p>
              </div>
            </div>
            <div className="gg-appearance-choice-grid" role="group" aria-label="Статусы проектов">
              {PROJECT_STATUS_DISPLAY_OPTIONS.map(option => (
                <button
                  key={option.id}
                  type="button"
                  className={`gg-appearance-choice ${projectStatusDisplay === option.id ? 'is-active' : ''}`}
                  onClick={() => void setProjectStatusDisplay(option.id)}
                  aria-pressed={projectStatusDisplay === option.id}
                >
                  <span className="gg-appearance-choice-main">
                    <span className="gg-appearance-choice-title">{option.label}</span>
                    <span className="gg-appearance-choice-desc">{option.description}</span>
                  </span>
                  <span className="gg-appearance-choice-mark" aria-hidden>{projectStatusDisplay === option.id ? '✓' : ''}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="gg-appearance-section">
            <div className="gg-appearance-section-head">
              <div>
                <div className="gg-appearance-title">{t.settings.uiScale}</div>
                <p className="gg-appearance-desc">Увеличивает весь интерфейс — текст, кнопки, панели</p>
              </div>
              <span className="gg-ui-scale-value">{uiScalePercent}%</span>
            </div>
            <div className="gg-ui-scale-block">
              <input
                type="range"
                className="gg-ui-scale-slider"
                min={MIN_UI_SCALE_PERCENT}
                max={MAX_UI_SCALE_PERCENT}
                step={5}
                value={uiScalePercent}
                onChange={(e) => void setUiScalePercent(Number(e.target.value))}
                aria-label={t.settings.uiScale}
              />
              <div className="gg-ui-scale-presets" role="group" aria-label={t.settings.uiScale}>
                {UI_SCALE_PRESETS.map(preset => (
                  <button
                    key={preset}
                    type="button"
                    className={`gg-btn gg-btn-ghost ${uiScalePercent === preset ? 'is-active' : ''}`}
                    onClick={() => void setUiScalePercent(preset)}
                  >
                    {preset}%
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="gg-appearance-section gg-appearance-section-inline">
            <div>
              <div className="gg-appearance-title">{t.settings.language}</div>
              <p className="gg-appearance-desc">Язык интерфейса применяется после перезапуска окна приложения</p>
            </div>
            <select
              className="gg-input"
              value={currentLang}
              onChange={e => {
                const lang = e.target.value
                setCurrentLang(lang)
                void (async () => {
                  await window.api.settings.setKey('app_language', lang)
                  window.location.reload()
                })()
              }}
            >
              <option value="en">English</option>
              <option value="ru">Русский</option>
            </select>
          </section>

          <section className="gg-appearance-reset">
            <div>
              <div className="gg-appearance-title">Сбросить внешний вид</div>
              <p className="gg-appearance-desc">Вернёт тёмную тему, стандартную плотность, полные анимации, статусы на аватарке и масштаб 100%</p>
            </div>
            <button
              type="button"
              className="gg-btn gg-btn-ghost gg-appearance-reset-btn"
              onClick={() => void Promise.all([
                setTheme('nord'),
                resetAppearance(),
                setUiScalePercent(100)
              ])}
            >
              Сбросить
            </button>
          </section>
        </div>
        )}

          </div>
        </div>

        <div className="gg-settings-actionbar">
          <div className={`gg-settings-save-status ${settingsDirty ? 'is-dirty' : saved ? 'is-saved' : ''}`}>
            {saving ? 'Сохраняю…' : saved ? 'Сохранено' : settingsDirty ? 'Есть несохранённые изменения' : 'Изменений нет'}
          </div>
          <button className="gg-btn gg-btn-ghost" onClick={onClose}>{t.common.close}</button>
          <button className="gg-btn gg-btn-primary" onClick={() => { void save() }} disabled={saving || !settingsLoaded}>
            {saving ? 'Сохраняю…' : saved ? t.settings.saved : t.settings.save}
          </button>
        </div>
      </div>
    </div>
  )
}

// ProvidersPage — OpenCode Desktop-style: «Подключённые» (с бейджем + Отключить)
// + «Доступные» (карточки с кнопкой Подключить, раскрывается inline-форма с
// ключом / hint'ом). Источник провайдеров — массив PROVIDERS (тот же что в
// Models). «Подключение» = задание API-ключа; для CLI-провайдеров «подключение»
// = установка CLI вне приложения, мы только подтверждаем галкой.
// ════════════════════════════════════════════════════════════════════════════

interface ProvidersPageProps {
  providers: ProviderConfig[]
  keys: Record<string, string>
  setKeys: React.Dispatch<React.SetStateAction<Record<string, string>>>
  enabledModels: Set<string>
  setEnabledModels: React.Dispatch<React.SetStateAction<Set<string>>>
  models: Record<string, string>
  setModels: React.Dispatch<React.SetStateAction<Record<string, string>>>
  activeProvider: ProviderId
  setActiveProvider: (id: ProviderId) => void
  // Custom OpenAI-compatible настройки. Уникальный провайдер 'custom-openai'
  // имеет ещё 2 поля: baseUrl и список моделей через запятую.
  customOpenaiBaseUrl: string
  setCustomOpenaiBaseUrl: (v: string) => void
  customOpenaiModels: string
  setCustomOpenaiModels: (v: string) => void
}

function statusBadge(
  status: ConnectionStatus,
  transport: 'API' | 'CLI' | 'Tunnel',
  providerId?: ProviderId,
  secretKey?: string | null,
  cliState?: { installed: boolean; loggedIn: boolean },
  ready?: boolean
): { label: string; tone: 'ready' | 'cli' | 'missing'; title?: string } {
  if (transport === 'CLI') {
    if (!cliState) return { label: 'Проверяется', tone: 'cli', title: 'Verstak проверяет локальную среду' }
    if (!cliState.installed) return { label: 'CLI не найден', tone: 'missing', title: 'Командная строка провайдера не найдена в PATH' }
    if (cliState.loggedIn)   return { label: 'Готов', tone: 'ready', title: 'Вход в CLI найден локально' }
    return { label: 'Нужен вход', tone: 'missing', title: 'CLI установлен, но вход не найден' }
  }
  if (providerId === 'custom-openai') {
    return ready
      ? { label: 'Готов', tone: 'ready' }
      : { label: 'Нужен адрес', tone: 'missing', title: 'Укажи адрес своего сервера' }
  }
  if (!secretKey) {
    return ready
      ? { label: 'Готов', tone: 'ready' }
      : { label: 'Нужно проверить', tone: 'missing', title: 'Локальный сервер нужно запустить отдельно' }
  }
  if (status === 'ready')  return { label: 'Готов', tone: 'ready' }
  return { label: 'Нужен API-ключ', tone: 'missing' }
}

type CliId = 'claude-cli' | 'gemini-cli' | 'grok-cli' | 'codex-cli'
type CliStatusMap = Record<CliId, { installed: boolean; loggedIn: boolean; credPath?: string }>
type ProviderFilter = 'all' | 'connected' | 'needs' | 'cli' | 'api'

function ProvidersPage(props: ProvidersPageProps) {
  const { providers, keys, setKeys, activeProvider, setActiveProvider,
          enabledModels, setEnabledModels, models, setModels,
          customOpenaiBaseUrl, setCustomOpenaiBaseUrl,
          customOpenaiModels, setCustomOpenaiModels } = props
  const [selectedProviderId, setSelectedProviderId] = useState<ProviderId | null>(null)
  const [filter, setFilter] = useState<ProviderFilter>('all')
  // toast — короткое сообщение о результате logout/relogin. null = ничего.
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [busy, setBusy] = useState<ProviderId | null>(null)
  // CLI статус: загружается при открытии страницы И после logout/relogin.
  // null = ещё не загружено (показываем "Среда" по дефолту).
  const [cliStatus, setCliStatus] = useState<CliStatusMap | null>(null)
  // Обнаруженные CLI-инструменты на компьютере пользователя.
  const [detectedClis, setDetectedClis] = useState<DetectedCli[]>([])
  const [cliDetectBusy, setCliDetectBusy] = useState(false)
  const [cliDetectMessage, setCliDetectMessage] = useState<string | null>(null)

  async function loadCliStatus() {
    try {
      const s = await window.api.cliAuth.statusAll()
      setCliStatus(s)
    } catch { /* не критично — оставим null, бейдж покажет fallback */ }
  }
  useEffect(() => {
    void loadCliStatus()
    void import('../lib/prefetch-cli').then(m => m.getDetectedClisCached().then(setDetectedClis))
  }, [])

  // Ручной пере-скан установленных CLI (Claude Code / Gemini / Grok / Codex и совместимых)
  // на машине. Дополняет авто-статус: полезно после установки CLI без переоткрытия Settings.
  async function refreshCliDetection() {
    setCliDetectBusy(true)
    setCliDetectMessage(null)
    try {
      const list = await window.api.cli.detect()
      setDetectedClis(list)
      await loadCliStatus()
      const ready = list.filter(c => c.status === 'ready').length
      setCliDetectMessage(list.length > 0
        ? `Найдено CLI: ${list.length}, готово: ${ready}`
        : 'CLI не найдены в PATH и стандартных папках')
    } catch (err) {
      setCliDetectMessage(`Не удалось проверить CLI: ${(err as Error).message}`)
    } finally {
      setCliDetectBusy(false)
    }
  }

  function getCliState(p: ProviderConfig) {
    return (p.transport === 'CLI' && cliStatus) ? cliStatus[p.id as CliId] : undefined
  }

  function isReady(p: ProviderConfig): boolean {
    if (p.transport === 'CLI') {
      const state = getCliState(p)
      return Boolean(state?.installed && state.loggedIn)
    }
    if (p.id === 'custom-openai') return customOpenaiBaseUrl.trim().length > 0
    if (!p.secretKey) return false
    return Boolean(keys[p.secretKey])
  }

  function needsSetup(p: ProviderConfig): boolean {
    return !isReady(p)
  }

  const readyProviders = providers.filter(isReady)
  const needsProviders = providers.filter(needsSetup)
  const visibleProviders = providers.filter(p => {
    if (filter === 'connected') return isReady(p)
    if (filter === 'needs') return needsSetup(p)
    if (filter === 'cli') return p.transport === 'CLI'
    if (filter === 'api') return p.transport === 'API'
    return true
  }).sort((a, b) => {
    if (filter !== 'all' && filter !== 'cli' && filter !== 'api') return 0
    const readyDelta = Number(isReady(b)) - Number(isReady(a))
    if (readyDelta !== 0) return readyDelta
    return a.name.localeCompare(b.name, 'ru')
  })

  function showToast(kind: 'ok' | 'err', text: string) {
    setToast({ kind, text })
    setTimeout(() => setToast(null), 5000)
  }

  async function disconnect(p: ProviderConfig) {
    if (p.transport === 'CLI') {
      // CLI: реальный logout через child_process + удаление credentials.
      setBusy(p.id)
      try {
        const res = await window.api.cliAuth.logout(p.id)
        if (res.ok) {
          const fileCount = res.removedFiles.length
          showToast('ok',
            res.method === 'logout-cmd' ? `${p.name}: отключено через \`${p.id.split('-')[0]} logout\`` :
            res.method === 'both' ? `${p.name}: logout + удалено ${fileCount} файл(ов) credentials` :
            `${p.name}: удалено ${fileCount} файл(ов) credentials`
          )
        } else {
          showToast('err', res.message ?? `${p.name}: не удалось отключить`)
        }
      } catch (err) {
        showToast('err', `${p.name}: ошибка — ${(err as Error).message}`)
      } finally {
        setBusy(null)
        void loadCliStatus() // обновить бейдж после logout
      }
      return
    }
    // API: просто чистим ключ в state (save → SafeStorage)
    if (p.secretKey) {
      setKeys(k => {
        const next = { ...k }
        delete next[p.secretKey!]
        return next
      })
      showToast('ok', `${p.name}: ключ очищен. Не забудь нажать «Сохранить» внизу.`)
    }
    if (activeProvider === p.id) {
      const fallback = providers.find(x => x.id !== p.id && isReady(x))
      if (fallback) setActiveProvider(fallback.id)
    }
  }

  async function relogin(p: ProviderConfig) {
    if (p.transport !== 'CLI') return
    setBusy(p.id)
    try {
      const res = await window.api.cliAuth.relogin(p.id)
      if (res.ok) {
        showToast('ok', `${p.name}: открыл терминал для входа. Пройди OAuth в новом окне → вернись сюда.`)
      } else {
        showToast('err', res.message ?? `${p.name}: не удалось открыть терминал`)
      }
    } catch (err) {
      showToast('err', `${p.name}: ошибка — ${(err as Error).message}`)
    } finally {
      setBusy(null)
      // После relogin'а проверим статус — но не сразу, OAuth требует времени.
      // Шлём через 8 сек когда пользователь успел пройти браузер-flow.
      setTimeout(() => void loadCliStatus(), 8000)
    }
  }

  const showEmptyState = readyProviders.length === 0

  function checkProvider(p: ProviderConfig) {
    if (p.transport === 'CLI') {
      const state = getCliState(p)
      if (!state) {
        showToast('err', `${p.name}: статус ещё загружается`)
      } else if (!state.installed) {
        showToast('err', `${p.name}: CLI не найден на компьютере`)
      } else if (!state.loggedIn) {
        showToast('err', `${p.name}: нужен вход в аккаунт`)
      } else {
        showToast('ok', `${p.name}: готов к работе`)
      }
      void loadCliStatus()
      return
    }
    if (p.id === 'custom-openai' && !customOpenaiBaseUrl.trim()) {
      showToast('err', `${p.name}: укажи адрес сервера`)
      return
    }
    if (p.secretKey && !keys[p.secretKey]) {
      showToast('err', `${p.name}: нужен API-ключ`)
      return
    }
    if (!p.secretKey) {
      showToast('err', `${p.name}: локальный сервер нужно запустить и проверить отдельно`)
      return
    }
    showToast('ok', `${p.name}: настройки выглядят готовыми`)
  }

  function providerGlyph(p: ProviderConfig): string {
    const explicit: Partial<Record<ProviderId, string>> = {
      'verstak-gateway': 'V',
      'gemini-api': 'G',
      'gemini-cli': 'GC',
      'claude': 'C',
      'claude-cli': 'CC',
      grok: 'X',
      'grok-cli': 'GB',
      openai: 'GPT',
      'codex-cli': 'CX',
      openrouter: 'OR',
      deepseek: 'DS',
      moonshot: 'K',
      'kimi-coding': 'K',
      'zai-coding': 'Z',
      qwen: 'Q',
      mistral: 'M',
      groq: 'GQ',
      ollama: 'OL',
      'yandex-gpt': 'YA',
      gigachat: 'GC',
      'custom-openai': '{}'
    }
    const value = explicit[p.id]
    if (value) return value
    return p.name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(part => part[0]?.toUpperCase())
      .join('') || p.transport
  }

  function toggleProvider(id: ProviderId) {
    setSelectedProviderId(prev => prev === id ? null : id)
  }

  function onProviderShellKey(event: React.KeyboardEvent<HTMLDivElement>, id: ProviderId) {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    toggleProvider(id)
  }

  async function quickUseCli(cli: DetectedCli) {
    const provider = providers.find(p => p.id === cli.id)
    if (!provider || provider.transport !== 'CLI') return
    const model = provider.defaultModel || models[provider.id] || 'auto'
    const key = modelKey(provider.id, model)
    const nextEnabled = new Set(enabledModels).add(key)
    setActiveProvider(provider.id)
    setModels(prev => ({ ...prev, [provider.id]: model }))
    setEnabledModels(nextEnabled)
    await Promise.all([
      window.api.settings.setKey('provider', provider.id),
      window.api.settings.setKey(`model_${provider.id}`, model),
      window.api.settings.setKey('enabled_models', JSON.stringify([...nextEnabled]))
    ])
    showToast('ok', `${provider.name}: добавлен в инструменты чата`)
    void loadCliStatus()
  }

  const supportedDetectedClis = detectedClis.filter(cli => (
    providers.some(p => p.id === cli.id && p.transport === 'CLI')
  ))

  return (
    <div className="gg-settings-extra gg-providers-page">
      <div className="gg-providers-hero">
        <div>
          <h2 className="gg-settings-page-title">Провайдеры</h2>
          <p className="gg-providers-lead">
            Подключи доступ к AI-сервисам. Модели, которые будут видны в чате, выбираются во вкладке «Модели»
          </p>
        </div>
      </div>

      <div className="gg-providers-summary">
        <div>
          <span>Подключено</span>
          <strong>{readyProviders.length}</strong>
        </div>
        <div>
          <span>Доступно</span>
          <strong>{needsProviders.length}</strong>
        </div>
        <div>
          <span>CLI доступно</span>
          <strong>{detectedClis.filter(c => c.status === 'ready' || c.status === 'found').length}</strong>
        </div>
      </div>

      <div className="gg-providers-explain">
        <div>
          <span>CLI</span>
          <p>Работает через установленную командную строку и вход в аккаунт</p>
        </div>
        <div>
          <span>API</span>
          <p>Работает через ключ с сайта провайдера</p>
        </div>
      </div>

      <section className="gg-prov-detected">
        <div className="gg-prov-detected-head">
          <div>
            <div className="gg-prov-detected-title">Локально найдено</div>
            <p>Verstak проверяет CLI-провайдеры на компьютере. Найденные можно сразу добавить в инструменты чата</p>
          </div>
          <button
            type="button"
            className="gg-btn gg-btn-ghost"
            onClick={() => void refreshCliDetection()}
            disabled={cliDetectBusy}
          >
            {cliDetectBusy ? 'Проверяю…' : 'Обновить'}
          </button>
        </div>
        {cliDetectMessage && <div className="gg-prov-cli-message">{cliDetectMessage}</div>}
        {supportedDetectedClis.length > 0 ? (
          <div className="gg-prov-detected-list">
            {supportedDetectedClis.map(c => {
              const provider = providers.find(p => p.id === c.id)
              const enabled = Boolean(provider && enabledModels.has(modelKey(provider.id, provider.defaultModel || 'auto')))
              return (
                <div key={c.id} className="gg-prov-detected-item">
                  <span className={`gg-prov-detected-dot is-${c.status}`} />
                  <span className="gg-prov-detected-main">
                    <span className="gg-prov-detected-name">{c.name}</span>
                    <span className="gg-prov-detected-version">{c.version}</span>
                  </span>
                  <button
                    type="button"
                    className="gg-btn gg-btn-ghost gg-prov-detected-action"
                    onClick={() => void quickUseCli(c)}
                    disabled={enabled}
                  >
                    {enabled ? 'Добавлен' : 'Добавить'}
                  </button>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="gg-prov-detected-empty">
            Ничего не найдено. Установи CLI-провайдер и нажми «Обновить»
          </div>
        )}
      </section>

      {showEmptyState && (
        <div className="gg-providers-empty" role="status">
          Подключи хотя бы один провайдер, чтобы модели появились в инструментах чата
        </div>
      )}

      {toast && (
        <div className={`gg-prov-toast is-${toast.kind}`} role="status">
          {toast.text}
        </div>
      )}

      <div className="gg-providers-filters" role="group" aria-label="Фильтр провайдеров">
        {[
          ['all', 'Все'],
          ['connected', 'Подключено'],
          ['needs', 'Доступно'],
          ['cli', 'CLI'],
          ['api', 'API']
        ].map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={filter === id ? 'is-active' : ''}
            onClick={() => setFilter(id as ProviderFilter)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="gg-prov-list">
        {visibleProviders.length === 0 && (
          <div className="gg-providers-empty">
            По этому фильтру ничего нет
          </div>
        )}
        {visibleProviders.map(p => {
          const status = connectionStatus(p.id, p.secretKey, keys)
          const cliState = getCliState(p)
          const ready = isReady(p)
          const badge = statusBadge(status, p.transport, p.id, p.secretKey, cliState, ready)
          const selected = selectedProviderId === p.id
          return (
            <div key={p.id} className={`gg-prov-card ${selected ? 'is-selected' : ''} ${ready ? 'is-ready' : 'is-missing'}`}>
              <div
                className="gg-prov-card-shell"
                role="button"
                tabIndex={0}
                onClick={() => toggleProvider(p.id)}
                onKeyDown={event => onProviderShellKey(event, p.id)}
                aria-expanded={selected}
              >
                <span className="gg-prov-card-icon" aria-hidden>{providerGlyph(p)}</span>
                <div className="gg-prov-card-main">
                  <div className="gg-prov-card-top">
                    <div className="gg-prov-card-name">{p.name}</div>
                    <span
                      className={`gg-prov-status-dot ${ready ? 'is-ready' : 'is-missing'}`}
                      title={badge.title ?? badge.label}
                      aria-label={badge.label}
                    />
                  </div>
                  <div className="gg-prov-card-desc">{p.description}</div>
                  <div className="gg-prov-card-note">
                    {p.transport === 'CLI'
                      ? 'Подключается через установленный CLI и вход в аккаунт'
                      : p.secretKey
                        ? 'Нужен API-ключ с сайта провайдера'
                        : 'Работает локально или через заданный сервер'}
                  </div>
                </div>
                <div className="gg-prov-card-side">
                  <span className={`gg-prov-type is-${p.transport.toLowerCase()}`}>{p.transport}</span>
                  <button
                    type="button"
                    className={`gg-btn gg-btn-ghost gg-provider-settings-toggle gg-provider-action-icon ${selected ? 'is-open' : ''}`}
                    onClick={event => { event.stopPropagation(); toggleProvider(p.id) }}
                    title={selected ? 'Закрыть настройки' : ready ? 'Открыть настройки' : 'Настроить подключение'}
                    aria-label={selected ? 'Закрыть настройки' : ready ? 'Открыть настройки' : 'Настроить подключение'}
                  >
                    <ProviderSettingsToggleIcon open={selected} />
                  </button>
                </div>
              </div>
              {selected && (
                <section className="gg-provider-detail-panel">
                  <div className="gg-provider-detail-head">
                    <div>
                      <span>Настройка</span>
                      <h3>{p.name}</h3>
                    </div>
                    <div className="gg-provider-detail-actions">
                      <button
                        type="button"
                        className="gg-btn gg-btn-ghost"
                        onClick={() => checkProvider(p)}
                      >
                        Проверить
                      </button>
                      {ready && (
                        <button
                          type="button"
                          className="gg-btn gg-btn-ghost"
                          onClick={() => void disconnect(p)}
                          disabled={busy === p.id}
                        >
                          {busy === p.id ? '...' : 'Отключить'}
                        </button>
                      )}
                      <button type="button" className="gg-btn gg-btn-ghost" onClick={() => setSelectedProviderId(null)}>
                        Закрыть
                      </button>
                    </div>
                  </div>
                  <ProviderExpandForm
                    p={p}
                    keys={keys}
                    setKeys={setKeys}
                    customOpenaiBaseUrl={customOpenaiBaseUrl}
                    setCustomOpenaiBaseUrl={setCustomOpenaiBaseUrl}
                    customOpenaiModels={customOpenaiModels}
                    setCustomOpenaiModels={setCustomOpenaiModels}
                    hint="После изменения нажми «Сохранить» внизу окна настроек"
                  />
                  {p.id === 'claude-cli' && (
                    <SubscriptionAccountsPanel providerId="claude-cli" secretLabel="OAuth-токен (claude setup-token)" />
                  )}
                  {p.id === 'codex-cli' && (
                    <SubscriptionAccountsPanel providerId="codex-cli" mode="dir" />
                  )}
                </section>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Универсальный expand-блок для карточки провайдера: API ключ + (для custom-openai)
 * Base URL и список моделей. Выделен в отдельный компонент чтобы не дублировать
 * между «Подключёнными» и «Доступными» секциями.
 */
interface ProviderExpandFormProps {
  p: ProviderConfig
  keys: Record<string, string>
  setKeys: React.Dispatch<React.SetStateAction<Record<string, string>>>
  customOpenaiBaseUrl: string
  setCustomOpenaiBaseUrl: (v: string) => void
  customOpenaiModels: string
  setCustomOpenaiModels: (v: string) => void
  /** Опциональный hint снизу (например, «Нажми Сохранить» для доступных). */
  hint?: string
}

function ProviderExpandForm(props: ProviderExpandFormProps) {
  const { p, keys, setKeys, customOpenaiBaseUrl, setCustomOpenaiBaseUrl,
          customOpenaiModels, setCustomOpenaiModels, hint } = props
  const isCustom = p.id === 'custom-openai'
  const isYandex = p.id === 'yandex-gpt'
  const isGigaChat = p.id === 'gigachat'

  return (
    <div className="gg-prov-card-expand">
      {isYandex && (
        <>
          <div className="gg-label">Folder ID</div>
          <input
            className="gg-input"
            value={keys['yandex_folder_id'] ?? ''}
            onChange={e => setKeys(k => ({ ...k, yandex_folder_id: e.target.value }))}
            placeholder="b1g…"
            spellCheck={false}
            autoFocus
          />
          <div className="gg-text-tertiary" style={{ fontSize: 'var(--text-xs)', marginTop: 4, marginBottom: 10 }}>
            Yandex Cloud Console → выбери каталог → скопируй ID из адресной строки
          </div>
        </>
      )}

      {isGigaChat && (
        <>
          <div className="gg-label">Client Secret</div>
          <input
            className="gg-input"
            type="password"
            value={keys['gigachat_client_secret'] ?? ''}
            onChange={e => setKeys(k => ({ ...k, gigachat_client_secret: e.target.value }))}
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            autoFocus
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={keys['gigachat_tls_verify'] === 'true'}
              onChange={e => setKeys(k => ({ ...k, gigachat_tls_verify: e.target.checked ? 'true' : 'false' }))}
            />
            <span style={{ fontSize: 'var(--text-sm)' }}>Проверять TLS-сертификат сервера</span>
          </label>
          <div className="gg-text-tertiary" style={{ fontSize: 'var(--text-xs)', marginTop: 4, marginBottom: 10 }}>
            Если на компьютере установлен Russian Trusted Root CA, включи проверку сертификата
          </div>
        </>
      )}

      {isCustom && (
        <>
          <div className="gg-label">Адрес сервера</div>
          <input
            className="gg-input"
            value={customOpenaiBaseUrl}
            onChange={e => setCustomOpenaiBaseUrl(e.target.value)}
            placeholder="https://server.local/v1 или http://localhost:8000/v1"
            spellCheck={false}
            autoFocus
          />
          <div className="gg-text-tertiary" style={{ fontSize: 'var(--text-xs)', marginTop: 4, marginBottom: 10 }}>
            Подойдёт любой совместимый сервер: LM Studio, vLLM, локальная модель или корпоративный шлюз
          </div>

          <div className="gg-label">Модели</div>
          <input
            className="gg-input"
            value={customOpenaiModels}
            onChange={e => setCustomOpenaiModels(e.target.value)}
            placeholder="qwen2.5-72b-instruct, llama-3.3-70b, mistral-large"
            spellCheck={false}
            style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }}
          />
          <div className="gg-text-tertiary" style={{ fontSize: 'var(--text-xs)', marginTop: 4, marginBottom: 10 }}>
            Укажи ID моделей через запятую
          </div>
        </>
      )}

      {p.optIn && p.secretKey && (
        <div className="gg-codex-optin">
          <div className="gg-codex-optin-warning">⚠ {p.optIn.warning}</div>
          <label className="gg-codex-optin-label">
            <input
              type="checkbox"
              checked={keys[p.secretKey] === '1'}
              onChange={e => setKeys(k => ({ ...k, [p.secretKey!]: e.target.checked ? '1' : '' }))}
            />
            {p.optIn.label}
          </label>
        </div>
      )}

      {p.secretKey && !p.optIn && (
        <>
          <div className="gg-label">{isCustom ? 'API-ключ' : 'API-ключ'}</div>
          <input
            className="gg-input"
            type="password"
            value={keys[p.secretKey] ?? ''}
            onChange={e => setKeys(k => ({ ...k, [p.secretKey!]: e.target.value }))}
            placeholder={p.keyHint}
            autoFocus={!isCustom}
          />
          {p.keyLink && (
            <div className="gg-provider-key-help">
              <span>Нужен ключ с сайта провайдера</span>
              <a className="gg-models-key-link gg-provider-key-link-action" href={p.keyLink.url} target="_blank" rel="noreferrer">Где взять ключ</a>
            </div>
          )}
        </>
      )}

      {!p.secretKey && !isCustom && (
        <div className="gg-text-tertiary" style={{ fontSize: 'var(--text-xs)' }}>
          Ключ не нужен — этот провайдер работает локально
        </div>
      )}

      {hint && (
        <div className="gg-text-tertiary" style={{ fontSize: 'var(--text-xs)', marginTop: 8 }}>
          {hint}
        </div>
      )}
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// ModelsPage — карточки провайдеров: ползунок «все модели» / «Выбрать отдельные».
// enabled_models управляет picker'ом; по умолчанию — только модель входа.
// ════════════════════════════════════════════════════════════════════════════

interface ModelsPageProps {
  providers: ProviderConfig[]
  enabledModels: Set<string>
  setEnabledModels: React.Dispatch<React.SetStateAction<Set<string>>>
  models: Record<string, string>
  setModels: React.Dispatch<React.SetStateAction<Record<string, string>>>
  activeProvider: ProviderId
  setActiveProvider: (id: ProviderId) => void
  keys: Record<string, string>
  customOpenaiBaseUrl: string
  onGoToProviders: () => void
  /** 2.0.7-D: live = каталог из providers:list; bundled = офлайн-снапшот (IPC упал). */
  catalogSource: CatalogSource
}

type ModelsCliStatusMap = Partial<Record<CliAuthId, CliAuthStatus>>

function ModelsPage(props: ModelsPageProps) {
  const t = useT()
  const {
    providers, enabledModels, setEnabledModels, models, setModels,
    activeProvider, setActiveProvider, keys, customOpenaiBaseUrl, onGoToProviders, catalogSource
  } = props

  // 2.0.7-D (карточка, шаг 5): сохранённая модель, которой НЕТ в живом каталоге провайдера,
  // — показываем её как «недоступна» (а не молча подменяем на дефолт). Пусто = всё ок.
  function savedUnavailableModel(p: ProviderConfig): string | null {
    return resolveModelAvailability(p.models, models[p.id]) === 'unavailable' ? models[p.id] : null
  }
  const [search, setSearch] = useState('')
  const [detailProviders, setDetailProviders] = useState<Set<ProviderId>>(new Set())
  const [authModal, setAuthModal] = useState<ProviderConfig | null>(null)
  const [cliStatus, setCliStatus] = useState<ModelsCliStatusMap | null>(null)
  const [localServerIds, setLocalServerIds] = useState<Set<string>>(new Set())
  // 2.0.7-E Model Doctor: живой каталог grok-cli (единственный live-адаптер пока).
  const [doctorBusy, setDoctorBusy] = useState(false)
  const [doctorStatus, setDoctorStatus] = useState<ProviderCatalogStatusDTO | null>(null)

  async function refreshGrokModels() {
    setDoctorBusy(true)
    try { setDoctorStatus(await window.api.providers.refreshModels('grok-cli')) }
    catch { /* ignore — оставляем прежний статус */ }
    finally { setDoctorBusy(false) }
  }

  useEffect(() => {
    void Promise.all([
      window.api.cliAuth.statusAll().catch(() => null as ModelsCliStatusMap | null),
      window.api.localModels.scan().catch(() => []),
    ]).then(([cli, local]) => {
      if (cli) setCliStatus(cli)
      setLocalServerIds(new Set(local.filter(s => s.running).map(s => s.id)))
    }).catch(() => { /* ignore */ })
  }, [])

  const catalog = useMemo(() => buildCatalog(providers), [providers])
  const grouped = useMemo(() => {
    const map = new Map<ProviderId, typeof catalog>()
    const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean)
    for (const e of catalog) {
      const haystack = modelSearchText(e)
      if (terms.length > 0 && !terms.every(term => haystack.includes(term))) continue
      const list = map.get(e.providerId) ?? []
      list.push(e)
      map.set(e.providerId, list)
    }
    return map
  }, [catalog, search])

  function isAuthorized(p: ProviderConfig): boolean {
    return isProviderAuthorized(p, keys, cliStatus, { customOpenaiBaseUrl, localServerIds })
  }

  function requireAuth(p: ProviderConfig, action: () => void) {
    if (!isAuthorized(p)) {
      setAuthModal(p)
      return
    }
    action()
  }

  function countEnabled(p: ProviderConfig): number {
    return p.models.filter(m => enabledModels.has(modelKey(p.id, m))).length
  }

  function providerModel(p: ProviderConfig): string {
    const stored = models[p.id]
    if (stored && p.models.includes(stored)) return stored
    if (p.models.includes(p.defaultModel)) return p.defaultModel
    return p.models[0] ?? p.defaultModel
  }

  function pickWorkModels(p: ProviderConfig): string[] {
    const picked = new Set<string>()
    const add = (m?: string | null) => {
      if (m && p.models.includes(m)) picked.add(m)
    }
    add(providerModel(p))
    add(p.defaultModel)
    add(p.models.find(m => /build|composer|coder|code|sonnet|gpt-5|gemini|kimi|deepseek/i.test(m)))
    add(p.models.find(m => /fast|flash|mini|haiku|economy/i.test(m)))
    return [...picked].slice(0, 3)
  }

  function applyPreset(kind: 'current' | 'work' | 'connected') {
    if (kind === 'current') {
      const p = providers.find(x => x.id === activeProvider)
      if (!p) return
      requireAuth(p, () => {
        setEnabledModels(new Set([modelKey(p.id, providerModel(p))]))
      })
      return
    }

    const authorized = providers.filter(p => p.models.length > 0 && isAuthorized(p))
    const next = new Set<string>()
    for (const p of authorized) {
      const selected = kind === 'connected' ? p.models : pickWorkModels(p)
      for (const m of selected) next.add(modelKey(p.id, m))
    }
    const active = providers.find(x => x.id === activeProvider)
    if (active && isAuthorized(active)) next.add(modelKey(active.id, providerModel(active)))
    setEnabledModels(next)
  }

  function enableAll(p: ProviderConfig) {
    setEnabledModels(prev => {
      const next = new Set(prev)
      for (const m of p.models) next.add(modelKey(p.id, m))
      return next
    })
  }

  function disableAll(p: ProviderConfig) {
    setEnabledModels(prev => {
      const next = new Set(prev)
      for (const m of p.models) next.delete(modelKey(p.id, m))
      // providerModel(p) — эффективная ВАЛИДНАЯ модель (не сырое сохранённое значение,
      // которое после 2.0.7-D может быть вне каталога → мёртвый ключ в enabled).
      if (p.id === activeProvider) next.add(modelKey(p.id, providerModel(p)))
      return next
    })
  }

  function toggleModel(p: ProviderConfig, key: string, enable: boolean) {
    if (enable) {
      requireAuth(p, () => {
        setEnabledModels(prev => new Set(prev).add(key))
      })
      return
    }
    setEnabledModels(prev => {
      const next = new Set(prev)
      next.delete(key)
      return next
    })
  }

  function toggleAllModels(p: ProviderConfig) {
    if (countEnabled(p) > 0) {
      disableAll(p)
      return
    }
    requireAuth(p, () => enableAll(p))
  }

  function toggleDetail(id: ProviderId) {
    setDetailProviders(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function setDefault(providerId: ProviderId, model: string) {
    const provider = providers.find(p => p.id === providerId)
    if (!provider) return
    requireAuth(provider, () => {
      setActiveProvider(providerId)
      setModels(m => ({ ...m, [providerId]: model }))
      setEnabledModels(prev => new Set(prev).add(modelKey(providerId, model)))
    })
  }

  async function openAuthSite(p: ProviderConfig) {
    const link = providerAuthLink(p)
    if (link) await window.api.app.openExternal(link.url)
  }

  function providerGlyph(p: ProviderConfig): string {
    const explicit: Partial<Record<ProviderId, string>> = {
      'verstak-gateway': 'V',
      'gemini-api': 'G',
      'gemini-cli': 'GC',
      'claude': 'C',
      'claude-cli': 'CC',
      'grok': 'X',
      'grok-cli': 'GB',
      'openai': 'GPT',
      'codex-cli': 'CX',
      'openrouter': 'OR',
      'deepseek': 'DS',
      'moonshot': 'K',
      'kimi-coding': 'K',
      'zai-coding': 'Z',
      'qwen': 'Q',
      'mistral': 'M',
      'groq': 'GQ',
      'ollama': 'OL',
      'yandex-gpt': 'YA',
      'gigachat': 'GC',
      'custom-openai': '{}'
    }
    const value = explicit[p.id]
    if (value) return value
    return p.name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(part => part[0]?.toUpperCase())
      .join('') || p.transport
  }

  const visibleProviders = providers.filter(p => {
    if (p.models.length === 0) return false
    if (!search.trim()) return true
    return grouped.has(p.id)
  }).sort((a, b) => {
    const authDelta = Number(isAuthorized(b)) - Number(isAuthorized(a))
    if (authDelta !== 0) return authDelta
    const activeDelta = Number(b.id === activeProvider) - Number(a.id === activeProvider)
    if (activeDelta !== 0) return activeDelta
    return a.name.localeCompare(b.name, 'ru')
  })
  const hasAuthorizedModelProviders = visibleProviders.some(p => isAuthorized(p))
  const firstLockedModelProviderIndex = visibleProviders.findIndex(p => !isAuthorized(p))

  return (
    <div className="gg-settings-extra gg-models-page">
      <h2 className="gg-settings-page-title">Модели</h2>
      <p className="gg-models-intro">
        Выбери, какие модели будут отображаться в инструментах чата. Подключение провайдера, видимость модели и текущая модель настраиваются отдельно
      </p>

      {catalogSource === 'bundled' && (
        <p className="gg-models-intro" role="status" style={{ color: 'var(--warn, #b8860b)' }}>
          ⚠ Офлайн-каталог: список моделей не удалось получить от приложения, показан встроенный снимок — модели могут быть устаревшими.
        </p>
      )}

      {/* 2.0.7-E Model Doctor: живая проверка каталога Grok Build (единственный live-адаптер). */}
      <div className="gg-models-doctor" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', margin: '4px 0 10px' }}>
        <button type="button" className="gg-btn gg-btn-ghost" disabled={doctorBusy} onClick={() => void refreshGrokModels()}>
          {doctorBusy ? '⏳ Проверяю…' : '🩺 Проверить модели Grok Build'}
        </button>
        {doctorStatus && (
          <span className="gg-models-card-desc" role="status">
            {doctorStatus.status === 'available'
              ? `Актуально: ${doctorStatus.ids.length} моделей${doctorStatus.authenticated ? '' : ' (не вошли в Grok — список может быть неполным)'}`
              : doctorStatus.status === 'unavailable'
                ? `Не удалось получить список (${doctorStatus.reasonCode ?? 'ошибка'})`
                : 'Живой каталог недоступен'}
          </span>
        )}
      </div>

      <div className="gg-models-presets" aria-label="Быстрые наборы моделей">
        <button type="button" className="gg-models-preset" onClick={() => applyPreset('current')}>
          <span>Только текущая</span>
          <small>Оставить в чате одну выбранную модель</small>
        </button>
        <button type="button" className="gg-models-preset" onClick={() => applyPreset('work')}>
          <span>Рабочий набор</span>
          <small>Показать основные модели подключённых провайдеров</small>
        </button>
        <button type="button" className="gg-models-preset" onClick={() => applyPreset('connected')}>
          <span>Все подключённые</span>
          <small>Показать все модели доступных провайдеров</small>
        </button>
      </div>

      <div className="gg-models-search-wrap">
        <input
          className="gg-input gg-models-search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Поиск: код, быстро, Grok, локальная"
          spellCheck={false}
        />
      </div>

      <div className="gg-models-cards">
        {visibleProviders.map((p, index) => {
          const list = grouped.get(p.id) ?? []
          const authorized = isAuthorized(p)
          const enabledCount = countEnabled(p)
          const isDetail = detailProviders.has(p.id)
          const isActiveProvider = activeProvider === p.id
          const control = modeControlInfo(p.id, p.transport)
          const authLink = providerAuthLink(p)

          return (
            <React.Fragment key={p.id}>
              {index === 0 && hasAuthorizedModelProviders && (
                <div className="gg-models-section-title">Подключённые модели</div>
              )}
              {index === firstLockedModelProviderIndex && (
                <div className="gg-models-section-title is-locked">Требуется подключение</div>
              )}
              <div className={`gg-models-card ${isActiveProvider ? 'is-current' : ''} ${isDetail ? 'is-open' : ''}`}>
                <div
                  role="button"
                  tabIndex={0}
                  className="gg-models-service-card"
                  onClick={() => toggleDetail(p.id)}
                  onKeyDown={event => {
                    if (event.target !== event.currentTarget) return
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      toggleDetail(p.id)
                    }
                  }}
                  aria-expanded={isDetail}
                >
                  <span className="gg-models-provider-icon" aria-hidden>{providerGlyph(p)}</span>
                  <span className="gg-models-card-head">
                    <span className="gg-models-card-title">
                      <span className="gg-models-card-name">{p.name}</span>
                      <span
                        className={`gg-models-card-access ${authorized ? 'is-ready' : 'is-locked'}`}
                        title={authorized ? 'Провайдер подключён' : 'Требуется подключение'}
                        aria-label={authorized ? 'Провайдер подключён' : 'Требуется подключение'}
                      />
                    </span>
                    <span className="gg-models-card-desc">{p.description}</span>
                    <span className="gg-models-card-meta">
                      <span className="gg-models-card-count">В чате: {enabledCount} из {p.models.length}</span>
                      <span className={`gg-models-card-control is-${control.tone}`} title={control.hint}>
                        {control.label}
                      </span>
                      {savedUnavailableModel(p) && (
                        <span
                          className="gg-models-card-control is-limited"
                          title={`Модель «${savedUnavailableModel(p)}» не найдена в текущем каталоге провайдера. Выберите доступную ниже — устаревшую модель приложение само заменит при отправке.`}
                        >
                          ⚠ модель недоступна
                        </span>
                      )}
                    </span>
                  </span>
                  <button
                    type="button"
                    className={`gg-btn gg-btn-ghost gg-provider-settings-toggle gg-provider-action-icon gg-models-card-chevron ${isDetail ? 'is-open' : ''}`}
                    onClick={event => { event.stopPropagation(); toggleDetail(p.id) }}
                    title={isDetail ? 'Закрыть настройки' : 'Открыть настройки'}
                    aria-label={isDetail ? 'Закрыть настройки' : 'Открыть настройки'}
                  >
                    <ProviderSettingsToggleIcon open={isDetail} />
                  </button>
                </div>

                {isDetail && (
                  <div className="gg-models-card-panel">
                    <div className="gg-models-card-actions">
                      <label className="gg-models-card-toggle">
                        <span className="gg-models-card-toggle-label">Показывать все</span>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={enabledCount > 0}
                          className={`gg-toggle ${enabledCount > 0 ? 'is-on' : ''}`}
                          onClick={() => toggleAllModels(p)}
                          title={enabledCount > 0 ? 'Выключить все модели провайдера' : 'Включить все модели провайдера'}
                        >
                          <span className="gg-toggle-knob" />
                        </button>
                      </label>
                      {!authorized && authLink && (
                        <button
                          type="button"
                          className="gg-models-key-link"
                          onClick={() => void openAuthSite(p)}
                        >
                          {p.secretKey ? 'Где взять ключ' : 'Как подключить'}
                        </button>
                      )}
                    </div>
                    <div className="gg-models-card-list">
                    {list.length === 0 && (
                      <div className="gg-text-tertiary" style={{ padding: '10px 4px', fontSize: 'var(--text-sm)' }}>
                        Ничего не найдено
                      </div>
                    )}
                    {list.map(e => {
                      const enabled = enabledModels.has(e.key)
                      const isCurrentModel = isActiveProvider && (models[p.id] ?? p.defaultModel) === e.model
                      return (
                        <div key={e.key} className={`gg-models-row ${isCurrentModel ? 'is-current' : ''} ${!authorized ? 'is-locked' : ''}`}>
                          <button
                            type="button"
                            className="gg-models-row-main"
                            onClick={() => setDefault(p.id, e.model)}
                            aria-disabled={!authorized}
                            title={authorized ? 'Сделать текущей моделью в чате' : 'Сначала подключи провайдера'}
                          >
                            <span className="gg-models-row-name">{e.model}</span>
                            <span className="gg-models-row-tags">
                              <span className={`gg-models-row-tag is-control-${control.tone}`} title={control.hint}>
                                {control.shortLabel}
                              </span>
                              {e.tags.map(tag => (
                                <span key={tag} className={`gg-models-row-tag is-${tag.toLowerCase().replace(/\$/g, 'd')}`}>{tag}</span>
                              ))}
                            </span>
                          </button>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={enabled}
                            className={`gg-toggle ${enabled ? 'is-on' : ''}`}
                            onClick={() => toggleModel(p, e.key, !enabled)}
                            title={enabled ? 'Скрыть из инструментов чата' : authorized ? 'Показать в инструментах чата' : 'Сначала подключи провайдера'}
                          >
                            <span className="gg-toggle-knob" />
                          </button>
                        </div>
                      )
                    })}
                    </div>
                  </div>
                )}
              </div>
            </React.Fragment>
          )
        })}
      </div>

      {visibleProviders.length === 0 && (
        <div className="gg-text-tertiary" style={{ padding: 18, textAlign: 'center', fontSize: 'var(--text-sm)' }}>
          Ничего не найдено
        </div>
      )}

      {authModal && (
        <div className="gg-modal-backdrop" role="dialog" aria-modal="true" onClick={() => setAuthModal(null)}>
          <div className="gg-models-auth-modal" onClick={e => e.stopPropagation()}>
            <h3>Нужна авторизация</h3>
            <p>
              Чтобы включить модели <strong>{authModal.name}</strong>, сначала подключи провайдер.
              {authModal.transport === 'API'
                ? ' Получи API-ключ на сайте провайдера и вставь его во вкладке «Провайдеры».'
                : ' Проверь, что CLI установлен и авторизация уже выполнена в аккаунте провайдера.'}
            </p>
            <div className="gg-models-auth-actions">
              {providerAuthLink(authModal) && (
                <button
                  type="button"
                  className="gg-btn gg-btn-primary"
                  onClick={() => void openAuthSite(authModal)}
                >
                  Открыть {providerAuthLink(authModal)!.label}
                </button>
              )}
              {authModal.transport === 'API' && (
                <button
                  type="button"
                  className="gg-btn gg-btn-ghost"
                  onClick={() => { setAuthModal(null); onGoToProviders() }}
                >
                  Перейти к ключу
                </button>
              )}
              <button type="button" className="gg-btn gg-btn-ghost" onClick={() => setAuthModal(null)}>
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
