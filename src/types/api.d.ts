export interface FileNode { name: string; path: string; isDirectory: boolean; children?: FileNode[] }

// ── Карта проекта (mirror типов из electron/ai/project-map.ts; renderer не
//    может импортировать из electron/, поэтому форма продублирована) ──
export interface ProjectFileSymbolDTO { kind: string; name: string; line: number }
export interface ProjectFileEntryDTO { path: string; lines: number; symbols: ProjectFileSymbolDTO[] }
export interface ProjectMapDTO {
  root: string
  generatedAt: number
  files: ProjectFileEntryDTO[]
  stats: { totalFiles: number; codeFiles: number; totalLines: number; truncated: boolean }
}
export interface DependencyMapDTO {
  files: Record<string, { imports: string[]; importedBy: string[]; exports: string[] }>
}
export interface Attachment { name: string; mimeType: string; data: string; size: number }
export interface ChatMessage { role: 'user' | 'assistant' | 'system'; content: string; attachments?: Attachment[]; thinking?: string; createdAt?: number; source?: 'reminder'; /** Длительность ответа ассистента (мс), только в UI сессии. */ responseDurationMs?: number }
export interface StoredChatMessage { id: number; role: 'user' | 'assistant' | 'system'; content: string; createdAt: number }
export type ChatKind = 'main' | 'review' | 'help'
export interface ChatSession {
  id: number
  projectPath: string
  title: string
  providerId: string | null
  model: string | null
  createdAt: number
  lastMessageAt: number
  kind: ChatKind
  parentChatId: number | null
}
export interface Task { id: number; text: string; done: boolean; createdAt: number; doneAt: number | null }
export type JournalKind = 'manual' | 'session' | 'tool' | 'note'
export interface JournalEntry { id: number; kind: JournalKind; title: string; detail: string | null; createdAt: number }
export type ReminderTarget = 'notification' | 'chat'
export type ReminderStatus = 'pending' | 'delivered' | 'dismissed'
export interface Reminder {
  id: number
  projectPath: string
  title: string
  body: string | null
  dueAt: number
  target: ReminderTarget
  chatId: number | null
  status: ReminderStatus
  createdAt: number
  updatedAt: number
  deliveredAt: number | null
  dismissedAt: number | null
}
export interface UndoEntry { id: number; filePath: string; beforeContent: string | null; afterContent: string | null; createdAt: number }
export type PlanStatus = 'draft' | 'running' | 'done' | 'cancelled'
export type StepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed'
export interface PlanStep { id: number; planId: number; idx: number; title: string; detail: string | null; status: StepStatus; result: string | null; runId?: string | null; verificationStatus?: string | null; changedFilesCount?: number | null }
export interface Plan { id: number; title: string; status: PlanStatus; createdAt: number; completedAt: number | null; steps: PlanStep[] }

/** Agency Workflows — каталожная карточка workflow'а. */
export interface WorkflowSummary { id: string; name: string; description: string; icon: string | null; stepCount: number }
/** Состояние одного прогона workflow. */
export interface WorkflowRunState { workflowId: string; status: 'pending' | 'running' | 'done' | 'error'; currentStep: number; startedAt: number; planId?: number; brief?: string }
/** Результат workflows:start — готовый промпт + созданный план + состояние прогона. */
export interface WorkflowStartResult { prompt: string; planId: number; runState: WorkflowRunState }
export interface FeedbackEntry { id: number; projectPath: string | null; providerId: string | null; rating: number | null; message: string; createdAt: number }
/** Источник проекта: local — папка; git — клон репо; ssh — файлы на сервере (live). */
export type ProjectKind = 'local' | 'git' | 'ssh'
/** Удалённый источник (зеркало electron/projects/remote-source.ts). */
export type RemoteSource =
  | { kind: 'git'; cloneUrl: string; name: string }
  | { kind: 'ssh'; user: string | null; host: string; remotePath: string; name: string }

export interface ProjectMeta {
  path: string
  name: string
  color: string
  iconPath: string | null
  lastOpenedAt: number
  hidden: boolean
  kind: ProjectKind
  remote: RemoteSource | null
}

export type RemoteDoctorStatus = 'pass' | 'warn' | 'fail'
export interface RemoteDoctorCheck {
  id: string
  label: string
  status: RemoteDoctorStatus
  detail?: string
}
export interface RemoteDoctorResult {
  ok: boolean
  status: RemoteDoctorStatus
  target: { user: string | null; host: string; remoteRoot: string }
  checkedAt: number
  summary: string
  checks: RemoteDoctorCheck[]
  notes: string[]
}

export interface ProjectGroup {
  id: number
  name: string
  sortOrder: number
  collapsed: boolean
  projectPaths: string[]
  createdAt: number
}

/** User profile — multi-user поддержка команды агентства (14 человек). */
export interface UserProfile {
  id: number
  name: string
  role: string | null
  defaultProvider: string | null
  defaultModel: string | null
  skillsEnabled: string[] | null
  createdAt: number
  isActive: boolean
}

/** Skill — переиспользуемый агентский пресет (system prompt + tools + provider).
 *  См. electron/ai/skills/types.ts для серверной структуры. */
export interface Skill {
  id: string
  name?: string
  description?: string
  icon?: string
  default_provider?: string
  default_model?: string
  default_mode?: 'ask' | 'accept-edits' | 'plan' | 'auto' | 'bypass'
  slash?: string
  tools_allow?: string[]
  suggested_prompts?: string[]
  context_loaders?: Array<{ id: string; impl: string; runs_on: 'chat_open' | 'slash_arg'; args?: Record<string, unknown> }>
  systemPrompt: string
  source: 'server' | 'user' | 'built-in'
  sourceRef: string
}

