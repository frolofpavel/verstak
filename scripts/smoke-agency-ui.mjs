#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const root = path.resolve(__dirname, '..')

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function sse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : null
      server.close(() => {
        if (!port) reject(new Error('Could not allocate a local debug port'))
        else resolve(port)
      })
    })
  })
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}) } catch (err) { reject(err) }
    })
    req.on('error', reject)
  })
}

function streamText(res, text) {
  res.write(sse({ choices: [{ delta: { content: text } }] }))
  res.write(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
  res.write('data: [DONE]\n\n')
  res.end()
}

function streamToolCall(res, id, name, args) {
  res.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: '' } }] } }] }))
  res.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name, arguments: JSON.stringify(args) } }] } }] }))
  res.write(sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }))
  res.write('data: [DONE]\n\n')
  res.end()
}

function toolNamesFromRequest(parsed) {
  return new Set((parsed.tools ?? [])
    .map(t => t?.function?.name)
    .filter(Boolean))
}

async function startFakeGateway() {
  const stats = {
    requests: 0,
    toolCalls: [],
    reviewerCalls: 0,
    finalReplies: 0,
    requestLog: [],
  }

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || !String(req.url || '').endsWith('/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'not_found' }))
      return
    }

    let parsed
    try {
      parsed = await readJsonBody(req)
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'bad_json' }))
      return
    }

    stats.requests += 1
    const messages = Array.isArray(parsed.messages) ? parsed.messages : []
    const allText = JSON.stringify(messages)
    const lastUser = [...messages].reverse().find(m => m?.role === 'user')
    const lastUserText = typeof lastUser?.content === 'string'
      ? lastUser.content
      : JSON.stringify(lastUser?.content ?? '')
    const isPlanRequest = lastUserText.includes('Составь план') || lastUserText.includes('create_plan')
    const toolResultText = messages
      .filter(m => m?.role === 'tool')
      .map(m => String(m.content ?? ''))
      .join('\n')
    const tools = toolNamesFromRequest(parsed)
    stats.requestLog.push({
      tools: [...tools],
      lastUser: lastUserText.slice(0, 500),
      toolResult: toolResultText.slice(-500),
      text: allText.slice(-800),
    })
    if (stats.requestLog.length > 12) stats.requestLog.splice(0, stats.requestLog.length - 12)

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })

    if (allText.includes('"inspected_diff"') || (allText.includes('DIFF') && allText.includes('confidence'))) {
      stats.reviewerCalls += 1
      streamText(res, JSON.stringify({
        inspected_diff: true,
        verdict: 'pass',
        confidence: 0.91,
        issues: [],
        summary: 'Diff is minimal: calc.mjs changes add from subtraction to addition; verify passed.',
      }))
      return
    }

    if (isPlanRequest && tools.has('create_plan') && !toolResultText.includes('Plan #')) {
      stats.toolCalls.push('create_plan')
      streamToolCall(res, 'call_smoke_plan', 'create_plan', {
        title: 'Agency smoke: fix add bug',
        steps: [
          { title: 'Inspect the failing add test', detail: 'Confirm calc.mjs subtracts instead of adding.' },
          { title: 'Patch calc.mjs only', detail: 'Replace a - b with a + b.' },
          { title: 'Verify and review', detail: 'Run node --test calc.test.mjs, then call review_before_commit.' },
        ],
      })
      return
    }

    if (isPlanRequest) {
      stats.finalReplies += 1
      streamText(res, 'Plan is ready for execution.')
      return
    }

    if (tools.has('apply_patch') && !toolResultText.includes('Applied patch to calc.mjs')) {
      stats.toolCalls.push('apply_patch')
      streamToolCall(res, 'call_smoke_patch', 'apply_patch', {
        path: 'calc.mjs',
        diff: '<<<<<<< SEARCH\nexport function add(a, b) { return a - b }\n=======\nexport function add(a, b) { return a + b }\n>>>>>>> REPLACE',
      })
      return
    }

    if (tools.has('attest_verification') && !toolResultText.includes('Verification attested')) {
      stats.toolCalls.push('attest_verification')
      streamToolCall(res, 'call_smoke_verify', 'attest_verification', {
        task_summary: 'Fixed calc.mjs add implementation for add(2, 3) === 5.',
        changed_files: ['calc.mjs'],
        checks: [
          { command: 'node --test calc.test.mjs', summary: 'Node test runner verifies add() behavior.' },
        ],
        risks: [],
      })
      return
    }

    if (tools.has('review_before_commit') && !toolResultText.includes('REVIEW GATE')) {
      stats.toolCalls.push('review_before_commit')
      streamToolCall(res, 'call_smoke_review', 'review_before_commit', {
        task_brief: 'Fixed calc.mjs add implementation with a minimal one-line patch.',
        verify_commands: ['node --test calc.test.mjs'],
      })
      return
    }

    stats.finalReplies += 1
    streamText(res, 'Done. Verification and review gate passed; Proof Pack can be generated.')
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : null
  if (!port) throw new Error('Could not allocate a fake gateway port')

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    stats,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

