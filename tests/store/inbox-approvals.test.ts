import { describe, it, expect } from 'vitest'
import { selectInboxApprovals } from '../../src/store/session-snapshot'

// T1.3 Inbox: все ожидающие подтверждения команды по ВСЕМ чатам (активный +
// фоновые снапшоты) в одном списке — одобрять/отклонять не заходя в каждый чат.
const cmd = (callId: string, command: string) => ({ callId, command, sendId: 1 })

describe('selectInboxApprovals', () => {
  it('собирает активную команду + команды фоновых чатов', () => {
    const r = selectInboxApprovals({
      activeChatId: 10,
      pendingCommand: cmd('a', 'rm -rf x'),
      chatSnapshots: {
        20: { pendingCommand: cmd('b', 'npm i') },
        30: { pendingCommand: null },
      },
    })
    expect(r).toEqual([
      { chatId: 10, command: cmd('a', 'rm -rf x') },
      { chatId: 20, command: cmd('b', 'npm i') },
    ])
  })

  it('ничего не ждёт → []', () => {
    expect(selectInboxApprovals({ activeChatId: 10, pendingCommand: null, chatSnapshots: {} })).toEqual([])
  })

  it('активная команда без activeChatId не включается (защитно)', () => {
    const r = selectInboxApprovals({ activeChatId: null, pendingCommand: cmd('a', 'ls'), chatSnapshots: {} })
    expect(r).toEqual([])
  })

  it('только фоновая команда (активный чат чист)', () => {
    const r = selectInboxApprovals({
      activeChatId: 10,
      pendingCommand: null,
      chatSnapshots: { 20: { pendingCommand: cmd('b', 'git push') } },
    })
    expect(r).toEqual([{ chatId: 20, command: cmd('b', 'git push') }])
  })
})
