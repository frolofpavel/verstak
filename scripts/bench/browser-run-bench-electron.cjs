// Electron-раннер прогонного замера (контракт — в browser-run-bench.mjs).
// Здесь живут три вещи, которых нет в чистом Node: расшифровка ключей провайдеров
// (safeStorage/DPAPI), настоящий Chromium со страницей и настоящий агентный цикл
// поверх browser_*-инструментов.
//
// Значения ключей НЕ печатаются и НЕ пишутся в отчёт (как prompt-cache-bench).
const { app, safeStorage, BrowserWindow } = require('electron')
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs')
const { pathToFileURL } = require('node:url')

const config = JSON.parse(readFileSync(process.env.VERSTAK_RUN_BENCH_CONFIG, 'utf8'))
app.setPath('userData', config.userDataDir)
app.disableHardwareAcceleration()

const snap = require(config.snapshotBundlePath)

/** Прогресс построчно в файл: stdout дочернего процесса виден только после выхода,
 *  и без этого живой прогон снаружи неотличим от зависшего. */
function progress(line) {
  const s = `${new Date().toISOString()} ${line}\n`
  process.stdout.write(s)
  try { if (config.progressPath) appendFileSync(config.progressPath, s, 'utf8') } catch { /* лог не критичен */ }
}

function decrypt(b64) {
  const buf = Buffer.from(b64, 'base64')
  try {
    if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(buf)
    return buf.toString('utf-8')
  } catch { return buf.toString('utf-8') }
}

const estimateTokens = (text) => Math.ceil(text.length / 4)

/**
 * Потолок на каждый вызов браузера — тот же урок, что в page-bench, и здесь он
 * стоил повторного зависания: `loadURL` ждёт did-finish-load, а поиск Хабра его не
 * даёт никогда.
 *
 * ЭТО ЖЕ МЕСТО ЕСТЬ В ПРОДУКТЕ. `window.verstakBrowser.navigate` (BrowserView.tsx)
 * делает `await wv.loadURL(target)` без потолка, и на такой странице ход агента
 * повисает до отмены человеком. Здесь чиню только измеритель — правка продукта
 * выходит за границы куска и записана находкой в отчёт.
 */
function withTimeout(promise, ms, label) {
  let timer = null
  const guard = new Promise((_res, rej) => { timer = setTimeout(() => rej(new Error(`таймаут ${ms} мс: ${label}`)), ms) })
  return Promise.race([promise, guard]).finally(() => { if (timer) clearTimeout(timer) })
}

