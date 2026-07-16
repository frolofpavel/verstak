# AI Handoff: Verstak 2.0.7 project settings and chat polish transfer

Last updated: 2026-07-16
Source branch: `codex/reapply-2.0.7`
Target use: pull Rayner's local fixes from the fork into Pavel's main Verstak repository
Local version alignment: `2.0.7`

## Read This First

This package contains the latest local fixes after the previous push. Keep Pavel's release version unless the release owner explicitly bumps it. Rayner's local `package.json` and installed app are aligned to `2.0.7`.

Do not include the untracked `mcps/chrome-devtools/` folder unless Pavel explicitly asks for that local tooling.

## What Changed

### Project Settings Encoding Fix

Main files:

- `src/components/ProjectSettings.tsx`
- `scripts/check-mojibake.cjs`
- `scripts/precommit.cjs`
- `package.json`
- `docs/PROJECT_SETTINGS_ENCODING_FIX_PLAN.md`

Important behavior:

- The project settings window must show normal Russian UI text instead of mojibake strings.
- The fix is for static interface copy only; project names, dates, notes, labels, and other user data must remain unchanged.
- A new `check:mojibake` guard scans source/docs/scripts for common broken UTF-8/Windows-1251 fragments.
- The precommit script runs the mojibake guard before the existing checks, so this class of regression is blocked earlier.
- `docs/PROJECT_SETTINGS_ENCODING_FIX_PLAN.md` explains the diagnosis and the prevention plan.

Verify:

- Open project settings from a project gear button.
- Confirm all headings, labels, helper text, buttons, placeholders, and warnings are readable Russian.
- Run `npm.cmd run check:mojibake` and confirm it passes.

### Chat View Refresh

Main files:

- `src/components/Chat.tsx`
- `src/styles/shell-atelier.css`

Important behavior:

- The chat stream has a calmer document-style layout around messages, date dividers, user bubbles, assistant bubbles, and work-progress blocks.
- While scrolling a chat, a small date label appears above the stream to show the date of the visible messages.
- The date label is driven from message metadata and should update during scroll without changing message content.
- The composer area remains visually separated from the chat stream.

Verify:

- Open a chat with messages from different days and scroll through it.
- Confirm the visible date label appears and changes as expected.
- Confirm user messages, assistant messages, date dividers, and AI work panels remain readable in dark and light themes.

## Validation To Run After Transfer

- `npm.cmd run check:mojibake`
- `npm.cmd run type`
- `npm.cmd run build`
- `git diff --check`
- local deploy/build verification if this is being packaged into Rayner's installed app
- manual checks listed above

## Transfer Notes For Pavel's AI

- Preserve `scripts/check-mojibake.cjs` and the `check:mojibake` npm script.
- Preserve the precommit mojibake guard; do not remove it as an unrelated script.
- Do not reintroduce the old broken strings in `ProjectSettings.tsx` from another branch or generated patch.
- Preserve the visible-date metadata attributes added in `Chat.tsx`; the chat label depends on them.
- Keep the chat CSS aligned with both dark and light themes.
- Keep user-facing patch notes human-readable and concrete. Use `docs/PATCHNOTES_DRAFT.md`.
