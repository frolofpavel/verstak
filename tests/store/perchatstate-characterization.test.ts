// PerChatState 4.4 — characterization ПЕРЕД удалением проекций.
//
// Срезы 4.1–4.3 сделали `chats` источником правды, оставив top-level bundle-поля и
// chatSnapshots поддерживаемыми проекциями. 4.4 их удалил. Этот файл
// фиксирует поведение так, как оно наблюдается ЧЕРЕЗ `chats` — то есть через
// поверхность, которая переживёт удаление. Тесты обязаны быть зелёными и до, и после:
// разница между «убрали дубль» и «потеряли состояние чата» видна только здесь.
//
// Умышленно читаем ТОЛЬКО chats: тест, снимавший показания с удаляемой проекции,
// доказывал бы существование проекции, а не сохранность данных.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const windowStub = {
  api: {
    chats: {
      listWindow: vi.fn(async () => ({ messages: [], totalCount: 0, hasMoreBefore: false })),
      list: vi.fn(async () => []),
      append: vi.fn(async () => {}),
    },
    agentRuns: { list: vi.fn(async () => [] as Array<{ runId: string }>) },
    settings: { setKey: vi.fn(async () => {}), getKey: vi.fn(async () => null) },
    skills: { recordUse: vi.fn(async () => {}) },
    projects: { setCurrent: vi.fn(async () => {}) },
    chatSessions: {
      listReviews: vi.fn(async () => []),
      getOrCreateHelp: vi.fn(async () => ({ id: 99 })),
      create: vi.fn(async (p: string, opts?: { title?: string }) => ({
        id: 4, projectPath: p, title: opts?.title ?? 'Новый чат', kind: 'main',
        providerId: null, model: null, parentChatId: null, createdAt: 1, updatedAt: 1,
      })),
      list: vi.fn(async (p: string) => [1, 2, 3, 4].map(id => ({
        id, projectPath: p, title: `Чат ${id}`, kind: 'main',
        providerId: null, model: null, parentChatId: null, createdAt: 1, updatedAt: 1,
      }))),
    },
  },
}
vi.stubGlobal('window', windowStub)

const { useProject } = await import('../../src/store/projectStore')
const { selectInboxApprovals } = await import('../../src/store/session-snapshot')

const st = () => useProject.getState()
/** Состояние чата так, как его увидит любой потребитель после 4.4. */
const chat = (id: number) => st().chats[id]

beforeEach(async () => {
  // Глобальный afterEach (tests/setup.ts) снимает стабы — переставляем на каждый тест.
  vi.stubGlobal('window', windowStub)
  useProject.setState({
    path: '/proj', chats: {}, activeChatId: null, helpMode: false,
    chatHasMoreBefore: false, chatTotalCount: 0,
  } as never, false)
  await st().switchChatSession(1)
})

