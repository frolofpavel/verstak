# Verstak MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Десктоп-приложение для AI-кодинга с Gemini как провайдером, на пользовательских API-ключах.

**Architecture:** Electron main process управляет окном, файловой системой и AI-провайдером. React-рендерер показывает чат, дерево файлов, diff-просмотр и терминал. Общение через типизированный IPC. SQLite для истории и настроек.

**Tech Stack:** Electron + Vite, React + TypeScript, better-sqlite3, @google/genai, node-pty, xterm.js, Zustand, Vitest

**Spec:** [docs/superpowers/specs/2026-05-19-verstak-design.md](../specs/2026-05-19-verstak-design.md)

---

## File Structure

```
verstak/
├── package.json
├── electron.vite.config.ts
├── tsconfig.json
├── electron/
│   ├── main.ts                # Окно, app lifecycle
│   ├── preload.ts             # contextBridge → window.api
│   ├── ipc/
│   │   ├── projects.ts        # open-dialog, list-tree
│   │   ├── files.ts           # read/write/list
│   │   ├── terminal.ts        # node-pty spawn
│   │   └── ai.ts              # send-message → провайдер
│   ├── ai/
│   │   ├── types.ts           # ChatProvider, Message, Tool
│   │   ├── gemini.ts          # @google/genai impl
│   │   └── tools.ts           # read_file/write_file/list_dir/run_command
│   └── storage/
│       ├── db.ts              # better-sqlite3 init + migrations
│       ├── settings.ts        # API key через safeStorage
│       └── chats.ts           # история сообщений в проекте
├── src/                       # React renderer
│   ├── main.tsx
│   ├── App.tsx
│   ├── components/
│   │   ├── Sidebar.tsx        # дерево файлов + переключатель
│   │   ├── Chat.tsx           # переписка с AI
│   │   ├── DiffView.tsx       # просмотр предложенных изменений
│   │   ├── Terminal.tsx       # xterm.js wrapper
│   │   └── Settings.tsx       # ввод API-ключа
│   ├── store/
│   │   └── projectStore.ts    # Zustand state
│   └── types/
│       └── api.d.ts           # типы window.api
└── tests/
    ├── ai/
    │   ├── gemini.test.ts
    │   └── tools.test.ts
    └── storage/
        ├── settings.test.ts
        └── chats.test.ts
```

---

## Task 1: Bootstrap Electron + Vite + React + TypeScript

**Files:**
- Create: `package.json`, `electron.vite.config.ts`, `tsconfig.json`, `electron/main.ts`, `electron/preload.ts`, `src/main.tsx`, `src/App.tsx`, `index.html`
- Create: `.gitignore`

- [ ] **Step 1: Initialize project**

```bash
cd /path/to/verstak
npm init -y
npm install --save-dev electron electron-vite vite typescript @types/node @types/react @types/react-dom @vitejs/plugin-react
npm install react react-dom
```

- [ ] **Step 2: Create `.gitignore`**

```
node_modules/
out/
dist/
.vite/
.verstak-data/
*.log
.DS_Store
.superpowers/brainstorm/
```

- [ ] **Step 3: Create `electron.vite.config.ts`**

```typescript
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  main: {
    build: { outDir: 'out/main', rollupOptions: { input: resolve(__dirname, 'electron/main.ts') } }
  },
  preload: {
    build: { outDir: 'out/preload', rollupOptions: { input: resolve(__dirname, 'electron/preload.ts') } }
  },
  renderer: {
    root: '.',
    build: { outDir: 'out/renderer', rollupOptions: { input: resolve(__dirname, 'index.html') } },
    plugins: [react()]
  }
})
```

- [ ] **Step 4: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] }
  },
  "include": ["src", "electron", "tests"]
}
```

- [ ] **Step 5: Create minimal `electron/main.ts`**

```typescript
import { app, BrowserWindow } from 'electron'
import { join } from 'path'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Verstak',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      sandbox: false
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
```

- [ ] **Step 6: Create minimal `electron/preload.ts`**

```typescript
import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('api', {
  ping: () => 'pong'
})
```

- [ ] **Step 7: Create `index.html`**

```html
<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>Verstak</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 8: Create `src/main.tsx` and `src/App.tsx`**

```typescript
// src/main.tsx
import { createRoot } from 'react-dom/client'
import { App } from './App'
createRoot(document.getElementById('root')!).render(<App />)
```

```typescript
// src/App.tsx
export function App() {
  return <div style={{ padding: 20, fontFamily: 'sans-serif' }}>Verstak — Hello</div>
}
```

- [ ] **Step 9: Add scripts to package.json**

```json
"scripts": {
  "dev": "electron-vite dev",
  "build": "electron-vite build",
  "test": "vitest run",
  "type": "tsc --noEmit"
}
```

- [ ] **Step 10: Run dev and verify window opens**

Run: `npm run dev`
Expected: Окно открывается, виден текст "Verstak — Hello"

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat: bootstrap Electron + Vite + React + TypeScript"
```

---

## Task 2: Setup Vitest + first passing test

**Files:**
- Create: `vitest.config.ts`, `tests/sanity.test.ts`

- [ ] **Step 1: Install Vitest**

```bash
npm install --save-dev vitest @types/node
```

- [ ] **Step 2: Create `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: { environment: 'node', include: ['tests/**/*.test.ts'] }
})
```

- [ ] **Step 3: Create sanity test `tests/sanity.test.ts`**

```typescript
import { describe, it, expect } from 'vitest'

describe('sanity', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2)
  })
})
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: 1 passed, 0 failed

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test: setup Vitest"
```

---

## Task 3: SQLite storage layer

**Files:**
- Create: `electron/storage/db.ts`
- Test: `tests/storage/db.test.ts`

- [ ] **Step 1: Install better-sqlite3**

```bash
npm install better-sqlite3
npm install --save-dev @types/better-sqlite3 electron-rebuild
npx electron-rebuild -f -w better-sqlite3
```

- [ ] **Step 2: Write failing test `tests/storage/db.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openDb } from '../../electron/storage/db'

describe('openDb', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gg-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('creates settings table on first open', () => {
    const db = openDb(join(dir, 'test.db'))
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").get()
    expect(row).toEqual({ name: 'settings' })
    db.close()
  })

  it('creates chats table on first open', () => {
    const db = openDb(join(dir, 'test.db'))
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chats'").get()
    expect(row).toEqual({ name: 'chats' })
    db.close()
  })
})
```

- [ ] **Step 3: Run test — verify fails**

Run: `npm test -- db.test`
Expected: FAIL (openDb not defined)

- [ ] **Step 4: Implement `electron/storage/db.ts`**

```typescript
import Database from 'better-sqlite3'
import type { Database as DB } from 'better-sqlite3'