export interface ScheduledTask {
  id: number
  project_path: string
  prompt: string
  cron: string
  human: string
  enabled: boolean
  provider_id: string | null
  model: string | null
  created_at: number
  last_run_at: number | null
  last_status: 'ok' | 'error' | null
  last_result: string | null
  last_run_minute: number | null
}
export interface ToolCall { id: string; name: string; args: Record<string, unknown> }
export interface UsageDelta {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  model?: string
}

export type ChatEvent =
  | { type: 'text'; text: string }
  | { type: 'thought'; text: string }
  | { type: 'pending-write'; callId: string; path: string; before: string; after: string }
  | { type: 'pending-command'; callId: string; command: string }
  | { type: 'command-result'; callId: string; command: string; status: 'ok' | 'error' | 'rejected'; exitCode?: number; stdout?: string; stderr?: string; error?: string }
  | { type: 'tool-blocked'; callId: string; name: string; command?: string; reason: string }
  | { type: 'turns-exhausted'; used: number; maxBudget: number; canContinue: boolean; suggestedAdd: number }
  | { type: 'tool-activity'; callId: string; name: string; label: string; detail: string; status: 'ok' | 'error' }
  | { type: 'plan-created'; planId: number; title: string; stepCount: number }
  | { type: 'plan-approval'; callId: string; planId: number; title: string; stepCount: number }
  | { type: 'preflight'; callId: string; summary: string; affectedZones: string[]; risk: 'low' | 'medium' | 'high'; riskReason: string; verifyAfter: string[]; outOfScope: string[] }
  | { type: 'subagent-run'; callId: string; label: string; provider?: string; skill?: string; task: string; status: 'running' | 'done' | 'error'; result?: string; role?: string; toolCount?: number; swarm?: string }
  | { type: 'artifact-created'; callId: string; kind: 'html' | 'docx' | 'verification'; filename: string; path: string; sizeBytes: number }
  | { type: 'verification-attested'; callId: string; overall: 'passed' | 'failed' | 'partial' | 'not_run'; checksTotal: number; checksPassed: number; changedFilesCount: number }
  | { type: 'usage'; usage: UsageDelta }
  | { type: 'info'; text: string }
  | { type: 'cross-verify'; result: string; provider: string; ok: boolean }
  | { type: 'done' }
  | { type: 'error'; message: string }

