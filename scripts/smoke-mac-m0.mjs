import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron } from 'playwright-core'

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error(`Mac M0 smoke requires darwin-arm64, got ${process.platform}-${process.arch}`)
}

const releaseDir = resolve('release')
const dmgName = readdirSync(releaseDir).find(name => /-mac-arm64\.dmg$/.test(name))
if (!dmgName) throw new Error('Mac ARM64 DMG не найден')

const tempRoot = mkdtempSync(join(tmpdir(), 'verstak-mac-m0-'))
const mountPoint = join(tempRoot, 'dmg')
const installRoot = join(tempRoot, 'Applications')
const projectPath = join(tempRoot, 'project')
const userDataDir = join(tempRoot, 'user-data')
const installedApp = join(installRoot, 'Verstak.app')
const executable = join(installedApp, 'Contents', 'MacOS', 'Verstak')
const inputFile = join(projectPath, 'canary.txt')
const editedText = 'Verstak Mac M0 edited this file\n'
const memoryText = 'Mac M0 canary memory survived restart.'
const secretValue = 'mac-m0-canary-secret-value'
let mounted = false
let apiCalls = 0

function sseChunk(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function toolResponse(name, args, id) {
  return sseChunk({
    id: `chatcmpl-${id}`,
    object: 'chat.completion.chunk',
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      },
      finish_reason: 'tool_calls',
    }],
  }) + 'data: [DONE]\n\n'
}

function finalResponse() {
  return sseChunk({
    id: 'chatcmpl-final',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'Mac M0 local task complete.' }, finish_reason: 'stop' }],
  }) + sseChunk({
    id: 'chatcmpl-final',
    object: 'chat.completion.chunk',
    choices: [],
    usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
  }) + 'data: [DONE]\n\n'
}

const server = createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404).end()
    return
  }
  let raw = ''
  request.setEncoding('utf8')
  request.on('data', chunk => { raw += chunk })
  request.on('end', () => {
    apiCalls += 1
    const body = JSON.parse(raw)
    const toolResults = Array.isArray(body.messages)
      ? body.messages.filter(message => message.role === 'tool').length
      : 0
    let payload
    if (toolResults === 0) payload = toolResponse('read_file', { path: 'canary.txt' }, 'mac-read')
    else if (toolResults === 1) payload = toolResponse('write_file', { path: 'canary.txt', content: editedText }, 'mac-write')
    else if (toolResults === 2) payload = toolResponse('run_command', { command: "printf 'shell-ok\\n' > shell-result.txt" }, 'mac-shell')
    else payload = finalResponse()
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    response.end(payload)
  })
})

async function listen() {
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Не удалось открыть mock API')
  return `http://127.0.0.1:${address.port}/v1`
}

async function launch() {
  const electronApp = await electron.launch({
    executablePath: executable,
    args: [`--user-data-dir=${userDataDir}`],
    env: { ...process.env, VERSTAK_SMOKE: '1' },
    timeout: 60_000,
  })
  const page = await electronApp.firstWindow({ timeout: 60_000 })
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.api?.projects && window.api?.userProfiles), null, { timeout: 60_000 })
  return { electronApp, page }
}

async function firstRun(page, baseUrl) {
  return page.evaluate(async ({ projectPath, inputFile, baseUrl, editedText, memoryText, secretValue }) => {
    const api = window.api
    const profile = await api.userProfiles.create({
      name: 'Mac M0 Canary',
      role: 'tester',
      defaultProvider: 'custom-openai',
      defaultModel: 'mac-canary',
    })
    await api.userProfiles.setActive(profile.id)
    await api.projects.setCurrent(projectPath)
    await api.settings.setKey('last_project_path', projectPath)
    await api.settings.setKey('custom_openai_baseurl', baseUrl)
    await api.settings.setKey('custom_openai_models', JSON.stringify(['mac-canary']))
    await api.settings.setKey('custom_openai_api_key', secretValue)
    await api.settings.setKey('mac_m0_canary_setting', 'persisted')
    await api.coreMemory.save(projectPath, 'memory', memoryText)

    const initial = await api.files.read(inputFile)
    if (initial !== 'before mac canary\n') throw new Error(`initial read mismatch: ${initial}`)

    const chat = await api.chatSessions.create(projectPath, {
      title: 'Mac M0 Canary',
      providerId: 'custom-openai',
      model: 'mac-canary',
    })
    const prompt = 'Read canary.txt, replace it with the requested Mac text, then run the safe shell command.'
    await api.chats.append(chat.id, projectPath, 'user', prompt)

    let assistantText = ''
    const events = []
    const completion = new Promise((resolveDone, rejectDone) => {
      const timeout = window.setTimeout(() => rejectDone(new Error('AI tool-loop timeout')), 60_000)
      const dispose = api.ai.onEvent(async ({ id, event }) => {
        events.push(event.type)
        if (event.type === 'text') assistantText += event.text
        if (event.type === 'pending-write') await api.ai.resolveWrite(event.callId, true, id)
        if (event.type === 'pending-command') await api.ai.resolveCommand(event.callId, true, id)
        if (event.type === 'error') {
          window.clearTimeout(timeout)
          dispose()
          rejectDone(new Error(event.message))
        }
        if (event.type === 'done') {
          window.clearTimeout(timeout)
          dispose()
          resolveDone(undefined)
        }
      })
    })
    const sendId = await api.ai.sendWithOverrides(
      [{ role: 'user', content: prompt }],
      projectPath,
      { providerId: 'custom-openai', model: 'mac-canary', agentMode: 'auto' },
      String(chat.id),
    )
    if (!sendId) throw new Error('AI send did not start')
    await completion
    await api.chats.append(chat.id, projectPath, 'assistant', assistantText)

    const edited = await api.files.read(inputFile)
    if (edited !== editedText) throw new Error(`edited read mismatch: ${edited}`)

    const terminalOutput = await new Promise(async (resolveTerminal, rejectTerminal) => {
      let output = ''
      const timeout = window.setTimeout(() => rejectTerminal(new Error('terminal timeout')), 20_000)
      const dispose = api.term.onData(({ id, data }) => {
        output += data
        if (!output.includes('terminal-ok')) return
        window.clearTimeout(timeout)
        dispose()
        void api.term.kill(id)
        resolveTerminal(output)
      })
      const id = await api.term.spawn(projectPath)
      if (id < 0) {
        window.clearTimeout(timeout)
        dispose()
        rejectTerminal(new Error('terminal spawn failed'))
        return
      }
      await api.term.write(id, "printf 'terminal-ok\\n'\n")
    })

    return { profileId: profile.id, chatId: chat.id, assistantText, events, terminalOutput }
  }, { projectPath, inputFile, baseUrl, editedText, memoryText, secretValue })
}

