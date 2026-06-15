import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  projects: {
    pick: () => ipcRenderer.invoke('projects:pick'),
    setCurrent: (path: string | null) => ipcRenderer.invoke('projects:set-current', path),
    list: () => ipcRenderer.invoke('projects:list'),
    rename: (path: string, name: string) => ipcRenderer.invoke('projects:rename', path, name),
    updateMeta: (path: string, patch: { name?: string }) =>
      ipcRenderer.invoke('projects:update-meta', path, patch),
    pickIcon: (path: string) => ipcRenderer.invoke('projects:pick-icon', path),
    clearIcon: (path: string) => ipcRenderer.invoke('projects:clear-icon', path),
    remove: (path: string) => ipcRenderer.invoke('projects:remove', path)
  },
  app: {
    getHomeDir: () => ipcRenderer.invoke('app:home-dir') as Promise<string>,
    getVersion: () => ipcRenderer.invoke('app:version') as Promise<string>,
    isFocused: () => ipcRenderer.invoke('app:is-focused') as Promise<boolean>,
    openExternal: (url: string) => ipcRenderer.invoke('app:open-external', url) as Promise<boolean>
  },
  notify: {
    show: (opts: { title: string; body: string }) =>
      ipcRenderer.invoke('notify:show', opts) as Promise<boolean>,
    playSound: (opts?: { isError?: boolean }) =>
      ipcRenderer.invoke('notify:play-sound', opts) as Promise<boolean>
  },
  files: {
    tree: (root: string) => ipcRenderer.invoke('files:tree', root),
    read: (path: string) => ipcRenderer.invoke('files:read', path),
    revealInExplorer: (path: string) => ipcRenderer.invoke('files:reveal', path),
    docxToHtml: (path: string) => ipcRenderer.invoke('files:docx-to-html', path)
  },
  projectMap: {
    warm: (root: string) => ipcRenderer.invoke('project-map:warm', root),
    get: (root: string, refresh?: boolean) => ipcRenderer.invoke('project-map:get', root, refresh),
    deps: (root: string, refresh?: boolean) => ipcRenderer.invoke('project-map:deps', root, refresh)
  },
  settings: {
    getKey: (key: string) => ipcRenderer.invoke('settings:get-key', key),
    setKey: (key: string, value: string) => ipcRenderer.invoke('settings:set-key', key, value),
    onUiScaleChanged: (cb: (percent: number) => void) => {
      const handler = (_e: unknown, percent: number) => cb(percent)
      ipcRenderer.on('ui-scale:changed', handler)
      return () => { ipcRenderer.off('ui-scale:changed', handler) }
    }
  },
  providers: {
    list: () => ipcRenderer.invoke('providers:list')
  },
  doctor: {
    run: () => ipcRenderer.invoke('doctor:run')
  },
  router: {
    recommend: (taskText: string) => ipcRenderer.invoke('router:recommend', taskText)
  },
  policy: {
    matrix: () => ipcRenderer.invoke('policy:matrix')
  },
  ai: {
    send: (messages: unknown[], projectPath: string | null, chatId?: string) =>
      ipcRenderer.invoke('ai:send', messages, projectPath, undefined, undefined, chatId),
    sendWithBudget: (messages: unknown[], projectPath: string | null, budget: number, chatId?: string) =>
      ipcRenderer.invoke('ai:send', messages, projectPath, budget, undefined, chatId),
    /** Send with provider/model/systemPrompt override. Used by Explicit Review:
     *  routes through ai:send with overrides so reviewer ≠ chat provider. */
    sendWithOverrides: (
      messages: unknown[],
      projectPath: string | null,
      overrides: { providerId?: string; model?: string | null; noTools?: boolean; systemPrompt?: string; useReviewerPrompt?: boolean },
      chatId?: string
    ) => ipcRenderer.invoke('ai:send', messages, projectPath, undefined, overrides, chatId),
    resolveWrite: (callId: string, accept: boolean, sendId?: number) =>
      ipcRenderer.invoke('ai:resolve-write', callId, accept, sendId),
    resolveCommand: (callId: string, accept: boolean, sendId?: number) =>
      ipcRenderer.invoke('ai:resolve-command', callId, accept, sendId),
    stop: (sendId: number) => ipcRenderer.invoke('ai:stop', sendId),
    countTokens: (text: string, projectPath: string | null, historyMessages?: unknown[]) =>
      ipcRenderer.invoke('ai:count-tokens', text, projectPath, historyMessages) as Promise<{ tokens: number; exact: boolean; providerId: string }>,
    onEvent: (cb: (data: { id: number; event: unknown; projectPath: string | null }) => void) => {
      const handler = (_e: unknown, data: { id: number; event: unknown; projectPath: string | null }) => cb(data)
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
  handoff: {
    generate: (sessionId: number, parentId?: string | null) =>
      ipcRenderer.invoke('handoff:generate', sessionId, parentId) as Promise<string>
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
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    get: (id: string) => ipcRenderer.invoke('skills:get', id),
    refresh: () => ipcRenderer.invoke('skills:refresh'),
    status: () => ipcRenderer.invoke('skills:status'),
    runLoaders: (skillId: string, opts: { arg?: string; projectPath?: string | null; trigger: 'chat_open' | 'slash_arg' }) =>
      ipcRenderer.invoke('skills:run-loaders', skillId, opts)
  },
  cliAuth: {
    logout: (providerId: string) => ipcRenderer.invoke('cli-auth:logout', providerId),
    relogin: (providerId: string) => ipcRenderer.invoke('cli-auth:relogin', providerId),
    statusAll: () => ipcRenderer.invoke('cli-auth:status-all')
  },
  userProfiles: {
    list: () => ipcRenderer.invoke('user-profiles:list'),
    getActive: () => ipcRenderer.invoke('user-profiles:get-active'),
    create: (input: { name: string; role?: string; defaultProvider?: string; defaultModel?: string; skillsEnabled?: string[] }) =>
      ipcRenderer.invoke('user-profiles:create', input),
    setActive: (id: number) => ipcRenderer.invoke('user-profiles:set-active', id),
    update: (id: number, patch: { name?: string; role?: string; defaultProvider?: string; defaultModel?: string; skillsEnabled?: string[] }) =>
      ipcRenderer.invoke('user-profiles:update', id, patch),
    remove: (id: number) => ipcRenderer.invoke('user-profiles:remove', id)
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
    updateStep: (id: number, patch: { status?: string; result?: string | null; runId?: string | null; verificationStatus?: string | null; changedFilesCount?: number | null }) =>
      ipcRenderer.invoke('plans:update-step', id, patch),
    remove: (id: number) => ipcRenderer.invoke('plans:remove', id)
  },
  workflows: {
    list: () => ipcRenderer.invoke('workflows:list'),
    start: (workflowId: string, projectPath: string, brief: string) =>
      ipcRenderer.invoke('workflows:start', workflowId, projectPath, brief)
  },
  memory: {
    save: (projectPath: string, type: string, content: string, tags: string[]) =>
      ipcRenderer.invoke('memory:save', { projectPath, type, content, tags }),
    search: (projectPath: string, query: string, limit?: number) =>
      ipcRenderer.invoke('memory:search', { projectPath, query, limit }),
    list: (projectPath: string) =>
      ipcRenderer.invoke('memory:list', { projectPath }),
    delete: (id: string) =>
      ipcRenderer.invoke('memory:delete', { id })
  },
  coreMemory: {
    load: (projectPath: string) => ipcRenderer.invoke('core-memory:load', projectPath),
    save: (projectPath: string, block: string, content: string) =>
      ipcRenderer.invoke('core-memory:save', { projectPath, block, content })
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
  commands: {
    list: (projectPath: string | null) => ipcRenderer.invoke('commands:list', projectPath)
  },
  cli: {
    detect: () => ipcRenderer.invoke('cli:detect')
  },
  localModels: {
    scan: () => ipcRenderer.invoke('local-models:scan')
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
    },
    /** Sidecar terminal intelligence: подписка на обнаруженные ошибки
     *  в потоке терминала. */
    onErrorDetected: (cb: (data: { id: number; error: { kind: string; file?: string; line?: number; message: string; raw: string } }) => void) => {
      const handler = (_e: unknown, data: { id: number; error: { kind: string; file?: string; line?: number; message: string; raw: string } }) => cb(data)
      ipcRenderer.on('term:error-detected', handler)
      return () => { ipcRenderer.off('term:error-detected', handler) }
    }
  },

  updater: {
    install: () => ipcRenderer.invoke('update:install'),
    check: () => ipcRenderer.invoke('update:check'),
    onAvailable: (cb: (data: { version: string }) => void) => {
      const handler = (_e: unknown, data: { version: string }) => cb(data)
      ipcRenderer.on('update:available', handler)
      return () => { ipcRenderer.off('update:available', handler) }
    },
    onDownloaded: (cb: (data: { version: string }) => void) => {
      const handler = (_e: unknown, data: { version: string }) => cb(data)
      ipcRenderer.on('update:downloaded', handler)
      return () => { ipcRenderer.off('update:downloaded', handler) }
    },
    onProgress: (cb: (data: { percent: number }) => void) => {
      const handler = (_e: unknown, data: { percent: number }) => cb(data)
      ipcRenderer.on('update:progress', handler)
      return () => { ipcRenderer.off('update:progress', handler) }
    },
    onNotAvailable: (cb: () => void) => {
      const handler = () => cb()
      ipcRenderer.on('update:not-available', handler)
      return () => { ipcRenderer.off('update:not-available', handler) }
    },
  },
  audit: {
    query: (projectPath: string, opts?: { limit?: number; action?: string; since?: number }) =>
      ipcRenderer.invoke('audit:query', projectPath, opts),
    export: (projectPath: string) => ipcRenderer.invoke('audit:export', projectPath),
    clear: (projectPath: string, olderThan?: number) => ipcRenderer.invoke('audit:clear', projectPath, olderThan)
  },
  debug: {
    packet: (runId: string) => ipcRenderer.invoke('debug:packet', runId)
  },
  // Панель Agents (Фаза 2) — персистентные суб-сессии + массовая отмена.
  agents: {
    list: (projectPath: string) => ipcRenderer.invoke('agents:list', projectPath),
    history: (subSessionId: number) => ipcRenderer.invoke('agents:history', subSessionId),
    cancel: (filter: { all?: boolean; group?: string | null; role?: string | null }) =>
      ipcRenderer.invoke('agents:cancel', filter),
    queueStats: () => ipcRenderer.invoke('agents:queue-stats'),
    todos: (projectPath: string, sessionId?: number | null) =>
      ipcRenderer.invoke('agents:todos', projectPath, sessionId)
  },
  // Вкладка «Задачи» (Multi-agent Manager) — высокоуровневые прогоны + stop/resume (Фаза 4).
  agentRuns: {
    list: (projectPath: string, opts?: { status?: string; owner?: string; limit?: number }) =>
      ipcRenderer.invoke('agent-runs:list', projectPath, opts),
    get: (runId: string) => ipcRenderer.invoke('agent-runs:get', runId),
    stop: (runId: string) => ipcRenderer.invoke('agent-runs:stop', runId),
    resume: (runId: string) => ipcRenderer.invoke('agent-runs:resume', runId)
  },
  suggestions: {
    get: (projectPath: string) => ipcRenderer.invoke('suggestions:get', projectPath)
  },
  mcp: {
    listServers: () => ipcRenderer.invoke('mcp:list-servers'),
    addServer: (entry: unknown) => ipcRenderer.invoke('mcp:add-server', entry),
    updateServer: (id: string, patch: unknown) => ipcRenderer.invoke('mcp:update-server', id, patch),
    removeServer: (id: string) => ipcRenderer.invoke('mcp:remove-server', id),
    toggleServer: (id: string, enabled: boolean) => ipcRenderer.invoke('mcp:toggle-server', id, enabled),
    connect: (id: string) => ipcRenderer.invoke('mcp:connect', id),
    disconnect: (id: string) => ipcRenderer.invoke('mcp:disconnect', id),
    tools: () => ipcRenderer.invoke('mcp:tools'),
    connectedServers: () => ipcRenderer.invoke('mcp:connected-servers'),
    popular: () => ipcRenderer.invoke('mcp:popular'),
    saveAll: (servers: unknown) => ipcRenderer.invoke('mcp:save-all', servers)
  }
})
