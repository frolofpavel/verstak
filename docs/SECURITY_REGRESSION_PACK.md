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
| SEC-SKILL-01 | skill-install | CWE-22 | block | `tests/security/skill-install.test.ts` | active |
| SEC-SKILL-02 | skill-install | CWE-829 | block | `tests/security/skill-install.test.ts` | active |
| SEC-SKILL-03 | skill-install | CWE-94 | block | `tests/security/skill-install.test.ts` | active |
| SEC-CFG-01 | config-mutation | CWE-922 | block | `tests/security/config-mutation.test.ts` | active |
| SEC-CFG-02 | config-mutation | CWE-922 | block | `tests/security/config-mutation.test.ts` | active |
| SEC-DOTENV-01 | dotenv-guard | CWE-200 | block | `tests/security/dotenv-guard.test.ts` | active |
| SEC-SSRF-01 | ssrf | CWE-918 | block | `tests/security/ssrf.test.ts` | active |
| SEC-SSRF-02 | ssrf | CWE-918 | block | `tests/security/ssrf.test.ts` | active |
| SEC-SSRF-03 | ssrf | CWE-918 | block | `tests/security/ssrf.test.ts` | active |
| SEC-SSRF-04 | secret-leak | CWE-200 | block | `tests/security/ssrf.test.ts` | active |

## Covered Classes

- Explicit external read is allowed only as read-only context.
- Absolute writes are restricted to the project, Downloads, or configured external write roots.
- Symlink escapes from allowed roots are blocked.
- The command shown to the user for approval is the exact command executed.
- Dangerous command chains are classified as a whole command, not only by first token.
- Dangerous command detection covers destructive shell operations and common obfuscation.
- Skill install targets cannot escape the configured skills root.
- Skill archive entries cannot use zip-slip or absolute paths.
- Imported skills cannot include executable payloads or hidden runtime hook paths.
- Skill archive scan errors fail closed.
- Agent-visible tools do not expose settings, secret, token, provider-key, or env mutation.
- Encrypted settings are not stored as plaintext when Electron safeStorage is available.
- Workspace `.env*` files are forbidden, and Verstak/ClawHub/OpenClaw env prefixes are explicit no-context keys.
- Literal private, loopback, link-local, and metadata web hosts are blocked.
- Redirect hops are revalidated before fetch continues.
- URL query and fragment secrets are redacted before log or trace use.

## Next Rules

Planned by `docs/COMPETITIVE_MASTER_PLAN_2026-07-07.md`:

- SEC-05: skill install path traversal and fail-closed scan. Active as `SEC-SKILL-01..03`.
- SEC-06: config mutation guard. Active as `SEC-CFG-01..02`.
- SEC-07: workspace dotenv guard. Active as `SEC-DOTENV-01`.
- APP-01: deterministic dangerous-command detector. Active as `SEC-CMD-03`.
