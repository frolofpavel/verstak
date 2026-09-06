// Проекция четырёх источников в один паспорт. Фикстуры собраны по ПРОДОВЫМ типам
// (Skill, McpServerEntry, ConnectorInfo, AgentModelRole), а не по выдуманной форме:
// тест на входе, которого в проде нет, не защищает ничего и об этом не сообщает
// (CLAUDE.md §3.1).
import { describe, it, expect } from 'vitest'
import { buildCapabilities, skillVersion, visibleTo } from '../../electron/capabilities/registry'
import { TRUST_DEFAULT, TRUST_FLOOR, capabilityId } from '../../shared/contracts/capability'
import type { Skill } from '../../electron/ai/skills/types'
import type { McpServerEntry } from '../../electron/mcp/registry'
import type { ConnectorInfo } from '../../electron/connectors/types'

const skill = (over: Partial<Skill> = {}): Skill => ({
  id: 'github',
  name: 'Разбор репозитория',
  description: 'Читает репозиторий и объясняет',
  source: 'user',
  sourceRef: 'C:/Users/Pavel/.verstak/skills/github.md',
  systemPrompt: 'Ты разбираешь репозиторий.',
  tools_allow: ['read_file', 'run_command'],
  ...over,
})

const mcp = (over: Partial<McpServerEntry> = {}): McpServerEntry => ({
  id: 'moex',
  name: 'Московская Биржа',
  command: 'npx',
  args: '["-y","moex-mcp"]',
  env: '{}',
  enabled: true,
  ...over,
})

const connector = (over: Partial<ConnectorInfo> = {}): ConnectorInfo => ({
  id: 'github',
  label: 'GitHub',
  kind: 'dev',
  status: 'ready',
  ...over,
})

const sources = (over: Partial<Parameters<typeof buildCapabilities>[0]> = {}) => ({
  skills: [skill()],
  mcpServers: [mcp()],
  connectors: [connector()],
  roles: ['planner', 'executor'] as const,
  policyVersion: '2026-07-04-stage-11',
  ...over,
})

