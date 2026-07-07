# Skill Governance Audit — 2026-07-08

## Current Runtime Map

- Loader: `electron/ai/skills/loader.ts`
  - Sources load in override order: built-in -> Claude/user/extra dirs/Grok -> server.
  - `~/.verstak/skills/*.md` is the primary user skill root.
  - `~/.claude/skills` and `~/.grok/skills` are compatibility/import roots.
  - `.archive/` is not handled yet; archive/restore stays a later governance step.
- Registry: `electron/ai/skills/registry.ts`
  - Keeps an in-memory `Skill[]` cache.
  - Exposes `list()`, `get(id)`, `refresh()`, `status()`.
  - Does not persist usage/provenance state itself.
- IPC: `electron/ipc/skills.ts`
  - Exposes list/get/refresh/status/run-loaders/capture.
  - Now also exposes usage list and record-use.
- Renderer store: `src/store/skillStore.ts`
  - Keeps `skills`, `activeSkillId`, loading/status flags.
  - `setActiveSkill(id)` is the activation point for usage counting.
- Agent prompt path:
  - `src/components/Chat.tsx` resolves active skill before send.
  - `electron/ipc/ai.ts` applies recipe protocol via `applyRecipeToSkillPrompt`.
  - `electron/ai/cli-prompt.ts` and compose helpers inject `<skill_layer>`.

## Governance Decisions

- Do not create a second skill registry.
- Keep immutable prompt behavior unchanged while adding usage metadata.
- Usage belongs in storage, not in markdown frontmatter.
- Built-in/user/server provenance is already present as `Skill.source`; richer protected/archive state belongs to `skill_usage`.
- Activation counter is best-effort: failed telemetry must not block chat or skill selection.

## Closed In This Pass

- `190-SG-01`: audited loader/import/built-ins and recorded this map.
- `190-SG-02`: added `skill_usage` storage, migration 40, IPC usage endpoints, and activation counter.

## Still Open

- `190-SG-03`: protected built-ins delete/archive policy.
- `190-SG-04`: archive/restore and loader skip for `.archive/`.
- `190-SG-05`: generated skill candidates with human approval.
- `190-SG-06`: Settings grouping by provenance plus usage badges.
- `190-SG-07`: context injection hygiene around usage/provenance.