async function secondRun(page, first) {
  return page.evaluate(async ({ projectPath, inputFile, editedText, memoryText, first }) => {
    const api = window.api
    await api.projects.setCurrent(projectPath)
    const activeProfile = await api.userProfiles.getActive()
    const projects = await api.projects.list()
    const setting = await api.settings.getKey('mac_m0_canary_setting')
    const lastProject = await api.settings.getKey('last_project_path')
    const memory = await api.coreMemory.load(projectPath)
    const file = await api.files.read(inputFile)
    const sessions = await api.chatSessions.list(projectPath)
    const history = await api.chats.list(first.chatId)
    const browser = await api.browserBridge.getState()
    const computer = await api.computerUse.getState()
    const updater = await api.updater.getState()
    return {
      profilePersisted: activeProfile?.id === first.profileId,
      projectPersisted: projects.some(project => project.path === projectPath) && lastProject === projectPath,
      settingPersisted: setting === 'persisted',
      memoryPersisted: memory.memory === memoryText,
      filePersisted: file === editedText,
      shellPersisted: await api.files.read(`${projectPath}/shell-result.txt`) === 'shell-ok\n',
      historyPersisted: sessions.some(session => session.id === first.chatId)
        && history.some(message => message.role === 'user')
        && history.some(message => message.role === 'assistant' && message.content.includes('Mac M0 local task complete.')),
      browserDisabled: browser.supported === false && browser.ui === 'unsupported',
      computerDisabled: computer.supported === false,
      updaterDisabled: updater.phase === 'error' && updater.error?.includes('Mac M0'),
    }
  }, { projectPath, inputFile, editedText, memoryText, first })
}

let firstApp
let secondApp
try {
  mkdirSync(mountPoint)
  mkdirSync(installRoot)
  mkdirSync(projectPath)
  writeFileSync(inputFile, 'before mac canary\n', 'utf8')
  execFileSync('/usr/bin/hdiutil', ['attach', join(releaseDir, dmgName), '-nobrowse', '-readonly', '-mountpoint', mountPoint], { stdio: 'inherit' })
  mounted = true
  const sourceApp = join(mountPoint, 'Verstak.app')
  if (!existsSync(sourceApp)) throw new Error('Verstak.app не найден внутри DMG')
  cpSync(sourceApp, installedApp, { recursive: true })
  const baseUrl = await listen()

  const firstLaunch = await launch()
  firstApp = firstLaunch.electronApp
  const first = await firstRun(firstLaunch.page, baseUrl)
  await firstApp.close()
  firstApp = null

  const secondLaunch = await launch()
  secondApp = secondLaunch.electronApp
  const persisted = await secondRun(secondLaunch.page, first)
  const failures = Object.entries(persisted).filter(([, value]) => value !== true)
  if (failures.length) throw new Error(`Restart assertions failed: ${failures.map(([key]) => key).join(', ')}`)
  await secondApp.close()
  secondApp = null

  const dbPath = join(userDataDir, 'verstak.db')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('custom_openai_api_key')
  db.close()
  const plainBase64 = Buffer.from(secretValue, 'utf8').toString('base64')
  const keychainEncrypted = typeof row?.value === 'string' && row.value !== plainBase64
  if (!keychainEncrypted) throw new Error('safeStorage/Keychain encryption was not available')

  const runtimeLog = join(userDataDir, 'logs', 'runtime.jsonl')
  const startupCount = existsSync(runtimeLog)
    ? (readFileSync(runtimeLog, 'utf8').match(/startup\.ok/g) || []).length
    : 0
  if (startupCount < 2) throw new Error(`Expected two packaged startup.ok markers, got ${startupCount}`)
  if (apiCalls < 4) throw new Error(`Shared agent core did not complete tool loop: API calls=${apiCalls}`)

  const evidence = {
    status: 'passed',
    platform: `${process.platform}-${process.arch}`,
    artifact: basename(dmgName),
    installedApp,
    startupCount,
    apiCalls,
    toolEvents: first.events,
    terminal: first.terminalOutput.includes('terminal-ok'),
    keychainEncrypted,
    persisted,
  }
  writeFileSync(join(releaseDir, 'mac-m0-smoke.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  try { await firstApp?.close() } catch { /* already closed */ }
  try { await secondApp?.close() } catch { /* already closed */ }
  await new Promise(resolveClose => server.close(resolveClose))
  if (mounted) {
    try { execFileSync('/usr/bin/hdiutil', ['detach', mountPoint], { stdio: 'inherit' }) } catch { /* best effort */ }
  }
  rmSync(tempRoot, { recursive: true, force: true })
}