declare global {
  interface Window {
    api: {
      projects: {
        pick: () => Promise<string | null>
        /** Добавить удалённый проект: https/git@…/repo (клон) или user@host:/path (ssh-live). */
        addRemote: (input: string) => Promise<
          { ok: true; path: string; meta: ProjectMeta } | { ok: false; error: string }
        >
        remoteDoctor: (path: string) => Promise<RemoteDoctorResult>
        create: (input: { name: string; folderSlug: string; iconSourcePath?: string | null }) => Promise<
          { ok: true; path: string; meta: ProjectMeta } | { ok: false; error: string }
        >
        clientsRoot: () => Promise<string>
        pickImage: () => Promise<string | null>
        setCurrent: (path: string | null) => Promise<void>
        list: () => Promise<ProjectMeta[]>
        rename: (path: string, name: string) => Promise<void>
        updateMeta: (path: string, patch: { name?: string; hidden?: boolean }) => Promise<ProjectMeta | null>
        pickIcon: (path: string) => Promise<ProjectMeta | null>
        clearIcon: (path: string) => Promise<ProjectMeta | null>
        remove: (path: string, options?: { deleteData?: boolean }) => Promise<{ ok: boolean; error?: string }>
        listGroups: () => Promise<ProjectGroup[]>
        createGroup: (name: string, projectPaths: string[]) => Promise<
          { ok: true; group: ProjectGroup } | { ok: false; error: string }
        >
        updateGroup: (id: number, patch: {
          name?: string
          projectPaths?: string[]
          collapsed?: boolean
          sortOrder?: number
        }) => Promise<{ ok: true; group: ProjectGroup } | { ok: false; error: string }>
        deleteGroup: (id: number) => Promise<{ ok: true }>
      }
      app: {
        getHomeDir: () => Promise<string>
        getVersion: () => Promise<string>
        isFocused: () => Promise<boolean>
        openExternal: (url: string) => Promise<boolean>
      }
      window: {
        minimize: () => Promise<void>
        maximize: () => Promise<boolean>
        close: () => Promise<void>
        isMaximized: () => Promise<boolean>
        onMaximizedChanged: (cb: (maximized: boolean) => void) => () => void
      }
      notify: {
        show: (opts: {
          title?: string
          body: string
          projectName?: string
          projectPath?: string
          isHelp?: boolean
          isError?: boolean
        }) => Promise<boolean>
        playSound: (opts?: { isError?: boolean }) => Promise<boolean>
        onOpenProject: (cb: (projectPath: string) => void) => () => void
        onOpenHelp: (cb: (projectPath?: string) => void) => () => void
        onOpenReminders: (cb: (projectPath?: string) => void) => () => void
        onOpenChat: (cb: (payload: { projectPath?: string; chatId: number }) => void) => () => void
        onSendChatReminder: (cb: (payload: { reminderId: number; projectPath: string; chatId: number; text: string }) => void) => () => void
      }
      voice: {
        status: () => Promise<{ ready: boolean; loading: boolean; label: string }>
        transcribe: (payload: { data: string; mimeType?: string }) => Promise<
          { ok: true; text: string } | { ok: false; error: string }
        >
      }
      files: {
        tree: (root: string) => Promise<FileNode[]>
        read: (path: string) => Promise<string>
        /** F6: прочитать @-упомянутые файлы → контекст-блок (path-policy + redaction). */
        resolveMentions: (projectPath: string, paths: string[]) => Promise<string>
        /** Открыть папку в системном проводнике через electron.shell.openPath. */
        revealInExplorer: (path: string) => Promise<{ ok: boolean; error: string | null }>
        /** Конвертация DOCX → HTML body через mammoth.js (для embedded preview). */
        docxToHtml: (path: string) => Promise<{ ok: true; html: string; warnings: string[] } | { ok: false; error: string }>
      }
      projectMap: {
        /** Фоновый прогрев карты+графа (non-blocking). Возвращает сразу. */
        warm: (root: string) => Promise<{ started: boolean }>
        /** Дерево файлов + top-level символы. null при ошибке/закрытом проекте. */
        get: (root: string, refresh?: boolean) => Promise<ProjectMapDTO | null>
        /** Граф зависимостей: imports / importedBy / exports по файлам. */
        deps: (root: string, refresh?: boolean) => Promise<DependencyMapDTO | null>
      }
      settings: {
        getKey: (key: string) => Promise<string | null>
        setKey: (key: string, value: string) => Promise<void>
        outputStyles: (projectPath: string | null) => Promise<Array<{ id: string; name: string; description: string; scope: string }>>
        rememberApproval: (toolName: string, argText: string) => Promise<string | null>
        onUiScaleChanged?: (cb: (percent: number) => void) => () => void
      }
      providers: {
        list: () => Promise<ProviderDescriptorDTO[]>
      }
      doctor: {
        run: () => Promise<DoctorReport>
      }
      connectors: {
        /** Проверка токена/доступа коннектора (Settings card id). */
        test: (uiId: string) => Promise<{ ok: boolean; message: string }>
      }
      router: {
        /** Рекомендует тир+провайдера+модель под текст задачи. null = нет подходящего. */
        recommend: (taskText: string) => Promise<TierRecommendation | null>
      }
      policy: {
        /** Снимок политики разрешений агента: матрица decide() × режимы + опасные команды. */
        matrix: () => Promise<PolicyMatrixDTO>
      }
      ai: {
        send: (messages: ChatMessage[], projectPath: string | null, chatId?: string) => Promise<number>
        sendWithBudget: (messages: ChatMessage[], projectPath: string | null, budget: number, chatId?: string) => Promise<number>
        sendWithOverrides: (
          messages: ChatMessage[],
          projectPath: string | null,
          overrides: { providerId?: string; model?: string | null; noTools?: boolean; systemPrompt?: string; useReviewerPrompt?: boolean; effortLevel?: 'quick' | 'standard' | 'deep'; toolsAllow?: string[]; agentMode?: 'ask' | 'accept-edits' | 'plan' | 'auto' | 'bypass'; resumeFromRunId?: string },
          chatId?: string
        ) => Promise<number>
        resolveWrite: (callId: string, accept: boolean, sendId?: number) => Promise<void>
        resolveCommand: (callId: string, accept: boolean, sendId?: number) => Promise<void>
        resolvePlan: (callId: string, decision: 'approve' | 'revise' | 'reject', feedback?: string, sendId?: number) => Promise<void>
        stop: (sendId: number) => Promise<boolean>
        suspend: (sendId: number) => Promise<boolean>
        /** Дополнить контекст активного API agent-loop (Ctrl+Enter во время стрима). */
        appendContext: (sendId: number, text: string) => Promise<
          { ok: true } | { ok: false; fallback: 'invalid' | 'unavailable' }
        >
        countTokens: (text: string, projectPath: string | null, historyMessages?: ChatMessage[]) => Promise<{ tokens: number; exact: boolean; providerId: string }>
        onEvent: (cb: (data: { id: number; event: ChatEvent; projectPath: string | null }) => void) => () => void
      }
      chatSessions: {
        list: (projectPath: string) => Promise<ChatSession[]>
        listReviews: (parentChatId: number) => Promise<ChatSession[]>
        create: (projectPath: string, opts?: {
          title?: string
          providerId?: string | null
          model?: string | null
          kind?: ChatKind
          parentChatId?: number | null
        }) => Promise<ChatSession>
        fork: (sourceId: number, opts?: { uptoMessageId?: number; title?: string }) => Promise<ChatSession | null>
        rename: (id: number, title: string) => Promise<void>
        setModel: (id: number, providerId: string | null, model: string | null) => Promise<void>
        remove: (id: number) => Promise<void>
        getOrCreateHelp: () => Promise<ChatSession>
      }
      chats: {
        list: (sessionId: number) => Promise<StoredChatMessage[]>
        append: (sessionId: number, projectPath: string, role: 'user' | 'assistant', content: string) => Promise<void>
        maxMessageId: (sessionId: number) => Promise<number>
        truncateAfter: (sessionId: number, afterMessageId: number) => Promise<number>
      }
      handoff: {
        generate: (sessionId: number, parentId?: string | null) => Promise<string>
        saveToDownloads: (sessionId: number, parentId?: string | null) => Promise<
          | { ok: true; path: string; markdown: string }
          | { ok: false; error: string }
        >
      }
      tasks: {
        list: (projectPath: string) => Promise<Task[]>
        add: (projectPath: string, text: string) => Promise<Task>
        toggle: (id: number, done: boolean) => Promise<void>
        remove: (id: number) => Promise<void>
        clearDone: (projectPath: string) => Promise<number>
      }
      journal: {
        list: (projectPath: string, limit?: number) => Promise<JournalEntry[]>
        currentSession: (projectPath: string) => Promise<JournalEntry | null>
        append: (projectPath: string, kind: JournalKind, title: string, detail?: string | null) => Promise<JournalEntry>
      }
      reminders: {
        list: (projectPath: string, limit?: number) => Promise<Reminder[]>
        create: (input: {
          projectPath: string
          title: string
          body?: string | null
          dueAt: number
          target: ReminderTarget
          chatId?: number | null
        }) => Promise<Reminder>
        snooze: (id: number, minutes?: number) => Promise<Reminder | null>
        dismiss: (id: number) => Promise<Reminder | null>
        remove: (id: number) => Promise<void>
      }
      undo: {
        list: (projectPath: string) => Promise<UndoEntry[]>
        count: (projectPath: string) => Promise<number>
        clear: (projectPath: string) => Promise<number>
        revert: (projectPath: string, id?: number) => Promise<{ ok: boolean; filePath?: string; reason?: string }>
        /** Snap a checkpoint. Returns the id of the newest entry, or 0 if
         *  the stack is currently empty (0 is below any real autoincrement
         *  id, so `id > 0` naturally matches every future entry). */
        checkpoint: (projectPath: string) => Promise<number>
        /** Revert every entry with id > checkpointId. */
        revertToCheckpoint: (projectPath: string, checkpointId: number) => Promise<{
          ok: boolean
          restored: string[]
          count: number
          failed?: Array<{ id: number; filePath: string; reason: string }>
        }>
      }
      skills: {
        list: () => Promise<Skill[]>
        get: (id: string) => Promise<Skill | null>
        refresh: () => Promise<{ added: number; updated: number; failed: string[] }>
        status: () => Promise<{ lastRefreshAt: number | null; serverReachable: boolean; total: number }>
        runLoaders: (skillId: string, opts: { arg?: string; projectPath?: string | null; trigger: 'chat_open' | 'slash_arg' }) =>
          Promise<{ context: string; labels: string[] }>
        /** Skill Capture: сохранить прогон как скилл-скаффолд в ~/.verstak/skills/. */
        capture: (input: { title: string; summary?: string; toolsAllow?: string[] }) =>
          Promise<{ ok: true; id: string; path: string } | { ok: false; error: string }>
      }
      cliAuth: {
        logout: (providerId: string) => Promise<{
          ok: boolean
          method: 'logout-cmd' | 'creds-deleted' | 'both'
          removedFiles: string[]
          stdout?: string
          stderr?: string
          message?: string
        }>
        relogin: (providerId: string) => Promise<{
          ok: boolean
          message?: string
          command?: string
        }>
        statusAll: () => Promise<Record<'claude-cli' | 'gemini-cli' | 'grok-cli' | 'codex-cli', {
          installed: boolean
          loggedIn: boolean
          credPath?: string
        }>>
      }
      userProfiles: {
        list: () => Promise<UserProfile[]>
        getActive: () => Promise<UserProfile | null>
        create: (input: { name: string; role?: string; defaultProvider?: string; defaultModel?: string; skillsEnabled?: string[] }) => Promise<UserProfile>
        setActive: (id: number) => Promise<void>
        update: (id: number, patch: { name?: string; role?: string; defaultProvider?: string; defaultModel?: string; skillsEnabled?: string[] }) => Promise<void>
        remove: (id: number) => Promise<void>
      }
      feedback: {
        list: (projectPath: string | null, limit?: number) => Promise<FeedbackEntry[]>
        submit: (input: { projectPath: string | null; providerId: string | null; rating: number | null; message: string }) => Promise<FeedbackEntry>
        remove: (id: number) => Promise<void>
      }
      plans: {
        list: (projectPath: string) => Promise<Plan[]>
        get: (id: number) => Promise<Plan | null>
        create: (projectPath: string, title: string, steps: Array<{ title: string; detail?: string | null }>) => Promise<Plan>
        setStatus: (id: number, status: PlanStatus) => Promise<void>
        updateStep: (id: number, patch: { status?: StepStatus; result?: string | null; runId?: string | null; verificationStatus?: string | null; changedFilesCount?: number | null }) => Promise<void>
        remove: (id: number) => Promise<void>
      }
      /** Proof Pack — доказательство выполнения прогона (proof.json + proof.html). */
      proof: {
        generate: (runId: string) => Promise<{ ok: boolean; jsonPath?: string; htmlPath?: string; html?: string; error?: string }>
      }
      workflows: {
        list: () => Promise<WorkflowSummary[]>
        start: (workflowId: string, projectPath: string, brief: string) => Promise<WorkflowStartResult | { error: string; message: string }>
      }
      memory: {
        save(projectPath: string, type: string, content: string, tags: string[]): Promise<Memory>
        search(projectPath: string, query: string, limit?: number): Promise<Memory[]>
        list(projectPath: string): Promise<Memory[]>
        delete(id: string): Promise<boolean>
      }
      coreMemory: {
        load(projectPath: string): Promise<{ memory: string; user: string }>
        save(projectPath: string, block: string, content: string): Promise<{ ok: boolean }>
      }
      verify: {
        exec: (command: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>
      }
      // Git READ + WRITE (Dev Task Flow). WRITE (Фаза 3) — argv-форма + денилист.
      git: {
        status(): Promise<GitStatus>
        diff(opts?: { base?: string; staged?: boolean; path?: string }): Promise<GitDiff>
        log(opts?: { limit?: number }): Promise<GitLogEntry[]>
        /** Создать и переключиться на ветку (checkout -b). */
        branchCreate(opts: { name: string; from?: string }): Promise<{ ok: boolean; branch?: string; error?: string }>
        /** Переключиться на verstak/* или существующую ветку (force запрещён). */
        checkout(opts: { ref: string }): Promise<{ ok: boolean; error?: string }>
        /** Поставить пути в индекс (внутри проекта). */
        add(opts: { paths: string[] }): Promise<{ ok: boolean; error?: string }>
        /** Закоммитить (+ опц. add paths). Без --no-verify/--amend. */
        commit(opts: { message: string; paths?: string[] }): Promise<{ ok: boolean; sha?: string; error?: string }>
      }
      // Dev Task Flow (Фазы 2-4) — оркестратор открытия/наблюдения/отката/пакета.
      devtask: {
        /** Открыть задачу: снять checkpoint, зафиксировать base. useBranch → ветка. */
        open(opts: { chatId?: number | null; title: string; summary?: string | null; risk?: string | null; useBranch?: boolean }): Promise<DevTask | null>
        /** Открыть задачу из объявленного preflight-плана. */
        openFromPreflight(opts: { chatId?: number | null; preflight: { summary: string; risk?: string; riskReason?: string; affectedZones?: string[] } }): Promise<DevTask | null>
        /** Задача + её проверки. */
        get(id: number): Promise<DevTaskDetail>
        /** Задачи проекта (новейшие первыми), опц. фильтр по state. */
        list(projectPath: string, opts?: { state?: DevTaskState }): Promise<DevTask[]>
        /** Связать прогон с задачей (идемпотентно). */
        linkRun(id: number, runId: string): Promise<void>
        /** Откатить файловые правки задачи к её чекпоинту. true = успех. */
        revert(id: number): Promise<boolean>
        /** Закоммитить правки задачи (git add+commit), state→committed.
         *  Ревью F2: backend блокирует commit при fail/pending/running проверках;
         *  обойти можно только явным overrideReason (пишется в audit_log). */
        commit(id: number, opts: { message: string; paths?: string[]; overrideReason?: string }): Promise<{ ok: boolean; sha?: string; error?: string }>
        /** Собрать пакет: прогнать проверки + diff + commit-planner, state→packaged. */
        buildPackage(id: number, opts?: { runChecks?: boolean; checks?: string[] }): Promise<DevTaskPackage | null>
        /** Открыть PR через github (нужен github_token + work_branch). */
        createPr(id: number, opts: { repo: string; base: string; draft?: boolean }): Promise<{ ok: boolean; url?: string; number?: number; error?: string }>
        setBranch(id: number, branch: string): Promise<DevTask | null>
      }
      pipeline: {
        /** Создать прогон Brief→Proof для активного проекта (step='plan'). */
        start(opts: { mode: PipelineMode; brief: PipelineBrief; chatId?: number | null; workflowId?: string | null }): Promise<PipelineRun | null>
        /** Продвинуть шаг / привязать planId / runId. */
        advance(id: number, patch: { step?: PipelineStep; planId?: number | null; agentRunId?: string | null; chatId?: number | null; verifyAttempts?: number }): Promise<PipelineRun | null>
        /** Активный (НЕтерминальный) прогон проекта для resume-баннера. */
        getActive(projectPath: string): Promise<PipelineRun | null>
        /** Отменить прогон (step='cancelled'). */
        cancel(id: number): Promise<void>
      }
      /** Project Brain — мозг проекта (warmup, состояние, решения). */
      brain: {
        /** Прогреть проект: скан → summaries → context-packs → Brain. */
        warmup(): Promise<{ filesScanned: number; filesSummarized: number; packs: Array<{ type: 'short' | 'medium' | 'long'; tokenEstimate: number | null }> } | null>
        /** Состояние мозга активного проекта (null если не прогрет). */
        get(): Promise<ProjectBrain | null>
        decisionsList(): Promise<DecisionRecord[]>
        decisionsSave(rec: NewDecisionRecord): Promise<DecisionRecord | null>
      }
      term: {
        spawn: (cwd: string) => Promise<number>
        write: (id: number, data: string) => Promise<void>
        resize: (id: number, cols: number, rows: number) => Promise<void>
        kill: (id: number) => Promise<void>
        onData: (cb: (data: { id: number; data: string }) => void) => () => void
        onExit: (cb: (data: { id: number }) => void) => () => void
        onErrorDetected: (cb: (data: { id: number; error: { kind: string; file?: string; line?: number; message: string; raw: string } }) => void) => () => void
      }
      autonomous: {
        status: () => Promise<AutonomousStatus>
        runOnce: () => Promise<AutonomousStatus>
        start: (intervalMin: number) => Promise<AutonomousStatus>
        stop: () => Promise<AutonomousStatus>
      }
      commands: {
        list: (projectPath: string | null) => Promise<UserCommand[]>
        expand: (name: string, argString: string, projectPath: string | null) => Promise<string>
      }
      scheduler: {
        list: (projectPath?: string) => Promise<ScheduledTask[]>
        create: (input: { projectPath: string; prompt: string; nl: string }) => Promise<{ task?: ScheduledTask; error?: string }>
        toggle: (id: number, enabled: boolean) => Promise<boolean>
        remove: (id: number) => Promise<boolean>
        runNow: (id: number) => Promise<ScheduledTask | null>
      }
      cli: {
        detect(): Promise<DetectedCli[]>
      }
      localModels: {
        scan(): Promise<DetectedLocalServer[]>
      }
      updater: {
        install(): Promise<{ ok: boolean; reason?: string }>
        ensureDownload(): Promise<{ ok: boolean; reason?: string; phase?: string }>
        getReleaseNotes(opts?: { sinceVersion?: string; upToVersion?: string; version?: string; all?: boolean }): Promise<Array<{
          version: string
          name: string
          body: string
          htmlUrl: string
          publishedAt?: string
        }>>
        check(): Promise<{ available: boolean; version?: string; installedVersion?: string; error?: string; errorCode?: string; rateLimitMinutes?: number; phase?: string; pendingRelease?: boolean }>
        getState(): Promise<{ phase: string; version?: string; percent?: number; stagingStep?: 'setup' | 'payload' | 'verify' | 'done'; error?: string; errorCode?: string; rateLimitMinutes?: number; pendingRelease?: boolean; installedVersion?: string; remoteVersion?: string }>
        onState(cb: (data: { phase: string; version?: string; percent?: number; stagingStep?: 'setup' | 'payload' | 'verify' | 'done'; error?: string; errorCode?: string; rateLimitMinutes?: number; pendingRelease?: boolean }) => void): () => void
        onAvailable(cb: (data: { version: string; pendingRelease?: boolean }) => void): () => void
        onDownloaded(cb: (data: { version: string }) => void): () => void
        onReady(cb: (data: { version: string }) => void): () => void
        onProgress(cb: (data: { percent: number; transferred?: number; total?: number }) => void): () => void
        onNotAvailable(cb: () => void): () => void
        onError(cb: (data: { error: string; errorCode?: string; rateLimitMinutes?: number }) => void): () => void
      }
      audit: {
        query(projectPath: string, opts?: { limit?: number; action?: string; since?: number }): Promise<AuditEntry[]>
        export(projectPath: string): Promise<string>
        clear(projectPath: string, olderThan?: number): Promise<number>
      }
      debug: {
        packet(runId: string): Promise<DebugPacket>
      }
      // Панель Agents (Фаза 2) — персистентные суб-сессии + массовая отмена.
      agents: {
        list(projectPath: string): Promise<SubSession[]>
        history(subSessionId: number): Promise<StoredChatMessage[]>
        cancel(filter: { all?: boolean; group?: string | null; role?: string | null }): Promise<number>
        queueStats(): Promise<{ inFlight: number; queued: number; tracked: number }>
        todos(projectPath: string, sessionId?: number | null): Promise<SessionTodo[]>
      }
      // Вкладка «Задачи» (Multi-agent Manager) — высокоуровневые прогоны + stop/resume (Фаза 4).
      agentRuns: {
        list(projectPath: string, opts?: { status?: AgentRunStatus; owner?: AgentRunOwner; limit?: number }): Promise<AgentRun[]>
        get(runId: string): Promise<AgentRunDetail>
        /** Per-session агрегат по всем прогонам чата (cost/инструменты/файлы/время). */
        sessionStats(chatId: number): Promise<{ runs: number; costCents: number; toolCount: number; filesCount: number; agentsCount: number; durationMs: number }>
        /** Остановить активный прогон (переиспользует ai:stop abort). true если прервали. */
        stop(runId: string): Promise<boolean>
        /** Данные для честного re-send: { chatId, userMessage } или { error }. */
        resume(runId: string): Promise<{ chatId: number | null; userMessage: string } | { error: string }>
        /** Crash-resume: зависшие после краха прогоны проекта для баннера «сессия прервана». */
        listResumable(projectPath: string): Promise<ResumableRun[]>
        /** Crash-resume: отклонить баннер для прогона (не показывать в этом сеансе app). */
        dismissResumable(runId: string): Promise<boolean>
      }
      // #5 worktree-lifecycle: изоляция чата в git-worktree + локальный merge/discard.
      worktree: {
        isolate(chatId: number, projectPath: string): Promise<{ ok: true; worktreePath: string } | { ok: false; error: string }>
        status(chatId: number): Promise<{ active: false } | { active: true; worktreePath: string; fileCount: number; hasChanges: boolean }>
        merge(chatId: number): Promise<{ ok: boolean; error?: string }>
        discard(chatId: number): Promise<{ ok: boolean; error?: string }>
      }
      // История Verification Artifact (Фаза 3) — DoD-доказательства поверх файла-артефакта.
      verifications: {
        list(projectPath: string, limit?: number): Promise<VerificationRow[]>
        /** Свежайшая верификация проекта; chatId сужает до конкретного чата (Review DoD). */
        latest(projectPath: string, chatId?: number | null): Promise<VerificationRow | null>
        /** Свежайшая верификация конкретного agent run. Использовать для Proof/Pipeline integrity. */
        latestByRunId(projectPath: string, runId: string): Promise<VerificationRow | null>
        get(id: number): Promise<VerificationRow | null>
      }
      suggestions: {
        get(projectPath: string): Promise<Suggestion[]>
      }
      mcp: {
        listServers(): Promise<McpServerEntry[]>
        addServer(entry: Omit<McpServerEntry, 'id'>): Promise<McpServerEntry>
        updateServer(id: string, patch: Partial<Omit<McpServerEntry, 'id'>>): Promise<McpServerEntry | null>
        removeServer(id: string): Promise<void>
        toggleServer(id: string, enabled: boolean): Promise<void>
        connect(id: string): Promise<McpTool[]>
        disconnect(id: string): Promise<void>
        tools(): Promise<McpTool[]>
        connectedServers(): Promise<Array<{ id: string; name: string; command: string; args: string[]; env?: Record<string, string> }>>
        popular(): Promise<PopularMcpServer[]>
        saveAll(servers: McpServerEntry[]): Promise<void>
      }
    }
  }
}
/** Воспоминание агента — факт, решение, баг или паттерн, привязанный к проекту. */
export interface Memory {
  id: string
  project_path: string
  type: 'fact' | 'decision' | 'bug' | 'preference' | 'pattern'
  content: string
  tags: string[]
  created_at: number
  accessed_at: number
}

/** Пользовательская команда — .md файл из ~/.verstak/commands/ или {project}/.verstak/commands/. */
export interface UserCommand {
  id: string
  name: string
  scope: 'user' | 'project'
  description: string
  body: string
  variables: string[]
  filePath: string
}

export interface AutonomousStatus {
  enabled: boolean
  intervalMin: number
  lastRunAt: number | null
  lastRunSuggestions: number
  lastRunError: string | null
  nextRunAt: number | null
}

/** Обнаруженный CLI-инструмент на компьютере пользователя. */
export interface DetectedCli {
  id: string
  name: string
  binary: string
  version: string
  status: 'ready' | 'found' | 'error'
}

/** Локальный OpenAI-compatible сервер моделей, найденный на компьютере. */
export interface DetectedLocalServer {
  id: 'ollama' | 'lmstudio' | 'llamacpp' | 'jan'
  name: string
  baseUrl: string
  running: boolean
  models: string[]
}

/** MCP Server — конфигурация внешнего MCP-сервера. */
export interface McpServerEntry {
  id: string
  name: string
  command: string
  /** JSON-строка: string[] */
  args: string
  /** JSON-строка: Record<string,string> */
  env: string
  enabled: boolean
}

/** MCP Tool — инструмент, предоставляемый внешним MCP-сервером. */
export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  serverId: string
}

