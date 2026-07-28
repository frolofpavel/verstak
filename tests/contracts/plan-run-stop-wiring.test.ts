import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const planView = readFileSync(join(root, 'src/components/PlanView.tsx'), 'utf8')
const chat = readFileSync(join(root, 'src/components/Chat.tsx'), 'utf8')

describe('Plan run → Stop/Pause wiring', () => {
  it('регистрирует sendId планового шага в едином реестре владельцев', () => {
    expect(planView).toMatch(/registerSendOwner\(sendId,\s*\{\s*kind:\s*'chat',\s*chatId:/s)
  })

  it('Stop/Pause ищет прогон активного чата в sendOwners, а не полагается на один ref', () => {
    const stopBlock = chat.slice(
      chat.indexOf('async function stop('),
      chat.indexOf('/**', chat.indexOf('async function stop(') + 1),
    )
    expect(stopBlock).toContain('findRunForChat')
  })
})
