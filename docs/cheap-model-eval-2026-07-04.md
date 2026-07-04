# Cheap Model Eval Matrix - 2026-07-04

Scope: headless recipe runner through Verstak Gateway, temporary workspaces only, no secrets written to report.

## Run Metadata

- Provider: verstak-gateway
- Gateway base URL for probes: https://api-ru.agi-iri.ru/v1
- Key present: yes
- Dry run: no
- Probe only: no
- Started: 2026-07-04T10:18:52.504Z
- Finished: 2026-07-04T10:32:11.997Z

## Recommendations

1. Default coding model: kimi-k2.7-code
2. Default fallback model: deepseek-chat
3. Default reviewer model: kimi-k2.7-code
4. Default planner model: kimi-k2.7-code
5. bugfix -> kimi-k2.7-code
6. test-fix -> kimi-k2.7-code
7. typescript-error -> kimi-k2.7-code
8. review-before-commit -> kimi-k2.7-code
9. verstak/coder/fast preset -> deepseek-chat
10. verstak/coder/balanced preset -> kimi-k2.7-code
11. Do not use in agent mode: verstak/coder/fast, z-ai/glm-4.6

## Policy Notes

- `kimi-k2.7-code` resolved through Gateway as `moonshotai-kimi-k2` and was the only model with 5/5 strict passes.
- `deepseek-chat` is the fallback coding model because it passed `bugfix`, `test-fix`, `typescript-error`, and `small-edit`; its only fail was the standalone `review-before-commit` recipe.
- `qwen3-coder` passed 4/5 but failed `bugfix` because the required review gate was not completed, so it is not the default fallback for required-review bugfix work.
- Current `verstak/fast` is not agent-mode ready: 1/5 strict passes. Re-map `verstak/coder/fast` to `deepseek-chat` or keep it out of agent mode until the Gateway preset is changed.
- Current `verstak/balanced` is usable for guarded coding (4/5) but failed `small-edit`; re-map `verstak/coder/balanced` to `kimi-k2.7-code` for release defaults.

## Matrix