/** Предложение от proactive agent — что сделать следующим. */
export interface Suggestion {
  title: string
  description: string
  source: 'memory' | 'journal' | 'pattern'
  priority: 'high' | 'medium' | 'low'
}

/** Запись в журнале аудита — каждое агентское действие. */
export interface AuditEntry {
  id: number
  timestamp: number
  projectPath: string
  chatId: number | null
  action: string
  detail: string
  providerId: string | null
  model: string | null
  /** ID агентного запуска (один ai:send = один run). null у строк до миграции 9. */
  runId: string | null
}

/** Снапшот реального входа агентного запуска — основа Debug Packet. */
export interface RunInput {
  runId: string
  projectPath: string | null
  chatId: number | null
  timestamp: number
  providerId: string | null
  model: string | null
  /** Точная system-строка, ушедшая модели (composed.system). */
  systemPrompt: string
  /** Контент последнего user-сообщения запроса. */
  userMessage: string
}

/** Replay-пакет одного run'а: реальный вход + audit trail + сообщения чата. */
export interface DebugPacket {
  input: RunInput | null
  audit: AuditEntry[]
  messages: StoredChatMessage[]
}

/** Персистентная суб-сессия делегированного агента (Фаза 2). */
export interface SubSession {
  id: number
  projectPath: string
  parentChatId: number | null
  role: string | null
  status: string | null          // running / done / error / cancelled
  task: string | null
  group: string | null
  toolCount: number | null
  costCents: number | null
  callId: string | null
  providerId: string | null
  model: string | null
  /** Глубина в дереве делегирования (Фаза 4): главный=0, его суб=1, под-суб=2. */
  depth: number | null
  /** callId агента-родителя в дереве (Фаза 4) — для иерархии в панели Agents. */
  parentCallId: string | null
  startedAt: number | null
  endedAt: number | null
  createdAt: number
}

