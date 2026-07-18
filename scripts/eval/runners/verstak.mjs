import { spawnSync } from 'node:child_process'
import { request as httpsRequest } from 'node:https'
import { cleanGitEnvironment, redactSecrets } from '../contracts.mjs'

export function runVerstakCli({ root, repoRoot, cliPath, fixture, model, maxTurns }) {
  return spawnSync(
    process.execPath,
    [
      cliPath,
      'recipe',
      'run',
      '--provider',
      'verstak-gateway',
      '--model',
      model,
      '--recipe',
      fixture.recipe,
      '--workspace',
      root,
      '--task',
      fixture.task,
      '--json',
      '--trace-json',
      '--max-turns',
      String(maxTurns),
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 420_000,
      maxBuffer: 16 * 1024 * 1024,
      env: cleanGitEnvironment(),
    },
  )
}

export async function resolveModel(spec, args, apiKey) {
  if (args.dryRun || args.skipProbe) {
    return {
      ...spec,
      selected: spec.aliases[0],
      probe: { ok: true, status: args.dryRun ? 'dry-run' : 'skipped', alias: spec.aliases[0] },
    }
  }

  const probes = []
  for (const alias of spec.aliases) {
    const probe = await probeAlias(alias, apiKey, args.baseUrl)
    probes.push(probe)
    if (probe.ok) return { ...spec, selected: alias, probe, probes }
  }
  return {
    ...spec,
    selected: spec.aliases[0],
    probe: probes.at(-1) ?? { ok: false, status: 'not-probed', alias: spec.aliases[0] },
    probes,
  }
}

export function publicProbe(probe) {
  return {
    ok: Boolean(probe?.ok),
    status: String(probe?.status ?? 'unknown'),
    alias: String(probe?.alias ?? ''),
  }
}

export function extractUsage(parsed) {
  const sources = [parsed?.usage, parsed?.trace?.usage, parsed?.response?.usage, parsed?.result?.usage].filter(
    source => source && typeof source === 'object',
  )
  const source = sources[0] ?? {}
  const input = firstNumber(source.inputTokens, source.input_tokens, source.prompt_tokens, source.promptTokens)
  const output = firstNumber(
    source.outputTokens,
    source.output_tokens,
    source.completion_tokens,
    source.completionTokens,
  )
  const total = firstNumber(
    source.totalTokens,
    source.total_tokens,
    input !== null && output !== null ? input + output : null,
  )
  const estimatedCost = firstNumber(
    parsed?.estimatedCost,
    parsed?.approximateCost,
    parsed?.costUSD,
    parsed?.cost_usd,
    parsed?.trace?.estimatedCost,
    source.costUSD,
    source.cost_usd,
  )
  return {
    tokens: { input, output, total },
    estimatedCost,
  }
}

function probeAlias(alias, apiKey, baseUrl) {
  if (!apiKey) return Promise.resolve({ ok: false, status: 'missing-key', alias })
  const url = new URL(baseUrl.replace(/\/$/, '') + '/chat/completions')
  const payload = JSON.stringify({
    model: alias,
    messages: [{ role: 'user', content: 'Return exactly: ok' }],
    max_tokens: 8,
    stream: false,
  })

  return new Promise(resolveProbe => {
    const request = httpsRequest(
      url,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
        timeout: 45_000,
      },
      response => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', chunk => {
          body += chunk
        })
        response.on('end', () => {
          resolveProbe({
            ok: Number(response.statusCode) >= 200 && Number(response.statusCode) < 300,
            status: String(response.statusCode ?? 'unknown'),
            alias,
            message: redactSecrets(body.slice(0, 500), [apiKey]),
          })
        })
      },
    )
    request.on('timeout', () => request.destroy(new Error('timeout')))
    request.on('error', error => {
      resolveProbe({ ok: false, status: 'network-error', alias, message: redactSecrets(error.message, [apiKey]) })
    })
    request.write(payload)
    request.end()
  })
}

function firstNumber(...values) {
  for (const value of values) {
    const number = Number(value)
    if (value !== null && value !== undefined && Number.isFinite(number)) return number
  }
  return null
}