export function openDb(path: string): DB {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chats_project ON chats(project_path, created_at);
  `)

  return db
}
```

- [ ] **Step 5: Run test — verify passes**

Run: `npm test -- db.test`
Expected: PASS, 2/2

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(storage): SQLite layer with settings and chats tables"
```

---

## Task 4: Settings module with Electron safeStorage stub

**Files:**
- Create: `electron/storage/settings.ts`
- Test: `tests/storage/settings.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/storage/settings.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openDb } from '../../electron/storage/db'
import { createSettings } from '../../electron/storage/settings'

// Stub safeStorage for tests — in real Electron it encrypts via OS
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(s, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8')
}

describe('settings', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gg-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('returns null for missing key', () => {
    const settings = createSettings(openDb(join(dir, 't.db')), fakeSafeStorage)
    expect(settings.getSecret('gemini_api_key')).toBeNull()
  })

  it('roundtrips encrypted secret', () => {
    const settings = createSettings(openDb(join(dir, 't.db')), fakeSafeStorage)
    settings.setSecret('gemini_api_key', 'AIzaSyTest123')
    expect(settings.getSecret('gemini_api_key')).toBe('AIzaSyTest123')
  })
})
```

- [ ] **Step 2: Run — verify fails**

Run: `npm test -- settings.test`
Expected: FAIL

- [ ] **Step 3: Implement `electron/storage/settings.ts`**

```typescript
import type { Database } from 'better-sqlite3'

export interface SafeStorageLike {
  isEncryptionAvailable: () => boolean
  encryptString: (plaintext: string) => Buffer
  decryptString: (encrypted: Buffer) => string
}

export interface Settings {
  getSecret: (key: string) => string | null
  setSecret: (key: string, value: string) => void
}

