import { ipcMain, BrowserWindow } from 'electron'
import type { Settings } from '../storage/settings'
import {
  UI_SCALE_KEY,
  applyUiScaleToWindow,
  normalizeUiScalePercent
} from '../ui-scale'
import { detectInstalledClis } from '../ai/cli-detect'
import { scanLocalModelServers } from '../ai/local-models'
import { PROVIDERS, providerCapabilities, type ProviderCapabilities } from '../ai/registry'
import { findGrokBinary } from '../ai/grok-cli'
import { runGrokDiscovery } from '../ai/model-discovery'
import {
  saveLiveCatalog, loadLiveCatalog, catalogStatus,
  type CatalogStore, type ProviderCatalogStatusDTO,
} from '../ai/model-catalog-service'
import {
  authKindFor,
  executionModeFor,
  EXPERIMENTAL_PROVIDER_IDS,
  type ProviderDescriptorDTO,
} from '../../shared/contracts/provider'
import { runDoctor } from '../ai/doctor'
import { recommendTier, type TierRecommendation } from '../ai/tier-router'
import { AGENT_MODES, decide, type AgentMode, type ToolDecision } from '../ai/mode-policy'
import { dangerousCommandLabels } from '../ai/command-policy'

/**
 * Сериализуемый дескриптор провайдера для renderer (без фабричных функций).
 * 2.0.7-C, ревью: здесь ЖИЛА ПЯТАЯ КОПИЯ этого типа (id: string, без honesty-полей).
 * Producer был типизирован ею, consumer — shared-контрактом, и связи между ними не было:
 * убери поле из литерала ниже — `npm run type` остался бы зелёным, а renderer получил бы
 * undefined там, где тип обещает значение. Теперь тип ровно один — из shared.
 */
export type { ProviderDescriptorDTO } from '../../shared/contracts/provider'

/** Категория действия агента — для матрицы Policy Center. */
export type PolicyCategory = 'read' | 'edit' | 'command' | 'connector'

export interface PolicyMatrixRow {
  tool: string
  category: PolicyCategory
  decisions: Record<AgentMode, ToolDecision>
}

export interface PolicyMatrixDTO {
  modes: Array<{ id: AgentMode; label: string; description: string; icon: string }>
  rows: PolicyMatrixRow[]
  commandDanger: string[]
}

// Представительные инструменты по категориям. Decision считается из реальной
// decide() для каждого режима — рендерер ничего не дублирует.
const POLICY_TOOLS: ReadonlyArray<{ tool: string; category: PolicyCategory }> = [
  { tool: 'read_file',       category: 'read' },
  { tool: 'write_file',      category: 'edit' },
  { tool: 'apply_patch',     category: 'edit' },
  { tool: 'run_command',     category: 'command' },
  { tool: 'connector_query', category: 'connector' }
]

/** Снимок политики разрешений агента — единый источник правды через decide(). */
function buildPolicyMatrix(): PolicyMatrixDTO {
  const rows: PolicyMatrixRow[] = POLICY_TOOLS.map(({ tool, category }) => {
    const decisions = {} as Record<AgentMode, ToolDecision>
    for (const m of AGENT_MODES) {
      decisions[m.id] = decide(tool, m.id)
    }
    return { tool, category, decisions }
  })
  return {
    modes: AGENT_MODES.map(m => ({ id: m.id, label: m.label, description: m.description, icon: m.icon })),
    rows,
    commandDanger: dangerousCommandLabels()
  }
}

