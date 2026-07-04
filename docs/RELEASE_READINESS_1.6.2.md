# Verstak 1.6.2 Release Readiness

Date: 2026-07-04
Status: release candidate accepted with non-blocking follow-ups

## Version / Release Sync

| Check | Result | Evidence |
|---|---|---|
| `package.json` version | PASS | `1.6.2` |
| `package-lock.json` root version | PASS | synced to `1.6.2` during hardening |
| Electron app version | PASS | `app.getVersion()` reads package version; `scripts/check-installed.cjs` reports installed/build `1.6.2` |
| Installer version | PASS | `release/Verstak-Setup-1.6.2-x64.exe` |
| Portable version | PASS | `release/Verstak-Portable-1.6.2-x64.exe` |
| Updater metadata | PASS | `release/latest.yml` version `1.6.2`, setup sha512 matches local setup |
| Git tag | PASS | remote tag `v1.6.2` exists; release code tag points to `7bfa1f7` |
| GitHub Release | PASS | `Verstak 1.6.2`, not draft, not pre-release, published `2026-07-04T05:48:56Z` |
| GitHub assets | PASS | `latest.yml`, `Verstak-Setup-1.6.2-x64.exe`, `Verstak-Portable-1.6.2-x64.exe`; sizes match local files |

Note: current `main` is ahead of tag by docs/status commits (`1384e42`), while release code is tagged at `7bfa1f7`.

## Smoke Matrix

| Check | Result | Evidence / Notes |
|---|---|---|
| `npm run type` | PASS | `tsc --noEmit` completed |
| `npm run test:fast` | PASS | 251 files passed, 2047 tests passed, 7 skipped |
| `npm run build` | PASS | electron-vite main/preload/renderer build completed |
| Windows installer build | PASS | Existing 1.6.2 `dist:win` artifacts verified. Not rebuilt during hardening to avoid generating new `latest.yml`/sha without uploading replacement assets. |
| Local app launch | PASS | `release/win-unpacked/Verstak.exe` launched and closed cleanly (`APP_LAUNCH_PASS`, `APP_CLOSE_PASS`) |
| Clean app launch | PARTIAL PASS | Launched with isolated Chromium `--user-data-dir`; full first-run GUI walkthrough was not manually clicked in this pass |
| Launch over old version | PRIOR PASS | `STATUS.md` records `deploy:local` to 1.6.2. Not rerun because downgrading/reinstalling old versions would mutate Pavel's installed app |
| Settings/provider selection | TEST PASS | Provider metadata tests pass; README capability matrix reviewed |
| DeepSeek small bugfix recipe | PRIOR LIVE PASS | `STATUS.md` records live DeepSeek/Qwen/Kimi/Gemini/GLM/MiniMax recipe proxy validation in Stage 5/7 |
| Review gate fail-closed | PASS | `tests/ai/review-gate.test.ts` included in 73-test targeted smoke |
| Secret redaction smoke | PASS | `tests/ai/secret-scanner.test.ts` and command-gating smoke passed |
| No telemetry smoke | PASS STATIC | README says no telemetry; source scan found provider/update/connectors endpoints but no telemetry SDK/use such as Sentry/PostHog/Segment/Amplitude/Mixpanel |
| CLI streaming parser fix | PASS | `tests/scripts/verstak-cli-toolname.test.ts` passed |

## Targeted Test Packs

- Review gate / CLI parser / secret redaction / command gating: 4 files, 73 tests passed.
- Provider compatibility / OpenAI-compatible tool calls / tool-call repair / recipe suggestion/render: 5 files, 36 tests passed.

## Blocking Issues

None for 1.6.2 release candidate.

## Non-Blocking Known Issues

1. Headless recipe runner / CLI parity: GUI/Electron loop has recipe enforcement; headless CLI is not full parity.
2. Reviewer model override: planned follow-up for `review_before_commit` reviewer/fixer separation.
3. Installer/updater edge cases: avoid regenerating assets without re-uploading `latest.yml`; old-version-overwrite smoke needs a disposable VM/sandbox.
4. UI activity stream regressions: dedup fix is in 1.6.2, but live UI should stay on the next dogfood checklist.
5. Provider compatibility matrix: DeepSeek/Qwen/Kimi validated; Qwen 2.5 coder via OpenRouter 404 and Groq geo-block remain provider-side limitations.

## Release Plan

1. Keep `v1.6.2` release as current stable; no new tag needed for documentation-only hardening.
2. Commit this hardening patch to `main`.
3. If release assets are ever rebuilt, upload the new setup/portable/latest.yml together and re-verify sha512/size through GitHub API.