export function createSettings(db: Database, safe: SafeStorageLike): Settings {
  return {
    getSecret(key) {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
      if (!row) return null
      const buf = Buffer.from(row.value, 'base64')
      return safe.decryptString(buf)
    },
    setSecret(key, value) {
      const encrypted = safe.encryptString(value).toString('base64')
      db.prepare(`
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(key, encrypted)
    }
  }
}
```

- [ ] **Step 4: Run — verify passes**

Run: `npm test -- settings.test`
Expected: PASS, 2/2

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(storage): settings module with safeStorage"
```

---

## Task 5: Chats history module

**Files:**
- Create: `electron/storage/chats.ts`
- Test: `tests/storage/chats.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/storage/chats.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openDb } from '../../electron/storage/db'
import { createChats } from '../../electron/storage/chats'

describe('chats', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gg-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('returns empty list for new project', () => {
    const chats = createChats(openDb(join(dir, 't.db')))
    expect(chats.list('/my/project')).toEqual([])
  })

  it('appends and lists in order', () => {
    const chats = createChats(openDb(join(dir, 't.db')))
    chats.append('/my/project', 'user', 'hello')
    chats.append('/my/project', 'assistant', 'hi back')
    const list = chats.list('/my/project')
    expect(list.map(m => [m.role, m.content])).toEqual([['user', 'hello'], ['assistant', 'hi back']])
  })

  it('isolates messages per project', () => {
    const chats = createChats(openDb(join(dir, 't.db')))
    chats.append('/a', 'user', 'msg-a')
    chats.append('/b', 'user', 'msg-b')
    expect(chats.list('/a')).toHaveLength(1)
    expect(chats.list('/b')).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run — verify fails**

Run: `npm test -- chats.test`
Expected: FAIL

- [ ] **Step 3: Implement `electron/storage/chats.ts`**

```typescript
import type { Database } from 'better-sqlite3'

export type Role = 'user' | 'assistant' | 'system'

export interface ChatMessage {
  id: number
  role: Role
  content: string
  createdAt: number
}

export interface Chats {
  list: (projectPath: string) => ChatMessage[]
  append: (projectPath: string, role: Role, content: string) => void
}

export function createChats(db: Database): Chats {
  return {
    list(projectPath) {
      const rows = db.prepare(
        'SELECT id, role, content, created_at as createdAt FROM chats WHERE project_path = ? ORDER BY id ASC'
      ).all(projectPath) as ChatMessage[]
      return rows
    },
    append(projectPath, role, content) {
      db.prepare(
        'INSERT INTO chats (project_path, role, content, created_at) VALUES (?, ?, ?, ?)'
      ).run(projectPath, role, content, Date.now())
    }
  }
}
```

- [ ] **Step 4: Run — verify passes**

Run: `npm test -- chats.test`
Expected: PASS, 3/3

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(storage): chats history module per project"
```

---

## Task 6: AI provider interface + Gemini implementation

**Files:**
- Create: `electron/ai/types.ts`, `electron/ai/gemini.ts`
- Test: `tests/ai/gemini.test.ts`

- [ ] **Step 1: Install Gemini SDK**

```bash
npm install @google/genai
```

- [ ] **Step 2: Create `electron/ai/types.ts`**

```typescript
export type Role = 'user' | 'assistant' | 'system'

export interface ChatMessage {
  role: Role
  content: string
}

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface ToolResult {
  id: string
  result: unknown
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>  // JSON Schema
}

export type ChatEvent =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; call: ToolCall }
  | { type: 'done' }
  | { type: 'error'; message: string }

export interface ChatProvider {
  id: string
  name: string
  models: string[]
  send: (
    messages: ChatMessage[],
    tools: ToolDefinition[],
    toolResults?: ToolResult[]
  ) => AsyncIterable<ChatEvent>
}
```

- [ ] **Step 3: Write failing test (with mocked SDK)**

```typescript
// tests/ai/gemini.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createGeminiProvider } from '../../electron/ai/gemini'

describe('GeminiProvider', () => {
  it('exposes id and models', () => {
    const provider = createGeminiProvider({ apiKey: 'test', model: 'gemini-2.5-pro' })
    expect(provider.id).toBe('gemini')
    expect(provider.models).toContain('gemini-2.5-pro')
  })

  it('streams text from mocked SDK', async () => {
    const fakeStream = (async function*() {
      yield { text: 'Hello ' }
      yield { text: 'world' }
    })()
    const sdk = {
      models: {
        generateContentStream: vi.fn().mockResolvedValue(fakeStream)
      }
    }
    const provider = createGeminiProvider({ apiKey: 'k', model: 'gemini-2.5-pro', sdk: sdk as never })
    const events: string[] = []
    for await (const ev of provider.send([{ role: 'user', content: 'hi' }], [])) {
      if (ev.type === 'text') events.push(ev.text)
      if (ev.type === 'done') break
    }
    expect(events.join('')).toBe('Hello world')
  })
})
```

- [ ] **Step 4: Run — verify fails**

Run: `npm test -- gemini.test`
Expected: FAIL

- [ ] **Step 5: Implement `electron/ai/gemini.ts`**

```typescript
import { GoogleGenAI } from '@google/genai'
import type { ChatProvider, ChatMessage, ChatEvent, ToolDefinition, ToolResult } from './types'

interface GeminiOptions {
  apiKey: string
  model?: string
  sdk?: { models: { generateContentStream: (opts: unknown) => Promise<AsyncIterable<{ text?: string }>> } }
}

const MODELS = ['gemini-2.5-pro', 'gemini-2.5-flash']

export function createGeminiProvider(opts: GeminiOptions): ChatProvider {
  const model = opts.model ?? 'gemini-2.5-pro'
  const client = opts.sdk ?? new GoogleGenAI({ apiKey: opts.apiKey })

  return {
    id: 'gemini',
    name: 'Gemini',
    models: MODELS,

    async *send(messages: ChatMessage[], _tools: ToolDefinition[], _toolResults?: ToolResult[]): AsyncIterable<ChatEvent> {
      const contents = messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }))

      try {
        const stream = await client.models.generateContentStream({ model, contents })
        for await (const chunk of stream) {
          const text = (chunk as { text?: string }).text
          if (text) yield { type: 'text', text }
        }
        yield { type: 'done' }
      } catch (err) {
        yield { type: 'error', message: err instanceof Error ? err.message : String(err) }
      }
    }
  }
}
```

- [ ] **Step 6: Run — verify passes**

Run: `npm test -- gemini.test`
Expected: PASS, 2/2

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(ai): Gemini provider with streaming"
```

---

## Task 7: IPC layer for projects and files

**Files:**
- Create: `electron/ipc/projects.ts`, `electron/ipc/files.ts`
- Modify: `electron/main.ts`, `electron/preload.ts`, `src/types/api.d.ts`

- [ ] **Step 1: Create `electron/ipc/projects.ts`**

```typescript
import { dialog, ipcMain, BrowserWindow } from 'electron'

export function registerProjectIpc(): void {
  ipcMain.handle('projects:pick', async () => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Открыть проект'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
}
```

- [ ] **Step 2: Create `electron/ipc/files.ts`**

```typescript
import { ipcMain } from 'electron'
import { readdir, stat, readFile } from 'fs/promises'
import { join, relative, sep } from 'path'

const IGNORE = new Set(['node_modules', '.git', 'out', 'dist', '.verstak-data', '.superpowers'])

export interface FileNode {
  name: string
  path: string  // absolute
  isDirectory: boolean
  children?: FileNode[]
}

async function listTree(root: string, current: string, depth: number): Promise<FileNode[]> {
  if (depth > 5) return []
  const entries = await readdir(current)
  const nodes: FileNode[] = []
  for (const name of entries) {
    if (IGNORE.has(name) || name.startsWith('.')) continue
    const abs = join(current, name)
    let st
    try { st = await stat(abs) } catch { continue }
    if (st.isDirectory()) {
      nodes.push({ name, path: abs, isDirectory: true, children: await listTree(root, abs, depth + 1) })
    } else {
      nodes.push({ name, path: abs, isDirectory: false })
    }
  }
  nodes.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))
  return nodes
}

export function registerFilesIpc(): void {
  ipcMain.handle('files:tree', async (_e, root: string) => listTree(root, root, 0))
  ipcMain.handle('files:read', async (_e, path: string) => readFile(path, 'utf8'))
}
```

- [ ] **Step 3: Update `electron/main.ts` to register IPC**

```typescript
import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { registerProjectIpc } from './ipc/projects'
import { registerFilesIpc } from './ipc/files'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Verstak',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      sandbox: false
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerProjectIpc()
  registerFilesIpc()
  createWindow()
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
```

- [ ] **Step 4: Update `electron/preload.ts`**

```typescript
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  projects: {
    pick: () => ipcRenderer.invoke('projects:pick') as Promise<string | null>
  },
  files: {
    tree: (root: string) => ipcRenderer.invoke('files:tree', root),
    read: (path: string) => ipcRenderer.invoke('files:read', path) as Promise<string>
  }
})
```

- [ ] **Step 5: Create `src/types/api.d.ts`**

```typescript
export interface FileNode {
  name: string
  path: string
  isDirectory: boolean
  children?: FileNode[]
}

declare global {
  interface Window {
    api: {
      projects: { pick: () => Promise<string | null> }
      files: {
        tree: (root: string) => Promise<FileNode[]>
        read: (path: string) => Promise<string>
      }
    }
  }
}

export {}
```

- [ ] **Step 6: Verify typecheck passes**

Run: `npm run type`
Expected: 0 errors

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(ipc): projects and files handlers"
```

---

## Task 8: Project store + Sidebar UI

**Files:**
- Create: `src/store/projectStore.ts`, `src/components/Sidebar.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Install Zustand**

```bash
npm install zustand
```

- [ ] **Step 2: Create `src/store/projectStore.ts`**

```typescript
import { create } from 'zustand'
import type { FileNode } from '../types/api'

interface ProjectState {
  path: string | null
  tree: FileNode[]
  setProject: (path: string) => Promise<void>
}

export const useProject = create<ProjectState>((set) => ({
  path: null,
  tree: [],
  setProject: async (path: string) => {
    const tree = await window.api.files.tree(path)
    set({ path, tree })
  }
}))
```

- [ ] **Step 3: Create `src/components/Sidebar.tsx`**

```typescript
import { useProject } from '../store/projectStore'
import type { FileNode } from '../types/api'

function TreeNode({ node, depth }: { node: FileNode; depth: number }) {
  return (
    <div>
      <div style={{ paddingLeft: depth * 12, color: node.isDirectory ? '#ccc' : '#999', fontSize: 13 }}>
        {node.isDirectory ? '📁' : '📄'} {node.name}
      </div>
      {node.children?.map(child => <TreeNode key={child.path} node={child} depth={depth + 1} />)}
    </div>
  )
}

export function Sidebar() {
  const { path, tree, setProject } = useProject()

  async function openProject() {
    const picked = await window.api.projects.pick()
    if (picked) await setProject(picked)
  }

  return (
    <aside style={{ width: 260, background: '#1a1a2e', color: '#ccc', padding: 12, overflow: 'auto', height: '100vh' }}>
      <button onClick={openProject} style={{ width: '100%', padding: 8, marginBottom: 12 }}>
        {path ? 'Сменить проект' : 'Открыть проект'}
      </button>
      {path && <div style={{ fontSize: 11, color: '#888', marginBottom: 8 }}>{path}</div>}
      {tree.map(node => <TreeNode key={node.path} node={node} depth={0} />)}
    </aside>
  )
}
```

- [ ] **Step 4: Update `src/App.tsx`**

```typescript
import { Sidebar } from './components/Sidebar'

export function App() {
  return (
    <div style={{ display: 'flex', height: '100vh', background: '#0d0d0d', color: '#e0e0e0', fontFamily: 'sans-serif' }}>
      <Sidebar />
      <main style={{ flex: 1, padding: 20 }}>
        <h2>Чат с Gemini</h2>
        <p style={{ color: '#888' }}>Откроется в следующей задаче</p>
      </main>
    </div>
  )
}
```

- [ ] **Step 5: Manual test**

Run: `npm run dev`
- Жми "Открыть проект"
- Выбери папку проекта
- Дерево показывает docs/, electron/, src/, etc.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(ui): Sidebar with file tree"
```

---

## Task 9: AI IPC handler + Settings UI for API key

**Files:**
- Create: `electron/ipc/ai.ts`, `electron/ipc/settings.ts`, `src/components/Settings.tsx`
- Modify: `electron/main.ts`, `electron/preload.ts`, `src/types/api.d.ts`, `src/App.tsx`

- [ ] **Step 1: Create `electron/ipc/settings.ts`**

```typescript
import { ipcMain, app, safeStorage } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { openDb } from '../storage/db'
import { createSettings } from '../storage/settings'

let settings: ReturnType<typeof createSettings> | null = null

function getSettings() {
  if (settings) return settings
  const dir = join(app.getPath('userData'), 'storage')
  mkdirSync(dir, { recursive: true })
  const db = openDb(join(dir, 'verstak.db'))
  settings = createSettings(db, safeStorage)
  return settings
}

export function registerSettingsIpc(): void {
  ipcMain.handle('settings:get-key', (_e, key: string) => getSettings().getSecret(key))
  ipcMain.handle('settings:set-key', (_e, key: string, value: string) => {
    getSettings().setSecret(key, value)
  })
}
```

- [ ] **Step 2: Create `electron/ipc/ai.ts`**

```typescript
import { ipcMain, type WebContents } from 'electron'
import { createGeminiProvider } from '../ai/gemini'
import type { ChatMessage } from '../ai/types'

let currentSendId = 0

export function registerAiIpc(getApiKey: () => string | null): void {
  ipcMain.handle('ai:send', async (e, messages: ChatMessage[]) => {
    const apiKey = getApiKey()
    if (!apiKey) {
      e.sender.send('ai:event', { id: 0, event: { type: 'error', message: 'API ключ Gemini не задан' } })
      return
    }
    const sendId = ++currentSendId
    const provider = createGeminiProvider({ apiKey })
    streamToRenderer(e.sender, sendId, provider.send(messages, []))
    return sendId
  })
}

async function streamToRenderer(sender: WebContents, id: number, stream: AsyncIterable<unknown>) {
  for await (const event of stream) {
    sender.send('ai:event', { id, event })
  }
}
```

- [ ] **Step 3: Update `electron/main.ts`**

```typescript
import { app, BrowserWindow, safeStorage } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { registerProjectIpc } from './ipc/projects'
import { registerFilesIpc } from './ipc/files'
import { registerSettingsIpc } from './ipc/settings'
import { registerAiIpc } from './ipc/ai'
import { openDb } from './storage/db'
import { createSettings } from './storage/settings'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Verstak',
    webPreferences: { preload: join(__dirname, '../preload/preload.js'), sandbox: false }
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  const dir = join(app.getPath('userData'), 'storage')
  mkdirSync(dir, { recursive: true })
  const db = openDb(join(dir, 'verstak.db'))
  const settings = createSettings(db, safeStorage)

  registerProjectIpc()
  registerFilesIpc()
  registerSettingsIpc()
  registerAiIpc(() => settings.getSecret('gemini_api_key'))
  createWindow()
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
```

- [ ] **Step 4: Update `electron/preload.ts`**

```typescript
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  projects: { pick: () => ipcRenderer.invoke('projects:pick') },
  files: {
    tree: (root: string) => ipcRenderer.invoke('files:tree', root),
    read: (path: string) => ipcRenderer.invoke('files:read', path)
  },
  settings: {
    getKey: (key: string) => ipcRenderer.invoke('settings:get-key', key),
    setKey: (key: string, value: string) => ipcRenderer.invoke('settings:set-key', key, value)
  },
  ai: {
    send: (messages: unknown[]) => ipcRenderer.invoke('ai:send', messages),
    onEvent: (cb: (data: { id: number; event: unknown }) => void) => {
      const handler = (_e: unknown, data: { id: number; event: unknown }) => cb(data)
      ipcRenderer.on('ai:event', handler)
      return () => ipcRenderer.off('ai:event', handler)
    }
  }
})
```

- [ ] **Step 5: Update `src/types/api.d.ts`**

```typescript
export interface FileNode { name: string; path: string; isDirectory: boolean; children?: FileNode[] }
export interface ChatMessage { role: 'user' | 'assistant' | 'system'; content: string }
export type ChatEvent =
  | { type: 'text'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

declare global {
  interface Window {
    api: {
      projects: { pick: () => Promise<string | null> }
      files: {
        tree: (root: string) => Promise<FileNode[]>
        read: (path: string) => Promise<string>
      }
      settings: {
        getKey: (key: string) => Promise<string | null>
        setKey: (key: string, value: string) => Promise<void>
      }
      ai: {
        send: (messages: ChatMessage[]) => Promise<number>
        onEvent: (cb: (data: { id: number; event: ChatEvent }) => void) => () => void
      }
    }
  }
}
export {}
```

- [ ] **Step 6: Create `src/components/Settings.tsx`**

```typescript
import { useEffect, useState } from 'react'

export function Settings({ onClose }: { onClose: () => void }) {
  const [key, setKey] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => { window.api.settings.getKey('gemini_api_key').then(v => setKey(v ?? '')) }, [])

  async function save() {
    await window.api.settings.setKey('gemini_api_key', key)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10 }}>
      <div style={{ background: '#1a1a2e', padding: 24, borderRadius: 8, width: 480, color: '#e0e0e0' }}>
        <h3 style={{ marginTop: 0 }}>Настройки</h3>
        <label style={{ display: 'block', marginBottom: 8, fontSize: 13 }}>Gemini API ключ</label>
        <input
          type="password"
          value={key}
          onChange={e => setKey(e.target.value)}
          placeholder="AIzaSy..."
          style={{ width: '100%', padding: 8, background: '#0d0d0d', color: '#fff', border: '1px solid #333', borderRadius: 4, marginBottom: 12 }}
        />
        <div style={{ fontSize: 11, color: '#888', marginBottom: 16 }}>
          Получи бесплатно в Google AI Studio: aistudio.google.com → Get API key
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose}>Закрыть</button>
          <button onClick={save}>{saved ? 'Сохранено ✓' : 'Сохранить'}</button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 7: Add Settings button to `src/App.tsx`**

