# Developer Push Log

## Latest Push Package

- Date: 2026-07-16
- Branch: `codex/reapply-2.0.7`
- Commit: this commit; see `git log -1`
- Title: Reapply missing 2.0.7 chat, file preview, stop, copy, and sidebar fixes

### Included

- Reapplied missing project sidebar label: the project-side panel must read "Управление проектом", while "Мои проекты" remains unchanged.
- Reapplied reliable copy support for code and copyable text blocks through Electron clipboard IPC.
- Reapplied `AbortSignal` forwarding for plain/CLI provider streams so the stop button can interrupt current model work.
- Preserved and included the current uncommitted 2.0.7 improvements for windowed chat history, file preview resilience, notification click-through behavior, AgentRuns list limiting, and local update/changelog handling.
- Preserved 90-minute agent run timeout already present in the 2.0.7 base.

### Files To Inspect First

- Chat history and stop behavior:
  - `electron/ipc/chats.ts`
  - `electron/storage/chats.ts`
  - `electron/ai/runner-plain.ts`
  - `electron/ipc/ai.ts`
  - `src/store/projectStore.ts`
  - `src/components/Chat.tsx`
  - `src/components/SideChat.tsx`
- Clipboard and Markdown:
  - `electron/ipc/clipboard.ts`
  - `electron/main.ts`
  - `electron/preload.ts`
  - `src/components/Markdown.tsx`
  - `src/types/api.d.ts`
- File preview:
  - `electron/ipc/files.ts`
  - `src/components/FilesView.tsx`
- Sidebar/project UI:
  - `src/i18n/ru.ts`
  - `src/components/Sidebar.tsx`
  - `src/components/ProjectRail.tsx`
  - `src/styles/layout.css`
- Notifications/update:
  - `src/notification/NotificationApp.tsx`
  - `src/notification/notification.css`
  - `electron/update-remote.ts`
  - `electron/rayner-changelog.ts`

### Not Included

- `mcps/chrome-devtools/` is still an untracked local folder and should not be transferred unless explicitly requested.

### Validation

- Run `npm.cmd run type`
- Run `npm.cmd run build`
- Run local deploy/build verification before shipping to Rayner
- Manually verify:
  - copy button in copyable text block
  - stop button on CLI/plain model
  - "Управление проектом" sidebar title
  - file preview from relative chat paths
  - notification click-through outside visible toast

### Transfer Notes For Pavel's AI

- This push exists because some fixes were present in `codex/reapply-1.9.5` but not in the updated `codex/reapply-2.0.7` base. Preserve these fixes during transfer.
- Do not remove `clipboard:write-text` IPC as "unused"; Markdown copy buttons depend on it in packaged Electron.
- Do not remove the `signal` argument from `provider.send(..., signal)` in `runner-plain.ts`.
- Keep patch notes user-facing and concrete. Do not include implementation details, file paths, or internal handoff notes in release notes.

### Patchnote Source

- Use `docs/PATCHNOTES_DRAFT.md`
