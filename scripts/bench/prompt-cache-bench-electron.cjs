// Electron-раннер замера prompt-кэша (см. prompt-cache-bench.mjs — там весь
// контракт). Здесь только то, что требует Electron: safeStorage-расшифровка
// ключей (DPAPI) и сами сетевые прогоны. Значения секретов живут ТОЛЬКО в
// памяти этого процесса — в result.json и stdout не попадают.
const { app, safeStorage } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { pathToFileURL } = require('node:url')

const config = JSON.parse(readFileSync(process.env.VERSTAK_CACHE_BENCH_CONFIG, 'utf8'))

// userData с копией Local State приложения — тот же os_crypt-ключ без
// конкуренции за живой профиль. Ставится ДО ready.
app.setPath('userData', config.userDataDir)
app.disableHardwareAcceleration()

// Фолбэк обязан оставлять след (§3.1): молчаливый base64-фолбэк при сломанной
// DPAPI-расшифровке выглядел бы как «ключ неверный» у провайдера. Возвращаем
// и значение, и метод; форму (не значение!) ключа логируем в отчёт.
function decrypt(b64) {
  const buf = Buffer.from(b64, 'base64')
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return { value: safeStorage.decryptString(buf), method: 'safeStorage' }
    }
    return { value: buf.toString('utf-8'), method: 'plain-b64 (encryption unavailable)' }
  } catch (err) {
    return { value: buf.toString('utf-8'), method: `plain-b64 (decrypt failed: ${err instanceof Error ? err.message : err})` }
  }
}

/** Форма секрета для диагностики — БЕЗ значения. */
function keyShape(s) {
  return {
    length: s.length,
    printable: /^[\x20-\x7E]*$/.test(s),
    prefix: s.slice(0, 3).replace(/[^\x20-\x7E]/g, '?'),
  }
}

/** Первая точка расхождения двух строк + фрагменты вокруг (диагноз кэш-мисса). */
function firstDivergence(a, b) {
  if (a === b) return null
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  const ctx = s => s.slice(Math.max(0, i - 60), i + 120)
  return { offset: i, prevLen: a.length, curLen: b.length, prevSnippet: ctx(a), curSnippet: ctx(b) }
}

async function runProvider(mod, spec, secrets, flags) {
  const { projectPath, turns, dry } = config
  const descriptor = mod.PROVIDERS[spec.id]
  const intensity = mod.intensityConfig(mod.parseIntensity(flags.intensity))

  // Набор инструментов — как runner-api.ts:954-978 (стабилен в пределах чата).
  let toolDefs = mod.selectAllowedToolDefs(mod.TOOL_DEFS, [], undefined)
  if (flags.ptc_enabled !== 'true') toolDefs = toolDefs.filter(t => t.name !== 'execute_code')
  if (flags.web_access !== 'true') toolDefs = toolDefs.filter(t => t.name !== 'web_fetch' && t.name !== 'web_search')
  if (flags.orchestrator_default === 'false') toolDefs = toolDefs.filter(t => t.name !== 'spawn_task_session')

  const model = spec.id === 'custom-openai'
    ? (secrets.customModels?.[0] ?? descriptor.defaultModel)
    : descriptor.defaultModel

  const out = {
    id: spec.id, model,
    toolCount: toolDefs.length,
    toolMode: mod.resolveToolMode(spec.id, model, undefined),
    turns: [],
    systemDiagnostics: [],
  }

  const history = []
  const systems = []
  let frozenSystem = null
  for (let i = 0; i < turns.length; i++) {
    history.push({ role: 'user', content: turns[i] })
    // Сборка system — тот же путь, что assembleSendSystem (API-ветка):
    // prepareSystemContext + интенсивность + systemForProvider. Упрощения
    // (memories=[], brainContext=null) объявлены в шапке оркестратора.
    const composed = await mod.prepareSystemContext({
      projectPath,
      messages: history,
      recentWrites: [],
      projectSystemPrompt: secrets.projectSystemPrompt ?? null,
      memories: [],
      coreMemory: mod.loadCoreMemory(projectPath),
      agentMode: 'ask',
      brainContext: null,
      outputStyle: flags.output_style ?? null,
    })
    let composedSystem = composed.system + '\n\n' + intensity.systemHint
    if (config.freezeSystem) {
      if (frozenSystem == null) frozenSystem = composedSystem
      composedSystem = frozenSystem
    }
    systems.push(composedSystem)
    const messages = [
      { role: 'system', content: mod.systemForProvider(composedSystem, spec.id) },
      ...history,
    ]
    if (out.toolMode === 'json') {
      messages.splice(1, 0, { role: 'system', content: mod.JSON_TOOL_INSTRUCTION })
    }

    const turnRec = { turn: i + 1, systemChars: composedSystem.length, error: null, textChars: 0, ms: 0 }
    if (dry) { out.turns.push(turnRec); history.push({ role: 'assistant', content: '(dry)' }); continue }

    const provider = mod.createProvider(spec.id, {
      apiKey: secrets.apiKey,
      model,
      customBaseUrl: secrets.customBaseUrl,
      customModels: secrets.customModels,
      effortLevel: intensity.effortLevel,
    })
    const t0 = Date.now()
    let text = ''
    try {
      const signal = AbortSignal.timeout(180000)
      for await (const ev of provider.send(messages, toolDefs, undefined, signal)) {
        if (ev.type === 'text') text += ev.text
        else if (ev.type === 'usage') {
          turnRec.inputTokens = ev.usage.inputTokens ?? null
          turnRec.outputTokens = ev.usage.outputTokens ?? null
          turnRec.cacheReadTokens = ev.usage.cacheReadTokens ?? null
          turnRec.cacheWriteTokens = ev.usage.cacheWriteTokens ?? null
          turnRec.inputAccounting = ev.usage.inputAccounting ?? null
        } else if (ev.type === 'error') turnRec.error = ev.message
        else if (ev.type === 'done') break
      }
    } catch (err) {
      turnRec.error = err instanceof Error ? err.message : String(err)
    }
    turnRec.ms = Date.now() - t0
    turnRec.textChars = text.length
    out.turns.push(turnRec)
    history.push({ role: 'assistant', content: text || '(пусто)' })
  }

  // Диагностика: где system-строка разошлась между соседними ходами.
  const bp = mod.CACHE_BREAKPOINT
  for (let i = 1; i < systems.length; i++) {
    const prevStable = systems[i - 1].split(bp)[0]
    const curStable = systems[i].split(bp)[0]
    out.systemDiagnostics.push({
      pair: `ход${i}→ход${i + 1}`,
      stablePrefixIdentical: prevStable === curStable,
      stablePrefixChars: curStable.length,
      divergence: firstDivergence(systems[i - 1], systems[i]),
    })
  }
  return out
}