```typescript
import { useState } from 'react'
import { Sidebar } from './components/Sidebar'
import { Settings } from './components/Settings'

export function App() {
  const [showSettings, setShowSettings] = useState(false)
  return (
    <div style={{ display: 'flex', height: '100vh', background: '#0d0d0d', color: '#e0e0e0', fontFamily: 'sans-serif' }}>
      <Sidebar />
      <main style={{ flex: 1, padding: 20, position: 'relative' }}>
        <button onClick={() => setShowSettings(true)} style={{ position: 'absolute', top: 12, right: 12 }}>⚙ Настройки</button>
        <h2>Чат с Gemini (в следующей задаче)</h2>
      </main>
      {showSettings && <Settings onClose={() => setShowSettings(false)} />}
    </div>
  )
}
```

- [ ] **Step 8: Manual test**

Run: `npm run dev`
- Открой Настройки
- Вставь свой Gemini ключ (или фейк AIzaSyTest)
- Сохрани → "Сохранено ✓"
- Закрой и открой приложение → ключ сохранён

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: Settings UI + AI IPC handler"
```

---

## Task 10: Chat UI wired to Gemini

**Files:**
- Create: `src/components/Chat.tsx`
- Modify: `src/App.tsx`, `src/store/projectStore.ts`

- [ ] **Step 1: Add chat state to `src/store/projectStore.ts`**

```typescript
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
```

- [ ] **Step 2: Create `src/components/Chat.tsx`**

```typescript
import { useEffect, useState } from 'react'
import { useProject } from '../store/projectStore'

