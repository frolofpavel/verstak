# Verstak

Open-source desktop AI coding IDE. Vendor-agnostic — 18 providers, 31 connectors, multi-agent orchestration, system-verified results, persistent memory.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## What is Verstak

Verstak is a desktop AI coding assistant built on Electron + TypeScript + React. It's a local-first alternative to Cursor, Claude Code, and GitHub Copilot that runs entirely on your own API keys or existing CLI subscriptions — no cloud account required beyond the providers you already use.

The key idea: never be locked in. If one provider is down or expensive, switch in one click. Your project context, memory, and chat history stay local.

---

## Features

### Providers (18)

**API providers** (bring your own key):
- Gemini, Claude, Grok, ChatGPT, OpenRouter, DeepSeek, Kimi (Moonshot), Qwen, Mistral, Groq, Ollama, Custom OpenAI-compatible
- **Russian:** YandexGPT, GigaChat (Sber)

**CLI providers** (use your existing subscription — no API key):
- Claude Code, Codex, Gemini CLI, Grok Build

Verstak **auto-detects installed CLIs on startup**. Switch provider and model per chat; if one is rate-limited or down, switch in one click without losing the session. Background sessions keep streaming when you switch projects. Automatic fallback on 429/503, smart model routing by task complexity.

**Default agent model policy (2026-07-04):** coding/planner/reviewer default is `kimi-k2.7-code` through Verstak Gateway; coding fallback is `deepseek-chat`; `qwen3-coder` is allowed but not the default for required-review bugfix work. `verstak/fast` / `verstak/coder/fast` are not recommended for agent mode until the Gateway preset is remapped. Explicit user model selection is preserved. Source: [`docs/cheap-model-eval-2026-07-04.md`](docs/cheap-model-eval-2026-07-04.md).

---

### Memory (Hermes-style)

Verstak maintains persistent memory across sessions, not just a long context window:

| Layer | What it stores |
|---|---|
| **Core Memory** | `MEMORY.md` + `USER.md` always injected into context. Agent self-updates these. |
| **Archival Memory** | FTS5-indexed facts searchable across all sessions |
| **Conversation Search** | Full-text search across all past chats |

Memory is visible and editable in Settings → Memory.

---

### Agent Capabilities

- **20+ tools:** read/write files, terminal, search, browser navigation, diagnostics
- **`check_diagnostics`** — runs `tsc --noEmit` as a native agent tool; agent sees and fixes type errors in the loop
- **Multi-agent orchestration** — `delegate` / `orchestrate` / **`swarm`** (consensus): dispatch subtasks to different providers/roles in parallel, live agent graph, todo-gate
- **Tasks dashboard** — every `ai:send` is a tracked run with live progress (turn N, current tool, counters), stop / resume, crash-resume that **never auto-replays destructive actions**
- **Verification artifact (proof of done)** — re-runs your tests and sets status by **real exit code**, not the model's word; `.json` + `.html` artifact
- **Dev Task Flow** — task → branch → diff → checks → commit/PR, with git-write behind a denylist (no `push --force` / `reset --hard`)
- **Explicit review** — a second model reviews the change with structured findings (severity, file:line, "fix selected")
- **Effort control** — quick / standard / deep thinking toggle per message
- **Auto-compact** — session summarization kicks in at 95% context window, no context overflow errors
- **Loop detection** — same tool + args called 3× triggers supervisor break; max turns per send configurable
- **Exponential backoff** — automatic retry on 429 / 503 / ECONNRESET

> **API vs CLI — honest scope:** the agent capabilities above (Verstak-controlled tools, verification artifact, live timeline, multi-agent, crash-resume guard) run under Verstak's control on **API providers**. **CLI providers** (Claude Code, Codex, Gemini CLI, Grok Build) run their own tooling internally — Verstak relays the conversation, but the control layer is reduced (tools/verification/timeline live inside the CLI, not in Verstak). The model picker marks CLI as "limited control". Full matrix: [`docs/PROVIDER_CAPABILITIES.md`](docs/PROVIDER_CAPABILITIES.md).

---

### UI / UX

- Multi-project sidebar with: **Chat · Tasks · Journal · Plan · Skills · Browser · Design · Video**
- Multi-chat per project — rename, delete, background sessions keep streaming
- Multi-file diff modal — accept/reject all changes from one turn in a single view
- Premium auth screen with Higgsfield-generated video background
- Connector marketplace (card grid, Codex-style)
- Custom commands from `.md` files (Skills system)
- Cost estimator in composer — shows `↑ tokens · ↓ tokens · $cost` per send
- **Voice input** — local Whisper (small), runs offline, no cloud STT
- Project groups, 5 agent modes (ask / accept-edits / plan / auto / bypass), per-file undo + session checkpoints
- Dark / light / Nord themes

