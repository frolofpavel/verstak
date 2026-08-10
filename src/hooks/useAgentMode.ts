import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AgentMode } from '../components/ModePicker'
import { HELP_AGENT_MODE } from '../lib/help-scope'
import { DEFAULT_AGENT_MODE, resolveAgentMode } from '../../shared/contracts/agent-mode-policy'

// V5: дефолт режима живёт в shared/contracts — одна точка на main и renderer.
// Дублировать строку 'auto' здесь нельзя: расхождение показало бы человеку один
// режим, пока main работает в другом (урок plan_approval_gate, A3 §2.1).
export function parseAgentMode(v: string | null | undefined, fallback: AgentMode = DEFAULT_AGENT_MODE): AgentMode {
  return resolveAgentMode(v, fallback)
}

const POLL_MS = 2000

export function agentModeSettingsKey(chatId: number | null | undefined, helpMode = false): string {
  if (helpMode) return 'agent_mode_help'
  return chatId != null ? `agent_mode_chat_${chatId}` : 'agent_mode'
}

export async function readAgentMode(chatId: number | null | undefined, helpMode = false): Promise<AgentMode> {
  if (helpMode) {
    // У справочного чата СВОЙ дефолт — он не участвует в продуктовом V5-дефолте.
    // Fallback передаётся явно: иначе мусорное значение уводило бы справку в auto.
    const v = await window.api.settings.getKey(agentModeSettingsKey(chatId, true))
    return parseAgentMode(v, HELP_AGENT_MODE as AgentMode)
  }
  const chatKey = agentModeSettingsKey(chatId, false)
  const v = await window.api.settings.getKey(chatKey)
  if (v) return parseAgentMode(v)
  return parseAgentMode(await window.api.settings.getKey('agent_mode'))
}

export async function writeAgentMode(chatId: number | null | undefined, helpMode: boolean, mode: AgentMode): Promise<void> {
  await window.api.settings.setKey(agentModeSettingsKey(chatId, helpMode), mode)
}

export function useAgentMode(chatId?: number | null, helpMode = false): { mode: AgentMode; setMode: (m: AgentMode) => Promise<void> } {
  // Начальное значение до первого чтения настроек: продуктовый дефолт, иначе на
  // старте мелькал бы `ask`, которого у нового пользователя уже нет.
  const [mode, setLocal] = useState<AgentMode>(helpMode ? (HELP_AGENT_MODE as AgentMode) : DEFAULT_AGENT_MODE)
  const key = useMemo(() => agentModeSettingsKey(chatId, helpMode), [chatId, helpMode])

  const refresh = useCallback(async () => {
    setLocal(await readAgentMode(chatId, helpMode))
  }, [chatId, helpMode])

  useEffect(() => {
    let cancelled = false
    void (async () => { if (!cancelled) await refresh() })()
    const t = window.setInterval(() => { void refresh() }, POLL_MS)
    return () => { cancelled = true; window.clearInterval(t) }
  }, [refresh, key])

  const setMode = useCallback(async (m: AgentMode) => {
    await writeAgentMode(chatId, helpMode, m)
    setLocal(m)
  }, [chatId, helpMode])

  return { mode, setMode }
}
