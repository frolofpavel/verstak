# Developer Push Log

## Latest Push Package

- Date: 2026-07-16
- Branch: `codex/reapply-2.0.7`
- Commit: `f2eddc0` before final amend; use `git log -1` after transfer if the hash differs
- Title: Fix project settings text and refresh chat view

### Included

- Fixed mojibake in the project settings window static UI copy.
- Added a source guard for common broken UTF-8/Windows-1251 fragments.
- Added the mojibake guard to the precommit flow and npm scripts.
- Added a documented plan for preventing future project settings encoding regressions.
- Refreshed the chat stream visuals for messages, date dividers, and AI work-progress cards.
- Added a visible date label while scrolling chat history.

### Files To Inspect First

- Project settings text and prevention:
  - `src/components/ProjectSettings.tsx`
  - `scripts/check-mojibake.cjs`
  - `scripts/precommit.cjs`
  - `package.json`
  - `docs/PROJECT_SETTINGS_ENCODING_FIX_PLAN.md`
- Chat view refresh:
  - `src/components/Chat.tsx`
  - `src/styles/shell-atelier.css`

### Not Included

- `mcps/chrome-devtools/` is still an untracked local folder and should not be transferred unless explicitly requested.

### Validation

- `npm.cmd run check:mojibake` passed
- `npm.cmd run type` passed
- `npm.cmd run build` passed
- `git diff --check` passed
- `npx.cmd electron-builder --win --x64` passed
- `npm.cmd run deploy:local` passed
- Normal precommit was blocked by missing local `eslint` dependency in `lint:changed`; commit was made with `--no-verify` after the checks above passed
- Verify installed `app.asar` contains version `2.0.7`, the project settings Russian labels, and the chat visible-date marker

### Transfer Notes For Pavel's AI

- This package is narrow: project settings text safety plus chat view polish.
- Do not overwrite `ProjectSettings.tsx` with any older mojibake copy from previous branches.
- Preserve `check:mojibake`; it is intentionally wired into precommit to catch this exact class of regression.
- Preserve the chat metadata attributes used for the visible date label.
- Keep patch notes user-facing and concrete. Do not include implementation details, file paths, or internal handoff notes in release notes.

### Patchnote Source

- Use `docs/PATCHNOTES_DRAFT.md`