describe('проекция источников в паспорт', () => {
  it('все четыре типа попадают в реестр', () => {
    const types = buildCapabilities(sources(), () => null).map(c => c.type).sort()
    expect(types).toEqual(['agent', 'agent', 'connector', 'mcp', 'skill'])
  })

  it('скилл и коннектор с одинаковым именем НЕ склеиваются', () => {
    const caps = buildCapabilities(sources(), () => null)
    const ids = caps.map(c => c.id)
    expect(ids).toContain(capabilityId('skill', 'github'))
    expect(ids).toContain(capabilityId('connector', 'github'))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('владелец скилла — его источник, а происхождение — путь к файлу', () => {
    const cap = buildCapabilities(sources(), () => null).find(c => c.type === 'skill')!
    expect(cap.owner).toBe('user')
    expect(cap.source).toBe('C:/Users/Pavel/.verstak/skills/github.md')
  })

  it('разрешённые инструменты берутся из tools_allow, а пустой список значит «не ограничен»', () => {
    const limited = buildCapabilities(sources(), () => null).find(c => c.type === 'skill')!
    expect(limited.allowedTools).toEqual(['read_file', 'run_command'])
    const open = buildCapabilities(
      sources({ skills: [skill({ tools_allow: undefined })] }), () => null,
    ).find(c => c.type === 'skill')!
    expect(open.allowedTools).toBeNull()
  })

  // Ограничений по путям и доменам сегодня НЕ объявляет ни один источник.
  // null здесь — честное «этот слой не ограничивает», а не защита.
  it('пути и домены не выдумываются', () => {
    for (const cap of buildCapabilities(sources(), () => null)) {
      expect(cap.allowedPaths, cap.id).toBeNull()
      expect(cap.allowedDomains, cap.id).toBeNull()
    }
  })

  it('выключенный MCP-сервер виден в реестре, но со статусом disabled', () => {
    const cap = buildCapabilities(
      sources({ mcpServers: [mcp({ enabled: false })] }), () => null,
    ).find(c => c.type === 'mcp')!
    expect(cap.enabled).toBe(false)
    expect(cap.status).toBe('disabled')
  })

  it('статус коннектора берётся из источника, а не назначается', () => {
    const cap = buildCapabilities(
      sources({ connectors: [connector({ status: 'needs-config' })] }), () => null,
    ).find(c => c.type === 'connector')!
    expect(cap.status).toBe('needs-config')
    expect(cap.enabled).toBe(false)
  })
})

describe('версия скилла — хеш содержимого', () => {
  it('правка тела скилла меняет версию', () => {
    const a = skillVersion(skill())
    const b = skillVersion(skill({ systemPrompt: 'Ты разбираешь репозиторий и молчишь.' }))
    expect(a).not.toBe(b)
  })

  it('правка разрешённых инструментов меняет версию', () => {
    expect(skillVersion(skill())).not.toBe(skillVersion(skill({ tools_allow: ['read_file'] })))
  })

  // Контроль: без него пин выше зелен и у функции, которая всегда возвращает разное.
  it('контроль: неизменный скилл даёт ту же версию', () => {
    expect(skillVersion(skill())).toBe(skillVersion(skill()))
  })
})

describe('доверие приходит из оверлея и не выдаётся авансом', () => {
  it('без записи в оверлее возможность получает доверие по умолчанию', () => {
    const cap = buildCapabilities(sources(), () => null).find(c => c.type === 'skill')!
    expect(cap.trustLevel).toBe(TRUST_DEFAULT)
    expect(cap.evalScore).toBeNull()
    expect(cap.lastVerifiedAt).toBeNull()
  })

  it('заработанное доверие поднимается из оверлея', () => {
    const version = skillVersion(skill())
    const cap = buildCapabilities(sources(), id =>
      id === capabilityId('skill', 'github')
        ? { trustLevel: 'T3' as const, version, evalScore: 0.82, lastVerifiedAt: 1_700_000_000_000 }
        : null,
    ).find(c => c.type === 'skill')!
    expect(cap.trustLevel).toBe('T3')
    expect(cap.evalScore).toBe(0.82)
  })

  // Главная защита реестра: подменили файл — заработанное не переезжает.
  it('подмена содержимого скилла роняет доверие на пол', () => {
    const cap = buildCapabilities(sources(), id =>
      id === capabilityId('skill', 'github')
        ? { trustLevel: 'T4' as const, version: 'версия-до-подмены', evalScore: 0.9, lastVerifiedAt: 1 }
        : null,
    ).find(c => c.type === 'skill')!
    expect(cap.trustLevel).toBe(TRUST_FLOOR)
  })
})

describe('агент видит только разрешённое', () => {
  const caps = () => buildCapabilities(sources(), () => null)

  it('без выданного списка не видно ничего — запрет по умолчанию', () => {
    expect(visibleTo(caps(), { granted: [] })).toEqual([])
  })

  it('видно ровно выданное', () => {
    const visible = visibleTo(caps(), { granted: [capabilityId('skill', 'github')] })
    expect(visible.map(c => c.id)).toEqual([capabilityId('skill', 'github')])
  })

  it('выключенная возможность не выдаётся, даже если разрешена', () => {
    const list = buildCapabilities(sources({ mcpServers: [mcp({ enabled: false })] }), () => null)
    const visible = visibleTo(list, { granted: [capabilityId('mcp', 'moex')] })
    expect(visible).toEqual([])
  })

  // Контроль: тот же сервер во включённом виде обязан проходить — иначе пин выше
  // зелен просто потому, что фильтр не пропускает ничего.
  it('контроль: включённая возможность проходит тот же фильтр', () => {
    const visible = visibleTo(caps(), { granted: [capabilityId('mcp', 'moex')] })
    expect(visible.map(c => c.id)).toEqual([capabilityId('mcp', 'moex')])
  })
})