| model | recipe | result | tool discipline | diff discipline | verify | review gate | turns | failure mode | recommendation |
|---|---|---:|---|---|---|---|---:|---|---|
| deepseek-chat | small-edit | pass | calls 6; first mutating apply_patch; malformed no; baseline yes | 1 lines; README.md; unrelated no | pass | not-required | 6 |  | candidate |
| deepseek-chat | bugfix | pass | calls 11; first mutating apply_patch; malformed no; baseline yes | 1 lines; calc.mjs; unrelated no | pass | pass | 6 |  | candidate |
| deepseek-chat | typescript-error | pass | calls 7; first mutating apply_patch; malformed no; baseline yes | 1 lines; src/value.ts; unrelated no | pass | pass | 5 |  | candidate |
| deepseek-chat | test-fix | pass | calls 11; first mutating apply_patch; malformed no; baseline yes | 1 lines; math.mjs; unrelated no | pass | pass | 8 |  | candidate |
| deepseek-chat | review-before-commit | fail | calls 0; no mutation; malformed yes; baseline no | 1 lines; calc.mjs; unrelated no | fail | not-called | 0 | non-zero exit | do not use for this recipe yet |
| deepseek-reasoner | small-edit | not tested | calls 0; no mutation; malformed no; baseline no | 0 lines; no changed files; unrelated no | fail | n/a | 0 | unavailable: network-error | not tested: unavailable |
| deepseek-reasoner | bugfix | not tested | calls 0; no mutation; malformed no; baseline no | 0 lines; no changed files; unrelated no | fail | not-called | 0 | unavailable: network-error | not tested: unavailable |
| deepseek-reasoner | typescript-error | not tested | calls 0; no mutation; malformed no; baseline no | 0 lines; no changed files; unrelated no | fail | n/a | 0 | unavailable: network-error | not tested: unavailable |
| deepseek-reasoner | test-fix | not tested | calls 0; no mutation; malformed no; baseline no | 0 lines; no changed files; unrelated no | fail | n/a | 0 | unavailable: network-error | not tested: unavailable |
| deepseek-reasoner | review-before-commit | not tested | calls 0; no mutation; malformed no; baseline no | 0 lines; no changed files; unrelated no | fail | not-called | 0 | unavailable: network-error | not tested: unavailable |
| qwen3-coder | small-edit | pass | calls 7; first mutating apply_patch; malformed no; baseline yes | 2 lines; README.md; unrelated no | pass | not-required | 7 |  | candidate |
| qwen3-coder | bugfix | fail | calls 0; no mutation; malformed yes; baseline no | 2 lines; calc.mjs; unrelated no | pass | not-called | 0 | non-zero exit | do not use for this recipe yet |
| qwen3-coder | typescript-error | pass | calls 8; first mutating apply_patch; malformed no; baseline yes | 2 lines; src/value.ts; unrelated no | pass | not-required | 8 |  | candidate |
| qwen3-coder | test-fix | pass | calls 8; first mutating apply_patch; malformed no; baseline yes | 2 lines; math.mjs; unrelated no | pass | not-required | 8 |  | candidate |
| qwen3-coder | review-before-commit | pass | calls 4; no mutation; malformed no; baseline no | 0 lines; no changed files; unrelated no | pass | pass | 4 |  | candidate |
| kimi-k2.7-code | small-edit | pass | calls 4; first mutating apply_patch; malformed no; baseline yes | 1 lines; README.md; unrelated no | pass | not-required | 3 |  | candidate |
| kimi-k2.7-code | bugfix | pass | calls 6; first mutating apply_patch; malformed no; baseline yes | 1 lines; calc.mjs; unrelated no | pass | pass | 4 |  | candidate |
| kimi-k2.7-code | typescript-error | pass | calls 4; first mutating apply_patch; malformed no; baseline yes | 1 lines; src/value.ts; unrelated no | pass | not-required | 3 |  | candidate |
| kimi-k2.7-code | test-fix | pass | calls 6; first mutating apply_patch; malformed no; baseline yes | 1 lines; math.mjs; unrelated no | pass | not-required | 5 |  | candidate |
| kimi-k2.7-code | review-before-commit | pass | calls 5; no mutation; malformed no; baseline no | 0 lines; no changed files; unrelated no | pass | pass | 3 |  | candidate |
| z-ai/glm-4.6 | small-edit | pass | calls 4; first mutating apply_patch; malformed no; baseline yes | 1 lines; README.md; unrelated no | pass | not-required | 4 |  | candidate |
| z-ai/glm-4.6 | bugfix | fail | calls 0; no mutation; malformed yes; baseline no | 0 lines; no changed files; unrelated no | fail | not-called | 0 | non-zero exit | do not use for this recipe yet |
| z-ai/glm-4.6 | typescript-error | fail | calls 0; no mutation; malformed no; baseline no | 0 lines; no changed files; unrelated no | fail | not-required | 0 | verify failed after run | do not use for this recipe yet |
| z-ai/glm-4.6 | test-fix | fail | calls 0; no mutation; malformed no; baseline no | 0 lines; no changed files; unrelated no | fail | not-required | 0 | verify failed after run | do not use for this recipe yet |
| z-ai/glm-4.6 | review-before-commit | fail | calls 0; no mutation; malformed yes; baseline no | 0 lines; no changed files; unrelated no | pass | not-called | 0 | non-zero exit | do not use for this recipe yet |
| minimax-m1 | small-edit | not tested | calls 0; no mutation; malformed no; baseline no | 0 lines; no changed files; unrelated no | fail | n/a | 0 | unavailable: 400 | not tested: unavailable |
| minimax-m1 | bugfix | not tested | calls 0; no mutation; malformed no; baseline no | 0 lines; no changed files; unrelated no | fail | not-called | 0 | unavailable: 400 | not tested: unavailable |
| minimax-m1 | typescript-error | not tested | calls 0; no mutation; malformed no; baseline no | 0 lines; no changed files; unrelated no | fail | n/a | 0 | unavailable: 400 | not tested: unavailable |
| minimax-m1 | test-fix | not tested | calls 0; no mutation; malformed no; baseline no | 0 lines; no changed files; unrelated no | fail | n/a | 0 | unavailable: 400 | not tested: unavailable |
| minimax-m1 | review-before-commit | not tested | calls 0; no mutation; malformed no; baseline no | 0 lines; no changed files; unrelated no | fail | not-called | 0 | unavailable: 400 | not tested: unavailable |
| verstak/coder | small-edit | pass | calls 4; first mutating apply_patch; malformed no; baseline yes | 1 lines; README.md; unrelated no | pass | not-required | 4 |  | candidate |
| verstak/coder | bugfix | fail | calls 0; no mutation; malformed yes; baseline no | 2 lines; calc.mjs; unrelated no | pass | not-called | 0 | non-zero exit | do not use for this recipe yet |
| verstak/coder | typescript-error | pass | calls 7; first mutating apply_patch; malformed no; baseline yes | 1 lines; src/value.ts; unrelated no | pass | not-required | 7 |  | candidate |
| verstak/coder | test-fix | pass | calls 8; first mutating apply_patch; malformed no; baseline yes | 2 lines; math.mjs; unrelated no | pass | not-required | 8 |  | candidate |
| verstak/coder | review-before-commit | pass | calls 4; no mutation; malformed no; baseline no | 0 lines; no changed files; unrelated no | pass | pass | 4 |  | candidate |
| verstak/coder/fast | small-edit | fail | calls 7; first mutating apply_patch; malformed no; baseline yes | 0 lines; no changed files; unrelated no | fail | not-required | 7 | verify failed after run | do not use for this recipe yet |
| verstak/coder/fast | bugfix | fail | calls 0; no mutation; malformed yes; baseline no | 2 lines; calc.mjs; unrelated no | pass | not-called | 0 | non-zero exit | do not use for this recipe yet |
| verstak/coder/fast | typescript-error | fail | calls 8; first mutating apply_patch; malformed no; baseline yes | 0 lines; no changed files; unrelated no | fail | not-required | 8 | verify failed after run | do not use for this recipe yet |
| verstak/coder/fast | test-fix | fail | calls 9; first mutating apply_patch; malformed no; baseline yes | 0 lines; no changed files; unrelated no | fail | not-required | 8 | verify failed after run | do not use for this recipe yet |
| verstak/coder/fast | review-before-commit | pass | calls 3; no mutation; malformed no; baseline no | 0 lines; no changed files; unrelated no | pass | pass | 2 |  | candidate |
| verstak/coder/balanced | small-edit | fail | calls 4; first mutating apply_patch; malformed no; baseline yes | 0 lines; no changed files; unrelated no | fail | not-required | 4 | verify failed after run | do not use for this recipe yet |
| verstak/coder/balanced | bugfix | pass | calls 7; first mutating apply_patch; malformed no; baseline yes | 2 lines; calc.mjs; unrelated no | pass | pass | 7 |  | candidate |
| verstak/coder/balanced | typescript-error | pass | calls 5; first mutating apply_patch; malformed no; baseline yes | 1 lines; src/value.ts; unrelated no | pass | not-required | 5 |  | candidate |
| verstak/coder/balanced | test-fix | pass | calls 8; first mutating apply_patch; malformed no; baseline yes | 2 lines; math.mjs; unrelated no | pass | not-required | 6 |  | candidate |
| verstak/coder/balanced | review-before-commit | pass | calls 3; no mutation; malformed no; baseline no | 0 lines; no changed files; unrelated no | pass | pass | 2 |  | candidate |

