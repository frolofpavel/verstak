// @vitest-environment jsdom
//
// ДЕФЕКТ: отказ от правки был безмолвным. Агент получал голое «User rejected write to
// <path>» (file-ops.ts) и переделывал вслепую — часто то же самое. Идея взята у Orca
// (замечание к диффу уходит обратно агенту), но реализована под наш случай: чинится
// не «комментарий к строке», а именно немой отказ.
//
// ГРАНИЦА, ради которой сделано именно так: механизм подтверждения НЕ ТРОГАЕТСЯ.
// Это путь паузы на ответственном действии, ошибка в нём дороже любой пользы. Причина
// уходит ОТДЕЛЬНЫМ, уже существующим каналом ai:append-context — тем же, которым
// «дополняют контекст на ходу».
//
// ГЛАВНЫЙ ПИН: причина доходит до прогона, и раньше, чем отпущено ожидание — иначе
// агент продолжит до того, как её увидит.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, cleanup, fireEvent, act } from '@testing-library/react'

const calls: string[] = []
const appendContext = vi.fn(async () => { calls.push('append'); return { ok: true } })
const resolveWrite = vi.fn(async () => { calls.push('resolve') })

const PENDING = [{ callId: 'c1', path: 'src/a.ts', before: 'a\n', after: 'b\n', sendId: 7 }]

beforeEach(() => {
  calls.length = 0
  ;(window as unknown as { api: unknown }).api = { ai: { appendContext, resolveWrite } }
  // Формы моков сверены с ПРОДОВЫМИ импортами DiffView.tsx: useProject живёт в
  // store/projectStore, а useActiveChatField — в hooks/useActiveChatBundle, это разные
  // модули. Первая редакция мокала оба одним файлом и не проверяла ничего (§3.1).
  vi.doMock('../../src/store/projectStore', () => ({
    useProject: (sel: (s: unknown) => unknown) =>
      sel({ resolvePendingWrite: () => {}, updateActivity: () => {}, path: 'C:/p' }),
  }))
  vi.doMock('../../src/hooks/useActiveChatBundle', () => ({
    useActiveChatField: (f: string) => (f === 'pendingWrites' ? PENDING : undefined),
  }))
})
afterEach(() => { cleanup(); vi.resetModules(); vi.clearAllMocks() })

async function mount() {
  const { DiffView } = await import('../../src/components/DiffView')
  return render(createElement(DiffView))
}

describe('Дифф: отказ перестаёт быть безмолвным', () => {
  it('поле причины есть рядом с кнопкой отказа', async () => {
    const { container } = await mount()
    expect(container.querySelector('.gg-diff-reject-reason')).toBeTruthy()
  })

  it('заполненная причина уходит в прогон — агент узнаёт, ЧТО не так', async () => {
    const { container } = await mount()
    const input = container.querySelector('.gg-diff-reject-reason') as HTMLInputElement
    await act(async () => { fireEvent.change(input, { target: { value: 'сломает обратную совместимость' } }) })
    const reject = [...container.querySelectorAll('button')].find(b => b.textContent === 'Отклонить')!
    await act(async () => { fireEvent.click(reject) })
    expect(appendContext).toHaveBeenCalled()
    const [sendId, text] = appendContext.mock.calls[0] as unknown as [number, string]
    expect(sendId).toBe(7)
    expect(text).toContain('сломает обратную совместимость')
    expect(text, 'в пояснении не назван файл — агенту непонятно, к чему оно').toContain('src/a.ts')
  })

  it('причина кладётся ДО того, как отпущено ожидание', async () => {
    // Иначе агент продолжит раньше, чем увидит пояснение, и правка уйдёт вслепую.
    const { container } = await mount()
    const input = container.querySelector('.gg-diff-reject-reason') as HTMLInputElement
    await act(async () => { fireEvent.change(input, { target: { value: 'не туда' } }) })
    const reject = [...container.querySelectorAll('button')].find(b => b.textContent === 'Отклонить')!
    await act(async () => { fireEvent.click(reject) })
    expect(calls).toEqual(['append', 'resolve'])
  })

  // КОНТРОЛЬНЫЙ КЕЙС: без него первые два пина зелены и тогда, когда контекст шлётся
  // ВСЕГДА — пустое пояснение засоряло бы прогон строкой ни о чём, а отказ без причины
  // должен вести себя ровно как прежде.
  it('пустая причина ничего не шлёт — отказ работает как раньше', async () => {
    const { container } = await mount()
    const reject = [...container.querySelectorAll('button')].find(b => b.textContent === 'Отклонить')!
    await act(async () => { fireEvent.click(reject) })
    expect(appendContext).not.toHaveBeenCalled()
    expect(resolveWrite).toHaveBeenCalled()
  })
})
