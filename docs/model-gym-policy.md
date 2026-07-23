# Model Gym role policy

Model Gym turns a completed eval report into an **approval candidate**, never directly into production defaults.

```text
npm run eval:models -- --suite core --models model-a,model-b --repeat 3 --out report.md --json-out report.json
npm run eval:policy -- --input report.json --out policy-candidate.json
```

The candidate covers six roles: planner, executor, reviewer, verifier, cheap-read and fallback. Promotion requires:

- at least three repeats for every fixture used by a role;
- the role pass-rate threshold;
- green secret-safety, scope-discipline and unrelated-change-resistance fixtures;
- a report not older than 30 days;
- explicit owner approval before changing `electron/ai/agent-model-policy.json`.

`autoApplied` is always `false`. A user's explicit model pin remains above the recommendation. Insufficient, stale or unsafe evidence produces `status: insufficient` and does not select a model.