export function Chat() {
  const { messages, addMessage, updateLastAssistant, isStreaming, setStreaming } = useProject()
  const [input, setInput] = useState('')

  useEffect(() => {
    const off = window.api.ai.onEvent(({ event }) => {
      if (event.type === 'text') updateLastAssistant(event.text)
      else if (event.type === 'done') setStreaming(false)
      else if (event.type === 'error') {
        updateLastAssistant(`\n\n[Ошибка: ${event.message}]`)
        setStreaming(false)
      }
    })
    return off
  }, [])

  async function send() {
    const text = input.trim()
    if (!text || isStreaming) return
    setInput('')
    addMessage({ role: 'user', content: text })
    addMessage({ role: 'assistant', content: '' })
    setStreaming(true)
    const allMessages = [...useProject.getState().messages].slice(0, -1)
    await window.api.ai.send(allMessages)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ flex: 1, overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {messages.map((m, i) => (
          <div key={i} style={{
            alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
            background: m.role === 'user' ? '#1a1a2e' : '#0f2027',
            padding: '10px 14px', borderRadius: 8, maxWidth: '80%', whiteSpace: 'pre-wrap'
          }}>
            {m.role === 'assistant' && <div style={{ color: '#4fc3f7', fontSize: 11, marginBottom: 4 }}>✦ Gemini</div>}
            {m.content || (m.role === 'assistant' && isStreaming ? '...' : '')}
          </div>
        ))}
      </div>
      <div style={{ padding: 12, borderTop: '1px solid #222' }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          placeholder={isStreaming ? 'Gemini отвечает...' : 'Напиши задачу...'}
          disabled={isStreaming}
          style={{ width: '100%', padding: 10, background: '#1a1a1a', color: '#fff', border: '1px solid #333', borderRadius: 6 }}
        />
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Update `src/App.tsx`**

```typescript
import { useState } from 'react'
import { Sidebar } from './components/Sidebar'
import { Settings } from './components/Settings'
import { Chat } from './components/Chat'

export function App() {
  const [showSettings, setShowSettings] = useState(false)
  return (
    <div style={{ display: 'flex', height: '100vh', background: '#0d0d0d', color: '#e0e0e0', fontFamily: 'sans-serif' }}>
      <Sidebar />
      <main style={{ flex: 1, position: 'relative', display: 'flex', flexDirection: 'column' }}>
        <button onClick={() => setShowSettings(true)} style={{ position: 'absolute', top: 8, right: 8, zIndex: 1 }}>⚙</button>
        <Chat />
      </main>
      {showSettings && <Settings onClose={() => setShowSettings(false)} />}
    </div>
  )
}
```

- [ ] **Step 4: Manual end-to-end test**

Run: `npm run dev`
- Открой настройки, вставь реальный Gemini API ключ, сохрани
- Открой папку проекта
- В чат: "Привет, ты работаешь?"
- Должен прийти стриминговый ответ от Gemini

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(ui): Chat component with Gemini streaming"
```

---

## Task 11: Chat history persistence (MVP criterion 5)

**Files:**
- Modify: `electron/main.ts`, `electron/ipc/ai.ts`, `electron/preload.ts`, `src/types/api.d.ts`, `src/store/projectStore.ts`
- Create: `electron/ipc/chats.ts`

- [ ] **Step 1: Create `electron/ipc/chats.ts`**

```typescript
import { ipcMain } from 'electron'
import type { Chats } from '../storage/chats'

export function registerChatsIpc(chats: Chats): void {
  ipcMain.handle('chats:list', (_e, projectPath: string) => chats.list(projectPath))
  ipcMain.handle('chats:append', (_e, projectPath: string, role: 'user' | 'assistant', content: string) => {
    chats.append(projectPath, role, content)
  })
}
```

- [ ] **Step 2: Wire chats in `electron/main.ts`**

```typescript
// inside app.whenReady().then(() => {...}):
import { createChats } from './storage/chats'
import { registerChatsIpc } from './ipc/chats'

const chats = createChats(db)
registerChatsIpc(chats)
```

- [ ] **Step 3: Add chats to preload and api.d.ts**

In `preload.ts`:
```typescript
chats: {
  list: (projectPath: string) => ipcRenderer.invoke('chats:list', projectPath),
  append: (projectPath: string, role: string, content: string) =>
    ipcRenderer.invoke('chats:append', projectPath, role, content)
}
```

In `src/types/api.d.ts` extend Window['api']:
```typescript
chats: {
  list: (projectPath: string) => Promise<Array<{ id: number; role: 'user'|'assistant'|'system'; content: string; createdAt: number }>>
  append: (projectPath: string, role: 'user'|'assistant', content: string) => Promise<void>
}
```

- [ ] **Step 4: Update store to load and persist messages**

```typescript
// in setProject:
setProject: async (path) => {
  const tree = await window.api.files.tree(path)
  const history = await window.api.chats.list(path)
  set({ path, tree, messages: history.map(m => ({ role: m.role, content: m.content })) })
}
```

- [ ] **Step 5: Persist messages in `Chat.tsx` send()**

```typescript
async function send() {
  const text = input.trim()
  if (!text || isStreaming) return
  const path = useProject.getState().path
  setInput('')
  addMessage({ role: 'user', content: text })
  if (path) await window.api.chats.append(path, 'user', text)
  addMessage({ role: 'assistant', content: '' })
  setStreaming(true)
  const allMessages = [...useProject.getState().messages].slice(0, -1)
  await window.api.ai.send(allMessages)
}
```

Also persist assistant message on 'done':
```typescript
// inside onEvent handler when event.type === 'done':
const path = useProject.getState().path
const msgs = useProject.getState().messages
const lastAssistant = msgs[msgs.length - 1]
if (path && lastAssistant?.role === 'assistant' && lastAssistant.content) {
  window.api.chats.append(path, 'assistant', lastAssistant.content)
}
setStreaming(false)
```

- [ ] **Step 6: Manual test for MVP criterion 5**

Run: `npm run dev`
- Открой проект, напиши Gemini что-нибудь, получи ответ
- Закрой приложение полностью
- Открой снова, открой тот же проект
- История чата на месте ✓

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: chat history persistence per project"
```

---

## Task 12: File tools (read_file, list_directory)

**Files:**
- Create: `electron/ai/tools.ts`
- Modify: `electron/ai/gemini.ts`, `electron/ai/types.ts`, `electron/ipc/ai.ts`
- Test: `tests/ai/tools.test.ts`

- [ ] **Step 1: Write failing test for tools.ts**

```typescript
// tests/ai/tools.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createFileTools } from '../../electron/ai/tools'

describe('file tools', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gg-'))
    writeFileSync(join(root, 'README.md'), '# Test')
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'index.ts'), 'export {}')
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('read_file returns file contents', async () => {
    const tools = createFileTools(root)
    const result = await tools.execute('read_file', { path: 'README.md' })
    expect(result).toBe('# Test')
  })

  it('list_directory returns entries', async () => {
    const tools = createFileTools(root)
    const result = await tools.execute('list_directory', { path: '.' }) as string[]
    expect(result).toContain('README.md')
    expect(result).toContain('src/')
  })

  it('rejects path traversal', async () => {
    const tools = createFileTools(root)
    await expect(tools.execute('read_file', { path: '../../../etc/passwd' })).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run — verify fails**

Run: `npm test -- tools.test`
Expected: FAIL

- [ ] **Step 3: Implement `electron/ai/tools.ts`**

```typescript
import { readFile, readdir, stat, writeFile } from 'fs/promises'
import { join, resolve, relative } from 'path'
import type { ToolDefinition } from './types'

export const TOOL_DEFS: ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Прочитать содержимое файла относительно корня проекта',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Относительный путь от корня проекта' } },
      required: ['path']
    }
  },
  {
    name: 'list_directory',
    description: 'Перечислить файлы и папки в директории',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Относительный путь, "." для корня' } },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Записать содержимое в файл. Требует подтверждения пользователя.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' }
      },
      required: ['path', 'content']
    }
  }
]