/** Пункт оркестрационного todo-листа TodoGate (Фаза 3). */
export interface SessionTodo {
  id: number
  projectPath: string
  sessionId: number | null
  goal: string | null
  title: string
  status: 'pending' | 'in_progress' | 'done' | 'blocked'
  assigneeCallId: string | null
  ord: number
  createdAt: number
  updatedAt: number
}

/**
 * Прогон агента (Multi-agent Manager V1). Зеркало shape из
 * electron/storage/agent-runs.ts — renderer не импортит electron/, поэтому
 * тип дублируется здесь. Один ai:send = одна строка.
 */
export type AgentRunOwner = 'main' | 'review' | 'delegate' | 'background'
export type AgentRunStatus = 'queued' | 'running' | 'waiting_review' | 'done' | 'failed' | 'stopped' | 'suspended'

export interface AgentRun {
  runId: string
  projectPath: string
  chatId: number | null
  owner: AgentRunOwner
  title: string
  status: AgentRunStatus
  providerId: string | null
  model: string | null
  sendId: number | null
  agentsCount: number
  toolCount: number
  filesCount: number
  costCents: number
  error: string | null
  startedAt: number
  endedAt: number | null
  // Crash-resume (P1, миграция 19): живой прогресс. 0/null у прогонов до миграции.
  turnIndex: number
  lastToolName: string | null
  lastCheckpointId: number | null
  agentMode: string | null
  updatedAt: number | null
}