async function waitForPageTarget(port) {
  for (let i = 0; i < 120; i += 1) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json())
      const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      // keep polling until Electron finishes booting
    }
    await wait(250)
  }
  throw new Error('CDP page target not found')
}

function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const pending = new Map()
    let seq = 0

    ws.onopen = () => {
      resolve({
        send(method, params = {}) {
          const id = ++seq
          ws.send(JSON.stringify({ id, method, params }))
          return new Promise((res, rej) => pending.set(id, { res, rej, method }))
        },
        close() {
          ws.close()
        },
      })
    }
    ws.onerror = reject
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data)
      if (!msg.id) return
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.error) p.rej(new Error(`${p.method}: ${msg.error.message}`))
      else p.res(msg.result)
    }
  })
}

async function evalExpr(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  })
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description
      ?? result.exceptionDetails.text
      ?? 'Runtime exception'
    throw new Error(detail)
  }
  return result.result.value
}

async function waitForAgencyEntry(cdp) {
  let last = null
  for (let i = 0; i < 80; i += 1) {
    last = await evalExpr(cdp, `(() => {
      const candidates = Array.from(document.querySelectorAll('button')).map((b, i) => ({
        i,
        text:(b.textContent||'').trim(),
        disabled:b.disabled,
        r:b.getBoundingClientRect(),
        style:getComputedStyle(b)
      })).filter(x => x.text.includes('Agency task') && !x.disabled && x.r.width > 0 && x.r.height > 0 && x.style.visibility !== 'hidden' && x.style.display !== 'none');
      return {
        visibleCandidates: candidates.length,
        body: document.body.innerText.slice(0, 1200),
      };
    })()`)
    if (last.visibleCandidates > 0) return last
    await wait(250)
  }
  return last
}

async function waitForEval(cdp, expression, predicate, timeoutMs = 60000, intervalMs = 500) {
  const started = Date.now()
  let last = null
  while (Date.now() - started < timeoutMs) {
    last = await evalExpr(cdp, expression)
    if (predicate(last)) return last
    await wait(intervalMs)
  }
  throw new Error(`Timed out waiting for condition. Last value: ${JSON.stringify(last)}`)
}

async function clickPipelinePrimary(cdp) {
  const clicked = await evalExpr(cdp, `(() => {
    const button = document.querySelector('.gg-pipeline-banner .gg-btn-primary');
    if (!button) return { clicked:false, text:null, body:document.body.innerText.slice(0, 1200) };
    button.click();
    return { clicked:true, text:(button.textContent || '').trim() };
  })()`)
  assert(clicked.clicked, `Pipeline primary button not found: ${JSON.stringify(clicked)}`)
  return clicked
}

