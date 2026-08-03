import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from 'fs'
import { randomBytes } from 'crypto'
import { request } from 'http'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ChatEvent, ChatProvider } from '../../electron/ai/types'

// ПРИЁМКА Этапа 1а (критерий постановки): на чистом Node поднимается процесс, принимает
// POST с задачей, гонит ПОЛНЫЙ runApiConversation, стримит события в SSE, кладёт артефакт
// в workspace задачи, таймлайн читается из БД после «рестарта процесса».
//
// Провайдер здесь скриптованный (детерминизм гейта); живой прогон на реальном DeepSeek
// закрыт отдельно — tests/live/headless-full-loop.live.test.ts.
vi.mock('electron', () => {
  throw new Error("Cannot find module 'electron' (headless Node)")
})

const { createHeadlessHost } = await import('../../electron/headless/host')
const { createHeadlessServer } = await import('../../electron/headless/server')
const { createAesGcmSafeStorage } = await import('../../electron/headless/secure-storage')

/** Модель просит DOCX-отчёт по «прочитанной странице», затем финализирует. */
function docsProvider(): ChatProvider {
  let turn = 0
  return {
    id: 'acceptance', name: 'acceptance', models: ['acceptance'],
    async *send(): AsyncGenerator<ChatEvent> {
      turn++
      if (turn === 1) {
        yield {
          type: 'tool-call',
          call: {
            id: 'd1', name: 'generate_docx',
            args: {
              filename: 'report',
              title: 'Отчёт по странице',
              sections: [{ heading: 'Итог', paragraphs: ['Страница прочитана, отчёт собран.'] }]
            }
          }
        }
        yield { type: 'done' }
      } else {
        yield { type: 'text', text: 'Готово: отчёт report.docx собран.' }
        yield { type: 'done' }
      }
    }
  }
}

function post(port: number, path: string, body: unknown) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'POST', path, headers: { 'content-type': 'application/json' } }, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
    })
    req.on('error', reject)
    req.write(JSON.stringify(body))
    req.end()
  })
}

function get(port: number, path: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'GET', path }, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** Подписка на SSE; резолвится, когда сервер закрывает стрим по завершении прогона. */
function subscribeSse(port: number, path: string, maxMs = 10_000) {
  return new Promise<string[]>((resolve, reject) => {
    const lines: string[] = []
    const req = request({ host: '127.0.0.1', port, method: 'GET', path }, res => {
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        for (const line of chunk.split('\n')) if (line.startsWith('data: ')) lines.push(line.slice(6))
      })
      res.on('end', () => resolve(lines))
    })
    req.on('error', reject)
    req.end()
    // Бюджет заметно ниже testTimeout теста (§3.1).
    setTimeout(() => { req.destroy(); resolve(lines) }, maxMs).unref()
  })
}

describe('ПРИЁМКА Этапа 1а: POST → полный цикл → SSE → артефакт → durable-таймлайн', () => {
  let dataDir: string
  let wsRoot: string
  const cleanup: Array<() => void | Promise<void>> = []

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'vsk-e2e-data-'))
    wsRoot = mkdtempSync(join(tmpdir(), 'vsk-e2e-ws-'))
  })
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn()
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(wsRoot, { recursive: true, force: true })
  })

  async function boot() {
    const host = await createHeadlessHost({
      dataDir,
      workspaceRoots: [wsRoot],
      safeStorage: createAesGcmSafeStorage(randomBytes(32)),
      env: {},
      // Провайдер инжектится ПРИ СОЗДАНИИ хоста: через HTTP функцию не передать,
      // и это правильно — снаружи процесса маршрут подменять нельзя.
      providerFactory: () => docsProvider()
    })
    cleanup.push(() => host.close())
    const server = createHeadlessServer({ host })
    cleanup.push(() => server.close())
    const port = await server.listen(0)
    return { host, port }
  }

  it('сквозной сценарий целиком', async () => {
    const { host, port } = await boot()
    const workspace = join(wsRoot, 'task-e2e')
    mkdirSync(workspace, { recursive: true })

    // 1. POST /tasks — задача принята, вернулся durable runId.
    const created = await post(port, '/tasks', {
      workspace,
      prompt: 'прочитай страницу и собери DOCX-отчёт',
      providerId: 'deepseek',
      agentMode: 'bypass'
    })
    expect(created.status).toBe(202)
    const runId = JSON.parse(created.body).runId as string
    expect(runId).toBeTruthy()

    // 2. SSE-канал по runId: события прогона дошли наружу и стрим закрылся с завершением.
    const events = await subscribeSse(port, `/tasks/${runId}/events`)
    const types = events.map(l => (JSON.parse(l) as { type?: string }).type)
    expect(types).toContain('done')

    // 3. Артефакт лежит в workspace задачи (не в homedir сервис-юзера).
    const artifactsRoot = join(workspace, '.verstak', 'artifacts')
    expect(existsSync(artifactsRoot)).toBe(true)
    const dayDirs = readdirSync(artifactsRoot)
    expect(dayDirs.length).toBeGreaterThan(0)
    const files = dayDirs.flatMap(d => readdirSync(join(artifactsRoot, d)))
    expect(files.some(f => f.endsWith('.docx'))).toBe(true)

    // 4. Статус прогона и таймлайн доступны по HTTP.
    const status = await get(port, `/tasks/${runId}`)
    expect(JSON.parse(status.body).status).toBe('done')
    const timeline = await get(port, `/tasks/${runId}/timeline`)
    expect(JSON.parse(timeline.body).events[0].kind).toBe('user_msg')

    // 5. «Рестарт процесса»: новый хост+сервер над тем же dataDir читает таймлайн из БД.
    host.close()
    const restarted = await boot()
    const afterRestart = await get(restarted.port, `/tasks/${runId}/timeline`)
    const restoredEvents = JSON.parse(afterRestart.body).events as Array<{ kind: string }>
    expect(restoredEvents.length).toBeGreaterThan(1)
    expect(restoredEvents[0].kind).toBe('user_msg')
    const statusAfter = await get(restarted.port, `/tasks/${runId}`)
    expect(JSON.parse(statusAfter.body).status).toBe('done')
    // Живого канала для этого прогона в новом процессе нет — SSE честно говорит 'gone',
    // а не молчит: клиент кабинета по этому сигналу уходит читать /timeline.
    const goneStream = await subscribeSse(restarted.port, `/tasks/${runId}/events`, 3000)
    expect(goneStream.length).toBeLessThanOrEqual(1)
  }, 60_000)
})
