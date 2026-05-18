import { create } from 'zustand'
import type { FileNode, ChatMessage } from '../types/api'

interface ProjectState {
  path: string | null
  tree: FileNode[]
  messages: ChatMessage[]
  isStreaming: boolean
  setProject: (path: string) => Promise<void>
  addMessage: (msg: ChatMessage) => void
  updateLastAssistant: (text: string) => void
  setStreaming: (v: boolean) => void
}

export const useProject = create<ProjectState>((set) => ({
  path: null,
  tree: [],
  messages: [],
  isStreaming: false,
  setProject: async (path) => {
    const tree = await window.api.files.tree(path)
    set({ path, tree, messages: [] })
  },
  addMessage: (msg) => set(s => ({ messages: [...s.messages, msg] })),
  updateLastAssistant: (text) => set(s => {
    const msgs = [...s.messages]
    const last = msgs[msgs.length - 1]
    if (last?.role === 'assistant') msgs[msgs.length - 1] = { ...last, content: last.content + text }
    return { messages: msgs }
  }),
  setStreaming: (v) => set({ isStreaming: v })
}))