describe('4.4 characterization: состояние чатов переживает переходы', () => {
  it('уходящий чат сохраняет свой bundle, входящий получает свой', async () => {
    st().pushActivity({ kind: 'tool', text: 'чат 1 работал' } as never)
    const before = chat(1)
    expect(before?.activity?.length, 'подготовка: у чата 1 есть активность').toBeGreaterThan(0)

    await st().switchChatSession(2)

    expect(chat(1)?.activity, 'состояние ушедшего чата обязано сохраниться').toEqual(before?.activity)
    expect(chat(2)?.activity ?? [], 'новый активный не наследует чужую активность').toHaveLength(0)
    expect(st().activeChatId).toBe(2)
  })

  it('возврат в чат восстанавливает именно его состояние, а не соседнего', async () => {
    st().pushActivity({ kind: 'tool', text: 'первый' } as never)
    await st().switchChatSession(2)
    st().pushActivity({ kind: 'tool', text: 'второй' } as never)
    await st().switchChatSession(1)

    const texts = (chat(1)?.activity ?? []).map(a => (a as { text?: string }).text)
    expect(texts).toContain('первый')
    expect(texts, 'активность соседнего чата не должна перетечь').not.toContain('второй')
  })

  it('событие фонового чата ложится в него и не трогает активный', () => {
    st().applyEventToChat(2, { type: 'text', text: 'фоновый ответ' } as never)
    expect(chat(2), 'фоновый чат обязан появиться в chats').toBeDefined()
    expect(chat(1)?.messages ?? [], 'активный чат не должен получить чужое событие').toHaveLength(0)
  })

  it('фоновый чат помечается непрочитанным, активный — никогда', () => {
    st().applyEventToChat(2, { type: 'text', text: 'привет' } as never)
    expect(chat(2)?.hasUnread).toBe(true)
    expect(chat(1)?.hasUnread, 'смотрим на активный — он прочитан по определению').toBe(false)
  })

  it('новый чат стартует пустым и сбрасывает пагинацию истории (VSK-FIX-PAGINATION)', async () => {
    useProject.setState({ chatHasMoreBefore: true, chatTotalCount: 137 } as never)
    await st().newChatSession()
    const id = st().activeChatId!
    expect(chat(id)?.messages ?? []).toHaveLength(0)
    expect(st().chatHasMoreBefore, 'кнопка «загрузить старое» в пустом чате — баг').toBe(false)
    expect(st().chatTotalCount).toBe(0)
  })

  it('состояние чата не теряется при повторных переключениях туда-обратно', async () => {
    st().setPendingCommand({ callId: 'c1', command: 'npm test' } as never)
    const pending = chat(1)?.pendingCommand
    expect(pending, 'подготовка: подтверждение висит на чате 1').toBeTruthy()

    await st().switchChatSession(2)
    await st().switchChatSession(3)
    await st().switchChatSession(1)

    expect(chat(1)?.pendingCommand, 'ожидающее подтверждение обязано пережить переключения').toEqual(pending)
  })
})

describe('4.4 characterization: потребители фоновых чатов', () => {
  // ЛОВУШКА МИГРАЦИИ, найденная этим харнесом до 4.4: селектор берёт активный чат из
  // отдельного поля pendingCommand И проходит по всей поданной map. Подача chats, где
  // активный есть, задвоила бы его строку. Закрыто пропуском активного в цикле.
  it('каждый чат с ожидающим подтверждением попадает в список РОВНО один раз', () => {
    st().setPendingCommand({ callId: 'active', command: 'активная команда' } as never)
    st().applyEventToChat(2, { type: 'confirm-command', callId: 'bg', command: 'фоновая команда' } as never)

    const s = st()
    const background = Object.fromEntries(
      Object.entries(s.chats).filter(([id]) => Number(id) !== s.activeChatId),
    )
    const rows = selectInboxApprovals({
      activeChatId: s.activeChatId,
      pendingCommand: s.chats[s.activeChatId!]?.pendingCommand ?? null,
      chats: background,
    } as never)
    const ids = rows.map(r => r.chatId)
    expect(ids.filter(id => id === 1), 'активный чат — одна строка, не две').toHaveLength(1)
    expect(new Set(ids).size, 'дублей быть не должно').toBe(ids.length)
  })

  it('поток чата виден по его записи в chats — источник для индикаторов Sidebar', () => {
    st().applyEventToChat(2, { type: 'text', text: 'идёт ответ' } as never)
    expect(chat(2)).toBeDefined()
    expect(typeof chat(2)!.isStreaming).toBe('boolean')
  })
})

describe('4.4 characterization: справка не съедает состояние проектного чата', () => {
  it('в справке события проектного чата продолжают идти в него', async () => {
    st().pushActivity({ kind: 'tool', text: 'до справки' } as never)
    await st().openHelpChat()
    st().applyEventToChat(1, { type: 'text', text: 'пришло во время справки' } as never)

    const texts = (chat(1)?.activity ?? []).map(a => (a as { text?: string }).text)
    expect(texts, 'состояние проектного чата не теряется при уходе в справку').toContain('до справки')
  })

  it('выход из справки возвращает проектный чат с его состоянием', async () => {
    st().pushActivity({ kind: 'tool', text: 'запомни меня' } as never)
    await st().openHelpChat()
    st().leaveHelpMode()   // синхронный экшен: await здесь был бы ложным обещанием асинхронности

    const texts = (chat(1)?.activity ?? []).map(a => (a as { text?: string }).text)
    expect(texts).toContain('запомни меня')
    expect(st().helpMode).toBe(false)
  })
})
