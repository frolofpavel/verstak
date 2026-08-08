// @vitest-environment jsdom
//
// Живой дефект (наблюдал Павел 08.08): карточка обновления показывала «Скачиваем 2.4.4»,
// а качалась 2.4.2. Причина по коду: на последней релизной версии (remoteVersion=2.4.4)
// нет пригодного установщика, резолвер откатывается на последнюю УСТАНАВЛИВАЕМУЮ
// (version=2.4.2) — качается ПРАВИЛЬНО 2.4.2. Но UpdatesSettings.getState() читал
// `s.remoteVersion ?? s.version` (2.4.4) вместо честной resolved-версии `s.version`
// (2.4.2, что реально качается). Все прочие пути (onState/onAvailable/onReady) уже
// брали s.version — расхождение только на getState-пути.
//
// Фикстура снята с формы живого state.json: version=2.4.2, remoteVersion=2.4.4.
// Red на текущем коде: заголовок содержит 2.4.4. После фикса — только 2.4.2.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, cleanup, waitFor } from '@testing-library/react'

const { UpdatesSettings } = await import('../../src/components/UpdatesSettings')

// Дивергентный снапшот available: качаться будет version (2.4.2), последний релиз —
// remoteVersion (2.4.4). Форма — как отдаёт toUiSnapshot для update_available.
const AVAILABLE_SNAPSHOT = {
  phase: 'available' as const,
  version: '2.4.2',
  remoteVersion: '2.4.4',
  installedVersion: '2.4.0',
  pendingRelease: false,
  updatedAt: 1,
}

function makeUpdaterMock() {
  const noopSub = () => () => {}
  return {
    app: { getVersion: async () => '2.4.0' },
    updater: {
      getVersion: async () => '2.4.0',
      getState: async () => AVAILABLE_SNAPSHOT,
      check: async () => ({ available: true, ...AVAILABLE_SNAPSHOT }),
      getReleaseNotes: async () => [],
      cleanupTemp: async () => ({ removed: 0 }),
      install: async () => ({ ok: true }),
      onState: noopSub,
      onAvailable: noopSub,
      onReady: noopSub,
      onNotAvailable: noopSub,
      onError: noopSub,
      onProgress: noopSub,
    },
  }
}

beforeEach(() => {
  vi.stubGlobal('window', Object.assign(globalThis.window, { api: makeUpdaterMock() }))
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

function titleText(container: HTMLElement): string {
  return container.querySelector('.gg-updates-title')?.textContent ?? ''
}

describe('UpdatesSettings: карточка показывает то, что КАЧАЕТСЯ, а не последний релиз', () => {
  it('available: заголовок — устанавливаемая версия (2.4.2), не последний релиз (2.4.4)', async () => {
    const { container } = render(createElement(UpdatesSettings))
    await waitFor(() => expect(titleText(container)).toContain('Доступна версия'), { timeout: 10000 })
    const title = titleText(container)
    expect(title).toContain('2.4.2')
    expect(title).not.toContain('2.4.4')
  }, 15000)

  // Симптом, который видел Павел («Скачиваем 2.4.4»), — та же переменная remoteVersion
  // ниже по течению: available-заголовок выше уже доказывает корень (getState берёт
  // remoteVersion вместо version). Отдельный downloading-кейс тут дал бы гонку late-getState
  // ↔ onProgress (недетерминированную), поэтому корень пиним на детерминированном
  // available-заголовке, а не на флейки-симптоме.
})