function electronBin() {
  if (process.platform === 'win32') {
    return path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  }
  return path.join(root, 'node_modules', '.bin', 'electron')
}

function safeRemoveTemp(target) {
  const resolved = path.resolve(target)
  const temp = path.resolve(os.tmpdir())
  const normalizedResolved = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  const normalizedTemp = process.platform === 'win32' ? temp.toLowerCase() : temp
  if (!normalizedResolved.startsWith(normalizedTemp + path.sep)) {
    throw new Error(`Refusing to remove non-temp path: ${target}`)
  }
  fs.rmSync(resolved, { recursive: true, force: true })
}

function killProcessTree(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try { child.kill('SIGTERM') } catch {}
  }
}

function writeAgencyFixture(project) {
  fs.writeFileSync(path.join(project, 'README.md'), '# Agency smoke workspace\n', 'utf8')
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({
    type: 'module',
    scripts: {
      'test:fast': 'node --test calc.test.mjs',
    },
  }, null, 2) + '\n', 'utf8')
  fs.writeFileSync(path.join(project, 'calc.mjs'), 'export function add(a, b) { return a - b }\n', 'utf8')
  fs.writeFileSync(path.join(project, 'calc.test.mjs'), [
    "import test from 'node:test'",
    "import assert from 'node:assert/strict'",
    "import { add } from './calc.mjs'",
    '',
    "test('add adds numbers', () => {",
    '  assert.equal(add(2, 3), 5)',
    '})',
    '',
  ].join('\n'), 'utf8')

  const gitInit = spawnSync('git', ['init'], { cwd: project, encoding: 'utf8' })
  assert(gitInit.status === 0, `git init failed: ${gitInit.stderr || gitInit.stdout}`)
  spawnSync('git', ['config', 'user.email', 'smoke@verstak.local'], { cwd: project, stdio: 'ignore' })
  spawnSync('git', ['config', 'user.name', 'Verstak Smoke'], { cwd: project, stdio: 'ignore' })
  const gitAdd = spawnSync('git', ['add', '.'], { cwd: project, encoding: 'utf8' })
  assert(gitAdd.status === 0, `git add failed: ${gitAdd.stderr || gitAdd.stdout}`)
  const gitCommit = spawnSync('git', ['commit', '-m', 'baseline'], { cwd: project, encoding: 'utf8' })
  assert(gitCommit.status === 0, `git commit failed: ${gitCommit.stderr || gitCommit.stdout}`)

  const before = spawnSync('node', ['--test', 'calc.test.mjs'], { cwd: project, encoding: 'utf8' })
  assert(before.status !== 0, 'Fixture must fail before the agent patch')
  return {
    readme: fs.readFileSync(path.join(project, 'README.md'), 'utf8'),
    packageJson: fs.readFileSync(path.join(project, 'package.json'), 'utf8'),
    testFile: fs.readFileSync(path.join(project, 'calc.test.mjs'), 'utf8'),
  }
}

