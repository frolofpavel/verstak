#!/usr/bin/env node

// Legacy Stage 11 entry point. Keep old commands working while Model Gym uses scripts/eval/index.mjs.
import { runCli } from './eval/index.mjs'

await runCli(process.argv.slice(2))
