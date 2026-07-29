# Security Regression Pack

Date: 2026-07-07

Purpose: keep Verstak's agent freedom safe while we add more runtime autonomy.
This pack ports the discipline of competitor security catalogs into small
TypeScript/Vitest regression tests instead of adding an external scanner.

## How To Run

Fast security gate:

```bash
npm run test:security
```

Release hardening order:

```bash
npm run test:security
npm run type
npm run test:fast
npm run build
```

`npm run test:fast` also includes `tests/security`, but `test:security` is the
quick focused gate for agent-safety work.

## Catalog

| ID | Category | CWE | Severity | Test File | Status |
|---|---|---|---|---|---|
| SEC-PATH-01 | path-escape | CWE-22 | warn | `tests/security/path-escape.test.ts` | active |
| SEC-PATH-02 | path-escape | CWE-22 | block | `tests/security/path-escape.test.ts` | active |
| SEC-PATH-03 | path-escape | CWE-22 | block | `tests/security/path-escape.test.ts` | active |
| SEC-PATH-04 | path-escape | CWE-22 | block | `tests/security/path-escape.test.ts` | active |
| SEC-CMD-01 | command-binding | CWE-178 | block | `tests/security/command-binding.test.ts` | active |
| SEC-CMD-02 | command-binding | CWE-178 | block | `tests/security/command-binding.test.ts` | active |
| SEC-CMD-03 | command-binding | CWE-78 | block | `tests/ai/dangerous-commands.test.ts` | active |
| SEC-CFG-01 | config-mutation | CWE-922 | block | `tests/security/config-mutation.test.ts` | active |
| SEC-CFG-02 | config-mutation | CWE-922 | block | `tests/security/config-mutation.test.ts` | active |
| SEC-DOTENV-01 | dotenv-guard | CWE-200 | block | `tests/security/dotenv-guard.test.ts` | active |
| SEC-SSRF-01 | ssrf | CWE-918 | block | `tests/security/ssrf.test.ts` | active |
| SEC-SSRF-02 | ssrf | CWE-918 | block | `tests/security/ssrf.test.ts` | active |
| SEC-SSRF-03 | ssrf | CWE-918 | block | `tests/security/ssrf.test.ts` | active |
| SEC-SSRF-04 | secret-leak | CWE-200 | block | `tests/security/ssrf.test.ts` | active |
| SEC-SECRET-01 | secret-destruction | CWE-212 | block | `tests/security/secret-write-path.test.ts` | active |
| SEC-SECRET-02 | secret-leak | CWE-200 | block | `tests/security/secret-write-path.test.ts` | active |
| SEC-SECRET-03 | secret-leak | CWE-200 | block | `tests/security/undo-list-no-content.test.ts` | active |
| SEC-SECRET-04 | secret-leak | CWE-200 | block | `tests/security/exact-rewind-no-content.test.ts` | active |
| SEC-CMD-04 | command-exec | CWE-77 | block | `tests/security/attest-verification-gate.test.ts` | active |

## Covered Classes

- Explicit external read is allowed only as read-only context.
- Absolute writes are restricted to the project, Downloads, or configured external write roots.
- Symlink escapes from allowed roots are blocked.
- The command shown to the user for approval is the exact command executed.
- Dangerous command chains are classified as a whole command, not only by first token.
- Dangerous command detection covers destructive shell operations and common obfuscation.
- Agent-visible tools do not expose settings, secret, token, provider-key, or env mutation.
- Encrypted settings are not stored as plaintext when Electron safeStorage is available.
- Workspace `.env*` files are forbidden, and Verstak/ClawHub/OpenClaw env prefixes are explicit no-context keys.
- Literal private, loopback, link-local, and metadata web hosts are blocked.
- Redirect hops are revalidated before fetch continues.
- URL query and fragment secrets are redacted before log or trace use.
- The write path takes the file's previous state raw, so neither an edit nor its undo can write a scanner placeholder over a live secret.
- Whole-file writes (`write_file`, `propose_edits`) are refused on files that contain secrets; `apply_patch` stays available because its SEARCH/REPLACE lands on the raw text.
- The confirmation diff leaving the main process carries the secret's type, a four-character fingerprint and its direction (added / changed / removed / unchanged), never the value. The mask is applied to the emitted event itself, not before rendering: `src/App.tsx` forwards every event of a phone-started run verbatim to an external relay over HTTP, so a renderer-side mask would let raw secrets leave the machine. File content leaves main from exactly one place, and that is pinned.
- The undo stack keeps raw content because that is the only way undo restores a live secret; `undo:list` therefore hands the renderer a summary with no content at all. Refusal rather than masking, because nothing displays it — every undo path reads the stack inside main. A control pin keeps the stack itself raw, so the leak cannot be "fixed" by dropping the content and reviving the original data-loss bug.
- Exact-rewind backups stay inside main under a one-shot token; the renderer never sees or supplies file content. Same refusal criterion as `undo:list` — the flow shows only counts and paths. A control pin proves the backup is alive in main (unrevert by token restores the file), so the leak cannot be "fixed" by dropping the backups.
- **A write primitive that bypassed every confirmation, recorded as its own defect.** `exact-rewind:unrevert` accepted an arbitrary path→content record straight from the renderer and wrote it to disk. Paths were constrained by `safeRealJoin`; the *content* was constrained by nothing, and no mode, permission rule or confirmation dialog stood in the way — a renderer-side call could rewrite any file in the project. It is the same class as the rest of the 29–30.07 line (a trusted-looking path that never asks the gate), and it closed only incidentally, because the neighbouring leak was being fixed. Filed under SEC-SECRET-04 because one token fixes both directions, but it is not a side effect of that leak: had the backups never left main, this primitive would still have been open.
- Verification checks (`attest_verification`) are executed through the shared command gate, not a raw spawn: the tool re-runs each check via the real `run_command` handler, so the denylist, agent mode (`plan` blocks), `autoApprove`, permission rules including the absolute `deny`, the responsible-action pause, `bash_allowlist` and the Agent Job guard all apply. Gating under the tool's own name would have been a no-op — `decide()` and `classifyResponsibleAction` only parse arguments for run_command/connector_query/execute_code, so the gate would have looked installed and never fired. A verify-command allowlist was rejected deliberately: both existing lists cover JS (plus pytest/ruff/mypy) and would make DoD unreachable for Go/Rust/.NET/Java projects, which the run_command description itself invites.

## Next Rules

Planned by `docs/COMPETITIVE_MASTER_PLAN_2026-07-07.md`:

- SEC-05: skill install path traversal and fail-closed scan. Active as `SEC-SKILL-01..03`.
- SEC-06: config mutation guard. Active as `SEC-CFG-01..02`.
- SEC-07: workspace dotenv guard. Active as `SEC-DOTENV-01`.
- APP-01: deterministic dangerous-command detector. Active as `SEC-CMD-03`.
