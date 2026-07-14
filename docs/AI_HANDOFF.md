# AI Handoff: Verstak local updates

Last updated: 2026-07-15
Source branch: `codex/reapply-1.9.5`
Target use: pull these changes from Rayner's fork into Pavel's main Verstak repository
Local version alignment: `2.0.5`

## Read This First

This push contains several connected changes from Rayner's local build. Do not cherry-pick only CSS or only React components without the matching IPC, preload, storage, type, and style changes.

Keep Pavel's release version unless the release owner explicitly bumps it. Rayner's local `package.json` and lockfile are aligned to installed Verstak `2.0.5`.

Do not include the untracked `mcps/chrome-devtools/` folder unless Pavel explicitly wants that local tooling copied into the main repo.

## What Changed

### 1. Project Settings

Main files:

- `src/components/ProjectSettings.tsx`
- `electron/ipc/projects.ts`
- `electron/storage/db.ts`
- `electron/storage/projects.ts`
- `src/components/ProjectAvatar.tsx`
- `src/components/ProjectRail.tsx`
- `src/styles/layout.css`
- `src/types/api.d.ts`

Important behavior:

- Project settings were rebuilt into a cleaner modal with notes, labels, group, project folder, status, project color, notifications, project data, archive, and project-management actions.
- Project labels are stored as shared label entities but applied per project.
- Project status supports active, paused, and done.
- Project accent color is shown on the avatar ring only when no stronger state is active. Streaming, unread/completed, interrupted/error, and active-project states must override the custom color.
- Duplicate project creates a copy named `Копия <project name>` and should preserve project settings.
- Project cleanup removes temporary/cache data only, not project files, chats, tasks, or logs.
- The modal uses the same action bar pattern as global settings: changed-state text plus close/save actions.

Verify:

- Open project settings from a project gear.
- Change notes, labels, group, status, color, mute notifications, and save.
- Confirm changes apply only after save where applicable.
- Confirm accent color appears on the avatar ring when the project is idle and inactive.
- Confirm active/streaming/unread/error states override the custom color.
- Confirm duplicate project copies settings.

### 2. Project Rail And Project Sidebar

Main files:

- `src/components/ProjectRail.tsx`
- `src/components/Sidebar.tsx`
- `src/styles/layout.css`
- `src/styles/atelier-global.css`

Important behavior:

- "Projects" and the project-side panel were visually aligned.
- The project rail can be resized between the old width and a wider maximum.
- In collapsed mode, clicking a group folder expands/collapses its projects.
- Project chips keep stable selected background while project status is shown through avatar rings and thin borders.
- The project rail has filters for default, active, paused, done, and archive views.
- Project hover should not show folder paths as native browser tooltips.

Verify:

- Resize the project rail and restart app.
- Collapse rail and expand/collapse folders.
- Switch projects quickly and ensure no white ring flashes before the active ring.
- Start/finish/error a project task and confirm state colors behave as described.

### 3. File Preview From Chat

Main files:

- `src/App.tsx`
- `src/components/Chat.tsx`
- `src/components/Markdown.tsx`
- `src/components/FilePreviewPanel.tsx`
- `electron/ipc/files.ts`
- `electron/preload.ts`
- `src/types/api.d.ts`
- `src/styles/markdown.css`
- `src/styles/layout.css`

Important behavior:

- Paths in assistant messages can open in a right-side file preview panel.
- The preview can read project files, known project roots, and skill folders.
- `SKILL.md` paths from skill names should resolve correctly.
- Text/Markdown/code files show readable content.
- `.docx` converts to HTML using the existing document conversion path.
- `.xlsx` converts to readable Markdown using the existing office reader.
- Unsupported or missing files show a clear user-facing error instead of raw IPC/ENOENT output.
- The right-side preview shares sizing behavior with the parallel chat panel.

Verify:

- Click a Markdown inline code path like `direct-search-minusation/SKILL.md`.
- Click a project file path, an `.xlsx`, and a `.docx`.
- Confirm missing files show a clear explanation and the "show in explorer" action handles allowed paths.

### 4. Copyable Text Blocks In Chat

Main files:

- `src/components/Markdown.tsx`
- `src/styles/markdown.css`

Important behavior:

- Code blocks marked as `copy`, `text`, `plain`, or `plaintext` render as a separate copyable text panel.
- The user can copy the whole text with one button, including numbered lists.
- Existing code blocks with real language highlighting still render as code.

Verify:

- Send a Markdown block with ```copy and numbered lines.
- Confirm the copy button copies the exact text, including numbering.

### 5. Performance Optimizations

Main files:

- `src/components/Chat.tsx`
- `src/store/projectStore.ts`
- `electron/storage/projects.ts`

Important behavior:

- Composer token preview is now a cheap local estimate and no longer sends the full message history through IPC while typing.
- Project file tree is loaded lazily when the Files tab opens, not every time a project is selected.
- `projects.list()` avoids per-project N+1 queries for labels and last assistant timestamp.

Verify:

- Type in a long chat and delete text quickly.
- Switch between projects with large histories.
- Open Files tab and confirm the tree still loads.

### 6. Long Agent Runs And Windows Shortcuts

Main files:

- `electron/ai/run-lifecycle.ts`
- `scripts/sync-windows-shortcuts.cjs`
- `package.json`
- `package-lock.json`

Important behavior:

- Default agent run timeout is now 90 minutes.
- Local deploy syncs Start Menu, Desktop, and pinned Taskbar shortcuts to the installed `Verstak.exe`.
- Shortcut repair is part of deploy because Rayner's Start/taskbar shortcuts previously pointed to stale backup paths.

Verify:

- Check `DEFAULT_AGENT_RUN_TIMEOUT_MS` is 90 minutes.
- Run local deploy and confirm Start Menu/Desktop/Taskbar shortcuts point to `C:\Users\RAYNER\AppData\Local\Programs\Verstak\Verstak.exe`.

### 7. Visual Guardrails

Main files:

- `docs/UI_DESIGN_GUIDE.md`
- `src/styles/layout.css`
- `src/styles/atelier-global.css`
- `src/styles/shell-atelier.css`
- `src/styles/theme.css`

Important behavior:

- Preserve the Verstak card/button style: thin accent borders, subtle depth, no random heavy hover shadows, no nested frame-in-frame panels for simple content, no oversized badges.
- Project settings typography must not fall back to the old heavy mono/uppercase label style.
- Compact UI helper text should avoid final periods unless it is a full paragraph.

## Files To Inspect First

1. `docs/PATCHNOTES_DRAFT.md`
2. `src/components/ProjectSettings.tsx`
3. `src/components/ProjectRail.tsx`
4. `src/components/FilePreviewPanel.tsx`
5. `src/components/Markdown.tsx`
6. `electron/ipc/files.ts`
7. `electron/storage/projects.ts`
8. `src/store/projectStore.ts`
9. `src/styles/layout.css`
10. `scripts/sync-windows-shortcuts.cjs`

## Verification Checklist

Run:

- `npm.cmd run type`
- `npm.cmd run build`

Manual checks:

- Project settings save flow
- Project color/status rail states
- File preview for project files and skill files
- Copyable chat text block
- Typing in a long chat
- Switching large projects
- Start Menu/Desktop/Taskbar shortcut launch

## Patch Note Rule For Release

Use `docs/PATCHNOTES_DRAFT.md` as the public release-note base.

Patch notes must be human-readable and concrete. Do not include file paths, CSS/React names, internal implementation notes, or tiny visual fixes.