export function registerSettingsIpc(settings: Settings): void {
  ipcMain.handle('settings:get-key', (_e, key: string) => settings.getSecret(key))
  ipcMain.handle('settings:set-key', (e, key: string, value: string) => {
    settings.setSecret(key, value)
    if (key === UI_SCALE_KEY) {
      const win = BrowserWindow.fromWebContents(e.sender)
      if (win) {
        const pct = normalizeUiScalePercent(value)
        applyUiScaleToWindow(win, pct)
        win.webContents.send('ui-scale:changed', pct)
      }
    }
  })
  // F3: список output-стилей (built-in + user:/project:) для динамического селектора —
  // иначе кастомные user:/project: стили недостижимы из UI (ревью HIGH).
  ipcMain.handle('output-styles:list', async (_e, projectPath: string | null) => {
    const { loadOutputStyles } = await import('../ai/output-styles')
    return loadOutputStyles(projectPath).map(s => ({ id: s.id, name: s.name, description: s.description, scope: s.scope }))
  })

  // Persistent per-command approvals: «запомнить это одобрение» → prefix-правило в
  // ~/.verstak/permissions.json (allow). Будущие сессии авто-разрешают. Возвращает
  // добавленное правило (или null, если нечего/уже было).
  ipcMain.handle('permissions:remember', async (_e, toolName: string, argText: string): Promise<string | null> => {
    const { derivePrefixRule, rememberApproval } = await import('../ai/permission-rules')
    const rule = derivePrefixRule(toolName, argText)
    if (!rule) return null
    rememberApproval(rule)  // идемпотентно; правило возвращаем для UI-фидбека
    return rule
  })

  ipcMain.handle('cli:detect', () => detectInstalledClis())
  ipcMain.handle('local-models:scan', () => scanLocalModelServers())

  // Единый источник истины для списка провайдеров и моделей — electron/ai/registry.ts.
  // Renderer получает данные через этот канал, а не хардкодит копию.
  ipcMain.handle('providers:list', (): ProviderDescriptorDTO[] => {
    // Аннотация НА КОЛЛБЭКЕ обязательна: без неё TS выводит тип литерала и проверяет
    // лишь совместимость массива — пропущенное поле контракта прошло бы молча.
    return Object.values(PROVIDERS).map((p): ProviderDescriptorDTO => ({
      id: p.id,
      name: p.name,
      transport: p.transport,
      // 2.0.7-C: honesty-поля считаются ЗДЕСЬ, из shared-контракта, а не угадываются в UI.
      executionMode: executionModeFor(p.transport),
      authKind: authKindFor(p.id, p.transport, p.secretKey),
      experimental: EXPERIMENTAL_PROVIDER_IDS.includes(p.id),
      // Списки моделей пока статические (зашиты в реестр); live-discovery — срез 2.0.7-E.
      catalogSource: 'static' as const,
      secretKey: p.secretKey,
      models: [...p.models],
      defaultModel: p.defaultModel,
      supportsTools: p.supportsTools,
      shortLabel: p.shortLabel,
      capabilities: providerCapabilities(p)
    }))
  })

  // ─── Model Doctor (2.0.7-E): живой каталог моделей ────────────────────────
  // Кеш живого каталога хранится в settings (только id+timestamp, TTL 24ч).
  const catalogStore: CatalogStore = {
    get: key => settings.getSecret(key),
    set: (key, value) => { settings.setSecret(key, value) },
  }

  // Провайдеры с live-адаптером обнаружения. Пока только grok-cli (первый адаптер —
  // `grok models`, карточка 2.0.7-E). Остальным — 'static' каталог реестра.
  const LIVE_DISCOVERY_PROVIDERS = new Set(['grok-cli'])

  // providers:refresh-models — ПРИНУДИТЕЛЬНО опросить провайдера и обновить живой каталог.
  ipcMain.handle('providers:refresh-models', async (_e, providerId: string): Promise<ProviderCatalogStatusDTO> => {
    const now = Date.now()
    if (!LIVE_DISCOVERY_PROVIDERS.has(providerId)) {
      return { providerId, status: 'unknown', ids: [], defaultModel: null, source: 'bundled', authenticated: false, reasonCode: 'NO_LIVE_ADAPTER' }
    }
    const result = await runGrokDiscovery({ binary: findGrokBinary() })
    // Ревью F1: НЕ сохраняем как авторитетный каталог ничего кроме 'available' с моделями.
    // Пустой (status='empty') или ошибочный вывод, сохранённый с authenticated=true,
    // заблокировал бы гейтом ВСЕ модели на 24ч. Пустой каталог = «не смогли», не «ноль».
    if (result.status !== 'available' || result.models.length === 0) {
      return { providerId, status: 'unavailable', ids: [], defaultModel: null, source: 'cli-live', authenticated: result.authenticated, fetchedAt: now, reasonCode: result.reasonCode ?? 'EMPTY_CATALOG' }
    }
    const entry = saveLiveCatalog(catalogStore, providerId, result, now)
    return {
      providerId, status: 'available', ids: entry.ids, defaultModel: entry.defaultModel,
      source: entry.source, authenticated: entry.authenticated, fetchedAt: entry.fetchedAt,
      expiresAt: entry.expiresAt, reasonCode: result.reasonCode,
    }
  })

  // providers:doctor — ТЕКУЩИЙ кешированный статус живого каталога (read-only, без опроса).
  ipcMain.handle('providers:doctor', (_e, providerId: string): ProviderCatalogStatusDTO => {
    const entry = loadLiveCatalog(catalogStore, providerId)
    const status = catalogStatus(entry, Date.now())
    return {
      providerId, status, ids: entry?.ids ?? [], defaultModel: entry?.defaultModel ?? null,
      source: entry?.source ?? 'bundled', authenticated: entry?.authenticated ?? false,
      fetchedAt: entry?.fetchedAt, expiresAt: entry?.expiresAt,
    }
  })

  // Policy Center — снимок «что разрешено агенту»: матрица decide(tool, mode)
  // по 5 режимам + список опасных команд. Вычисляется из реальных policy-функций
  // (mode-policy.decide + command-policy.dangerousCommandLabels), рендерер не
  // дублирует логику.
  ipcMain.handle('policy:matrix', (): PolicyMatrixDTO => buildPolicyMatrix())

  // Doctor — health-check настроенных провайдеров и коннекторов (config presence,
  // без сетевых вызовов). См. electron/ai/doctor.ts.
  ipcMain.handle('doctor:run', () => runDoctor(settings))

  // Tier Router — РЕКОМЕНДАЦИЯ тира+провайдера+модели под текст задачи.
  // Чистая рекомендация (см. electron/ai/tier-router.ts), не autopilot: UI
  // показывает pill с кнопкой «применить», переключение делает пользователь.
  // configuredProviderIds = провайдеры с заданным ключом + CLI/локальные
  // (secretKey === null или ollama — ключ не нужен). Тот же критерий «настроен»
  // что в doctor:run / ModelPicker.
  ipcMain.handle('router:recommend', (_e, taskText: string): TierRecommendation | null => {
    const text = typeof taskText === 'string' ? taskText.trim() : ''
    if (!text) return null

    const configuredProviderIds = Object.values(PROVIDERS)
      .filter(p => {
        // CLI-провайдеры авторизуются через бинарь — ключ не нужен, считаем настроенными.
        if (p.secretKey === null) return true
        // Ollama — локальный сервис, ключ необязателен.
        if (p.id === 'ollama') return true
        return !!settings.getSecret(p.secretKey)
      })
      .map(p => p.id)

    return recommendTier([{ role: 'user', content: text }], configuredProviderIds)
  })
}
