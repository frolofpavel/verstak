// Паспорт возможности: общий словарь для скиллов, MCP, коннекторов и ролей агента.
// Пины стерегут ровно то, что легко потерять при первом же расширении реестра.
import { describe, it, expect } from 'vitest'
import {
  capabilityId,
  parseCapabilityId,
  CAPABILITY_TYPES,
  TRUST_LEVELS,
  TRUST_FLOOR,
  TRUST_DEFAULT,
  compareTrust,
  trustAfterVersionChange,
  type TrustLevel,
} from '../../shared/contracts/capability'

describe('идентичность возможности', () => {
  // Настоящая коллизия в этом продукте: скилл `github` и коннектор `github`
  // существуют оба. Общий реестр без типа в ключе склеил бы их в одну запись
  // и отдал бы агенту чужие права.
  it('одинаковый нативный id разных типов даёт разные ключи', () => {
    expect(capabilityId('skill', 'github')).not.toBe(capabilityId('connector', 'github'))
  })

  it('ключ разбирается обратно без потерь', () => {
    for (const type of CAPABILITY_TYPES) {
      const parsed = parseCapabilityId(capabilityId(type, 'yandex-direct'))
      expect(parsed).toEqual({ type, nativeId: 'yandex-direct' })
    }
  })

  // Нативные id приходят из чужих файлов (frontmatter скилла, каталог MCP).
  // Двоеточие внутри не должно рвать разбор ключа.
  it('двоеточие внутри нативного id не ломает разбор', () => {
    const parsed = parseCapabilityId(capabilityId('mcp', 'vendor:server:v2'))
    expect(parsed).toEqual({ type: 'mcp', nativeId: 'vendor:server:v2' })
  })

  it('мусор вместо ключа даёт null, а не догадку', () => {
    for (const bad of ['', 'github', 'unknown:github', ':github', 'skill:']) {
      expect(parseCapabilityId(bad), bad).toBeNull()
    }
  })
})

describe('уровни доверия упорядочены', () => {
  it('порядок T0..T4 строгий и полный', () => {
    expect(TRUST_LEVELS).toEqual(['T0', 'T1', 'T2', 'T3', 'T4'])
    for (let i = 1; i < TRUST_LEVELS.length; i++) {
      expect(compareTrust(TRUST_LEVELS[i], TRUST_LEVELS[i - 1])).toBeGreaterThan(0)
    }
  })

  it('пол — T0, а по умолчанию возможность НЕ получает права записи', () => {
    expect(TRUST_FLOOR).toBe('T0')
    expect(compareTrust(TRUST_DEFAULT, 'T2')).toBeLessThan(0)
  })
})

describe('обновление возможности не повышает доверие', () => {
  // Требование постановки и главная защита реестра: подменил файл скилла —
  // заработанное доверие не переезжает на новое содержимое.
  it('смена версии сбрасывает доверие на пол', () => {
    for (const prev of TRUST_LEVELS) {
      expect(trustAfterVersionChange(prev, 'sha-old', 'sha-new')).toBe(TRUST_FLOOR)
    }
  })

  it('та же версия доверие сохраняет', () => {
    for (const prev of TRUST_LEVELS) {
      expect(trustAfterVersionChange(prev, 'sha-same', 'sha-same')).toBe(prev)
    }
  })

  // Контроль: без этого кейса пин выше зелен и тогда, когда функция всегда
  // возвращает пол — то есть не измеряет ничего.
  it('контроль: функция умеет НЕ сбрасывать', () => {
    const kept = trustAfterVersionChange('T4', 'v1', 'v1')
    const dropped = trustAfterVersionChange('T4', 'v1', 'v2')
    expect(kept).not.toBe(dropped)
    expect(kept).toBe('T4')
  })

  // Первая регистрация — не «обновление»: прежней версии нет, и понижать нечего.
  it('первая версия берёт доверие по умолчанию, а не пол', () => {
    expect(trustAfterVersionChange(TRUST_DEFAULT as TrustLevel, null, 'sha-first')).toBe(TRUST_DEFAULT)
  })
})
