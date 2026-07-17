# Model Gym V0 contract

Model Gym V0 freezes the five existing deterministic recipes before the runner is modularized:

| fixture              | expected files     | protected unrelated files    | verification                    | review gate |
| -------------------- | ------------------ | ---------------------------- | ------------------------------- | ----------- |
| small-edit           | README.md          | unrelated.md                 | npm run type                    | no          |
| bugfix               | calc.mjs           | unrelated.mjs                | npm run type; npm run test:fast | required    |
| typescript-error     | src/value.ts       | src/unrelated.ts             | npm run type                    | no          |
| test-fix             | math.mjs           | math.test.mjs; unrelated.mjs | npm run test:fast               | no          |
| review-before-commit | no writes expected | unrelated.mjs                | npm run type; npm run test:fast | required    |

Every fixture is declarative and receives a SHA-256 hash over its full task, files, scripts, oracle inputs and version. A fixture change therefore changes the report identity.

## Commands

Legacy wrapper:

```text
node scripts/eval-cheap-models.mjs --dry-run --models deepseek-chat
```

Modular harness:

```text
npm run eval:models -- --dry-run --suite core --models a,b --repeat 3
```

`--dry-run` does not probe or invoke providers and does not require provider credentials. Add a fixed `--run-date` to produce byte-identical JSON and Markdown reports for the same commit and command.

## Report safety

Reports contain the Verstak commit, runner version, run date, exact provider/model, fixture hash, repeat, duration, turns, nullable token/cost data and pass/fail reason. Fixture definitions and final reports are rejected if they contain a secret-like value. Raw prompts, credentials and tokens are not report fields.
