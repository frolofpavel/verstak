# AI Handoff: Verstak 2.0.7 local patch transfer

Last updated: 2026-07-16
Source branch: `codex/reapply-2.0.7`
Target use: pull Rayner's local fixes from the fork into Pavel's main Verstak repository
Local version alignment: `2.0.7`

## Read This First

This package reapplies fixes that were partly lost when Rayner updated to the 2.0.7 base. Do not cherry-pick only renderer code: several UI fixes depend on matching Electron IPC, preload, storage, and type changes.

Keep Pavel's release version unless the release owner explicitly bumps it. Rayner's local `package.json` and installed app are aligned to `2.0.7`.

Do not include the untracked `mcps/chrome-devtools/` folder unless Pavel explicitly asks for that local tooling.

## What Changed

### Chat Stability And Long Histories

Main files:

- `electron/ipc/chats.ts`
- `electron/storage/chats.ts`
- `electron/preload.ts`
- `src/store/projectStore.ts`
- `src/components/Chat.tsx`
- `src/styles/layout.css`

Important behavior:

- Chat history can be loaded in windows instead of pulling the whole long conversation into the renderer at once.
- The chat can show a "Показать ранние сообщения" control for older messages.
- Project switching and typing in large chats should be lighter because file/tree work is deferred until needed.
- Autoscroll must not force the user to the bottom while they are reading older messages and editing the composer.

Verify:

- Open a project with a long chat history.
- Confirm the latest messages load first and older messages can be requested.
- Type in the composer while scrolled up and confirm the chat does not jump down until a real send/update requires it.

### Stop Button For Plain/CLI Runs

Main files:

- `electron/ai/runner-plain.ts`
- `electron/ipc/ai.ts`
- `src/components/Chat.tsx`
- `src/components/SideChat.tsx`

Important behavior:

- Plain/CLI provider streams now receive the active `AbortSignal`.
- The stop button should interrupt only the current send, not unrelated model work in another project.
- Manual stop should not immediately auto-flush queued follow-up tasks as if the run completed normally.

Verify:

- Start a CLI/plain model answer.
- Press stop and confirm the current response stops promptly.
- Confirm another active project is not stopped by the same click.

### Copyable Text And Code Blocks

Main files:

- `electron/ipc/clipboard.ts`
- `electron/main.ts`
- `electron/preload.ts`
- `src/components/Markdown.tsx`
- `src/types/api.d.ts`

Important behavior:

- Markdown code blocks and copyable text blocks use Electron clipboard IPC first, then fall back to `navigator.clipboard`.
- This prevents the copy button from silently doing nothing in packaged Electron contexts.

Verify:

- Ask the assistant for a copyable text block.
- Click copy and paste into any text field.
- Repeat with a normal code block.

### File Preview From Chat

Main files:

- `electron/ipc/files.ts`
- `src/components/FilesView.tsx`
- `src/components/Markdown.tsx`
- `src/types/api.d.ts`

Important behavior:

- Relative paths produced in chat should resolve against the active project root.
- Missing or unsupported files should show a readable explanation instead of a raw technical failure.
- Heavy folders are collapsed/truncated so file preview does not freeze the UI.

Verify:

- Click a project-relative file path in chat, including files from skill folders.
- Confirm readable files open in the side preview.
- Confirm missing files explain why preview is unavailable.

### Project Sidebar Naming And Disabled Sections

Main files:

- `src/i18n/ru.ts`
- `src/components/Sidebar.tsx`

Important behavior:

- The second left-side project panel is named "Управление проектом" to avoid confusion with "Мои проекты".
- Browser and Design project sections are marked as "Скоро" and disabled until their flows are ready.

Verify:

- Open a project and check the panel title.
- Confirm Browser and Design show "Скоро" and cannot be opened.

### Notifications And Local Update Robustness

Main files:

- `src/notification/NotificationApp.tsx`
- `src/notification/notification.css`
- `electron/update-remote.ts`
- `electron/rayner-changelog.ts`
- `src/hooks/useAppearance.ts`

Important behavior:

- Toast windows should not block clicks outside their visible notification card.
- Update/changelog handling includes the local Rayner package notes.
- Appearance hooks keep the local UI in sync after recent settings redesign work.

Verify:

- Trigger a completion toast and click around the app outside the visible toast.
- Confirm only the visible notification area blocks interaction.

## Validation To Run After Transfer

- `npm.cmd run type`
- `npm.cmd run build`
- local deploy/build check if this is being packaged into Rayner's installed app
- manual checks listed above

## Transfer Notes For Pavel's AI

- Preserve the `AbortSignal` argument in plain/CLI provider sends.
- Preserve `clipboard:write-text` IPC and the renderer fallback.
- Preserve the "Управление проектом" label and disabled Browser/Design sections.
- Preserve windowed chat history types across Electron IPC, preload, store, and renderer.
- Keep user-facing patch notes human-readable. Use `docs/PATCHNOTES_DRAFT.md`.
