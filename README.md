# GeminiGrok

Desktop AI coding assistant. Chat-first interface. Bring your own Gemini API key.

## What this is

A simple, clean alternative to Cursor/ClawCode. You open a project folder, chat with Gemini about it, AI reads files and proposes edits with diff-review. No subscription required — uses your own Gemini API key from Google AI Studio.

## Setup

1. Install dependencies:
   ```bash
   npm install --legacy-peer-deps
   ```

2. Rebuild native modules for Electron:
   ```bash
   npm run electron-rebuild
   ```

3. Run dev:
   ```bash
   npm run dev
   ```

4. In the app: click ⚙ → paste your Gemini API key (get one free at https://aistudio.google.com → Get API key)

## MVP Acceptance Criteria

- [ ] Open a project folder → file tree appears in sidebar
- [ ] Ask "describe this project" → Gemini reads files and answers
- [ ] Ask "add Setup section to README" → diff modal → accept → file changes
- [ ] Ask "run npm test" → command executes, AI sees the output
- [ ] Close and re-open app → chat history is preserved per project

## Stack

- Electron + Vite + React + TypeScript
- better-sqlite3 — local storage (settings, chat history)
- @google/genai — Gemini SDK
- node-pty + xterm.js — built-in terminal
- Zustand — state management

## Architecture

```
electron/
├── main.ts           # Electron main process, window, bootstrap
├── preload.ts        # contextBridge → window.api
├── ai/
│   ├── types.ts      # ChatProvider interface
│   ├── gemini.ts     # @google/genai implementation
│   └── tools.ts      # File tools (read/list/write/run_command)
├── ipc/              # IPC handlers (projects/files/settings/ai/chats/terminal)
└── storage/
    ├── db.ts         # SQLite open
    ├── settings.ts   # Encrypted secrets (safeStorage)
    └── chats.ts      # Per-project message history

src/                   # React renderer
├── App.tsx           # Layout
├── components/       # Sidebar, Chat, DiffView, Terminal, Settings
├── store/            # Zustand state
└── types/api.d.ts    # window.api types
```

## Tests

```bash
npm test
```

**Note:** native modules (better-sqlite3) are rebuilt for Electron after running `electron-rebuild`. To run Vitest, you need them built for plain node. If tests fail with `Error: was compiled against a different Node.js version`, run:

```bash
npm install --legacy-peer-deps  # restores node binaries
npm test                         # passes
npm run electron-rebuild         # rebuilds for Electron when ready to run dev
```

A cleaner future fix is to use `electron-forge` or `electron-builder` with the `nativeRebuild` step gated to packaging time.

### Electron version pin

The project pins Electron to `^40.x` (ABI 143). Newer Electron (42+, ABI 146) currently has no prebuilt binaries for `better-sqlite3@12.x` and won't build from source on Windows/MSVC due to a `__builtin_frame_address` mismatch in Electron's cppgc headers. Stay on Electron 40 until upstream prebuilds catch up.

`node-pty` ships generic N-API prebuilds that work across Node and Electron — it does not need an electron-rebuild step.

## Status — MVP v0.1

- ✅ Single model: Gemini 2.5 Pro
- ✅ Chat-first interface
- ✅ File tools with diff confirmation
- ✅ Built-in terminal
- ✅ Chat history per project
- ⏳ Multi-model (Claude, GPT) — deferred to v0.2
- ⏳ Distributable installer — deferred to v0.2
- ⏳ Monaco inline editor — deferred to v0.3

See `docs/superpowers/specs/2026-05-19-geminigrok-design.md` for the full design.
