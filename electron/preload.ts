import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  projects: {
    pick: () => ipcRenderer.invoke('projects:pick'),
    setCurrent: (path: string | null) => ipcRenderer.invoke('projects:set-current', path),
    list: () => ipcRenderer.invoke('projects:list'),
    rename: (path: string, name: string) => ipcRenderer.invoke('projects:rename', path, name),
    remove: (path: string) => ipcRenderer.invoke('projects:remove', path)
  },
  files: {
    tree: (root: string) => ipcRenderer.invoke('files:tree', root),
    read: (path: string) => ipcRenderer.invoke('files:read', path)
  },
  settings: {
    getKey: (key: string) => ipcRenderer.invoke('settings:get-key', key),
    setKey: (key: string, value: string) => ipcRenderer.invoke('settings:set-key', key, value)
  },
  ai: {
    send: (messages: unknown[], projectPath: string | null) =>
      ipcRenderer.invoke('ai:send', messages, projectPath),
    sendWithBudget: (messages: unknown[], projectPath: string | null, budget: number) =>
      ipcRenderer.invoke('ai:send', messages, projectPath, budget),
    /** Send with provider/model/systemPrompt override. Used by Explicit Review:
     *  routes through ai:send with overrides so reviewer ≠ chat provider. */
    sendWithOverrides: (
      messages: unknown[],
      projectPath: string | null,
      overrides: { providerId?: string; model?: string | null; noTools?: boolean; systemPrompt?: string }
    ) => ipcRenderer.invoke('ai:send', messages, projectPath, undefined, overrides),
    resolveWrite: (callId: string, accept: boolean, sendId?: number) =>
      ipcRenderer.invoke('ai:resolve-write', callId, accept, sendId),
    resolveCommand: (callId: string, accept: boolean, sendId?: number) =>
      ipcRenderer.invoke('ai:resolve-command', callId, accept, sendId),
    stop: (sendId: number) => ipcRenderer.invoke('ai:stop', sendId),
    countTokens: (text: string, projectPath: string | null, historyMessages?: unknown[]) =>
      ipcRenderer.invoke('ai:count-tokens', text, projectPath, historyMessages) as Promise<{ tokens: number; exact: boolean; providerId: string }>,
    onEvent: (cb: (data: { id: number; event: unknown }) => void) => {
      const handler = (_e: unknown, data: { id: number; event: unknown }) => cb(data)
      ipcRenderer.on('ai:event', handler)
      return () => { ipcRenderer.off('ai:event', handler) }
    }
  },
  chatSessions: {
    list: (projectPath: string) => ipcRenderer.invoke('chat-sessions:list', projectPath),
    listReviews: (parentChatId: number) => ipcRenderer.invoke('chat-sessions:list-reviews', parentChatId),
    create: (projectPath: string, opts?: {
      title?: string
      providerId?: string | null
      model?: string | null
      kind?: 'main' | 'review'
      parentChatId?: number | null
    }) => ipcRenderer.invoke('chat-sessions:create', projectPath, opts),
    rename: (id: number, title: string) => ipcRenderer.invoke('chat-sessions:rename', id, title),
    setModel: (id: number, providerId: string | null, model: string | null) =>
      ipcRenderer.invoke('chat-sessions:set-model', id, providerId, model),
    remove: (id: number) => ipcRenderer.invoke('chat-sessions:remove', id)
  },
  chats: {
    list: (sessionId: number) => ipcRenderer.invoke('chats:list', sessionId),
    append: (sessionId: number, projectPath: string, role: 'user' | 'assistant', content: string) =>
      ipcRenderer.invoke('chats:append', sessionId, projectPath, role, content)
  },
  tasks: {
    list: (projectPath: string) => ipcRenderer.invoke('tasks:list', projectPath),
    add: (projectPath: string, text: string) => ipcRenderer.invoke('tasks:add', projectPath, text),
    toggle: (id: number, done: boolean) => ipcRenderer.invoke('tasks:toggle', id, done),
    remove: (id: number) => ipcRenderer.invoke('tasks:remove', id),
    clearDone: (projectPath: string) => ipcRenderer.invoke('tasks:clear-done', projectPath)
  },
  journal: {
    list: (projectPath: string, limit?: number) => ipcRenderer.invoke('journal:list', projectPath, limit),
    append: (projectPath: string, kind: string, title: string, detail?: string | null) =>
      ipcRenderer.invoke('journal:append', projectPath, kind, title, detail),
    remove: (id: number) => ipcRenderer.invoke('journal:remove', id),
    clear: (projectPath: string) => ipcRenderer.invoke('journal:clear', projectPath)
  },
  undo: {
    list: (projectPath: string) => ipcRenderer.invoke('undo:list', projectPath),
    count: (projectPath: string) => ipcRenderer.invoke('undo:count', projectPath),
    clear: (projectPath: string) => ipcRenderer.invoke('undo:clear', projectPath),
    revert: (projectPath: string, id?: number) => ipcRenderer.invoke('undo:revert', projectPath, id),
    checkpoint: (projectPath: string) => ipcRenderer.invoke('undo:checkpoint', projectPath),
    revertToCheckpoint: (projectPath: string, checkpointId: number) =>
      ipcRenderer.invoke('undo:revertToCheckpoint', projectPath, checkpointId)
  },
  feedback: {
    list: (projectPath: string | null, limit?: number) => ipcRenderer.invoke('feedback:list', projectPath, limit),
    submit: (input: { projectPath: string | null; providerId: string | null; rating: number | null; message: string }) =>
      ipcRenderer.invoke('feedback:submit', input),
    remove: (id: number) => ipcRenderer.invoke('feedback:remove', id)
  },
  plans: {
    list: (projectPath: string) => ipcRenderer.invoke('plans:list', projectPath),
    get: (id: number) => ipcRenderer.invoke('plans:get', id),
    create: (projectPath: string, title: string, steps: Array<{ title: string; detail?: string | null }>) =>
      ipcRenderer.invoke('plans:create', projectPath, title, steps),
    setStatus: (id: number, status: string) => ipcRenderer.invoke('plans:set-status', id, status),
    updateStep: (id: number, patch: { status?: string; result?: string | null }) =>
      ipcRenderer.invoke('plans:update-step', id, patch),
    remove: (id: number) => ipcRenderer.invoke('plans:remove', id)
  },
  verify: {
    exec: (command: string) => ipcRenderer.invoke('verify:exec', command) as Promise<{ exitCode: number; stdout: string; stderr: string }>
  },
  autonomous: {
    status: () => ipcRenderer.invoke('autonomous:status') as Promise<{ enabled: boolean; intervalMin: number; lastRunAt: number | null; lastRunSuggestions: number; lastRunError: string | null; nextRunAt: number | null }>,
    runOnce: () => ipcRenderer.invoke('autonomous:run-once') as Promise<{ enabled: boolean; intervalMin: number; lastRunAt: number | null; lastRunSuggestions: number; lastRunError: string | null; nextRunAt: number | null }>,
    start: (intervalMin: number) => ipcRenderer.invoke('autonomous:start', intervalMin),
    stop: () => ipcRenderer.invoke('autonomous:stop')
  },
  term: {
    spawn: (cwd: string) => ipcRenderer.invoke('term:spawn', cwd) as Promise<number>,
    write: (id: number, data: string) => ipcRenderer.invoke('term:write', id, data),
    resize: (id: number, cols: number, rows: number) => ipcRenderer.invoke('term:resize', id, cols, rows),
    kill: (id: number) => ipcRenderer.invoke('term:kill', id),
    onData: (cb: (data: { id: number; data: string }) => void) => {
      const handler = (_e: unknown, data: { id: number; data: string }) => cb(data)
      ipcRenderer.on('term:data', handler)
      return () => { ipcRenderer.off('term:data', handler) }
    },
    onExit: (cb: (data: { id: number }) => void) => {
      const handler = (_e: unknown, data: { id: number }) => cb(data)
      ipcRenderer.on('term:exit', handler)
      return () => { ipcRenderer.off('term:exit', handler) }
    }
  }
})
