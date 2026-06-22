import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AgentMode } from '../components/ModePicker'
import { HELP_AGENT_MODE } from '../lib/help-scope'

const KNOWN: AgentMode[] = ['ask', 'accept-edits', 'plan', 'auto', 'bypass']
export function parseAgentMode(v: string | null | undefined): AgentMode {
  return (v && (KNOWN as string[]).includes(v)) ? (v as AgentMode) : 'ask'
}

const POLL_MS = 2000

export function agentModeSettingsKey(chatId: number | null | undefined, helpMode = false): string {
  if (helpMode) return 'agent_mode_help'
  return chatId != null ? `agent_mode_chat_${chatId}` : 'agent_mode'
}

export async function readAgentMode(chatId: number | null | undefined, helpMode = false): Promise<AgentMode> {
  if (helpMode) {
    const v = await window.api.settings.getKey(agentModeSettingsKey(chatId, true))
    return parseAgentMode(v ?? HELP_AGENT_MODE)
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
  const [mode, setLocal] = useState<AgentMode>('ask')
  const key = useMemo(() => agentModeSettingsKey(chatId, helpMode), [chatId, helpMode])

  const refresh = useCallback(async () => {
    setLocal(await readAgentMode(chatId, helpMode))
  }, [chatId, helpMode])

  useEffect(() => {
    let cancelled = false
    void (async () => { if (!cancelled) await refresh() })()
    const t = window.setInterval(refresh, POLL_MS)
    return () => { cancelled = true; window.clearInterval(t) }
  }, [refresh, key])

  const setMode = useCallback(async (m: AgentMode) => {
    await writeAgentMode(chatId, helpMode, m)
    setLocal(m)
  }, [chatId, helpMode])

  return { mode, setMode }
}
