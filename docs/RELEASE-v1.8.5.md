# Verstak v1.8.5

Release focus: settings mechanics, model policy visibility, project rules visibility, and safer explicit file exports.

## Highlights

- Settings navigation is grouped into practical blocks: app, AI/models, integrations, agent control, project data.
- Provider settings now has `Find CLI` for installed external CLI agents.
- Model policy is visible in Settings and ModelPicker: Kimi K2.7 Code is the main coding/planner/reviewer model, DeepSeek Chat is fallback, and models that should not run agent mode are marked.
- Settings has a `Rules` tab for global and project rules files, with safe create/open/folder actions.
- Explicit writes outside the active project are supported only for user-requested exports into Downloads.

## Safety Notes

- External absolute paths remain read-only context unless they are explicit Downloads exports.
- Secret paths remain blocked.
- Rules actions are constrained to registered projects and known rules candidates.

## Verification

- `npm run type`
- `npm run test:fast` - 2102 passed / 7 skipped
- `npm run build`
- `npm run dist:win`
