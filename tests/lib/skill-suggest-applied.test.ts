import { describe, expect, it } from 'vitest'
import { buildSkillIndex, suggestFromIndex, suggestSkill, suggestSkills } from '../../src/lib/skill-suggest'
import type { Skill } from '../../src/types/api'

const mk = (over: Partial<Skill>): Skill => ({
  id: over.id ?? 'x',
  systemPrompt: '',
  source: 'user',
  sourceRef: '',
  ...over,
})

describe('skill suggestions for focused task routing', () => {
  it('does not suggest a skill already applied to the draft', () => {
    const review = mk({
      id: 'code-review',
      name: 'Code Review',
      description: 'Review code for bugs and security',
      suggested_prompts: ['review code bugs security'],
    })

    const index = buildSkillIndex([review])

    expect(suggestFromIndex(
      'review code bugs security',
      index,
      null,
      new Set(['code-review'])
    )).toBeNull()
  })

  it('does not auto-suggest service skills', () => {
    const guide = mk({
      id: 'verstak-guide',
      name: 'Verstak Guide',
      description: 'Help with the Verstak interface',
      suggested_prompts: ['help interface settings project chat'],
    })
    const nightShift = mk({
      id: 'client-run',
      name: 'Night shift',
      description: 'Nightly client cabinet checks',
      suggested_prompts: ['night shift client report anomalies'],
    })

    expect(suggestSkill('help interface settings project chat', [guide], null)).toBeNull()
    expect(suggestSkill('night shift client report anomalies', [nightShift], null)).toBeNull()
  })

  it('prefers a narrow Direct operation skill over broad client marketing', () => {
    const clientMkt = mk({
      id: 'client-mkt',
      name: 'client-mkt',
      description: 'Маркетинговый router: Директ, минусация, семантика, отчёты.',
      suggested_prompts: [],
    })
    const searchMinusation = mk({
      id: 'direct-search-minusation',
      name: 'direct-search-minusation',
      description: 'Минусация поисковых запросов в Яндекс Директе, мусорные фразы, отчёт поисковых запросов.',
      suggested_prompts: ['проминусовать поисковые запросы'],
    })

    expect(suggestSkill(
      'Проминусуй рекламную кампанию: отсеять мусорные поисковые запросы на Поиске',
      [clientMkt, searchMinusation],
      null
    )?.id).toBe('direct-search-minusation')
  })

  it('returns multiple narrow skills for compound Direct tasks', () => {
    const clientMkt = mk({
      id: 'client-mkt',
      name: 'client-mkt',
      description: 'Маркетинговый router: Директ, семантика, настройка РК.',
      suggested_prompts: [],
    })
    const semantics = mk({
      id: 'direct-semantics',
      name: 'direct-semantics',
      description: 'Сбор, расширение и группировка семантического ядра для Яндекс Директа.',
      suggested_prompts: ['расширить семантическое ядро'],
    })
    const campaignSetup = mk({
      id: 'direct-campaign-setup',
      name: 'direct-campaign-setup',
      description: 'Настройка, копирование, перенос и запуск рекламных кампаний в Яндекс Директе.',
      suggested_prompts: ['настроить РК на поиске'],
    })

    const ids = suggestSkills(
      'Расширить семантическое ядро и настроить РК на поиске',
      [clientMkt, semantics, campaignSetup],
      null
    ).map(skill => skill.id)

    expect(ids).toContain('direct-semantics')
    expect(ids).toContain('direct-campaign-setup')
    expect(ids).not.toContain('client-mkt')
  })
})
