import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { buildCliPrompt, fitCliPayloadToArgvCap, wrapCurrentUserRequest } from '../../electron/ai/cli-prompt'
import type { ChatMessage } from '../../electron/ai/types'

describe('buildCliPrompt', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gg-cli-'))
    writeFileSync(join(dir, 'package.json'), '{"scripts":{"test":"vitest"}}')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('grok-cli: пробрасывает полный system_layer', async () => {
    const out = await buildCliPrompt({
      providerId: 'grok-cli',
      projectPath: dir,
      messages: [{ role: 'user', content: 'hi' }]
    })
    expect(out).toContain('verstak_system_layer')
  })

  it('включает context_pack с verify_scripts когда package.json есть', async () => {
    const out = await buildCliPrompt({
      providerId: 'grok-cli',
      projectPath: dir,
      messages: [{ role: 'user', content: 'q' }]
    })
    expect(out).toContain('context_pack')
    expect(out).toContain('verify_scripts')
  })

  it('сериализует историю предыдущих turns', async () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'первый вопрос' },
      { role: 'assistant', content: 'первый ответ' },
      { role: 'user', content: 'второй вопрос' }
    ]
    const out = await buildCliPrompt({
      providerId: 'grok-cli',
      projectPath: dir,
      messages: msgs
    })
    expect(out).toContain('conversation_history')
    expect(out).toContain('[USER]: первый вопрос')
    expect(out).toContain('[ASSISTANT]: первый ответ')
    // Last user message is wrapped and goes at the end, NOT inside history
    expect(out).toContain('<current_user_request>')
    expect(out).toContain('второй вопрос')
    expect(out.endsWith('</current_user_request>')).toBe(true)
  })

  it('помечает attachments если они есть', async () => {
    const out = await buildCliPrompt({
      providerId: 'grok-cli',
      projectPath: dir,
      messages: [{
        role: 'user', content: 'посмотри',
        attachments: [{ name: 'img.png', mimeType: 'image/png', data: 'xxx', size: 100 }]
      }]
    })
    expect(out).toContain('img.png')
    expect(out).toMatch(/CLI не видит содержимое/)
  })

  it('пробрасывает recent_writes в context_pack', async () => {
    const out = await buildCliPrompt({
      providerId: 'grok-cli',
      projectPath: dir,
      messages: [{ role: 'user', content: 'q' }],
      recentWrites: [{ filePath: 'src/foo.ts', createdAt: Date.now() }]
    })
    expect(out).toContain('recent_writes')
    expect(out).toContain('src/foo.ts')
  })

  it('бросает понятную ошибку если нет user-сообщения', async () => {
    await expect(buildCliPrompt({
      providerId: 'grok-cli', projectPath: dir,
      messages: [{ role: 'assistant', content: 'hi' }]
    })).rejects.toThrow(/нет user/)
  })

  // Регрессия: skill-промпт раньше терялся для CLI-провайдеров (приходил как
  // role:system и фильтровался) — Grok Build не видел активный скилл.
  // Теперь он наслаивается секцией <skill_layer>.
  it('grok-cli: skillPrompt попадает в <skill_layer>', async () => {
    const out = await buildCliPrompt({
      providerId: 'grok-cli',
      projectPath: dir,
      messages: [{ role: 'user', content: 'q' }],
      skillPrompt: 'Ты эксперт по рекламе. Анализируй кабинеты.'
    })
    expect(out).toContain('<skill_layer>')
    expect(out).toContain('эксперт по рекламе')
  })

  it('без skillPrompt — нет секции <skill_layer>', async () => {
    const out = await buildCliPrompt({
      providerId: 'grok-cli',
      projectPath: dir,
      messages: [{ role: 'user', content: 'q' }]
    })
    expect(out).not.toContain('<skill_layer>')
  })

  // Verify-hint паритет с API-путём (§5 #2). CLI one-shot не имеет цикла, поэтому
  // напоминание «запусти проверку» инжектится в промпт по факту прошлых write'ов.
  it('verify_hint появляется когда в истории был apply_patch (авто-детект)', async () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'поправь файл' },
      { role: 'assistant', content: 'готово', toolCalls: [{ id: 'c1', name: 'apply_patch', args: {} }] },
      { role: 'user', content: 'что дальше' }
    ]
    const out = await buildCliPrompt({ providerId: 'grok-cli', projectPath: dir, messages: msgs })
    expect(out).toContain('verify_hint')
    expect(out).toMatch(/запусти проверку/)
  })

  it('без write\'ов в истории verify_hint не инжектится', async () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'просто вопрос' },
      { role: 'assistant', content: 'просто ответ' },
      { role: 'user', content: 'ещё вопрос' }
    ]
    const out = await buildCliPrompt({ providerId: 'grok-cli', projectPath: dir, messages: msgs })
    expect(out).not.toContain('verify_hint')
  })

  it('явный appendVerifyHint:true форсит хинт даже без write\'ов в истории', async () => {
    const out = await buildCliPrompt({
      providerId: 'grok-cli',
      projectPath: dir,
      messages: [{ role: 'user', content: 'q' }],
      appendVerifyHint: true
    })
    expect(out).toContain('verify_hint')
  })

  it('uses a low-latency history window for short conversational CLI turns', async () => {
    const msgs: ChatMessage[] = []
    for (let i = 0; i < 60; i++) {
      msgs.push({ role: 'user', content: `old question ${i} ${'U'.repeat(900)}` })
      msgs.push({ role: 'assistant', content: `old answer ${i} ${'A'.repeat(900)}` })
    }
    msgs.push({ role: 'user', content: 'why so slow?' })

    const out = await buildCliPrompt({ providerId: 'grok-cli', projectPath: dir, messages: msgs, agentMode: 'ask' })
    const match = out.match(/<conversation_history turns="(\d+)" dropped="(\d+)"/)

    expect(match).not.toBeNull()
    expect(Number(match?.[1])).toBeLessThan(20)
    expect(Number(match?.[2])).toBeGreaterThan(90)
    expect(out.length).toBeLessThan(30_000)
  })

  it('keeps the wider history window in auto mode', async () => {
    const msgs: ChatMessage[] = []
    for (let i = 0; i < 60; i++) {
      msgs.push({ role: 'user', content: `old question ${i} ${'U'.repeat(900)}` })
      msgs.push({ role: 'assistant', content: `old answer ${i} ${'A'.repeat(900)}` })
    }
    msgs.push({ role: 'user', content: 'why so slow?' })

    const out = await buildCliPrompt({ providerId: 'grok-cli', projectPath: dir, messages: msgs, agentMode: 'auto' })
    const match = out.match(/<conversation_history turns="(\d+)" dropped="(\d+)"/)

    expect(match).not.toBeNull()
    expect(Number(match?.[1])).toBeGreaterThan(30)
    expect(Number(match?.[2])).toBeLessThan(90)
  })
})

describe('fitCliPayloadToArgvCap', () => {
  it('сохраняет текущий user turn при обрезке head', () => {
    const head = 'A'.repeat(10_000)
    const user = 'второй вопрос пользователя'
    const payload = `${head}\n\n${wrapCurrentUserRequest(user)}`
    const fitted = fitCliPayloadToArgvCap(payload, 8000)
    expect(fitted).toContain('второй вопрос пользователя')
    expect(fitted).toContain('<current_user_request>')
    expect(fitted.length).toBeLessThanOrEqual(8000)
    expect(fitted).not.toMatch(/^A{8000}/)
  })

  it('не меняет payload если он уже влезает', () => {
    const payload = wrapCurrentUserRequest('короткий')
    expect(fitCliPayloadToArgvCap(payload, 8000)).toBe(payload)
  })
})
