import { describe, it, expect } from 'vitest'
import { suggestSkill, suggestSkills, SUGGEST_THRESHOLD } from '../../src/lib/skill-suggest'
import type { Skill } from '../../src/types/api'

const mk = (over: Partial<Skill>): Skill => ({
  id: over.id ?? 'x',
  systemPrompt: '',
  source: 'user',
  sourceRef: '',
  ...over,
})

const REVIEW = mk({
  id: 'code-review',
  name: 'Code Review',
  description: 'Ревью кода: баги, безопасность, качество',
  suggested_prompts: ['проверь этот код на баги', 'сделай ревью безопасности'],
})
const GIT = mk({
  id: 'git-summary',
  name: 'Git Summary',
  description: 'Сводка изменений git',
  suggested_prompts: ['что изменилось в коммитах'],
})

describe('suggestSkill', () => {
  it('релевантный черновик → топ-скилл по пересечению токенов', () => {
    expect(suggestSkill('сделай ревью безопасности этого кода', [REVIEW, GIT], null)?.id).toBe('code-review')
  })

  it('пустой/короткий черновик → null', () => {
    expect(suggestSkill('', [REVIEW, GIT], null)).toBeNull()
    expect(suggestSkill('ок да', [REVIEW, GIT], null)).toBeNull() // <3 символов / стоп-слова
  })

  it('нерелевантный черновик ниже порога → null (не шумим)', () => {
    expect(suggestSkill('купи молоко завтра утром', [REVIEW, GIT], null)).toBeNull()
  })

  it('активный скилл исключён из кандидатов', () => {
    // тот же релевантный текст, но code-review уже активен → не предлагаем его снова
    expect(suggestSkill('сделай ревью безопасности кода', [REVIEW, GIT], 'code-review')).toBeNull()
  })

  it('suggested_prompts весомее meta (вес 2 vs 1)', () => {
    const a = mk({ id: 'a', name: 'баги', description: 'баги баги', suggested_prompts: [] })
    const b = mk({ id: 'b', name: 'x', description: 'y', suggested_prompts: ['баги тесты ревью'] })
    // 'баги тесты ревью' даёт 3 prompt-токена (вес 2) у b → перебивает a
    expect(suggestSkill('найди баги тесты ревью', [a, b], null)?.id).toBe('b')
  })

  it('предлагает маркетинговый скилл по задачам Директа даже без suggested_prompts', () => {
    const clientMkt = mk({
      id: 'client-mkt',
      name: 'client-mkt',
      description: '/client-mkt — маркетинговый штаб для работы по одному клиенту. Директ, настройка РК, аудит клиента.',
      suggested_prompts: [],
    })
    const pubg = mk({
      id: 'pubg',
      name: 'pubg',
      description: 'Аккаунт PUBG (Стимбаланс), Директ porg-v4ryspsl. Используй когда пользователь пишет ПАБГ.',
      suggested_prompts: [],
    })

    expect(suggestSkill(
      'Мне нужно проминусовать рекламную кампанию ПАБГ, отсеять мусорные поисковые запросы, сделать минусацию площадок в РСЯ и настроить рекламную кампанию на ВТ тематику',
      [clientMkt, pubg],
      null
    )?.id).toBe('client-mkt')
  })

  it('предпочитает Wordstat широкому client-mkt при задаче про семантику и частотность', () => {
    const clientMkt = mk({
      id: 'client-mkt',
      name: 'client-mkt',
      description: '/client-mkt — маркетинговый штаб: Директ, настройка РК, аудит клиента, семантика.',
      suggested_prompts: [],
    })
    const wordstat = mk({
      id: 'wordstat-api',
      name: 'wordstat-api',
      description: 'Яндекс Вордстат API — частотность, топ запросов, динамика, регионы. Используй при задачах с семантикой, ключами, частотностью, подбором фраз для Директа/SEO.',
      suggested_prompts: [],
    })

    expect(suggestSkill(
      'Собери семантику и частотность через вордстат для рекламной кампании',
      [clientMkt, wordstat],
      null
    )?.id).toBe('wordstat-api')
  })

  it('предпочитает Метрику широкому client-mkt при задаче про цели и конверсии', () => {
    const clientMkt = mk({
      id: 'client-mkt',
      name: 'client-mkt',
      description: '/client-mkt — маркетинговый штаб: Директ, настройка РК, аудит клиента, отчёты.',
      suggested_prompts: [],
    })
    const metrika = mk({
      id: 'metrika-api',
      name: 'metrika-api',
      description: 'Яндекс.Метрика API — счётчики, цели, сегменты, отчёты, конверсии, Logs API.',
      suggested_prompts: [],
    })

    expect(suggestSkill(
      'Проверь в Метрике цели и конверсии по рекламной кампании',
      [clientMkt, metrika],
      null
    )?.id).toBe('metrika-api')
  })

  it('предпочитает узкую минусацию Поиска широкому client-mkt', () => {
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

  it('предпочитает минусацию площадок РСЯ широкому client-mkt', () => {
    const clientMkt = mk({
      id: 'client-mkt',
      name: 'client-mkt',
      description: 'Маркетинговый router: Директ, РСЯ, минусация, аудит.',
      suggested_prompts: [],
    })
    const rsyaSites = mk({
      id: 'direct-rsya-sites-minusation',
      name: 'direct-rsya-sites-minusation',
      description: 'Минусация площадок РСЯ, приложения, сайты, источники расхода без конверсий.',
      suggested_prompts: ['проминусовать площадки РСЯ'],
    })

    expect(suggestSkill(
      'Сделай минусацию площадок в РСЯ, отключи мусорные приложения и сайты',
      [clientMkt, rsyaSites],
      null
    )?.id).toBe('direct-rsya-sites-minusation')
  })

  it('предпочитает скилл семантики широкому client-mkt при сборе ядра', () => {
    const clientMkt = mk({
      id: 'client-mkt',
      name: 'client-mkt',
      description: 'Маркетинговый router: Директ, семантика, ключевые фразы.',
      suggested_prompts: [],
    })
    const semantics = mk({
      id: 'direct-semantics',
      name: 'direct-semantics',
      description: 'Сбор, расширение и группировка семантического ядра для Яндекс Директа.',
      suggested_prompts: ['собрать семантику'],
    })

    expect(suggestSkill(
      'Нужно собрать семантику и расширить ядро для рекламной кампании',
      [clientMkt, semantics],
      null
    )?.id).toBe('direct-semantics')
  })

  it('предпочитает аудит конверсий при задаче про Метрику и цели', () => {
    const clientMkt = mk({
      id: 'client-mkt',
      name: 'client-mkt',
      description: 'Маркетинговый router: Директ, Метрика, отчёты.',
      suggested_prompts: [],
    })
    const metrikaApi = mk({
      id: 'metrika-api',
      name: 'metrika-api',
      description: 'Яндекс.Метрика API — счётчики, цели, сегменты, отчёты, конверсии.',
      suggested_prompts: [],
    })
    const metrikaAudit = mk({
      id: 'metrika-conversions-audit',
      name: 'metrika-conversions-audit',
      description: 'Проверка целей, конверсий и качества трафика в Яндекс Метрике.',
      suggested_prompts: ['проверить конверсии в Метрике'],
    })

    expect(suggestSkill(
      'Посмотри в Метрике цели и конверсии, почему расход есть, а заявок нет',
      [clientMkt, metrikaApi, metrikaAudit],
      null
    )?.id).toBe('metrika-conversions-audit')
  })

  it('понимает короткую формулировку аудита РК за неделю', () => {
    const clientMkt = mk({
      id: 'client-mkt',
      name: 'client-mkt',
      description: 'Маркетинговый router: Директ, Метрика, аудит, отчёты.',
      suggested_prompts: [],
    })
    const metrikaAudit = mk({
      id: 'metrika-conversions-audit',
      name: 'metrika-conversions-audit',
      description: 'Проверка целей, конверсий, качества трафика и аудит РК за период в Яндекс Метрике/Директе.',
      suggested_prompts: ['аудит РК за неделю'],
    })

    expect(suggestSkill(
      'Аудит РК за неделю',
      [clientMkt, metrikaAudit],
      null
    )?.id).toBe('metrika-conversions-audit')
  })

  it('предпочитает direct-semantics, а не wordstat-api, для общей фразы про расширение семантики', () => {
    const semantics = mk({
      id: 'direct-semantics',
      name: 'direct-semantics',
      description: 'Сбор, расширение и группировка семантического ядра для Яндекс Директа.',
      suggested_prompts: ['расширить семантическое'],
    })
    const wordstat = mk({
      id: 'wordstat-api',
      name: 'wordstat-api',
      description: 'Яндекс Вордстат API — частотность, топ запросов, динамика, регионы. Используй при задачах с семантикой, ключами, частотностью, подбором фраз.',
      suggested_prompts: [],
    })

    expect(suggestSkill(
      'Расширить семантическое',
      [wordstat, semantics],
      null
    )?.id).toBe('direct-semantics')
  })

  it('возвращает несколько скиллов для составной задачи', () => {
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
    const wordstat = mk({
      id: 'wordstat-api',
      name: 'wordstat-api',
      description: 'Яндекс Вордстат API — частотность, топ запросов, динамика, регионы.',
      suggested_prompts: [],
    })

    const ids = suggestSkills(
      'Расширить семантическое ядро и настроить РК на поиске',
      [clientMkt, semantics, campaignSetup, wordstat],
      null
    ).map(skill => skill.id)

    expect(ids).toContain('direct-semantics')
    expect(ids).toContain('direct-campaign-setup')
    expect(ids).not.toContain('client-mkt')
    expect(ids).not.toContain('wordstat-api')
  })

  it('порог экспортируется и равен 3', () => {
    expect(SUGGEST_THRESHOLD).toBe(3)
  })
})