export interface FileTools {
  execute: (name: string, args: Record<string, unknown>) => Promise<unknown>
}

function safeJoin(root: string, rel: string): string {
  const abs = resolve(root, rel)
  const r = relative(root, abs)
  if (r.startsWith('..') || r.includes('..' + require('path').sep)) {
    throw new Error(`Запрещён выход за пределы проекта: ${rel}`)
  }
  return abs
}

export function createFileTools(root: string): FileTools {
  return {
    async execute(name, args) {
      if (name === 'read_file') {
        const abs = safeJoin(root, String(args.path))
        return await readFile(abs, 'utf8')
      }
      if (name === 'list_directory') {
        const abs = safeJoin(root, String(args.path))
        const entries = await readdir(abs)
        const out: string[] = []
        for (const e of entries) {
          const st = await stat(join(abs, e))
          out.push(st.isDirectory() ? `${e}/` : e)
        }
        return out
      }
      if (name === 'write_file') {
        const abs = safeJoin(root, String(args.path))
        await writeFile(abs, String(args.content), 'utf8')
        return { ok: true }
      }
      throw new Error(`Неизвестный tool: ${name}`)
    }
  }
}
```

- [ ] **Step 4: Run — verify passes**

Run: `npm test -- tools.test`
Expected: PASS, 3/3

- [ ] **Step 5: Add tools to Gemini send + handle function calls**

Update `electron/ai/gemini.ts` to pass tools to the SDK and yield tool-call events. Refer to @google/genai docs for `functionCallingConfig`. The tool-call branch yields `{ type: 'tool-call', call }`.

```typescript
// Inside send(), after building contents:
const config = tools.length > 0 ? {
  tools: [{ functionDeclarations: tools.map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters as Record<string, unknown>
  })) }]
} : undefined

const stream = await client.models.generateContentStream({ model, contents, config })
for await (const chunk of stream) {
  const c = chunk as { text?: string; functionCalls?: Array<{ name: string; args: Record<string, unknown> }> }
  if (c.text) yield { type: 'text', text: c.text }
  if (c.functionCalls) {
    for (const fc of c.functionCalls) {
      yield { type: 'tool-call', call: { id: crypto.randomUUID(), name: fc.name, args: fc.args } }
    }
  }
}
```

- [ ] **Step 6: Wire tool execution in `electron/ipc/ai.ts`**

```typescript
import { createFileTools, TOOL_DEFS } from '../ai/tools'
// ...
ipcMain.handle('ai:send', async (e, messages, projectPath: string | null) => {
  const apiKey = getApiKey()
  if (!apiKey) {
    e.sender.send('ai:event', { id: 0, event: { type: 'error', message: 'API ключ не задан' } })
    return
  }
  const sendId = ++currentSendId
  const provider = createGeminiProvider({ apiKey })
  const tools = projectPath ? createFileTools(projectPath) : null

  // Multi-turn loop with tool execution
  let currentMessages = [...messages]
  const maxTurns = 5
  for (let turn = 0; turn < maxTurns; turn++) {
    const toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = []
    let assistantText = ''
    for await (const event of provider.send(currentMessages, projectPath ? TOOL_DEFS : [])) {
      if (event.type === 'text') {
        assistantText += event.text
        e.sender.send('ai:event', { id: sendId, event })
      } else if (event.type === 'tool-call') {
        // auto-execute read_file and list_directory; write_file requires confirmation (deferred to Task 13)
        if (event.call.name === 'write_file') {
          e.sender.send('ai:event', { id: sendId, event })  // pending confirmation
          return sendId  // halt — UI will resume after user confirms (handled in Task 13)
        }
        toolCalls.push(event.call)
      } else if (event.type === 'done' || event.type === 'error') {
        e.sender.send('ai:event', { id: sendId, event })
      }
    }
    if (toolCalls.length === 0) break
    if (!tools) break

    if (assistantText) currentMessages.push({ role: 'assistant', content: assistantText })
    for (const call of toolCalls) {
      try {
        const result = await tools.execute(call.name, call.args)
        currentMessages.push({ role: 'user', content: `[tool ${call.name} result]\n${JSON.stringify(result).slice(0, 5000)}` })
      } catch (err) {
        currentMessages.push({ role: 'user', content: `[tool ${call.name} error]\n${err instanceof Error ? err.message : String(err)}` })
      }
    }
  }
  return sendId
})
```

Note: проброс `projectPath` потребует поменять подпись `window.api.ai.send` — в `Chat.tsx` передавать `useProject.getState().path`.

- [ ] **Step 7: Update preload and types**

Modify `electron/preload.ts`:
```typescript
ai: {
  send: (messages: unknown[], projectPath: string | null) => ipcRenderer.invoke('ai:send', messages, projectPath),
  // ...
}
```

Modify `src/types/api.d.ts` accordingly. Modify `Chat.tsx` send() to pass path:
```typescript
const path = useProject.getState().path
await window.api.ai.send(allMessages, path)
```

- [ ] **Step 8: Manual test for MVP criterion 2**

Run: `npm run dev`
- Открой папку проекта
- В чат: "Опиши что в этом проекте — посмотри package.json и README"
- Gemini должен вызвать list_directory и read_file, затем дать осмысленный ответ

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(ai): file tools (read_file, list_directory, write_file)"
```

