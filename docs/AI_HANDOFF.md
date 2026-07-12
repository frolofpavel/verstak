# AI Handoff: settings, connectors, project instructions

Last updated: 2026-07-12
Source branch: `codex/reapply-1.9.5`
Target use: pull these changes from Rayner's fork into Pavel's main Verstak repository

## Read This First

Start here before reading the raw diff. This branch contains a broad UI/settings refresh plus connector and project-instruction work. The changes are connected: do not cherry-pick only CSS without the matching React, IPC, connector, type, and test changes.

Also read `docs/UI_DESIGN_GUIDE.md`. It is now the visual baseline for future Verstak UI work. The connector-card style is the reference for cards, buttons, expandable panels, internal blocks, inputs, lamps, hover states, and compact helper text.

## What To Transfer

Transfer the functional/UI changes below into the main repo while keeping the target repo's own release version unless Pavel explicitly wants a version bump.

### 1. Settings Redesign

Main files:

- `src/components/Settings.tsx`
- `src/styles/layout.css`
- `src/styles/theme.css`
- `src/hooks/useAppearance.ts`
- `src/i18n/ru.ts`
- `src/i18n/en.ts`

Important points:

- The settings UI was rebuilt around the new connector-card visual language.
- The first settings tab should open by default instead of jumping into providers.
- The old `Контроль`, `Ночной режим`, `Память`, `Правила`, and `Audit Log` placement was changed:
  - `Права модели` moved into the AI area
  - project memory/rules/history belong in the project-side Control section
  - profile is intentionally a `Скоро` page until account/organization features exist
- Appearance, notifications, updates, providers, models, connectors, external tools, model rights, and model work modes were all refreshed.
- Keep both dark and light theme compatibility.

Do not reintroduce:

- random card styles per settings tab
- old heavy hover shadows
- nested card-in-card layouts for simple settings
- unclear final-period helper copy in compact UI labels

### 2. Models And Providers

Main files:

- `src/components/ModelPicker.tsx`
- `src/components/ModePicker.tsx`
- `src/components/Settings.tsx`
- `src/lib/model-catalog.ts`
- `src/lib/runtime-capability.ts`
- `electron/ai/mode-policy.ts`
- `electron/ai/grok-cli.ts`
- `electron/ai/cost-guard.ts`

Important points:

- Models and providers now use cleaner cards with inline expanded settings.
- Connected/ready items sort higher.
- "Current", "primary", and duplicated control badges were removed or reduced where they misled users.
- Provider/model cards should show useful user-facing descriptions, not internal phrases like "tools".
- Runtime capability/control copy should warn users when external CLI models cannot be fully controlled by Verstak.
- Daily spending limit language replaced per-session wording and should reset by local user day.

Verify:

- Connected Grok Build still appears correctly.
- Unconnected providers are not shown as ready.
- `Где взять ключ`/connection buttons are outline buttons, not heavy filled pills.
- Tooltips use the new global Verstak style.

### 3. Connectors

Main files:

- `src/components/ConnectorIcons.tsx`
- `src/components/Settings.tsx`
- `electron/ai/connector-test.ts`
- `electron/connectors/bitrix24.ts`
- `electron/connectors/yandex-wordstat.ts`
- `electron/ipc/tool-handlers/connectors.ts`
- `src/types/api.d.ts`
- `tests/connectors/yandex-wordstat.test.ts`
- `tests/ai/connector-test-bitrix.test.ts`
- `tests/connectors/bitrix24-profile.test.ts`

Important points:

- Connector cards were redesigned and became the UI baseline.
- Connected and disconnected connectors are separated.
- Status is shown by small lamps; avoid big status pills in closed cards.
- Expanded connector settings are part of the connector card, not a detached duplicated panel.
- Bitrix24 validation now treats a webhook as connected when at least one supported area works. Show per-area capability status instead of failing the whole connector when CRM/task/user permissions differ.
- Wordstat now uses Yandex Search API wording:
  - `Идентификатор каталога`
  - API key from Yandex AI Studio/Search API
  - clear text about Search API permissions and service account setup
- Token checks must actually call the selected connector test; do not mark a connector as ready only because a value was saved.

Verify:

