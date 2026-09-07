// Служба реестра поверх НАСТОЯЩЕЙ базы: проверяем, что понижение доверия при
// подмене содержимого закрепляется в БД, а не живёт до конца вызова.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openDb } from '../../electron/storage/db'
import { createCapabilityOverlay } from '../../electron/storage/capability-overlay'
import { createCapabilityService } from '../../electron/capabilities/service'
import { skillVersion } from '../../electron/capabilities/registry'
import { capabilityId, compareTrust, TRUST_DEFAULT, TRUST_FLOOR } from '../../shared/contracts/capability'
import { emptyEvidence } from '../../shared/contracts/trust'
import { AGENT_MODEL_ROLES } from '../../electron/ai/agent-model-policy'
import policyData from '../../electron/ai/agent-model-policy.json'
import type { Skill } from '../../electron/ai/skills/types'

const skill = (prompt: string): Skill => ({
  id: 'github',
  name: 'Разбор репозитория',
  description: '',
  source: 'user',
  sourceRef: 'C:/skills/github.md',
  systemPrompt: prompt,
  tools_allow: ['read_file'],
})

describe('служба реестра возможностей', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'verstak-cap-svc-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  /** Доказательства «безупречной работы» — ими и зарабатывается высокий уровень. */
  const proven = {
    ...emptyEvidence(),
    successfulRuns: 20, completedTasks: 20,
    verificationsPassed: 20, verificationsTotal: 20,
    humanAccepted: 15, humanRejected: 0,
  }

  /**
   * `evidenceVersion` — версия, ЗА КОТОРОЙ закреплены доказательства. Прогоны
   * привязаны к содержимому: у другой версии их нет, и это ядро проверки ниже.
   */
  const build = (prompt: string, evidenceVersion?: string) => {
    const db = openDb(join(dir, 'test.db'))
    const overlay = createCapabilityOverlay(db)
    const service = createCapabilityService(
      () => ({
        skills: [skill(prompt)],
        mcpServers: [],
        connectors: [],
        roles: [],
        policyVersion: 'p1',
      }),
      overlay,
      (_id, version) => (evidenceVersion && version === evidenceVersion ? proven : emptyEvidence())
    )
    return { db, overlay, service }
  }

  it('собирает паспорт и отдаёт причину уровня', () => {
    const version = skillVersion(skill('исходный промпт'))
    const { db, overlay, service } = build('исходный промпт', version)
    const id = capabilityId('skill', 'github')
    overlay.set(id, { trustLevel: 'T4', version, evalScore: 0.8, lastVerifiedAt: 5, reason: 'три зелёные проверки' })
    // Уровень пришёл из ДОКАЗАТЕЛЬСТВ; запись в оверлее лишь не мешает ему.
    expect(compareTrust(service.get(id)!.trustLevel, TRUST_DEFAULT)).toBeGreaterThan(0)
    expect(service.reason(id)).toBe('три зелёные проверки')
    db.close()
  })

  // Главное свойство службы: понижение переживает перезапуск. Если бы оно жило
  // только в собранном паспорте, следующий запуск снова показал бы T3 на
  // подменённом содержимом.
  it('подмена промпта роняет доверие НАВСЕГДА, а не до конца вызова', () => {
    const version = skillVersion(skill('исходный промпт'))
    const before = build('исходный промпт', version)
    const id = capabilityId('skill', 'github')
    before.overlay.set(id, { trustLevel: 'T4', version, evalScore: 0.9, lastVerifiedAt: 5, reason: 'заслужено' })
    expect(compareTrust(before.service.get(id)!.trustLevel, TRUST_DEFAULT)).toBeGreaterThan(0)
    before.db.close()

    // Кто-то подменил файл скилла. Доказательства закреплены за ПРЕЖНЕЙ версией и
    // на новое содержимое не переезжают, а потолок в оверлее падает на пол.
    const after = build('промпт, которого человек не одобрял', version)
    expect(after.service.get(id)?.trustLevel).toBe(TRUST_FLOOR)
    expect(after.service.reason(id)).toContain('версия')
    after.db.close()

    // И после ещё одного перезапуска доверие НЕ возвращается само.
    const later = build('промпт, которого человек не одобрял', version)
    expect(later.service.get(id)?.trustLevel).toBe(TRUST_FLOOR)
    later.db.close()
  })

  // Контроль: без подмены тот же путь обязан сохранять уровень — иначе пин выше
  // зелен просто потому, что служба роняет доверие всегда.
  it('контроль: без подмены уровень переживает перезапуск', () => {
    const version = skillVersion(skill('исходный промпт'))
    const first = build('исходный промпт', version)
    const id = capabilityId('skill', 'github')
    first.overlay.set(id, { trustLevel: 'T4', version, evalScore: 0.9, lastVerifiedAt: 5, reason: 'заслужено' })
    first.service.list()
    first.db.close()

    const second = build('исходный промпт', version)
    expect(compareTrust(second.service.get(id)!.trustLevel, TRUST_DEFAULT)).toBeGreaterThan(0)
    second.db.close()
  })
})

describe('список ролей не отстаёт от политики моделей', () => {
  // Список ролей в коде — вторая редакция того, что объявлено в JSON. Такая пара
  // расходится молча (CLAUDE.md §3.1), поэтому расхождение делаем красным.
  it('каждая роль из agent-model-policy.json есть в AGENT_MODEL_ROLES', () => {
    const declared = new Set<string>()
    for (const policy of policyData.policies) for (const role of policy.roles) declared.add(role)
    for (const role of declared) expect(AGENT_MODEL_ROLES, role).toContain(role)
  })

  it('контроль: список ролей непустой и без дублей', () => {
    expect(AGENT_MODEL_ROLES.length).toBeGreaterThan(0)
    expect(new Set(AGENT_MODEL_ROLES).size).toBe(AGENT_MODEL_ROLES.length)
  })
})