async function main() {
  await app.whenReady()
  const result = { project: config.projectPath, dry: config.dry, startedAt: new Date().toISOString(), providers: [] }
  result.encryptionAvailable = safeStorage.isEncryptionAvailable()
  const flags = {}
  for (const k of ['ptc_enabled', 'web_access', 'orchestrator_default', 'intensity', 'output_style']) {
    flags[k] = config.encrypted[k] ? decrypt(config.encrypted[k]).value : null
  }
  const projectSystemPrompt = config.encrypted[`system_prompt_${config.projectPath}`]
    ? decrypt(config.encrypted[`system_prompt_${config.projectPath}`]).value : null

  const mod = await import(pathToFileURL(config.bundlePath).href)
  for (const spec of config.providers) {
    const key = decrypt(config.encrypted[spec.secretKey])
    // customBaseUrl/customModels — ТОЛЬКО для custom-openai (как ipc/ai.ts).
    // createExtraProvider трактует customBaseUrl как override для ЛЮБОГО
    // extra-провайдера — передача его всем уводила deepseek/kimi/zai на чужой
    // endpoint (одинаковый 401 у трёх разных сервисов и был этим следом).
    const isCustom = spec.id === 'custom-openai'
    const secrets = {
      apiKey: key.value,
      customBaseUrl: isCustom && config.encrypted.custom_openai_baseurl ? decrypt(config.encrypted.custom_openai_baseurl).value : undefined,
      customModels: isCustom && config.encrypted.custom_openai_models
        ? decrypt(config.encrypted.custom_openai_models).value.split(',').map(s => s.trim()).filter(Boolean)
        : undefined,
      projectSystemPrompt,
    }
    console.log(`[cache-bench] ${spec.id}: старт (3 хода)`)
    try {
      const rec = await runProvider(mod, spec, secrets, flags)
      rec.keyDecrypt = { method: key.method, ...keyShape(key.value) }
      result.providers.push(rec)
    } catch (err) {
      result.providers.push({ id: spec.id, fatal: err instanceof Error ? err.message : String(err) })
    }
  }
  // Флаги в отчёт — без секретов (это runtime-режимы, не ключи).
  result.flags = flags
  writeFileSync(config.resultPath, JSON.stringify(result, null, 2), 'utf8')
  app.exit(0)
}

main().catch(err => {
  console.error(err)
  app.exit(1)
})