async function main() {
  assert(typeof WebSocket === 'function', 'Node runtime must provide global WebSocket')
  assert(fs.existsSync(path.join(root, 'out', 'main', 'main.mjs')), 'Run npm run build before this smoke')
  assert(fs.existsSync(path.join(root, 'out', 'renderer', 'index.html')), 'Run npm run build before this smoke')

  const port = await findFreePort()
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'verstak-agency-smoke-'))
  const userData = path.join(tempRoot, 'user-data')
  const project = path.join(tempRoot, 'workspace')
  fs.mkdirSync(userData, { recursive: true })
  fs.mkdirSync(project, { recursive: true })
  const fixtureSnapshot = writeAgencyFixture(project)
  const fakeGateway = await startFakeGateway()

  const child = spawn(electronBin(), [
    '.',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userData}`,
    '--disable-gpu',
  ], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  const output = []
  const collect = chunk => {
    output.push(String(chunk))
    if (output.length > 80) output.splice(0, output.length - 80)
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)

  let cdp = null
  try {
    const target = await waitForPageTarget(port)
    cdp = await connectCdp(target.webSocketDebuggerUrl)
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')

    const setup = await evalExpr(cdp, `(async () => {
      const started = Date.now();
      while (!window.api) {
        if (Date.now() - started > 10000) return { ok:false, reason:'api missing', text: document.body.innerText.slice(0, 500) };
        await new Promise(r => setTimeout(r, 100));
      }
      await window.api.settings.setKey('auth_completed', 'true');
      await window.api.settings.setKey('provider', 'verstak-gateway');
      await window.api.settings.setKey('model_verstak-gateway', 'kimi-k2.7-code');
      await window.api.settings.setKey('model_verstak_gateway', 'kimi-k2.7-code');
      await window.api.settings.setKey('verstak_gateway_api_key', 'vsk_live_smoke_fake');
      await window.api.settings.setKey('verstak_gateway_baseurl', ${JSON.stringify(fakeGateway.baseUrl)});
      await window.api.projects.setCurrent(${JSON.stringify(project)});
      return { ok:true };
    })()`)
    assert(setup.ok, `Renderer setup failed: ${JSON.stringify(setup)}`)

    await cdp.send('Page.reload', { ignoreCache: true })
    await wait(1000)
    const entry = await waitForAgencyEntry(cdp)
    assert(entry?.visibleCandidates > 0, `Agency task button was not visible: ${JSON.stringify(entry)}`)

    const clicked = await evalExpr(cdp, `(() => {
      const candidates = Array.from(document.querySelectorAll('button')).map((b, i) => ({
        b, i, r:b.getBoundingClientRect(), text:(b.textContent||'').trim(), style:getComputedStyle(b)
      })).filter(x => x.text.includes('Agency task') && !x.b.disabled && x.r.width > 0 && x.r.height > 0 && x.style.visibility !== 'hidden' && x.style.display !== 'none');
      const chosen = candidates.at(0);
      if (!chosen) return { clicked:false, visibleCandidates:candidates.length };
      chosen.b.click();
      return { clicked:true, visibleCandidates:candidates.length, text:chosen.text, rect:{x:Math.round(chosen.r.x), y:Math.round(chosen.r.y), w:Math.round(chosen.r.width), h:Math.round(chosen.r.height)} };
    })()`)
    assert(clicked.clicked, `Agency task button was not clickable: ${JSON.stringify(clicked)}`)

    await wait(700)
    const modal = await evalExpr(cdp, `(() => {
      const dialog = document.querySelector('[role="dialog"].gg-pipeline-wizard, .gg-pipeline-wizard[role="dialog"], .gg-pipeline-wizard');
      const text = dialog ? dialog.innerText : '';
      const textareas = Array.from(dialog?.querySelectorAll('textarea') || []);
      const startButton = Array.from(dialog?.querySelectorAll('button') || []).at(-1);
      return {
        open: !!dialog,
        hasReviewStep: text.includes('Review'),
        hasProofStep: text.includes('Proof'),
        textareaCount: textareas.length,
        startInitiallyDisabled: !!startButton?.disabled,
        startText: (startButton?.textContent || '').trim(),
        text: text.slice(0, 500),
      };
    })()`)
    assert(modal.open, 'Agency wizard did not open')
    assert(modal.hasReviewStep, 'Agency wizard is missing Review step')
    assert(modal.hasProofStep, 'Agency wizard is missing Proof step')
    assert(modal.textareaCount === 3, `Expected 3 brief textareas, got ${modal.textareaCount}`)
    assert(modal.startInitiallyDisabled, 'Start button must be disabled before brief is ready')

    const filled = await evalExpr(cdp, `(() => {
      const dialog = document.querySelector('[role="dialog"].gg-pipeline-wizard, .gg-pipeline-wizard[role="dialog"], .gg-pipeline-wizard');
      const fields = Array.from(dialog?.querySelectorAll('textarea') || []);
      const values = ['Live smoke agency goal', 'Temporary workspace only; no network; no secrets', 'Wizard opens with Review and Proof'];
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      fields.forEach((el, index) => {
        setter.call(el, values[index] || '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      return { filled: fields.length };
    })()`)
    assert(filled.filled === 3, `Expected to fill 3 fields, filled ${filled.filled}`)

    await wait(700)
    const afterFill = await evalExpr(cdp, `(() => {
      const dialog = document.querySelector('[role="dialog"].gg-pipeline-wizard, .gg-pipeline-wizard[role="dialog"], .gg-pipeline-wizard');
      const startButton = Array.from(dialog?.querySelectorAll('button') || []).at(-1);
      return {
        startEnabledAfterFill: !!startButton && !startButton.disabled,
        startText: (startButton?.textContent || '').trim(),
      };
    })()`)
    assert(afterFill.startEnabledAfterFill, 'Start button did not become enabled after filling brief')

    await evalExpr(cdp, `(() => {
      const dialog = document.querySelector('[role="dialog"].gg-pipeline-wizard, .gg-pipeline-wizard[role="dialog"], .gg-pipeline-wizard');
      const close = dialog?.querySelector('.gg-modal-close');
      if (close) close.click();
      return !!close;
    })()`)

    const ipc = await evalExpr(cdp, `(async () => {
      const brief = {
        goal: 'IPC smoke: create agency pipeline',
        constraints: 'temporary workspace only',
        dod: 'pipeline starts in plan step and can be cancelled'
      };
      const run = await window.api.pipeline.start({ mode: 'agency', brief, chatId: null });
      if (!run) return { ok:false, reason:'pipeline.start returned null' };
      const active = await window.api.pipeline.getActive(${JSON.stringify(project)});
      await window.api.pipeline.cancel(run.id);
      const afterCancel = await window.api.pipeline.getActive(${JSON.stringify(project)});
      return {
        ok: true,
        run: { id: run.id, mode: run.mode, step: run.step, projectPath: run.projectPath, goal: run.brief.goal },
        active: active ? { id: active.id, mode: active.mode, step: active.step } : null,
        afterCancel: afterCancel ? { id: afterCancel.id, step: afterCancel.step } : null
      };
    })()`)
    assert(ipc.ok, `Pipeline IPC failed: ${JSON.stringify(ipc)}`)
    assert(ipc.run.mode === 'agency', `Expected agency mode, got ${ipc.run.mode}`)
    assert(ipc.run.step === 'plan', `Expected plan step, got ${ipc.run.step}`)
    assert(ipc.active?.id === ipc.run.id, 'pipeline:getActive did not return the created run')
    assert(ipc.afterCancel == null, `Cancelled pipeline still active: ${JSON.stringify(ipc.afterCancel)}`)

    const fullLoopStarted = await evalExpr(cdp, `(async () => {
      const entry = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').includes('Agency task') && !b.disabled);
      if (!entry) return { ok:false, reason:'agency entry missing' };
      entry.click();
      const wait = ms => new Promise(r => setTimeout(r, ms));
      let dialog = null;
      for (let i = 0; i < 40; i += 1) {
        dialog = document.querySelector('[role="dialog"].gg-pipeline-wizard, .gg-pipeline-wizard[role="dialog"], .gg-pipeline-wizard');
        if (dialog) break;
        await wait(100);
      }
      if (!dialog) return { ok:false, reason:'dialog missing' };
      const fields = Array.from(dialog.querySelectorAll('textarea'));
      const values = [
        'Fix calc.mjs so add(2, 3) returns 5.',
        'Only edit calc.mjs. Do not touch README.md, package.json, or calc.test.mjs.',
        'node --test calc.test.mjs passes, then review_before_commit passes, then Proof Pack is generated.'
      ];
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      fields.forEach((el, index) => {
        setter.call(el, values[index] || '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      let startButton = null;
      for (let i = 0; i < 40; i += 1) {
        startButton = Array.from(dialog.querySelectorAll('button')).at(-1);
        if (startButton && !startButton.disabled) break;
        await wait(100);
      }
      if (!startButton || startButton.disabled) return { ok:false, reason:'start disabled', text: dialog.innerText.slice(0, 800) };
      startButton.click();
      return { ok:true, fields: fields.length, startText: (startButton.textContent || '').trim() };
    })()`)
    assert(fullLoopStarted.ok, `Full-loop Agency wizard did not start: ${JSON.stringify(fullLoopStarted)}`)

    const planned = await waitForEval(cdp, `(async () => {
      const p = await window.api.pipeline.getActive(${JSON.stringify(project)});
      return p ? { step:p.step, planId:p.planId, chatId:p.chatId, agentRunId:p.agentRunId } : null;
    })()`, v => v?.step === 'plan' && v.planId != null, 60000, 500)

    const planClick = await clickPipelinePrimary(cdp)

    const verified = await waitForEval(cdp, `(async () => {
      const p = await window.api.pipeline.getActive(${JSON.stringify(project)});
      const v = p?.agentRunId
        ? await window.api.verifications.latestByRunId(${JSON.stringify(project)}, p.agentRunId).catch(() => null)
        : (p ? await window.api.verifications.latest(${JSON.stringify(project)}, p.chatId ?? null).catch(() => null) : null);
      return p ? {
        step:p.step,
        planId:p.planId,
        chatId:p.chatId,
        agentRunId:p.agentRunId,
        verification:v ? { overall:v.overall, checksPassed:v.checksPassed, checksTotal:v.checksTotal, runId:v.runId } : null,
        body:document.body.innerText.slice(0, 1200)
      } : null;
    })()`, v => v?.step === 'verify' && v.agentRunId && v.verification?.overall === 'passed', 90000, 750)

    const verifyClick = await clickPipelinePrimary(cdp)

    const reviewed = await waitForEval(cdp, `(async () => {
      const p = await window.api.pipeline.getActive(${JSON.stringify(project)});
      if (!p) return null;
      const detail = p.agentRunId ? await window.api.agentRuns.get(p.agentRunId).catch(() => null) : null;
      const events = detail?.events ?? [];
      const review = events.find(e => e.kind === 'tool_call' && e.label === 'review_before_commit' && e.status === 'ok' && String(e.detail || '').includes('REVIEW GATE'));
      return {
        step:p.step,
        agentRunId:p.agentRunId,
        reviewGatePassed: !!review,
        reviewDetail: review?.detail ?? null,
        body:document.body.innerText.slice(0, 1200)
      };
    })()`, v => v?.step === 'review' && v.reviewGatePassed === true, 60000, 750)

    const reviewClick = await clickPipelinePrimary(cdp)

    const proofReady = await waitForEval(cdp, `(async () => {
      const p = await window.api.pipeline.getActive(${JSON.stringify(project)});
      return p ? { step:p.step, agentRunId:p.agentRunId, body:document.body.innerText.slice(0, 1200) } : null;
    })()`, v => v?.step === 'proof' && v.agentRunId, 30000, 500)

    const proofClick = await clickPipelinePrimary(cdp)

    const completed = await waitForEval(cdp, `(async () => {
      const p = await window.api.pipeline.getActive(${JSON.stringify(project)});
      return p ? { active:true, step:p.step, agentRunId:p.agentRunId, body:document.body.innerText.slice(0, 1200) } : { active:false };
    })()`, v => v?.active === false, 30000, 500)

    const calcAfter = fs.readFileSync(path.join(project, 'calc.mjs'), 'utf8')
    const testAfter = fs.readFileSync(path.join(project, 'calc.test.mjs'), 'utf8')
    const readmeAfter = fs.readFileSync(path.join(project, 'README.md'), 'utf8')
    const packageAfter = fs.readFileSync(path.join(project, 'package.json'), 'utf8')
    assert(calcAfter.includes('return a + b'), 'calc.mjs was not fixed')
    assert(testAfter === fixtureSnapshot.testFile, 'calc.test.mjs was touched')
    assert(readmeAfter === fixtureSnapshot.readme, 'README.md was touched')
    assert(packageAfter === fixtureSnapshot.packageJson, 'package.json was touched')

    const verifyAfter = spawnSync('node', ['--test', 'calc.test.mjs'], { cwd: project, encoding: 'utf8' })
    assert(verifyAfter.status === 0, `Post-run verify failed: ${verifyAfter.stdout}\n${verifyAfter.stderr}`)
    const diffNames = spawnSync('git', ['diff', '--name-only', '--', 'README.md', 'package.json', 'calc.test.mjs', 'calc.mjs'], { cwd: project, encoding: 'utf8' })
    assert(diffNames.status === 0, `git diff --name-only failed: ${diffNames.stderr || diffNames.stdout}`)
    const changedTrackedFiles = diffNames.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    assert(changedTrackedFiles.length === 1 && changedTrackedFiles[0] === 'calc.mjs', `Unexpected tracked file changes: ${changedTrackedFiles.join(', ')}`)

    const artifactDir = path.join(project, '.verstak', 'artifacts')
    const proofFiles = fs.existsSync(artifactDir)
      ? fs.readdirSync(artifactDir, { recursive: true }).map(String).filter(p => p.includes('.proof.'))
      : []
    assert(proofFiles.some(p => p.endsWith('.proof.json')), 'proof json was not generated')
    assert(proofFiles.some(p => p.endsWith('.proof.html')), 'proof html was not generated')
    assert(proofFiles.some(p => p.endsWith('.proof.md')), 'proof markdown was not generated')

    console.log(JSON.stringify({
      ok: true,
      smoke: 'agency-ui',
      secretsUsed: false,
      providerCall: 'fake-local-openai-compatible',
      realNetwork: false,
      clicked,
      modal,
      filled,
      afterFill,
      ipc: {
        mode: ipc.run.mode,
        initialStep: ipc.run.step,
        activeMatched: ipc.active?.id === ipc.run.id,
        cancelledInactive: ipc.afterCancel == null,
      },
      fullLoop: {
        started: fullLoopStarted.ok,
        planned,
        planClick,
        verified: {
          step: verified.step,
          agentRunId: verified.agentRunId,
          verification: verified.verification,
        },
        verifyClick,
        reviewed: {
          step: reviewed.step,
          reviewGatePassed: reviewed.reviewGatePassed,
          reviewDetail: reviewed.reviewDetail,
        },
        reviewClick,
        proofReady,
        proofClick,
        completed,
        calcFixed: calcAfter.includes('return a + b'),
        trackedDiff: changedTrackedFiles,
        postVerifyExit: verifyAfter.status,
        proofFiles,
        fakeGateway: {
          requests: fakeGateway.stats.requests,
          toolCalls: fakeGateway.stats.toolCalls,
          reviewerCalls: fakeGateway.stats.reviewerCalls,
          finalReplies: fakeGateway.stats.finalReplies,
        },
      },
    }, null, 2))
  } catch (err) {
    console.error(JSON.stringify({
      ok: false,
      smoke: 'agency-ui',
      message: err instanceof Error ? err.message : String(err),
      fakeGateway: fakeGateway.stats,
      electronTail: output.join('').slice(-4000),
    }, null, 2))
    process.exitCode = 1
  } finally {
    try { cdp?.close() } catch {}
    killProcessTree(child)
    try { await fakeGateway.close() } catch {}
    await wait(500)
    try { safeRemoveTemp(tempRoot) } catch {}
  }
}

await main()