/** Событие Timeline прогона (append-only). */
export interface AgentRunEvent {
  id: number
  runId: string
  kind: string
  label: string | null
  detail: string | null
  ref: string | null
  status: string | null
  createdAt: number
}

/** Агрегат одного прогона для раскрытой карточки (agent-runs:get). */
export interface AgentRunDetail {
  run: AgentRun | null
  events: AgentRunEvent[]
  subs: SubSession[]
  todos: SessionTodo[]
}

/**
 * Crash-resume (P1) — зависший после краха прогон для баннера «сессия прервана».
 * Зеркало shape из electron/storage/agent-runs.ts (renderer не импортит electron/).
 */
export interface ResumableRun {
  runId: string
  projectPath: string
  chatId: number | null
  title: string
  /** Текст последнего user-запроса (для re-send и подписи баннера). */
  lastUserRequest: string
  turnIndex: number
  lastToolName: string | null
  agentMode: string | null
  startedAt: number
  /** Можно ли предлагать авто-возобновление (read-only последний tool + безопасный режим).
   *  false → деструктив/auto/bypass: только «показать что было» + ручной ре-промпт. */
  autoResumable: boolean
}

/**
 * Verification Artifact (Фаза 3) — строка истории DoD. Зеркало shape из
 * electron/storage/verifications.ts — renderer не импортит electron/, поэтому
 * тип дублируется здесь. Источник истины — файл-артефакт (.verification.json/.html).
 */
