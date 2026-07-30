// Модель суб-агента: цепочка наследования и запрет пустого имени.
//
// ЖИВОЙ ДЕФЕКТ (прогон Павла 30.07, custom-openai). Провайдер суб-агента
// НАСЛЕДОВАЛСЯ от родителя (parallel.ts: `task.provider_id ?? ctx.currentProviderId`),
// а модель — НЕТ: `task.model ?? descriptor.defaultModel`. У custom-openai
// `defaultModel` пуст по построению (модели задаёт юзер в настройках), поэтому в
// шлюз уходил `model: ''`, и он отвечал `503 Provider error`. Все четыре
// под-агента падали одинаково, тогда как ОСНОВНОЙ путь на том же провайдере
// работал — он брал модель, выбранную в чате.
//
// Класс — «переиспользование не переносит предпосылок»: фолбэк на
// `descriptor.defaultModel` верен для gemini/claude/grok (у них дефолт реальный)
// и пуст у custom-openai. Провайдер наследуют, модель — нет; асимметрия и есть
// баг.
//
// ЛЕЧЕНИЕ — ЦЕПОЧКА `task.model ?? ctx.currentModel ?? descriptor.defaultModel`,
// в ОДНОМ месте (buildSubCreateOptions), через которое идут все четыре пути
// делегирования, а не в четырёх литералах. Плюс ГАРД: пустое имя не доезжает до
// шлюза НИКОГДА — отказ с честным текстом, называющим провайдера, а не чужой 503.
import { describe, it, expect, vi } from 'vitest'
import { resolveSubModel, buildSubCreateOptions } from '../../electron/ipc/tool-handlers/delegation/common'
import type { ToolContext } from '../../electron/ipc/tool-handlers/shared'

describe('resolveSubModel · цепочка из трёх звеньев', () => {
  const D = 'gemini-3.5-flash' // непустой дефолт дескриптора

  it('явная модель задачи сильнее всего', () => {
    expect(resolveSubModel('task-model', 'parent-model', D)).toBe('task-model')
  })

  it('нет явной → наследуется модель родителя (случай Павла)', () => {
    expect(resolveSubModel(null, 'parent-model', D)).toBe('parent-model')
    expect(resolveSubModel(undefined, 'parent-model', D)).toBe('parent-model')
    expect(resolveSubModel('', 'parent-model', D)).toBe('parent-model')
  })

  it('нет ни явной, ни родительской → дефолт дескриптора (control: провайдеры с дефолтом целы)', () => {
    expect(resolveSubModel(null, null, D)).toBe(D)
    expect(resolveSubModel('', '', D)).toBe(D)
  })

  it('пробелы на любом звене считаются пустыми', () => {
    expect(resolveSubModel('   ', 'parent', D)).toBe('parent')
    expect(resolveSubModel(null, '  ', D)).toBe(D)
  })

  it('все три пустые → пустая строка (сигнал для гарда)', () => {
    expect(resolveSubModel(null, null, '')).toBe('')
    expect(resolveSubModel('', '  ', '   ')).toBe('')
  })
})

function ctxFor(over: Record<string, unknown> = {}): ToolContext {
  return {
    projectPath: 'C:/p',
    getSecretForDelegate: (k: string) =>
      (k === 'custom_openai_baseurl' ? 'https://gw.example/v1' : null),
    agentMode: 'auto',
    ...over,
  } as unknown as ToolContext
}

const sig = new AbortController().signal

describe('buildSubCreateOptions · пустая модель не доходит до шлюза', () => {
  // ОБЯЗАТЕЛЬНЫЙ: сегодня custom-openai с пустой моделью и без родительской
  // получал 503 от шлюза. Теперь — честный отказ ДО сети.
  it('custom-openai, модели нет нигде → отказ, называющий провайдера', () => {
    expect(() => buildSubCreateOptions('custom-openai', 'k', '', sig, ctxFor()))
      .toThrow(/custom-openai|Свой провайдер|модель/i)
  })

  it('custom-openai, пустая модель, но родитель на claude-opus-4-8 → берётся она', () => {
    const opts = buildSubCreateOptions('custom-openai', 'k', '', sig, ctxFor({ currentModel: 'claude-opus-4-8' }))
    expect(opts.model, 'модель родителя не унаследована — суб уйдёт с пустой').toBe('claude-opus-4-8')
  })

  it('явная модель задачи сильнее родительской', () => {
    const opts = buildSubCreateOptions('custom-openai', 'k', 'llama-3.3', sig, ctxFor({ currentModel: 'claude-opus-4-8' }))
    expect(opts.model).toBe('llama-3.3')
  })

  // КОНТРОЛЬ: провайдер с реальным дефолтом не сломан — пустого имени у него не
  // бывает, и наследование ему не мешает.
  it('контроль: gemini без явной и без родителя берёт дефолт дескриптора', () => {
    const g = ctxFor({ getSecretForDelegate: () => null })
    const opts = buildSubCreateOptions('gemini-api', 'k', '', sig, g)
    expect(opts.model).toBe('gemini-3.5-flash')
  })

  it('контроль: у gemini явная модель по-прежнему уважается', () => {
    const g = ctxFor({ getSecretForDelegate: () => null })
    expect(buildSubCreateOptions('gemini-api', 'k', 'gemini-3.5-pro', sig, g).model).toBe('gemini-3.5-pro')
  })
})
