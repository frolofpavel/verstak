import type { Projects } from '../storage/projects'
import type { Chats } from '../storage/chats'
import type { ChatSessions } from '../storage/chat-sessions'
import { createMobileHandlers } from './adapter'
import { createRootCapabilities } from './roots'
import { MobileBridgeSession } from './session'
import { DesktopRelayTransport, type DesktopTransportConfig } from './transport'

export function startMobileBridge(input: {
  config: DesktopTransportConfig
  projects: Projects
  sessions: ChatSessions
  chats: Chats
  startRun: (input: { chatId: number; projectPath: string; text: string }) => Promise<{ runId: string }>
  stopRun: (runId: string) => Promise<boolean>
}): DesktopRelayTransport {
  const roots = createRootCapabilities(input.projects.list())
  const handlers = createMobileHandlers({ roots, sessions: input.sessions, chats: input.chats, startRun: input.startRun, stopRun: input.stopRun })
  const transport = new DesktopRelayTransport(input.config, new MobileBridgeSession(handlers))
  void transport.connect().catch(() => {})
  return transport
}