export type VerificationOverall = 'passed' | 'failed' | 'partial' | 'not_run'
export interface VerificationRow {
  id: number
  projectPath: string
  chatId: number | null
  runId: string | null
  overall: VerificationOverall
  checksTotal: number
  checksPassed: number
  changedFilesCount: number
  artifactPath: string
  htmlPath: string | null
  taskSummary: string | null
  createdAt: number
}

/**
 * Git READ (Dev Task Flow, Фаза 1) — зеркало shape из electron/ipc/git.ts.
 * Renderer не импортит electron/, поэтому типы дублируются здесь.
 */
export interface GitStatus {
  branch: string | null
  ahead: number
  behind: number
  staged: string[]
  unstaged: string[]
  untracked: string[]
}
export interface GitDiffStatEntry {
  path: string
  added: number
  removed: number
  status: string
}
export interface GitDiff {
  stat: GitDiffStatEntry[]
  patch?: string
}
export interface GitLogEntry {
  sha: string
  subject: string
  author: string
  date: string
}

/**
 * Dev Task Flow (Фаза 1) — зеркало shape из electron/storage/dev-tasks.ts.
 * В Фазе 1 типы определены, но в UI ещё не используются (storage+git-read доступны).
 */
export type DevTaskState =
  | 'draft'
  | 'branching'
  | 'in_progress'
  | 'review_ready'
  | 'paused'
  | 'packaged'
  | 'committed'
  | 'cancelled'
