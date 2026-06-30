import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { BUILT_IN_STYLES, resolveOutputStylePrompt, loadOutputStyles } from '../../electron/ai/output-styles'
import { prepareSystemContext } from '../../electron/ai/compose-system'

describe('output-styles', () => {
  it('default стиль даёт пустой промпт (без надстройки)', () => {
    expect(resolveOutputStylePrompt('default', null)).toBe('')
    expect(resolveOutputStylePrompt(null, null)).toBe('')
    expect(resolveOutputStylePrompt(undefined, null)).toBe('')
  })

  it('built-in concise/explanatory/formal возвращают непустой текст стиля', () => {
    expect(resolveOutputStylePrompt('concise', null)).toContain('кратко')
    expect(resolveOutputStylePrompt('explanatory', null)).toContain('ПОЧЕМУ')
    expect(resolveOutputStylePrompt('formal', null)).toContain('деловой')
  })

  it('неизвестный id → пустая строка (graceful, не ломаем сборку промпта)', () => {
    expect(resolveOutputStylePrompt('no-such-style', null)).toBe('')
    expect(resolveOutputStylePrompt('user:ghost', null)).toBe('')
  })

  it('loadOutputStyles всегда содержит built-in', () => {
    const styles = loadOutputStyles(null)
    const ids = styles.map(s => s.id)
    expect(ids).toContain('default')
    expect(ids).toContain('concise')
    expect(styles.length).toBeGreaterThanOrEqual(BUILT_IN_STYLES.length)
  })

  it('default в built-in имеет пустой prompt по контракту', () => {
    const def = BUILT_IN_STYLES.find(s => s.id === 'default')
    expect(def).toBeTruthy()
    expect(def!.prompt).toBe('')
  })
})

describe('output-styles — инъекция в системный промпт', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gg-style-'))
    writeFileSync(join(dir, 'package.json'), '{"scripts":{"test":"vitest"}}')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('outputStyle=concise → секция output_style в system prompt', async () => {
    const composed = await prepareSystemContext({
      projectPath: dir,
      messages: [{ role: 'user', content: 'q' }],
      recentWrites: [],
      outputStyle: 'concise'
    })
    expect(composed.system).toContain('output_style')
    expect(composed.system).toContain('кратко')
  })

  it('outputStyle=default → секции output_style НЕТ (базовый стиль)', async () => {
    const composed = await prepareSystemContext({
      projectPath: dir,
      messages: [{ role: 'user', content: 'q' }],
      recentWrites: [],
      outputStyle: 'default'
    })
    expect(composed.system).not.toContain('output_style')
  })

  it('без outputStyle → секции нет (обратная совместимость)', async () => {
    const composed = await prepareSystemContext({
      projectPath: dir,
      messages: [{ role: 'user', content: 'q' }],
      recentWrites: []
    })
    expect(composed.system).not.toContain('output_style')
  })
})
