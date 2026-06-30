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
import { runDoctor } from '../ai/doctor'
import { recommendTier, type TierRecommendation } from '../ai/tier-router'
import { AGENT_MODES, decide, type AgentMode, type ToolDecision } from '../ai/mode-policy'
import { dangerousCommandLabels } from '../ai/command-policy'

/** Сериализуемый дескриптор провайдера для renderer (без фабричных функций). */
export interface ProviderDescriptorDTO {
  id: string
  name: string
  transport: 'API' | 'CLI'
  secretKey: string | null
  models: string[]
  defaultModel: string
  supportsTools: boolean
  shortLabel: string
  /** Ревью F3: формальная матрица возможностей — драйвит degraded-индикацию в UI. */
  capabilities: ProviderCapabilities
}

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

  ipcMain.handle('cli:detect', () => detectInstalledClis())
  ipcMain.handle('local-models:scan', () => scanLocalModelServers())

  // Единый источник истины для списка провайдеров и моделей — electron/ai/registry.ts.
  // Renderer получает данные через этот канал, а не хардкодит копию.
  ipcMain.handle('providers:list', (): ProviderDescriptorDTO[] => {
    return Object.values(PROVIDERS).map(p => ({
      id: p.id,
      name: p.name,
      transport: p.transport,
      secretKey: p.secretKey,
      models: [...p.models],
      defaultModel: p.defaultModel,
      supportsTools: p.supportsTools,
      shortLabel: p.shortLabel,
      capabilities: providerCapabilities(p)
    }))
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