## Blocking Runtime Bugs

- None found in the headless recipe runner or gateway path.
- Eval harness bug found and fixed during this run: Windows paths with Cyrillic segments must use `fileURLToPath(import.meta.url)`, not manual URL pathname parsing.

## Raw Summary

- deepseek-chat / small-edit: result=pass, exit=0, selected=deepseek-chat, duration=16s, secretLeak=no
- deepseek-chat / bugfix: result=pass, exit=0, selected=deepseek-chat, duration=23s, secretLeak=no
- deepseek-chat / typescript-error: result=pass, exit=0, selected=deepseek-chat, duration=18s, secretLeak=no
- deepseek-chat / test-fix: result=pass, exit=0, selected=deepseek-chat, duration=19s, secretLeak=no
- deepseek-chat / review-before-commit: result=fail, exit=1, selected=deepseek-chat, duration=18s, secretLeak=no
- deepseek-reasoner / small-edit: result=not tested, exit=1, selected=deepseek-reasoner, duration=0s, secretLeak=no
- deepseek-reasoner / bugfix: result=not tested, exit=1, selected=deepseek-reasoner, duration=0s, secretLeak=no
- deepseek-reasoner / typescript-error: result=not tested, exit=1, selected=deepseek-reasoner, duration=0s, secretLeak=no
- deepseek-reasoner / test-fix: result=not tested, exit=1, selected=deepseek-reasoner, duration=0s, secretLeak=no
- deepseek-reasoner / review-before-commit: result=not tested, exit=1, selected=deepseek-reasoner, duration=0s, secretLeak=no
- qwen3-coder / small-edit: result=pass, exit=0, selected=qwen3-coder, duration=21s, secretLeak=no
- qwen3-coder / bugfix: result=fail, exit=1, selected=qwen3-coder, duration=28s, secretLeak=no
- qwen3-coder / typescript-error: result=pass, exit=0, selected=qwen3-coder, duration=22s, secretLeak=no
- qwen3-coder / test-fix: result=pass, exit=0, selected=qwen3-coder, duration=20s, secretLeak=no
- qwen3-coder / review-before-commit: result=pass, exit=0, selected=qwen3-coder, duration=20s, secretLeak=no
- kimi-k2.7-code / small-edit: result=pass, exit=0, selected=moonshotai-kimi-k2, duration=13s, secretLeak=no
- kimi-k2.7-code / bugfix: result=pass, exit=0, selected=moonshotai-kimi-k2, duration=30s, secretLeak=no
- kimi-k2.7-code / typescript-error: result=pass, exit=0, selected=moonshotai-kimi-k2, duration=14s, secretLeak=no
- kimi-k2.7-code / test-fix: result=pass, exit=0, selected=moonshotai-kimi-k2, duration=19s, secretLeak=no
- kimi-k2.7-code / review-before-commit: result=pass, exit=0, selected=moonshotai-kimi-k2, duration=22s, secretLeak=no
- z-ai/glm-4.6 / small-edit: result=pass, exit=0, selected=glm-4.6, duration=21s, secretLeak=no
- z-ai/glm-4.6 / bugfix: result=fail, exit=1, selected=glm-4.6, duration=50s, secretLeak=no
- z-ai/glm-4.6 / typescript-error: result=fail, exit=0, selected=glm-4.6, duration=6s, secretLeak=no
- z-ai/glm-4.6 / test-fix: result=fail, exit=0, selected=glm-4.6, duration=6s, secretLeak=no
- z-ai/glm-4.6 / review-before-commit: result=fail, exit=1, selected=glm-4.6, duration=11s, secretLeak=no
- minimax-m1 / small-edit: result=not tested, exit=1, selected=minimax-m1, duration=0s, secretLeak=no
- minimax-m1 / bugfix: result=not tested, exit=1, selected=minimax-m1, duration=0s, secretLeak=no
- minimax-m1 / typescript-error: result=not tested, exit=1, selected=minimax-m1, duration=0s, secretLeak=no
- minimax-m1 / test-fix: result=not tested, exit=1, selected=minimax-m1, duration=0s, secretLeak=no
- minimax-m1 / review-before-commit: result=not tested, exit=1, selected=minimax-m1, duration=0s, secretLeak=no
- verstak/coder / small-edit: result=pass, exit=0, selected=verstak/coder, duration=16s, secretLeak=no
- verstak/coder / bugfix: result=fail, exit=1, selected=verstak/coder, duration=30s, secretLeak=no
- verstak/coder / typescript-error: result=pass, exit=0, selected=verstak/coder, duration=22s, secretLeak=no
- verstak/coder / test-fix: result=pass, exit=0, selected=verstak/coder, duration=21s, secretLeak=no
- verstak/coder / review-before-commit: result=pass, exit=0, selected=verstak/coder, duration=22s, secretLeak=no
- verstak/coder/fast / small-edit: result=fail, exit=0, selected=verstak/fast, duration=12s, secretLeak=no
- verstak/coder/fast / bugfix: result=fail, exit=1, selected=verstak/fast, duration=21s, secretLeak=no
- verstak/coder/fast / typescript-error: result=fail, exit=0, selected=verstak/fast, duration=16s, secretLeak=no
- verstak/coder/fast / test-fix: result=fail, exit=0, selected=verstak/fast, duration=15s, secretLeak=no
- verstak/coder/fast / review-before-commit: result=pass, exit=0, selected=verstak/fast, duration=10s, secretLeak=no
- verstak/coder/balanced / small-edit: result=fail, exit=0, selected=verstak/balanced, duration=36s, secretLeak=no
- verstak/coder/balanced / bugfix: result=pass, exit=0, selected=verstak/balanced, duration=55s, secretLeak=no
- verstak/coder/balanced / typescript-error: result=pass, exit=0, selected=verstak/balanced, duration=30s, secretLeak=no
- verstak/coder/balanced / test-fix: result=pass, exit=0, selected=verstak/balanced, duration=35s, secretLeak=no
- verstak/coder/balanced / review-before-commit: result=pass, exit=0, selected=verstak/balanced, duration=22s, secretLeak=no
