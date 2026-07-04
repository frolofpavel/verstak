# Verstak 1.6.2 Release Notes

Release date: 2026-07-04

## Highlights

- **Recipe Enforcement for cheaper models:** coding recipes now keep small/cheap models on rails: inspect, patch, verify, review, then finish.
- **Auto-baseline:** recipe verification snapshots the pre-existing state before the first mutation, so old failures are not blamed on the current run.
- **Mandatory review gate:** recipes with `reviewer.required` must pass `review_before_commit`; missing the gate fails closed instead of silently reporting success.
- **Fail-closed max-turns:** if max turns are exhausted before the required review gate, the run ends as failed and can be continued with more budget.
- **CLI streaming tool-call parser fix:** streaming tool-call names are assigned instead of appended, fixing `read_fileread_file` style failures seen with DeepSeek/Qwen-like streams.
- **DeepSeek/Qwen/Kimi live proxy validation:** DeepSeek chat/reasoner, Qwen3 coder, Kimi K2, Gemini, GLM, and MiniMax were validated through the live proxy recipe harness; Qwen 2.5 coder via OpenRouter returned 404 and Groq was geo-blocked.

## Known Limitations

- API providers have the full Verstak control layer: tools, verification, timeline, MCP, delegation, and safe crash-resume.
- CLI providers are limited-control: their tools and checks run inside the external CLI, not inside Verstak.
- Headless recipe runner parity is not complete; recipe enforcement is currently GUI/Electron-loop first.
- Reviewer/fixer model override is planned, not part of 1.6.2.