---

### Connectors (31)

Pull live data from external systems straight into the agent chat. Read-only, credentials encrypted.

- **Dev / global:** GitHub, Google Sheets, Generic HTTP, SSH Executor, Telegram, Jira, Trello, Notion, Social Publish
- **Analytics & ads:** Google Analytics 4, Яндекс.Метрика, Яндекс.Директ, Яндекс.Вебмастер, Яндекс.Wordstat, Ozon Performance
- **Marketplaces:** Ozon Seller, Wildberries, MPSTATS, Avito
- **CRM & ops:** 1С OData, Битрикс24, amoCRM, МойСклад, Яндекс.Трекер
- **Counterparties / payments / messaging:** DaData, Контур.Фокус, ЮКасса (read-only), SendPulse, UniSender, VK, Яндекс.Диск

Each is hand-written over the official API (no scraping), read-only by default. Credentials stored in encrypted `safeStorage` (Electron built-in), never in prompts or logs.

---

### Security

- **Secret scanner** — API keys, tokens, JWTs, private key blocks redacted as `[REDACTED:type]` in all tool outputs and logs
- **Path policy** — `.env`, `.ssh`, `.aws`, `*.key`, `*.pem`, `creds*`, `cookies` blocked at read/write/list level
- **No telemetry** — nothing leaves your machine except calls to the providers you configure
- **No cloud dependency** — SQLite local storage, all state on disk

### Known limitations (1.6.3)

- **CLI providers have limited control:** Claude Code, Codex, Gemini CLI, and Grok Build run their own tool loops. Verstak can launch/relay/stop them, but Verstak-side verification artifacts, live tool timeline, MCP, delegation, and crash-resume guards are API-provider features.
- **Headless recipe-runner parity is intentionally minimal:** `scripts/verstak-cli.mjs recipe run` now shares the recipe protocol, baseline, review gate, and default model policy, but it is not yet a full GUI-equivalent runtime for attachments, timeline, or all provider UX.
- **Reviewer model override is planned:** `review_before_commit` currently uses the existing delegate path; using a separate reviewer/fixer model per recipe is a follow-up.
- **Connectors are read-only by default:** write/send operations are intentionally narrow and gated where present.
- **Encrypted local storage depends on the OS keychain:** on Linux, install/use gnome-keyring or KDE Wallet; without it, Electron safeStorage may fall back to weaker local protection.

---

## Quick Start

```bash
git clone https://github.com/frolofpavel/verstak.git
cd verstak
npm install --legacy-peer-deps
npm run electron-rebuild
npm run dev
```

Then open Settings (⚙), pick a provider, paste your API key — or select a CLI provider if the binary is on your PATH and already logged in.

---

## Download

| Platform | Command | Output |
|----------|---------|--------|
| **Windows** | `npm run dist:win` | NSIS installer + portable `.exe` |
| **Linux** | `npm run dist:linux` | AppImage + `.deb` |
| **macOS** | `npm run dist:mac` | `.dmg` + `.zip` |
| **All** | `npm run dist:all` | All platforms |

Pre-built binaries: see [Releases](https://github.com/frolofpavel/verstak/releases)

### Linux notes
- AppImage: `chmod +x Verstak-*.AppImage && ./Verstak-*.AppImage`
- If you get a sandbox error, the app handles it automatically (appends `--no-sandbox` for AppImage)
- For encrypted credential storage, install `libsecret-1-dev` (Ubuntu/Debian) or `libsecret-devel` (Fedora): `sudo apt install libsecret-1-dev gnome-keyring`
- Without gnome-keyring/KDE Wallet, API keys are stored in base64 (not encrypted) — functional but less secure

---

## CLI Auto-Detection

On startup, Verstak scans your PATH for installed CLI tools and makes them available as providers instantly — no manual configuration needed:

| Tool | Command |
|---|---|
| Claude Code | `claude` |
| Codex | `codex` |
| Gemini CLI | `gemini` |
| Grok Build | `grok` |

---

## Stack

Electron 40 · React 19 · TypeScript · Zustand · better-sqlite3 · Vite · node-pty · xterm.js

---

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Dev mode with HMR |
| `npm run build` | Production bundle → `out/` |
| `npm run type` | `tsc --noEmit` |
| `npm run test:fast` | Vitest (skip native rebuild) |
| `npm run dist:win` | NSIS + portable installer |

---

## Contributing

PRs welcome. See [CLAUDE.md](CLAUDE.md) for architecture docs, file zone rules, and code conventions.

Before submitting: `npm run type && npm run test:fast` must pass.

---

## License

MIT