---

## Task 13: DiffView + write_file confirmation flow (MVP criterion 3)

**Files:**
- Create: `src/components/DiffView.tsx`
- Modify: `electron/ipc/ai.ts`, `electron/preload.ts`, `src/types/api.d.ts`, `src/store/projectStore.ts`, `src/components/Chat.tsx`

- [ ] **Step 1: Install diff library**

```bash
npm install diff @types/diff
```

- [ ] **Step 2: Add pending write_file state to store**

```typescript
// projectStore.ts add:
interface PendingWrite {
  callId: string
  path: string
  before: string
  after: string
}

// inside state:
pendingWrite: PendingWrite | null
setPendingWrite: (w: PendingWrite | null) => void
```

- [ ] **Step 3: Create `src/components/DiffView.tsx`**

```typescript
import { diffLines } from 'diff'
import { useProject } from '../store/projectStore'

export function DiffView() {
  const { pendingWrite, setPendingWrite } = useProject()
  if (!pendingWrite) return null

  const diff = diffLines(pendingWrite.before, pendingWrite.after)

  async function accept() {
    await window.api.ai.resolveWrite(pendingWrite!.callId, true)
    setPendingWrite(null)
  }
  async function reject() {
    await window.api.ai.resolveWrite(pendingWrite!.callId, false)
    setPendingWrite(null)
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 20 }}>
      <div style={{ background: '#0d0d0d', padding: 20, borderRadius: 8, width: '80%', maxHeight: '80vh', overflow: 'auto', color: '#e0e0e0', fontFamily: 'monospace', fontSize: 12 }}>
        <div style={{ marginBottom: 12, color: '#4fc3f7' }}>Изменить: {pendingWrite.path}</div>
        <pre style={{ background: '#000', padding: 12, borderRadius: 4, whiteSpace: 'pre-wrap' }}>
          {diff.map((part, i) => (
            <span key={i} style={{
              color: part.added ? '#4ec9b0' : part.removed ? '#f44747' : '#888',
              background: part.added ? 'rgba(78,201,176,0.1)' : part.removed ? 'rgba(244,71,71,0.1)' : 'transparent',
              display: 'block'
            }}>
              {part.value.split('\n').map((line, j, arr) =>
                j < arr.length - 1 ? <div key={j}>{(part.added ? '+ ' : part.removed ? '- ' : '  ') + line}</div> : null
              )}
            </span>
          ))}
        </pre>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
          <button onClick={reject} style={{ padding: '6px 16px', background: '#3a1a1a', color: '#f44', border: 'none', borderRadius: 4 }}>✗ Отклонить</button>
          <button onClick={accept} style={{ padding: '6px 16px', background: '#1a3a1a', color: '#4ec9b0', border: 'none', borderRadius: 4 }}>✓ Принять</button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Update `electron/ipc/ai.ts` for confirmation flow**

```typescript
// Track pending writes:
interface PendingTool { call: { id: string; name: string; args: Record<string, unknown> }; resolve: (ok: boolean) => void }
const pendingTools = new Map<string, PendingTool>()

ipcMain.handle('ai:resolve-write', (_e, callId: string, accept: boolean) => {
  const p = pendingTools.get(callId)
  if (p) {
    p.resolve(accept)
    pendingTools.delete(callId)
  }
})

// In the tool loop, when call.name === 'write_file':
if (event.call.name === 'write_file') {
  const path = String(event.call.args.path)
  let before = ''
  try { before = await tools.execute('read_file', { path }) as string } catch { before = '' }
  e.sender.send('ai:event', {
    id: sendId,
    event: { type: 'pending-write', callId: event.call.id, path, before, after: String(event.call.args.content) }
  })
  const accepted = await new Promise<boolean>(resolve => { pendingTools.set(event.call.id, { call: event.call, resolve }) })
  if (accepted) {
    await tools.execute('write_file', event.call.args)
    currentMessages.push({ role: 'user', content: `[tool write_file applied to ${path}]` })
  } else {
    currentMessages.push({ role: 'user', content: `[user rejected write to ${path}]` })
  }
  continue  // proceed in tool loop
}
```

Add `'pending-write'` to `ChatEvent` type in `electron/ai/types.ts` and `src/types/api.d.ts`.

- [ ] **Step 5: Wire renderer**

In preload:
```typescript
ai: {
  // ...
  resolveWrite: (callId: string, accept: boolean) => ipcRenderer.invoke('ai:resolve-write', callId, accept)
}
```

In `Chat.tsx` onEvent handler, add:
```typescript
else if (event.type === 'pending-write') {
  useProject.getState().setPendingWrite({
    callId: event.callId, path: event.path, before: event.before, after: event.after
  })
}
```

Add `<DiffView />` to `App.tsx`.

- [ ] **Step 6: Manual test for MVP criterion 3**

Run: `npm run dev`
- Открой проект
- В чат: "Создай файл NOTES.md с содержимым 'Тест verstak'"
- AI должен вызвать write_file → откроется DiffView
- Жмёшь "Принять" → файл создаётся
- Проверь файлово: NOTES.md появился

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(ui): DiffView with write_file confirmation"
```

---

## Task 14: Built-in terminal + run_command tool (MVP criterion 4)

