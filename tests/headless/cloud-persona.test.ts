import { describe, it, expect, vi } from 'vitest'

// Дефект живой приёмки 04.08: облачная задача «скажи погоду и сравни за 10 лет» получила
// отказ «мои возможности ограничены работой с файлами и кодом в вашем проекте» — при том,
// что web_search/web_fetch были в allowlist. Инструменты были, ЛИЧНОСТЬ запрещала ими
// пользоваться: headless-прогон собирался с десктопным system-layer.
vi.mock('electron', () => {
  throw new Error("Cannot find module 'electron' (headless Node)")
})

const { composeSystemPrompt } = await import('../../electron/ai/compose-prompt')
const { SYSTEM_LAYER_PROMPT } = await import('../../electron/ai/system-layer')
const { CLOUD_SYSTEM_LAYER_PROMPT } = await import('../../electron/headless/cloud-layer')

const EMPTY_LAYER = { path: null, content: '' }

describe('облачная персона headless-прогона', () => {
  it('облачная сборка НЕ содержит десктопной самоидентификации', () => {
    const { system } = composeSystemPrompt(EMPTY_LAYER, '', '', CLOUD_SYSTEM_LAYER_PROMPT)
    expect(system.toLowerCase()).not.toContain('desktop coding assistant')
    expect(system).not.toContain('вашем проекте')
    // Контрольный кейс: те же слова ЕСТЬ в десктопной сборке — иначе проверка была бы
    // зелёной просто потому, что искомой строки не существует нигде.
    const desktop = composeSystemPrompt(EMPTY_LAYER).system
    expect(desktop.toLowerCase()).toContain('desktop coding assistant')
  })

  it('облачная сборка объявляет универсального исполнителя и веб-путь для фактов', () => {
    const { system } = composeSystemPrompt(EMPTY_LAYER, '', '', CLOUD_SYSTEM_LAYER_PROMPT)
    expect(system).toContain('Verstak в облаке')
    expect(system).toContain('web_search')
    expect(system).toContain('web_fetch')
    // Ответ по-русски и запрет на отказ «я только про код».
    expect(system).toContain('по-русски')
    expect(system.toLowerCase()).toContain('никогда не отказывайся')
  })

  it('облачная сборка честна о том, чего в облаке нет (shell/код/браузер)', () => {
    const { system } = composeSystemPrompt(EMPTY_LAYER, '', '', CLOUD_SYSTEM_LAYER_PROMPT)
    expect(system).toContain('Оболочки, выполнения кода и браузера у тебя нет')
  })

  it('ДЕСКТОПНАЯ сборка байт-в-байт прежняя: параметр по умолчанию — SYSTEM_LAYER_PROMPT', () => {
    const desktop = composeSystemPrompt(EMPTY_LAYER, 'pack', 'skill')
    const explicit = composeSystemPrompt(EMPTY_LAYER, 'pack', 'skill', SYSTEM_LAYER_PROMPT)
    expect(desktop.system).toBe(explicit.system)
    expect(desktop.system.startsWith(SYSTEM_LAYER_PROMPT)).toBe(true)
    // И облачная от неё отличается — параметр реально влияет.
    const cloud = composeSystemPrompt(EMPTY_LAYER, 'pack', 'skill', CLOUD_SYSTEM_LAYER_PROMPT)
    expect(cloud.system).not.toBe(desktop.system)
  })

  it('остальной протокол сохранён: user-layer, skill и preflight на своих местах', () => {
    const cloud = composeSystemPrompt(
      { path: 'RULES.md', content: 'правило проекта' }, 'context-pack', 'skill-body', CLOUD_SYSTEM_LAYER_PROMPT
    )
    expect(cloud.system).toContain('<user_layer source="RULES.md">')
    expect(cloud.system).toContain('skill-body')
    expect(cloud.system).toContain('preflight')
    expect(cloud.system).toContain('context-pack')
  })
})

// ── Гейт web_access в облаке ────────────────────────────────────────────────
// Второй слой того же дефекта: персона починена, но агент всё равно отвечал
// «веб-доступ выключен в настройках» — десктопный opt-in гасил инструмент,
// который stage1-allowlist уже разрешил.
describe('web_access в облачном хосте', () => {
  it('web_search и web_fetch входят в allowlist Этапа 1 (иначе гейт бессмыслен)', async () => {
    const { STAGE1_TOOLS_ALLOW } = await import('../../electron/headless/stage1')
    expect(STAGE1_TOOLS_ALLOW).toContain('web_search')
    expect(STAGE1_TOOLS_ALLOW).toContain('web_fetch')
  })

  it('по умолчанию открыт, но явная настройка тенанта побеждает', async () => {
    const { mkdtempSync, rmSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const { randomBytes } = await import('crypto')
    const { createHeadlessHost } = await import('../../electron/headless/host')
    const { createAesGcmSafeStorage } = await import('../../electron/headless/secure-storage')
    const dir = mkdtempSync(join(tmpdir(), 'vsk-web-'))
    const ws = mkdtempSync(join(tmpdir(), 'vsk-web-ws-'))
    const host = await createHeadlessHost({
      dataDir: dir, workspaceRoots: [ws],
      safeStorage: createAesGcmSafeStorage(randomBytes(32)), env: {}
    })
    try {
      // Ничего не задано → getSecret отдаёт null, а прогон получает 'true'.
      expect(host.getSecret('web_access')).toBeNull()
      host.setSecret('web_access', 'false')
      expect(host.getSecret('web_access')).toBe('false')
    } finally {
      host.close()
      rmSync(dir, { recursive: true, force: true })
      rmSync(ws, { recursive: true, force: true })
    }
  })
})
