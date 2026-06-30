import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  projects: {
    pick: () => ipcRenderer.invoke('projects:pick'),
    addRemote: (input: string) => ipcRenderer.invoke('projects:add-remote', input),
    remoteDoctor: (path: string) => ipcRenderer.invoke('projects:remote-doctor', path),
    create: (input: { name: string; folderSlug: string; iconSourcePath?: string | null }) =>
      ipcRenderer.invoke('projects:create', input),
    clientsRoot: () => ipcRenderer.invoke('projects:clients-root') as Promise<string>,
    pickImage: () => ipcRenderer.invoke('projects:pick-image') as Promise<string | null>,
    setCurrent: (path: string | null) => ipcRenderer.invoke('projects:set-current', path),
    list: () => ipcRenderer.invoke('projects:list'),
    rename: (path: string, name: string) => ipcRenderer.invoke('projects:rename', path, name),
    updateMeta: (path: string, patch: { name?: string; hidden?: boolean }) =>
      ipcRenderer.invoke('projects:update-meta', path, patch),
    pickIcon: (path: string) => ipcRenderer.invoke('projects:pick-icon', path),
    clearIcon: (path: string) => ipcRenderer.invoke('projects:clear-icon', path),
    remove: (path: string, options?: { deleteData?: boolean }) =>
      ipcRenderer.invoke('projects:remove', path, options) as Promise<{ ok: boolean; error?: string }>,
    listGroups: () => ipcRenderer.invoke('projects:list-groups'),
    createGroup: (name: string, projectPaths: string[]) =>
      ipcRenderer.invoke('projects:create-group', name, projectPaths),
    updateGroup: (id: number, patch: {
      name?: string
      projectPaths?: string[]
      collapsed?: boolean
      sortOrder?: number
    }) => ipcRenderer.invoke('projects:update-group', id, patch),
    deleteGroup: (id: number) => ipcRenderer.invoke('projects:delete-group', id)
  },
  app: {
    getHomeDir: () => ipcRenderer.invoke('app:home-dir') as Promise<string>,
    getVersion: () => ipcRenderer.invoke('app:version') as Promise<string>,
    isFocused: () => ipcRenderer.invoke('app:is-focused') as Promise<boolean>,
    openExternal: (url: string) => ipcRenderer.invoke('app:open-external', url) as Promise<boolean>
  },
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize') as Promise<void>,
    maximize: () => ipcRenderer.invoke('window:maximize') as Promise<boolean>,
    close: () => ipcRenderer.invoke('window:close') as Promise<void>,
    isMaximized: () => ipcRenderer.invoke('window:is-maximized') as Promise<boolean>,
    onMaximizedChanged: (cb: (maximized: boolean) => void) => {
      const handler = (_e: unknown, maximized: boolean) => cb(maximized)
      ipcRenderer.on('window:maximized-changed', handler)
      return () => { ipcRenderer.off('window:maximized-changed', handler) }
    }
  },
  notify: {
    show: (opts: {
      title?: string
      body: string
      projectName?: string
      projectPath?: string
      isHelp?: boolean
      isError?: boolean
    }) => ipcRenderer.invoke('notify:show', opts) as Promise<boolean>,
    playSound: (opts?: { isError?: boolean }) =>
      ipcRenderer.invoke('notify:play-sound', opts) as Promise<boolean>,
    onOpenProject: (cb: (projectPath: string) => void) => {
      const handler = (_e: unknown, projectPath: string) => cb(projectPath)
      ipcRenderer.on('notify:open-project', handler)
      return () => { ipcRenderer.removeListener('notify:open-project', handler) }
    },
    onOpenHelp: (cb: (projectPath?: string) => void) => {
      const handler = (_e: unknown, projectPath?: string) => cb(projectPath)
      ipcRenderer.on('notify:open-help', handler)
      return () => { ipcRenderer.removeListener('notify:open-help', handler) }
    },
    onOpenReminders: (cb: (projectPath?: string) => void) => {
      const handler = (_e: unknown, projectPath?: string) => cb(projectPath)
      ipcRenderer.on('notify:open-reminders', handler)
      return () => { ipcRenderer.removeListener('notify:open-reminders', handler) }
    },
    onOpenChat: (cb: (payload: { projectPath?: string; chatId: number }) => void) => {
      const handler = (_e: unknown, payload: { projectPath?: string; chatId: number }) => cb(payload)
      ipcRenderer.on('notify:open-chat', handler)
      return () => { ipcRenderer.removeListener('notify:open-chat', handler) }
    },
    onSendChatReminder: (cb: (payload: { reminderId: number; projectPath: string; chatId: number; text: string }) => void) => {
      const handler = (_e: unknown, payload: { reminderId: number; projectPath: string; chatId: number; text: string }) => cb(payload)
      ipcRenderer.on('notify:send-chat-reminder', handler)
      return () => { ipcRenderer.removeListener('notify:send-chat-reminder', handler) }
    }
  },
  voice: {
    status: () => ipcRenderer.invoke('voice:status') as Promise<{
      ready: boolean
      loading: boolean
      label: string
    }>,
    transcribe: (payload: { data: string; mimeType?: string }) =>
      ipcRenderer.invoke('voice:transcribe', payload) as Promise<
        { ok: true; text: string } | { ok: false; error: string }
      >
  },
  files: {
    tree: (root: string) => ipcRenderer.invoke('files:tree', root),
    read: (path: string) => ipcRenderer.invoke('files:read', path),
    resolveMentions: (projectPath: string, paths: string[]) => ipcRenderer.invoke('files:resolveMentions', projectPath, paths),
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
    outputStyles: (projectPath: string | null) => ipcRenderer.invoke('output-styles:list', projectPath),
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
  connectors: {
    test: (uiId: string) => ipcRenderer.invoke('connectors:test', uiId) as Promise<{ ok: boolean; message: string }>
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
      overrides: { providerId?: string; model?: string | null; noTools?: boolean; systemPrompt?: string; useReviewerPrompt?: boolean; effortLevel?: 'quick' | 'standard' | 'deep'; toolsAllow?: string[]; agentMode?: 'ask' | 'accept-edits' | 'plan' | 'auto' | 'bypass' },
      chatId?: string
    ) => ipcRenderer.invoke('ai:send', messages, projectPath, undefined, overrides, chatId),
    resolveWrite: (callId: string, accept: boolean, sendId?: number) =>
      ipcRenderer.invoke('ai:resolve-write', callId, accept, sendId),
    resolveCommand: (callId: string, accept: boolean, sendId?: number) =>
      ipcRenderer.invoke('ai:resolve-command', callId, accept, sendId),
    resolvePlan: (callId: string, decision: 'approve' | 'revise' | 'reject', feedback?: string, sendId?: number) =>
      ipcRenderer.invoke('ai:resolve-plan', callId, decision, feedback, sendId),
    stop: (sendId: number) => ipcRenderer.invoke('ai:stop', sendId),
    suspend: (sendId: number) => ipcRenderer.invoke('ai:suspend', sendId),
    appendContext: (sendId: number, text: string) =>
      ipcRenderer.invoke('ai:append-context', sendId, text) as Promise<
        { ok: true } | { ok: false; fallback: 'invalid' | 'unavailable' }
      >,
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
      kind?: 'main' | 'review' | 'help'
      parentChatId?: number | null
    }) => ipcRenderer.invoke('chat-sessions:create', projectPath, opts),
    fork: (sourceId: number, opts?: { uptoMessageId?: number; title?: string }) =>
      ipcRenderer.invoke('chat-sessions:fork', sourceId, opts),
    getOrCreateHelp: () => ipcRenderer.invoke('chat-sessions:get-or-create-help'),
    rename: (id: number, title: string) => ipcRenderer.invoke('chat-sessions:rename', id, title),
    setModel: (id: number, providerId: string | null, model: string | null) =>
      ipcRenderer.invoke('chat-sessions:set-model', id, providerId, model),
    remove: (id: number) => ipcRenderer.invoke('chat-sessions:remove', id)
  },
  chats: {
    list: (sessionId: number) => ipcRenderer.invoke('chats:list', sessionId),
    append: (sessionId: number, projectPath: string, role: 'user' | 'assistant', content: string) =>
      ipcRenderer.invoke('chats:append', sessionId, projectPath, role, content),
    maxMessageId: (sessionId: number) => ipcRenderer.invoke('chats:max-message-id', sessionId) as Promise<number>,
    truncateAfter: (sessionId: number, afterMessageId: number) => ipcRenderer.invoke('chats:truncate-after', sessionId, afterMessageId) as Promise<number>
  },
  handoff: {
    generate: (sessionId: number, parentId?: string | null) =>
      ipcRenderer.invoke('handoff:generate', sessionId, parentId) as Promise<string>,
    saveToDownloads: (sessionId: number, parentId?: string | null) =>
      ipcRenderer.invoke('handoff:save-to-downloads', sessionId, parentId)
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
    currentSession: (projectPath: string) => ipcRenderer.invoke('journal:currentSession', projectPath),
    append: (projectPath: string, kind: string, title: string, detail?: string | null) =>
      ipcRenderer.invoke('journal:append', projectPath, kind, title, detail)
  },
  reminders: {
    list: (projectPath: string, limit?: number) => ipcRenderer.invoke('reminders:list', projectPath, limit),
    create: (input: {
      projectPath: string
      title: string
      body?: string | null
      dueAt: number
      target: 'notification' | 'chat'
      chatId?: number | null
    }) => ipcRenderer.invoke('reminders:create', input),
    snooze: (id: number, minutes?: number) => ipcRenderer.invoke('reminders:snooze', id, minutes),
    dismiss: (id: number) => ipcRenderer.invoke('reminders:dismiss', id),
    remove: (id: number) => ipcRenderer.invoke('reminders:remove', id)
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
      ipcRenderer.invoke('skills:run-loaders', skillId, opts),
    capture: (input: { title: string; summary?: string; toolsAllow?: string[] }) =>
      ipcRenderer.invoke('skills:capture', input)
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
  proof: {
    generate: (runId: string) => ipcRenderer.invoke('proof:generate', runId) as Promise<
      { ok: boolean; jsonPath?: string; htmlPath?: string; html?: string; error?: string }
    >
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
  // Git READ + WRITE (Dev Task Flow). READ: status/diff/log. WRITE (Фаза 3,
  // argv-форма + денилист push/force/reset): branchCreate/checkout/add/commit.
  git: {
    status: () => ipcRenderer.invoke('git:status'),
    diff: (opts?: { base?: string; staged?: boolean; path?: string }) => ipcRenderer.invoke('git:diff', opts),
    log: (opts?: { limit?: number }) => ipcRenderer.invoke('git:log', opts),
    branchCreate: (opts: { name: string; from?: string }) => ipcRenderer.invoke('git:branchCreate', opts),
    checkout: (opts: { ref: string }) => ipcRenderer.invoke('git:checkout', opts),
    add: (opts: { paths: string[] }) => ipcRenderer.invoke('git:add', opts),
    commit: (opts: { message: string; paths?: string[] }) => ipcRenderer.invoke('git:commit', opts)
  },
  // Dev Task Flow (Фазы 2-4) — оркестратор open/наблюдение/откат/commit/пакет/PR.
  devtask: {
    open: (opts: { chatId?: number | null; title: string; summary?: string | null; risk?: string | null; useBranch?: boolean }) =>
      ipcRenderer.invoke('devtask:open', opts),
    openFromPreflight: (opts: { chatId?: number | null; preflight: { summary: string; risk?: string; riskReason?: string; affectedZones?: string[] } }) =>
      ipcRenderer.invoke('devtask:openFromPreflight', opts),
    get: (id: number) => ipcRenderer.invoke('devtask:get', id),
    list: (projectPath: string, opts?: { state?: string }) => ipcRenderer.invoke('devtask:list', projectPath, opts),
    linkRun: (id: number, runId: string) => ipcRenderer.invoke('devtask:linkRun', id, runId),
    revert: (id: number) => ipcRenderer.invoke('devtask:revert', id),
    commit: (id: number, opts: { message: string; paths?: string[]; overrideReason?: string }) => ipcRenderer.invoke('devtask:commit', id, opts),
    buildPackage: (id: number, opts?: { runChecks?: boolean; checks?: string[] }) => ipcRenderer.invoke('devtask:buildPackage', id, opts),
    createPr: (id: number, opts: { repo: string; base: string; draft?: boolean }) => ipcRenderer.invoke('devtask:createPr', id, opts),
    setBranch: (id: number, branch: string) => ipcRenderer.invoke('devtask:setBranch', id, branch)
  },
  pipeline: {
    start: (opts: { mode: 'dev' | 'agency'; brief: { goal: string; constraints: string; dod: string }; chatId?: number | null; workflowId?: string | null }) =>
      ipcRenderer.invoke('pipeline:start', opts),
    advance: (id: number, patch: { step?: string; planId?: number | null; agentRunId?: string | null; chatId?: number | null }) =>
      ipcRenderer.invoke('pipeline:advance', id, patch),
    getActive: (projectPath: string) => ipcRenderer.invoke('pipeline:getActive', projectPath),
    cancel: (id: number) => ipcRenderer.invoke('pipeline:cancel', id)
  },
  brain: {
    warmup: () => ipcRenderer.invoke('brain:warmup'),
    get: () => ipcRenderer.invoke('brain:get'),
    decisionsList: () => ipcRenderer.invoke('brain:decisions-list'),
    decisionsSave: (rec: unknown) => ipcRenderer.invoke('brain:decisions-save', rec)
  },
  autonomous: {
    status: () => ipcRenderer.invoke('autonomous:status') as Promise<{ enabled: boolean; intervalMin: number; lastRunAt: number | null; lastRunSuggestions: number; lastRunError: string | null; nextRunAt: number | null }>,
    runOnce: () => ipcRenderer.invoke('autonomous:run-once') as Promise<{ enabled: boolean; intervalMin: number; lastRunAt: number | null; lastRunSuggestions: number; lastRunError: string | null; nextRunAt: number | null }>,
    start: (intervalMin: number) => ipcRenderer.invoke('autonomous:start', intervalMin),
    stop: () => ipcRenderer.invoke('autonomous:stop')
  },
  commands: {
    list: (projectPath: string | null) => ipcRenderer.invoke('commands:list', projectPath),
    expand: (name: string, argString: string, projectPath: string | null) => ipcRenderer.invoke('commands:expand', name, argString, projectPath)
  },
  scheduler: {
    list: (projectPath?: string) => ipcRenderer.invoke('scheduler:list', projectPath),
    create: (input: { projectPath: string; prompt: string; nl: string }) => ipcRenderer.invoke('scheduler:create', input),
    toggle: (id: number, enabled: boolean) => ipcRenderer.invoke('scheduler:toggle', id, enabled),
    remove: (id: number) => ipcRenderer.invoke('scheduler:delete', id),
    runNow: (id: number) => ipcRenderer.invoke('scheduler:run-now', id)
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
    ensureDownload: () => ipcRenderer.invoke('update:ensure-download'),
    getReleaseNotes: (opts?: { sinceVersion?: string; upToVersion?: string; version?: string; all?: boolean }) =>
      ipcRenderer.invoke('update:get-release-notes', opts ?? {}),
    check: () => ipcRenderer.invoke('update:check'),
    getState: () => ipcRenderer.invoke('update:get-state') as Promise<{
      phase: string
      version?: string
      percent?: number
      stagingStep?: 'setup' | 'payload' | 'verify' | 'done'
      error?: string
      errorCode?: string
      rateLimitMinutes?: number
      pendingRelease?: boolean
      installedVersion?: string
      remoteVersion?: string
    }>,
    onState: (cb: (data: {
      phase: string
      version?: string
      percent?: number
      stagingStep?: 'setup' | 'payload' | 'verify' | 'done'
      error?: string
      errorCode?: string
      rateLimitMinutes?: number
      pendingRelease?: boolean
    }) => void) => {
      const handler = (_e: unknown, data: {
        phase: string
        version?: string
        percent?: number
        stagingStep?: 'setup' | 'payload' | 'verify' | 'done'
        error?: string
        errorCode?: string
        rateLimitMinutes?: number
        pendingRelease?: boolean
      }) => cb(data)
      ipcRenderer.on('update:state', handler)
      return () => { ipcRenderer.off('update:state', handler) }
    },
    onAvailable: (cb: (data: { version: string; pendingRelease?: boolean }) => void) => {
      const handler = (_e: unknown, data: { version: string; pendingRelease?: boolean }) => cb(data)
      ipcRenderer.on('update:available', handler)
      return () => { ipcRenderer.off('update:available', handler) }
    },
    onDownloaded: (cb: (data: { version: string }) => void) => {
      const handler = (_e: unknown, data: { version: string }) => cb(data)
      ipcRenderer.on('update:downloaded', handler)
      return () => { ipcRenderer.off('update:downloaded', handler) }
    },
    onReady: (cb: (data: { version: string }) => void) => {
      const handler = (_e: unknown, data: { version: string }) => cb(data)
      ipcRenderer.on('update:ready', handler)
      return () => { ipcRenderer.off('update:ready', handler) }
    },
    onProgress: (cb: (data: { percent: number; transferred?: number; total?: number }) => void) => {
      const handler = (_e: unknown, data: { percent: number; transferred?: number; total?: number }) => cb(data)
      ipcRenderer.on('update:progress', handler)
      return () => { ipcRenderer.off('update:progress', handler) }
    },
    onNotAvailable: (cb: () => void) => {
      const handler = () => cb()
      ipcRenderer.on('update:not-available', handler)
      return () => { ipcRenderer.off('update:not-available', handler) }
    },
    onError: (cb: (data: { error: string; errorCode?: string; rateLimitMinutes?: number }) => void) => {
      const handler = (_e: unknown, data: { error: string; errorCode?: string; rateLimitMinutes?: number }) => cb(data)
      ipcRenderer.on('update:error', handler)
      return () => { ipcRenderer.off('update:error', handler) }
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
    sessionStats: (chatId: number) => ipcRenderer.invoke('agent-runs:session-stats', chatId),
    stop: (runId: string) => ipcRenderer.invoke('agent-runs:stop', runId),
    resume: (runId: string) => ipcRenderer.invoke('agent-runs:resume', runId),
    // Crash-resume: зависшие после краха прогоны для баннера «сессия прервана».
    listResumable: (projectPath: string) => ipcRenderer.invoke('ai:list-resumable', projectPath),
    dismissResumable: (runId: string) => ipcRenderer.invoke('ai:dismiss-resumable', runId)
  },
  // #5 worktree-lifecycle: изоляция чата в git-worktree + локальный merge/discard.
  worktree: {
    isolate: (chatId: number, projectPath: string) => ipcRenderer.invoke('worktree:isolate', chatId, projectPath),
    status: (chatId: number) => ipcRenderer.invoke('worktree:status', chatId),
    merge: (chatId: number) => ipcRenderer.invoke('worktree:merge', chatId),
    discard: (chatId: number) => ipcRenderer.invoke('worktree:discard', chatId),
  },
  // История Verification Artifact (Фаза 3) — DoD-доказательства поверх файла-артефакта.
  verifications: {
    list: (projectPath: string, limit?: number) =>
      ipcRenderer.invoke('verifications:list', projectPath, limit),
    latest: (projectPath: string, chatId?: number | null) =>
      ipcRenderer.invoke('verifications:latest', projectPath, chatId),
    latestByRunId: (projectPath: string, runId: string) =>
      ipcRenderer.invoke('verifications:latest-by-run', projectPath, runId),
    get: (id: number) => ipcRenderer.invoke('verifications:get', id)
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