export type DevTaskCheckStatus = 'pending' | 'running' | 'pass' | 'fail' | 'skipped'
export interface DevTask {
  id: number
  projectPath: string
  chatId: number | null
  planId: number | null
  title: string
  state: DevTaskState
  baseBranch: string | null
  baseSha: string | null
  workBranch: string | null
  worktreePath: string | null
  checkpointId: number | null
  risk: string | null
  summary: string | null
  packageJson: string | null
  createdAt: number
  updatedAt: number
}
export interface DevTaskCheck {
  id: number
  devTaskId: number
  label: string
  command: string
  status: DevTaskCheckStatus
  exitCode: number | null
  outputTail: string | null
  ranInWorktree: boolean
  createdAt: number
}
/** Агрегат devtask:get — задача + её проверки (Фаза 2). */
export interface DevTaskDetail {
  task: DevTask | null
  checks: DevTaskCheck[]
}

/** Pipeline Brief→Proof (спек). Зеркало типов electron/storage/pipeline-runs.ts —
 *  renderer не может импортить из electron/, поэтому держим декларации здесь. */
export type PipelineMode = 'dev' | 'agency'
export type PipelineStep = 'brief' | 'plan' | 'execute' | 'verify' | 'proof' | 'completed' | 'cancelled' | 'blocked'

// Project Brain (зеркало electron/storage/project-brain.ts — renderer без main).
export interface ProjectBrain {
  id: number
  projectPath: string
  version: number
  overview: string | null
  architectureSummary: string | null
  importantFiles: string[]
  entities: string[]
  projectRules: string | null
  createdAt: number
  updatedAt: number
  lastWarmupAt: number | null
}
export type Confidence = 'low' | 'medium' | 'high'
export interface DecisionRecord {
  id: number
  projectPath: string
  sourceMessageId: string | null
  title: string
  userRequest: string | null
  finalDecision: string | null
  why: string | null
  keyArguments: string[]
  objections: string[]
  risks: string[]
  alternativesRejected: string[]
  nextActions: string[]
  confidence: Confidence | null
  revisitDate: number | null
  createdAt: number
  updatedAt: number
}
export type NewDecisionRecord = Omit<DecisionRecord, 'id' | 'projectPath' | 'createdAt' | 'updatedAt'>
export interface PipelineBrief {
  goal: string
  constraints: string
  dod: string
}
export interface PipelineRun {
  id: number
  projectPath: string
  chatId: number | null
  agentRunId: string | null
  mode: PipelineMode
  workflowId: string | null
  step: PipelineStep
  brief: PipelineBrief
  planId: number | null
  verifyAttempts: number
  createdAt: number
  updatedAt: number
}

/** Conventional-группа коммита (commit-planner, Фаза 4). */
export type CommitType = 'feat' | 'fix' | 'chore' | 'test' | 'docs' | 'refactor'
export interface CommitGroup {
  type: CommitType
  scope: string
  subject: string
  files: string[]
}

/** Замороженный пакет задачи (devtask:buildPackage, Фаза 4). */
export interface DevTaskPackage {
  changedFiles: { path: string; added: number; removed: number; status: string }[]
  checks: { label: string; command: string; status: string; exitCode: number | null }[]
  commitGroups: CommitGroup[]
  commitMessage: string
  prSummary: string
  risks: string[]
}

/** Дескриптор провайдера — единый источник из main process (electron/ai/registry.ts). */
export interface ProviderDescriptorDTO {
  id: string
  name: string
  transport: 'API' | 'CLI'
  secretKey: string | null
  models: string[]
  defaultModel: string
  supportsTools: boolean
  shortLabel: string
  /** Ревью F3: матрица возможностей — degraded-индикация на CLI. */
  capabilities?: ProviderCapabilitiesDTO
}

/** Ревью F3: что провайдер реально умеет под контролем Verstak. */
export interface ProviderCapabilitiesDTO {
  tools: boolean
  verification: boolean
  liveTimeline: boolean
  resumeSafe: boolean
  mcp: boolean
  delegation: boolean
  attachments: boolean
}

/** Doctor — health-check провайдеров и коннекторов (см. electron/ai/doctor.ts). */
export type DoctorStatus = 'ok' | 'no-key' | 'n-a'
export interface DoctorItem {
  id: string
  name: string
  status: DoctorStatus
  detail: string
}
export interface DoctorReport {
  providers: DoctorItem[]
  connectors: DoctorItem[]
  summary: { okCount: number; problemCount: number }
}

/** Tier Router — рекомендация тира+провайдера+модели (см. electron/ai/tier-router.ts). */
export type ModelTier = 'cheap' | 'frontier' | 'private'
export interface TierRecommendation {
  tier: ModelTier
  providerId: string
  model: string
  /** Человекочитаемое обоснование выбора (tooltip). */
  reason: string
}

/** Policy Center — снимок политики разрешений агента (см. electron/ipc/settings.ts). */
export type AgentModeId = 'ask' | 'accept-edits' | 'plan' | 'auto' | 'bypass'
export type PolicyDecision = 'confirm' | 'auto-accept' | 'block'
export type PolicyCategory = 'read' | 'edit' | 'command' | 'connector'
export interface PolicyMatrixRow {
  tool: string
  category: PolicyCategory
  decisions: Record<AgentModeId, PolicyDecision>
}
export interface PolicyMatrixDTO {
  modes: Array<{ id: AgentModeId; label: string; description: string; icon: string }>
  rows: PolicyMatrixRow[]
  commandDanger: string[]
}

/** Предустановленный популярный MCP-сервер. */
export interface PopularMcpServer {
  name: string
  command: string
  args: string[]
  envHint?: string
  description: string
}

export {}
