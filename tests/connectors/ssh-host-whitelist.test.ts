import { describe, it, expect } from 'vitest'
import { createSshConnector } from '../../electron/connectors/ssh'
import type { ConnectorContext } from '../../electron/connectors/types'

// Whitelist хоста — граница «команды модели не уедут на чужой сервер». В коде она есть
// (ssh.ts: host !== defaultHost → blocked), но пина у неё не было, хотя комментарий рядом
// прямо описывает СТАРУЮ логику как дыру: «разрешало любой host если default не задан
// (через fallback args.host ?? ''), модель может слить команды на любой сервер».
// Починка без пина разваливается молча — этот файл стережёт именно её.
//
// Все кейсы ниже обязаны отбиваться ДО сети: host, который здесь используется как
// «чужой», нигде не резолвится, а разрешённый — заведомо несуществующий домен .invalid,
// поэтому ни одна проверка не может достучаться до реальной машины.

const ALLOWED = 'user@allowed.invalid'

function ctxWith(host: string | null): ConnectorContext {
  return {
    getSecret: (key: string) => (key === 'ssh_default_host' ? host : null),
  } as ConnectorContext
}

async function run(args: Record<string, unknown>, host: string | null) {
  const connector = createSshConnector()
  return (await connector.query(args, ctxWith(host))) as { error?: string; message?: string }
}

describe('SSH: whitelist хоста', () => {
  it('чужой хост отклоняется — команда не уходит наружу', async () => {
    const res = await run({ command: 'ls -la', host: 'user@8.8.8.8' }, ALLOWED)
    expect(res.error).toBe('blocked')
    expect(res.message).toContain('whitelist')
  })

  it('подмена хоста при безобидной команде тоже отклоняется', async () => {
    // Опасность не в команде, а в адресате: безобидный `whoami` на чужой машине —
    // это разведка чужой инфраструктуры от имени пользователя.
    const res = await run({ command: 'whoami', host: 'attacker.example.com' }, ALLOWED)
    expect(res.error).toBe('blocked')
  })

  it('без настроенного хоста SSH заблокирован целиком (fail-closed)', async () => {
    const res = await run({ command: 'ls -la' }, null)
    expect(res.error).toBe('no-host')
  })

  it('пустая строка в настройке — это НЕ разрешение (старый fallback)', async () => {
    // Ровно тот дефект, что описан в комментарии ssh.ts: пустой default host
    // раньше открывал дорогу любому адресату.
    const res = await run({ command: 'ls -la', host: 'user@8.8.8.8' }, '')
    expect(res.error).toBe('no-host')
  })

  // КОНТРОЛЬНЫЙ КЕЙС. Без него три проверки выше зелены и тогда, когда SSH не работает
  // вовсе: «отклонено» неотличимо от «сломано». Разрешённый хост обязан пройти гейт и
  // дойти до попытки соединения — домен .invalid не резолвится, поэтому ошибка придёт
  // сетевая, а НЕ 'blocked'/'no-host'.
  it('разрешённый хост проходит гейт и доходит до соединения', async () => {
    const res = await run({ command: 'ls -la', host: ALLOWED }, ALLOWED)
    expect(res.error).not.toBe('blocked')
    expect(res.error).not.toBe('no-host')
  })

  it('хост не указан — подставляется разрешённый, гейт пройден', async () => {
    const res = await run({ command: 'ls -la' }, ALLOWED)
    expect(res.error).not.toBe('blocked')
    expect(res.error).not.toBe('no-host')
  })
})