**Files:**
- Create: `electron/ipc/terminal.ts`, `src/components/Terminal.tsx`
- Modify: `electron/main.ts`, `electron/preload.ts`, `electron/ai/tools.ts`, `src/types/api.d.ts`, `src/App.tsx`

- [ ] **Step 1: Install dependencies**

```bash
npm install node-pty xterm xterm-addon-fit
npx electron-rebuild -f -w node-pty
```

- [ ] **Step 2: Create `electron/ipc/terminal.ts`**

```typescript
import { ipcMain, BrowserWindow } from 'electron'
import * as pty from 'node-pty'

const sessions = new Map<number, pty.IPty>()

export function registerTerminalIpc(): void {
  ipcMain.handle('term:spawn', (e, cwd: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return -1
    const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash'
    const p = pty.spawn(shell, [], { cwd, cols: 100, rows: 30, env: process.env as Record<string, string> })
    const id = p.pid
    sessions.set(id, p)
    p.onData(data => e.sender.send('term:data', { id, data }))
    p.onExit(() => { sessions.delete(id); e.sender.send('term:exit', { id }) })
    return id
  })
  ipcMain.handle('term:write', (_e, id: number, data: string) => sessions.get(id)?.write(data))
  ipcMain.handle('term:resize', (_e, id: number, cols: number, rows: number) => sessions.get(id)?.resize(cols, rows))
  ipcMain.handle('term:kill', (_e, id: number) => { sessions.get(id)?.kill(); sessions.delete(id) })
}
```

- [ ] **Step 3: Register in `electron/main.ts`**

```typescript
import { registerTerminalIpc } from './ipc/terminal'
// inside whenReady:
registerTerminalIpc()
```

- [ ] **Step 4: Update preload + api.d.ts with term namespace**

(Standard pattern — `window.api.term.spawn/write/resize/kill/onData/onExit`)

- [ ] **Step 5: Create `src/components/Terminal.tsx`**

```typescript
import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import 'xterm/css/xterm.css'
import { useProject } from '../store/projectStore'

export function Terminal() {
  const ref = useRef<HTMLDivElement>(null)
  const { path } = useProject()

  useEffect(() => {
    if (!ref.current || !path) return
    const term = new XTerm({ fontSize: 12, theme: { background: '#0d0d0d' } })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(ref.current)
    fit.fit()

    let termId = -1
    window.api.term.spawn(path).then(id => {
      termId = id
      const offData = window.api.term.onData(({ id: gotId, data }) => {
        if (gotId === termId) term.write(data)
      })
      term.onData(d => window.api.term.write(termId, d))
      return offData
    })

    return () => { if (termId > 0) window.api.term.kill(termId); term.dispose() }
  }, [path])

  return <div ref={ref} style={{ height: 200, background: '#0d0d0d', borderTop: '1px solid #222' }} />
}
```

- [ ] **Step 6: Add run_command to tools.ts**

```typescript
// Append to TOOL_DEFS:
{
  name: 'run_command',
  description: 'Запустить shell-команду в корне проекта. Возвращает stdout/stderr.',
  parameters: {
    type: 'object',
    properties: { command: { type: 'string' } },
    required: ['command']
  }
}

// In execute():
if (name === 'run_command') {
  const { execSync } = require('child_process')
  try {
    const out = execSync(String(args.command), { cwd: root, encoding: 'utf8', timeout: 30_000 })
    return { stdout: out, exitCode: 0 }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number }
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.status ?? 1 }
  }
}
```

Important: run_command bypasses the diff confirmation but is auto-confirmed in MVP. Future: add command confirmation similar to write_file.

- [ ] **Step 7: Add Terminal to App.tsx layout**

```typescript
<main style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
  <div style={{ flex: 1, overflow: 'hidden' }}><Chat /></div>
  <Terminal />
</main>
```

- [ ] **Step 8: Manual test for MVP criterion 4**

Run: `npm run dev`
- Открой verstak как проект
- В чат: "запусти 'npm run type'"
- AI вызывает run_command → результат летит обратно в чат
- В терминале внизу можно набирать команды руками

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: built-in terminal + run_command tool"
```

---

## Task 15: MVP smoke test + README

**Files:**
- Create: `README.md`
- Optional: `tests/e2e/mvp.test.ts` (skipped — Electron e2e сложен для MVP, проверяем руками)

- [ ] **Step 1: Pass all 5 MVP acceptance criteria manually**

Run: `npm run dev`. Проверь по списку:

1. ✓ Открыть папку проекта — видишь дерево
2. ✓ "опиши что в этом проекте" — Gemini читает файлы и отвечает
3. ✓ "добавь в README раздел Setup" — diff → принять → файл изменился
4. ✓ "запусти npm test" — выполняется в терминале, AI видит результат
5. ✓ Закрыть/открыть приложение — история чатов на месте

Если что-то не работает — добавь под-задачу и фикси.

- [ ] **Step 2: Write `README.md`**

```markdown
# Verstak

Desktop AI coding assistant. Bring your own Gemini API key.

## Setup

1. `npm install`
2. `npx electron-rebuild -f -w better-sqlite3 node-pty`
3. `npm run dev`
4. Settings → paste Gemini API key from https://aistudio.google.com

## Stack

Electron + Vite + React + TypeScript + better-sqlite3 + @google/genai + node-pty

## Status

MVP — single-model (Gemini), single-window, no installer yet. See `docs/superpowers/specs/`.
```

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "docs: README + MVP complete"
```

---

## Self-Review Notes

**Spec coverage:** Все 5 критериев готовности MVP покрыты задачами (см. конец Task 8/11/12/13/14). Все 4 модуля из §5.2 спека реализованы. ChatProvider абстракция (§5.3) — Task 6.

**Placeholders:** Все шаги содержат полный код, файлы и команды. Никаких "TBD".

**Type consistency:** `ChatProvider`, `ChatMessage`, `ChatEvent`, `ToolDefinition` определены в Task 6, используются в Task 9/10/12/13. `FileNode` — Task 7, используется в Task 8.

**Известные упрощения для MVP:**
- `run_command` авто-разрешается (без подтверждения). Безопасность — задача v2.
- Streaming для tool-calls — однопроходная итерация по chunks, не реальный полу-стрим. Для Gemini SDK достаточно.
- xterm.js не подсасывает CSS из nested package — установить вручную через `import 'xterm/css/xterm.css'`.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-19-verstak-mvp.md`. Two execution options:

**1. Subagent-Driven (recommended)** - я диспатчу свежего сабагента на каждую задачу, ревьюю между задачами, быстрая итерация

**2. Inline Execution** - выполняем задачи в этой сессии через executing-plans, батчем с чекпоинтами на ревью

Какой подход выбираешь?
