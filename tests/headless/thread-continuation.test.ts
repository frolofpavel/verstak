import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { request } from 'http'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ChatEvent, ChatMessage, ChatProvider } from '../../electron/ai/types'

// Задача W0 облачного Verstak: облачная задача — ТРЕД, а не одноразовый прогон.
// Мок electron кидает: и хост, и сервер обязаны жить в чистом Node (см. full-loop-headless).
vi.mock('electron', () => {
  throw new Error("Cannot find module 'electron' (headless Node)")
})

const { createHeadlessServer } = await import('../../electron/headless/server')
const { createTenantRegistry } = await import('../../electron/headless/tenants')

/**
 * Провайдер-стенограф: запоминает КАЖДЫЙ набор сообщений, с которым его позвали.
 * Именно по этим снимкам проверяется, что второй ход видит первый обмен — утверждение
 * «агент ответил осмысленно» проверяемо только так, без живой модели.
 *
 * `turn` считается ПО ЖИЗНИ СТЕНДА, а не по экземпляру: фабрика провайдера зовётся
 * на каждый прогон заново, и счётчик внутри экземпляра давал бы всем ходам «ход 1».
 */
function recordingProvider(seen: ChatMessage[][], script: (turn: number, messages: ChatMessage[]) => ChatEvent[], counter: { n: number }): ChatProvider {
  return {
    id: 'rec', name: 'rec', models: ['rec'],
    async *send(messages: ChatMessage[]): AsyncGenerator<ChatEvent> {
      seen.push(messages.map(m => ({ role: m.role, content: m.content })))
      counter.n++
      for (const ev of script(counter.n, messages)) yield ev
      yield { type: 'done' }
    }
  }
}

/**
 * ПЕРВЫЙ вызов провайдера в прогоне, начатом этим промптом — то есть ровно то, что ядро
 * положило в initialMessages. Искать по позиции в `seen` нельзя: агентный цикл делает
 * внутри хода дополнительные вызовы (nudge «ответил только текстом»), и последний вызов
 * прогона содержит уже дописанное самим циклом, а не историю треда.
 */
function initialCall(seen: ChatMessage[][], prompt: string): ChatMessage[] {
  const found = seen.find(c => c[c.length - 1]?.role === 'user' && c[c.length - 1]?.content === prompt)
  if (!found) throw new Error(`нет вызова провайдера с постановкой «${prompt}»`)
  return found.filter(m => m.role !== 'system')
}

function call(port: number, method: string, path: string, tenant?: string, body?: unknown) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (tenant) headers['x-verstak-tenant'] = tenant
    const req = request({ host: '127.0.0.1', port, method, path, headers }, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
}

/** Ждёт терминального статуса прогона. Бюджет заметно меньше testTimeout (§3.1). */
async function waitDone(port: number, runId: string, tenant: string): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const status = JSON.parse((await call(port, 'GET', `/tasks/${runId}`, tenant)).body).status as string
    if (status !== 'running') return status
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`прогон ${runId} не завершился за 6с`)
}

