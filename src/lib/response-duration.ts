import type { ChatMessage } from '../types/api'
import type { SessionSnapshot } from '../store/session-snapshot'

export type StreamTimingSlice = Pick<SessionSnapshot, 'messages' | 'isStreaming' | 'streamStartedAt'>

export function stampDurationOnStreamEnd(snapshot: StreamTimingSlice): StreamTimingSlice {
  const startedAt = snapshot.streamStartedAt
  if (startedAt == null) {
    return { ...snapshot, isStreaming: false, streamStartedAt: null }
  }
  const ms = Math.max(0, Date.now() - startedAt)
  const msgs = stampLastAssistantDuration(snapshot.messages, ms)
  return { messages: msgs, isStreaming: false, streamStartedAt: null }
}

export function stampLastAssistantDuration(messages: ChatMessage[], ms: number): ChatMessage[] {
  const msgs = [...messages]
  const last = msgs[msgs.length - 1]
  if (last?.role === 'assistant') {
    msgs[msgs.length - 1] = { ...last, responseDurationMs: ms }
  }
  return msgs
}