// ── Браузерный API: та же семантика, что window.verstakBrowser в BrowserView.tsx ──
// Инжектируемые функции — ТЕ ЖЕ (shared/browser-snapshot.ts через .toString()).
// ОТЛИЧИЕ, объявленное честно: здесь страница живёт в BrowserWindow, а не в <webview>
// внутри окна приложения, и вызовы идут напрямую, а не через IPC tool-handler. Форма
// результата собирается такой же, как в electron/ipc/tool-handlers/browser.ts, потому
// что мерится именно она — то, что уходит модели.
function makeBrowserApi(win) {
  const wc = () => win.webContents
  const js = (code) => withTimeout(wc().executeJavaScript(code), 30000, 'вызов в странице')
  return {
    getURL: () => { try { return wc().getURL() } catch { return null } },
    getTitle: () => { try { return wc().getTitle() } catch { return null } },
    async navigate(url) {
      const target = /^https?:\/\//i.test(url) ? url : `https://${url}`
      try {
        await withTimeout(wc().loadURL(target), 30000, `загрузка ${target}`)
        return { ok: true, url: this.getURL() }
      } catch (e) {
        // Незавершённая загрузка ≠ пустая страница: DOM уже есть, дальше агент
        // работает по нему. Возвращаем ok с пометкой — молчать о причине нельзя.
        try { wc().stop() } catch { /* уже остановлен */ }
        const here = this.getURL()
        if (here && here !== 'about:blank') return { ok: true, url: here, note: 'загрузка не завершилась за 30 с, работаем по тому, что отрисовано' }
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
    async readPage(selector) {
      const code = selector
        ? `(document.querySelector(${JSON.stringify(selector)})?.innerText) || ''`
        : `(document.body?.innerText || '').slice(0, 50000)`
      try { const r = await js(code); return typeof r === 'string' ? r : '' } catch { return '' }
    },
    async snapshot() {
      const gen = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
      const code = `(() => {
        const snapshot = ${snap.vskSnapshot.toString()};
        const cap = ${snap.vskCapSnapshot.toString()};
        return cap(snapshot(${JSON.stringify(gen)}), ${config.topN});
      })()`
      try { return await js(code) } catch (e) { return { error: e instanceof Error ? e.message : String(e) } }
    },
    async find(query, limit) {
      const gen = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
      const lim = Math.min(Math.max(1, limit ?? 30), 100)
      const code = `(() => {
        const snapshot = ${snap.vskSnapshot.toString()};
        const find = ${snap.vskFind.toString()};
        return find(snapshot(${JSON.stringify(gen)}), ${JSON.stringify(query)}, ${lim});
      })()`
      try { return await js(code) } catch (e) { return { error: e instanceof Error ? e.message : String(e) } }
    },
    async clickByNumber(n) {
      const code = `(() => {
        const resolve = ${snap.vskResolveNumbered.toString()};
        const r = resolve(${JSON.stringify(n)});
        if (!r.ok) return r;
        try { r.el.scrollIntoView({ block: 'center' }); } catch (e) {}
        if (typeof r.el.click === 'function') r.el.click();
        else r.el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return { ok: true, url: location.href };
      })()`
      try { return await js(code) } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
    },
    async typeByNumber(n, text) {
      const code = `(() => {
        const resolve = ${snap.vskResolveNumbered.toString()};
        const fill = ${snap.vskFill.toString()};
        const r = resolve(${JSON.stringify(n)});
        if (!r.ok) return r;
        const f = fill(r.el, ${JSON.stringify(text)});
        if (!f.ok) return f;
        return { ok: true, url: location.href };
      })()`
      try { return await js(code) } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
    },
    async pressKey(key, n) {
      const target = n != null
        ? `(() => { const r = resolve(${JSON.stringify(n)}); return r.ok ? r.el : r; })()`
        : `(document.activeElement && document.activeElement !== document.body ? document.activeElement : null)`
      const code = `(() => {
        const resolve = ${snap.vskResolveNumbered.toString()};
        const press = ${snap.vskPressKey.toString()};
        const t = ${target};
        if (!t) return { ok: false, error: 'Нет поля в фокусе: сначала введи текст (browser_type_by_number) или укажи номер поля.' };
        if (t.ok === false) return t;
        const r = press(t, ${JSON.stringify(key)});
        if (!r.ok) return r;
        return { ok: true, submitted: r.submitted, url: location.href };
      })()`
      try { return await js(code) } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
    },
    async waitFor(query, timeoutMs) {
      const budget = Math.min(Math.max(500, timeoutMs ?? 10000), 30000)
      const started = Date.now()
      const check = `(${snap.vskMatchTarget.toString()})(${JSON.stringify(query)})`
      while (Date.now() - started < budget) {
        try { if (await js(check) === true) return { ok: true } } catch { /* между переходами */ }
        await new Promise(r => setTimeout(r, 200))
      }
      return { ok: false, error: `Элемент «${query}» не появился за ${Math.round(budget / 1000)} с.` }
    },
  }
}

/** Исполнение одного вызова — форма результата как в tool-handlers/browser.ts. */
async function execTool(api, call) {
  const a = call.args ?? {}
  switch (call.name) {
    case 'browser_navigate': return await api.navigate(String(a.url ?? ''))
    case 'browser_read_page': {
      const text = await api.readPage(a.selector ? String(a.selector) : undefined)
      return { url: api.getURL(), title: api.getTitle(), text }
    }
    case 'browser_snapshot': {
      const s = await api.snapshot()
      return { url: api.getURL(), title: api.getTitle(), ...s }
    }
    case 'browser_find': {
      const r = await api.find(String(a.query ?? ''), a.limit != null ? Number(a.limit) : undefined)
      return { url: api.getURL(), title: api.getTitle(), ...r }
    }
    case 'browser_click_by_number': return await api.clickByNumber(Number(a.n))
    case 'browser_type_by_number': return await api.typeByNumber(Number(a.n), String(a.text ?? ''))
    case 'browser_press_key': return await api.pressKey(String(a.key ?? ''), a.n != null ? Number(a.n) : undefined)
    case 'browser_wait_for': return await api.waitFor(String(a.query ?? ''), a.timeout_ms != null ? Number(a.timeout_ms) : undefined)
    default: return { ok: false, error: `Инструмент ${call.name} в этом замере не поднят (браузерный набор ограничен).` }
  }
}

async function runOne(mod, api, spec, secrets, task) {
  const descriptor = mod.PROVIDERS[spec.id]
  const model = spec.model || descriptor.defaultModel
  const allTools = mod.selectAllowedToolDefs(mod.TOOL_DEFS, [], undefined)
  // Инструментальный набор УЖАТ до браузерного + без него замер мерил бы не то:
  // с полным набором дешёвая модель уходит в файлы и команды. Ограничение объявлено
  // в отчёте: это НЕ прод-конфигурация, а изоляция браузерной оси.
  const toolDefs = allTools.filter(t => config.toolNames.includes(t.name))

  const composed = await mod.prepareSystemContext({
    projectPath: config.projectPath,
    messages: [{ role: 'user', content: task.prompt }],
    recentWrites: [], memories: [], coreMemory: mod.loadCoreMemory(config.projectPath),
    agentMode: 'accept-edits', brainContext: null, outputStyle: null, isFirstTurn: true,
  })
  const system = mod.systemForProvider(composed.system, spec.id)

  const provider = mod.createProvider(spec.id, {
    apiKey: secrets.apiKey, model,
    customBaseUrl: secrets.customBaseUrl, customModels: secrets.customModels,
  })

  const history = [{ role: 'user', content: task.prompt }]
  const rec = {
    provider: spec.id, model, task: task.id, url: task.url,
    systemChars: composed.system.length,
    toolDefChars: JSON.stringify(toolDefs).length,
    toolCount: toolDefs.length,
    turns: [], toolUse: {}, finalText: '', stoppedBy: null,
    totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, toolResultChars: 0, ms: 0 },
  }

  await api.navigate(task.url)   // старт задачи — страница уже открыта, как у человека

  for (let turn = 1; turn <= config.maxTurns; turn++) {
    const messages = [{ role: 'system', content: system }, ...history]
    const t0 = Date.now()
    const calls = []
    let text = ''
    const turnRec = { turn: turn, calls: [], error: null }
    try {
      const signal = AbortSignal.timeout(config.turnTimeoutMs)
      for await (const ev of provider.send(messages, toolDefs, undefined, signal)) {
        if (ev.type === 'text') text += ev.text
        else if (ev.type === 'tool-call') calls.push(ev.call)
        else if (ev.type === 'usage') {
          turnRec.inputTokens = ev.usage.inputTokens ?? null
          turnRec.outputTokens = ev.usage.outputTokens ?? null
          turnRec.cacheReadTokens = ev.usage.cacheReadTokens ?? null
          turnRec.inputAccounting = ev.usage.inputAccounting ?? null
        } else if (ev.type === 'error') turnRec.error = ev.message
        else if (ev.type === 'done') break
      }
    } catch (err) {
      turnRec.error = err instanceof Error ? err.message : String(err)
    }
    turnRec.ms = Date.now() - t0
    rec.totals.ms += turnRec.ms
    rec.totals.inputTokens += turnRec.inputTokens ?? 0
    rec.totals.outputTokens += turnRec.outputTokens ?? 0
    rec.totals.cacheReadTokens += turnRec.cacheReadTokens ?? 0

    if (turnRec.error) { rec.turns.push(turnRec); rec.stoppedBy = `ошибка: ${turnRec.error}`; break }
    if (calls.length === 0) {
      rec.turns.push(turnRec)
      rec.finalText = text
      rec.stoppedBy = 'модель перестала звать инструменты'
      break
    }

    progress(`    ход ${turn}: ${calls.map(c => c.name.replace('browser_', '')).join(', ')} (вход ${turnRec.inputTokens ?? '?'} ток, ${Math.round(turnRec.ms / 1000)} с)`)
    const results = []
    for (const call of calls) {
      const tt = Date.now()
      const out = await execTool(api, call)
      const serialized = typeof out === 'string' ? out : JSON.stringify(out ?? '')
      rec.toolUse[call.name] = (rec.toolUse[call.name] ?? 0) + 1
      rec.totals.toolResultChars += serialized.length
      turnRec.calls.push({
        name: call.name,
        args: call.name === 'browser_type_by_number' ? { ...call.args, text: '<текст>' } : call.args,
        resultChars: serialized.length,
        resultTokens: estimateTokens(serialized),
        ms: Date.now() - tt,
      })
      results.push({ id: call.id, name: call.name, result: out })
    }
    history.push({ role: 'assistant', content: text, toolCalls: calls })
    history.push({ role: 'user', content: '', toolResults: results })
    rec.turns.push(turnRec)
    if (turn === config.maxTurns) rec.stoppedBy = `упёрся в потолок ходов (${config.maxTurns})`
  }

  // Итоговое состояние страницы — readback ЗАМЕРА, независимый от слов модели.
  rec.readback = {
    url: api.getURL(),
    title: api.getTitle(),
    pageTextChars: (await api.readPage()).length,
  }
  return rec
}

async function main() {
  await app.whenReady()
  const win = new BrowserWindow({
    show: false, width: 1280, height: 900,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  })
  const api = makeBrowserApi(win)
  const mod = await import(pathToFileURL(config.bundlePath).href)
  const result = { startedAt: new Date().toISOString(), runs: [], maxTurns: config.maxTurns, topN: config.topN }

  for (const spec of config.providers) {
    const secrets = {
      apiKey: decrypt(config.encrypted[spec.secretKey]),
      customBaseUrl: spec.id === 'custom-openai' && config.encrypted.custom_openai_baseurl ? decrypt(config.encrypted.custom_openai_baseurl) : undefined,
      customModels: spec.id === 'custom-openai' && config.encrypted.custom_openai_models
        ? decrypt(config.encrypted.custom_openai_models).split(',').map(s => s.trim()).filter(Boolean) : undefined,
    }
    for (const task of config.tasks) {
      progress(`[run-bench] ${spec.id} × ${task.id}`)
      try {
        result.runs.push(await runOne(mod, api, spec, secrets, task))
      } catch (err) {
        result.runs.push({ provider: spec.id, task: task.id, fatal: err instanceof Error ? err.message : String(err) })
      }
      writeFileSync(config.resultPath, JSON.stringify(result, null, 2), 'utf8')
    }
  }
  result.complete = true
  writeFileSync(config.resultPath, JSON.stringify(result, null, 2), 'utf8')
  app.exit(0)
}

main().catch(err => { console.error(err); app.exit(1) })