- Bitrix24 shows available areas such as webhook/tasks/CRM correctly.
- Wordstat test fails clearly when the Search API key/folder/roles are wrong.
- Saving a wrong key does not make the connector look connected.
- Connector icons follow the custom Verstak line-icon style.

### 4. Project Control: AI Instructions And History

Main files:

- `src/components/ProjectRulesView.tsx`
- `src/components/Sidebar.tsx`
- `src/components/BrainPanel.tsx`
- `electron/ipc/projects.ts`
- `src/store/projectStore.ts`
- `src/styles/layout.css`

Important points:

- Project rules/memory were moved out of global settings and into the project Control area.
- The section should be understandable for a first-time user:
  - quick-start templates explain what they add and whether they are safe
  - working instructions have one clean helper panel, not nested frames
  - the editable textarea is the only recessed writing surface
- The product is universal, not Yandex Direct-only. Keep templates cross-domain: marketing, development, operations, support, reporting, and general project behavior.
- Quick-start template cards are informational blocks with internal action buttons. The whole block should not animate like a button.

Verify:

- Opening the project Control section shows the new AI instruction page.
- Adding template blocks inserts text into the editor.
- Saving updates the project instructions.
- The page scrolls correctly and does not trap the settings/project panel.

### 5. Project Rail And Visual System

Main files:

- `src/components/ProjectRail.tsx`
- `src/components/Sidebar.tsx`
- `src/App.tsx`
- `src/styles/layout.css`
- `src/styles/atelier-global.css`
- `docs/UI_DESIGN_GUIDE.md`

Important points:

- The design guide is now mandatory for future UI work.
- Collapsed project folders can expand/collapse from the rail.
- Avatar/project status visuals, folder icons, lamps, card borders, and hover language should stay consistent.
- Do not bring back mixed one-off colors, thick side bars, random glows, or heavy mono labels.

### 6. External Tools And Model Rights

Main files:

- `electron/mcp/registry.ts`
- `src/components/Settings.tsx`
- `electron/ai/tools.ts`
- `electron/ipc/ai.ts`
- `electron/main.ts`
- `electron/preload.ts`

Important points:

- `MCP` is renamed/presented as `Внешние инструменты` / `Продвинутые подключения` for users.
- Ready-made server descriptions were rewritten for normal users.
- `Права модели` replaces the vague `Что разрешено` naming.
- The permissions table was redesigned as a compact matrix with lamps.
- Include the disclaimer that some external models cannot be technically controlled by Verstak.

Verify:

- The external tools tab is understandable without knowing the MCP acronym.
- The model-rights table fits horizontally and uses the same lamp style as the rest of the app.
- Expandable blocks use connector-style hover and no frame-in-frame look.

## Files To Inspect First

Recommended review order:

1. `docs/UI_DESIGN_GUIDE.md`
2. `docs/PATCHNOTES_DRAFT.md`
3. `src/components/Settings.tsx`
4. `src/styles/layout.css`
5. `src/components/ProjectRulesView.tsx`
6. `src/components/ConnectorIcons.tsx`
7. `electron/ai/connector-test.ts`
8. `electron/connectors/yandex-wordstat.ts`
9. `electron/connectors/bitrix24.ts`

## Do Not Include

Do not include `mcps/chrome-devtools/` from this working tree unless Pavel explicitly wants it. It is an untracked local tooling folder and is not wired into the current MCP registry.

## Verification Checklist

Run at minimum:

- `npm.cmd run type`
- `npm.cmd run build`

Recommended targeted checks:

- connector tests for Bitrix24 and Wordstat
- open settings and inspect dark/light themes
- check `Внешний вид`, `Уведомления`, `Обновления`, `Провайдеры`, `Модели`, `Коннекторы`, `Внешние инструменты`, `Права модели`
- open a project and check Control -> AI instructions / history/rules sections
- verify collapsed project folder behavior in the rail

## Patch Note Rule For Release

Use `docs/PATCHNOTES_DRAFT.md` as the public release-note base.

Patch notes must be written for normal users:

- concrete visible changes
- grouped by app section
- no file paths
- no CSS/React/internal implementation names
- no tiny spacing-only fixes
- no long "because..." explanations

## Version Note

Rayner's local branch was built/deployed against installed Verstak `1.9.5`. When merging into Pavel's main release branch, keep Pavel's current release version unless the release owner explicitly asks to publish this as a version bump.