describe('облачная задача = тред (W0): продолжение, чтение, список', () => {
  let root: string
  let server: { close: () => Promise<void> } | null = null
  let registry: ReturnType<typeof createTenantRegistry> | null = null

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'vsk-thread-')) })
  afterEach(async () => {
    if (server) { await server.close(); server = null }
    if (registry) { await registry.closeAll(); registry = null }
    rmSync(root, { recursive: true, force: true })
  })

  async function boot(provider: () => ChatProvider) {
    registry = createTenantRegistry({
      root,
      masterKey: randomBytes(32),
      hostDefaults: { providerFactory: () => provider() }
    })
    const s = createHeadlessServer({ tenants: registry })
    server = s
    return await s.listen(0)
  }

  it('ПРОДОЛЖЕНИЕ ВИДИТ ПЕРВЫЙ ХОД: во втором прогоне история треда лежит в initialMessages', async () => {
    const seen: ChatMessage[][] = []
    const turns = { n: 0 }
    const port = await boot(() => recordingProvider(seen, () => [{ type: 'text', text: 'выручка за июнь: 100' }], turns))

    const first = JSON.parse((await call(port, 'POST', '/tasks', 'user-a', {
      prompt: 'посчитай выручку за июнь', agentMode: 'bypass', providerId: 'deepseek'
    })).body) as { runId: string; threadId: number }
    expect(await waitDone(port, first.runId, 'user-a')).toBe('done')

    const second = JSON.parse((await call(port, 'POST', `/tasks/${first.runId}/continue`, 'user-a', {
      prompt: 'а теперь то же самое, но за июль', agentMode: 'bypass', providerId: 'deepseek'
    })).body) as { runId: string; threadId: number }
    expect(second.threadId).toBe(first.threadId)
    expect(second.runId).not.toBe(first.runId)
    expect(await waitDone(port, second.runId, 'user-a')).toBe('done')

    // Первый ход: только system + постановка, истории неоткуда взяться.
    expect(initialCall(seen, 'посчитай выручку за июнь'))
      .toEqual([{ role: 'user', content: 'посчитай выручку за июнь' }])

    // Второй ход: ВЕСЬ обмен первого хода + новое уточнение, в этом порядке.
    expect(initialCall(seen, 'а теперь то же самое, но за июль')).toEqual([
      { role: 'user', content: 'посчитай выручку за июнь' },
      { role: 'assistant', content: 'выручка за июнь: 100' },
      { role: 'user', content: 'а теперь то же самое, но за июль' }
    ])
  }, 20_000)

  it('КОНТРОЛЬНЫЙ КЕЙС к предыдущему: НОВАЯ задача истории чужого треда НЕ видит', async () => {
    const seen: ChatMessage[][] = []
    const turns = { n: 0 }
    const port = await boot(() => recordingProvider(seen, () => [{ type: 'text', text: 'готово' }], turns))

    const first = JSON.parse((await call(port, 'POST', '/tasks', 'user-a', {
      prompt: 'первая задача', agentMode: 'bypass', providerId: 'deepseek'
    })).body) as { runId: string }
    expect(await waitDone(port, first.runId, 'user-a')).toBe('done')

    // Тот же тенант, но НОВЫЙ POST /tasks — а не /continue.
    const other = JSON.parse((await call(port, 'POST', '/tasks', 'user-a', {
      prompt: 'вторая задача', agentMode: 'bypass', providerId: 'deepseek'
    })).body) as { runId: string; threadId: number }
    expect(other.threadId).not.toBe(JSON.parse((await call(port, 'GET', `/tasks/${first.runId}/thread`, 'user-a')).body).threadId)
    expect(await waitDone(port, other.runId, 'user-a')).toBe('done')

    expect(initialCall(seen, 'вторая задача')).toEqual([{ role: 'user', content: 'вторая задача' }])
  }, 20_000)

  it('ТОТ ЖЕ WORKSPACE: файл первого хода виден второму, и артефакты треда отдаются по обоим прогонам', async () => {
    const seen: ChatMessage[][] = []
    const turns = { n: 0 }
    // Инструмент выбираем по ПОСЛЕДНЕМУ сообщению вызова, а не по номеру хода: после
    // tool-результата цикл зовёт провайдера снова, и счётчик увёл бы сценарий в петлю.
    const port = await boot(() => recordingProvider(seen, (_turn, messages) => {
      const last = messages[messages.length - 1]
      if (last?.role !== 'user') return [{ type: 'text', text: 'готово' }]
      if (last.content === 'запиши june.md') {
        return [{ type: 'tool-call', call: { id: 'w1', name: 'write_file', args: { path: 'june.md', content: 'выручка 100\n' } } }]
      }
      if (last.content === 'прочитай june.md') {
        return [{ type: 'tool-call', call: { id: 'r1', name: 'read_file', args: { path: 'june.md' } } }]
      }
      return [{ type: 'text', text: 'готово' }]
    }, turns))

    const first = JSON.parse((await call(port, 'POST', '/tasks', 'user-a', {
      prompt: 'запиши june.md', agentMode: 'bypass', providerId: 'deepseek'
    })).body) as { runId: string }
    expect(await waitDone(port, first.runId, 'user-a')).toBe('done')

    const workspace = JSON.parse((await call(port, 'GET', '/tasks', 'user-a')).body).tasks[0].workspace as string
    expect(existsSync(join(workspace, 'june.md'))).toBe(true)

    const second = JSON.parse((await call(port, 'POST', `/tasks/${first.runId}/continue`, 'user-a', {
      prompt: 'прочитай june.md', agentMode: 'bypass', providerId: 'deepseek'
    })).body) as { runId: string }
    expect(await waitDone(port, second.runId, 'user-a')).toBe('done')

    // Второй прогон реально прочитал файл первого — tool_result с содержимым лежит
    // в его собственном таймлайне, значит workspace тот же, а не новый пустой каталог.
    const tl = JSON.parse((await call(port, 'GET', `/tasks/${second.runId}/timeline`, 'user-a')).body) as {
      events: Array<{ kind: string; detail: string | null }>
    }
    expect(JSON.stringify(tl.events)).toContain('june.md')

    // Артефакт ПЕРВОГО хода доступен по runId ВТОРОГО: файлы принадлежат треду.
    const listed = JSON.parse((await call(port, 'GET', `/tasks/${second.runId}/artifacts`, 'user-a')).body) as {
      files: Array<{ path: string }>
    }
    expect(listed.files.some(f => f.path === 'june.md')).toBe(true)
    const download = await call(port, 'GET', `/tasks/${second.runId}/artifacts/june.md`, 'user-a')
    expect(download.status).toBe(200)
    expect(download.body).toContain('выручка 100')
  }, 20_000)

  it('ПЕРИМЕТР: чужой тенант не может ни продолжить тред, ни прочитать его целиком', async () => {
    const seen: ChatMessage[][] = []
    const turns = { n: 0 }
    const port = await boot(() => recordingProvider(seen, () => [{ type: 'text', text: 'готово' }], turns))

    const first = JSON.parse((await call(port, 'POST', '/tasks', 'user-a', {
      prompt: 'приватный тред', agentMode: 'bypass', providerId: 'deepseek'
    })).body) as { runId: string }
    expect(await waitDone(port, first.runId, 'user-a')).toBe('done')

    expect((await call(port, 'POST', `/tasks/${first.runId}/continue`, 'user-b', { prompt: 'подсмотрю' })).status).toBe(404)
    expect((await call(port, 'GET', `/tasks/${first.runId}/thread`, 'user-b')).status).toBe(404)
    expect(JSON.parse((await call(port, 'GET', '/tasks', 'user-b')).body).tasks).toEqual([])
    // Чужого хода не появилось и в самом треде: 404 отказал, а не «отказал и всё же выполнил».
    const owner = JSON.parse((await call(port, 'GET', `/tasks/${first.runId}/thread`, 'user-a')).body) as {
      runs: unknown[]; messages: Array<{ content: string }>
    }
    expect(owner.runs.length).toBe(1)
    expect(owner.messages.map(m => m.content)).not.toContain('подсмотрю')
    // Контрольный кейс: владелец ТЕМ ЖЕ запросом тред продолжает — иначе пин доказывал
    // бы лишь то, что /continue всегда отвечает 404.
    expect((await call(port, 'POST', `/tasks/${first.runId}/continue`, 'user-a', {
      prompt: 'уточняю', agentMode: 'bypass', providerId: 'deepseek'
    })).status).toBe(202)
  }, 20_000)

  it('СПИСОК НЕ РАСТЁТ на каждый ход треда: одна строка на задачу, со счётчиком ходов', async () => {
    const seen: ChatMessage[][] = []
    const turns = { n: 0 }
    const port = await boot(() => recordingProvider(seen, () => [{ type: 'text', text: 'готово' }], turns))

    const first = JSON.parse((await call(port, 'POST', '/tasks', 'user-a', {
      prompt: 'исходная постановка', agentMode: 'bypass', providerId: 'deepseek'
    })).body) as { runId: string; threadId: number }
    expect(await waitDone(port, first.runId, 'user-a')).toBe('done')

    const second = JSON.parse((await call(port, 'POST', `/tasks/${first.runId}/continue`, 'user-a', {
      prompt: 'уточнение', agentMode: 'bypass', providerId: 'deepseek'
    })).body) as { runId: string }
    expect(await waitDone(port, second.runId, 'user-a')).toBe('done')

    const list = JSON.parse((await call(port, 'GET', '/tasks', 'user-a')).body) as {
      tasks: Array<{ threadId: number; runId: string; prompt: string; runCount: number; status: string }>
    }
    expect(list.tasks.length).toBe(1)
    expect(list.tasks[0].threadId).toBe(first.threadId)
    // Заголовок = ПЕРВАЯ постановка: задача не переименовывается после каждого уточнения.
    expect(list.tasks[0].prompt).toBe('исходная постановка')
    expect(list.tasks[0].runCount).toBe(2)
    // Строка показывает ПОСЛЕДНИЙ ход — по нему клиент и продолжает тред.
    expect(list.tasks[0].runId).toBe(second.runId)
    expect(list.tasks[0].status).toBe('done')

    // Контрольный кейс: вторая НЕЗАВИСИМАЯ задача строку всё-таки добавляет — иначе пин
    // был бы зелен и у списка, который вообще не растёт.
    const other = JSON.parse((await call(port, 'POST', '/tasks', 'user-a', {
      prompt: 'другая задача', agentMode: 'bypass', providerId: 'deepseek'
    })).body) as { runId: string }
    expect(await waitDone(port, other.runId, 'user-a')).toBe('done')
    expect(JSON.parse((await call(port, 'GET', '/tasks', 'user-a')).body).tasks.length).toBe(2)
  }, 25_000)

  it('ТРЕД ЧИТАЕТСЯ ПОСЛЕ РЕСТАРТА процесса: сообщения и ходы приходят из БД, а не из памяти', async () => {
    const seen: ChatMessage[][] = []
    const turns = { n: 0 }
    // Ответ производный от постановки, а не от номера вызова: цикл делает внутри хода
    // добавочные вызовы (nudge), и «ответ N» разъезжался бы с ходом.
    const port = await boot(() => recordingProvider(seen, (_turn, messages) => {
      const last = messages[messages.length - 1]
      return [{ type: 'text', text: last?.role === 'user' ? `ответ на «${last.content}»` : 'ответ' }]
    }, turns))

    const first = JSON.parse((await call(port, 'POST', '/tasks', 'user-a', {
      prompt: 'постановка', agentMode: 'bypass', providerId: 'deepseek'
    })).body) as { runId: string }
    expect(await waitDone(port, first.runId, 'user-a')).toBe('done')
    const second = JSON.parse((await call(port, `POST`, `/tasks/${first.runId}/continue`, 'user-a', {
      prompt: 'уточнение', agentMode: 'bypass', providerId: 'deepseek'
    })).body) as { runId: string }
    expect(await waitDone(port, second.runId, 'user-a')).toBe('done')

    // Полный рестарт сервиса: новый реестр тенантов над ТЕМ ЖЕ каталогом данных.
    await server!.close(); server = null
    await registry!.closeAll(); registry = null
    const restartedPort = await boot(() => recordingProvider(seen, () => [{ type: 'text', text: 'x' }], turns))

    const thread = JSON.parse((await call(restartedPort, 'GET', `/tasks/${first.runId}/thread`, 'user-a')).body) as {
      messages: Array<{ role: string; content: string }>
      runs: Array<{ runId: string; status: string }>
    }
    // Оба хода по порядку: постановка → ответ → уточнение → ответ. Текст ответа
    // сверяем вхождением: сообщение ассистента склеено из всех text-событий хода
    // (включая добавочный nudge-вызов), как и на десктопе.
    expect(thread.messages.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(thread.messages[0].content).toBe('постановка')
    expect(thread.messages[2].content).toBe('уточнение')
    expect(thread.messages[1].content).toContain('ответ на «постановка»')
    expect(thread.messages[3].content).toContain('ответ на «уточнение»')
    // Ответы ходов не перепутаны: во втором нет реплики первого.
    expect(thread.messages[3].content).not.toContain('ответ на «постановка»')
    expect(thread.runs.map(r => r.runId)).toEqual([first.runId, second.runId])
    expect(thread.runs.every(r => r.status === 'done')).toBe(true)
    // Таймлайн каждого хода тоже durable.
    expect(thread.runs.every(r => (r as unknown as { events: unknown[] }).events.length > 0)).toBe(true)
    // И список после рестарта по-прежнему одна задача, а не два прогона.
    expect(JSON.parse((await call(restartedPort, 'GET', '/tasks', 'user-a')).body).tasks.length).toBe(1)
  }, 25_000)

  it('в треде не может идти два прогона разом: продолжение живого треда отклоняется', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(r => { release = r })
    const port = await boot(() => ({
      id: 'slow', name: 'slow', models: ['slow'],
      async *send(): AsyncGenerator<ChatEvent> {
        await gate
        yield { type: 'text', text: 'готово' }
        yield { type: 'done' }
      }
    }))

    const first = JSON.parse((await call(port, 'POST', '/tasks', 'user-a', {
      prompt: 'долгая задача', agentMode: 'bypass', providerId: 'deepseek'
    })).body) as { runId: string }
    const denied = await call(port, 'POST', `/tasks/${first.runId}/continue`, 'user-a', {
      prompt: 'пока не время', agentMode: 'bypass', providerId: 'deepseek'
    })
    expect(denied.status).toBe(400)
    expect(denied.body).toContain('уже идёт')

    // Контрольный кейс: как только прогон закончился, то же продолжение проходит.
    release()
    expect(await waitDone(port, first.runId, 'user-a')).toBe('done')
    expect((await call(port, 'POST', `/tasks/${first.runId}/continue`, 'user-a', {
      prompt: 'теперь можно', agentMode: 'bypass', providerId: 'deepseek'
    })).status).toBe(202)
  }, 20_000)

  it('продолжение НЕ принимает чужой workspace из тела: каталог берётся у треда', async () => {
    const seen: ChatMessage[][] = []
    const turns = { n: 0 }
    const port = await boot(() => recordingProvider(seen, () => [{ type: 'text', text: 'готово' }], turns))
    const outsider = join(root, 'workspaces', 'user-a', 'чужой')
    mkdirSync(outsider, { recursive: true })
    writeFileSync(join(outsider, 'secret.md'), 'не для этого треда\n')

    const first = JSON.parse((await call(port, 'POST', '/tasks', 'user-a', {
      prompt: 'постановка', agentMode: 'bypass', providerId: 'deepseek'
    })).body) as { runId: string }
    expect(await waitDone(port, first.runId, 'user-a')).toBe('done')
    const workspace = JSON.parse((await call(port, 'GET', '/tasks', 'user-a')).body).tasks[0].workspace as string

    const second = JSON.parse((await call(port, 'POST', `/tasks/${first.runId}/continue`, 'user-a', {
      prompt: 'уточнение', agentMode: 'bypass', providerId: 'deepseek', workspace: outsider
    })).body) as { runId: string }
    expect(await waitDone(port, second.runId, 'user-a')).toBe('done')

    // Прогон остался в каталоге треда — подсунутый workspace проигнорирован.
    const list = JSON.parse((await call(port, 'GET', '/tasks', 'user-a')).body) as {
      tasks: Array<{ workspace: string; runCount: number }>
    }
    expect(list.tasks.length).toBe(1)
    expect(list.tasks[0].workspace).toBe(workspace)
    expect(list.tasks[0].runCount).toBe(2)
    // Контрольный кейс: подсунутый каталог существовал и был доступен хосту (внутри
    // корней тенанта) — значит отказ дал именно тред, а не гейт корней.
    expect(readFileSync(join(outsider, 'secret.md'), 'utf8')).toContain('не для этого треда')
    expect(existsSync(workspace)).toBe(true)
  }, 20_000)
})
