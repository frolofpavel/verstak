import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { ru } from '../../src/i18n/ru'

const source = readFileSync(join(__dirname, '..', '..', 'src', 'components', 'AuthScreen.tsx'), 'utf8')

describe('первый запуск требует подключить рабочую модель', () => {
  it('профиль по умолчанию ведёт в IRI Gateway, а не в API без ключа', () => {
    expect(source).toContain("provider: 'verstak-gateway', model: 'kimi-k2.7-code'")
    expect(source).not.toContain("provider: 'gemini-api', model: 'gemini-2.5-flash'")
  })

  it('создание профиля открывает настройку Gateway и не завершает онбординг', () => {
    const signUp = source.slice(source.indexOf('async function handleSignUp'), source.indexOf('async function connectGateway'))
    expect(signUp).toContain('setShowGatewaySetup(true)')
    expect(signUp).not.toContain("setKey('auth_completed'")
    expect(signUp).not.toContain('doLeave()')
  })

  it('ключ сохраняется только после успешной проверки', () => {
    const connect = source.slice(source.indexOf('async function connectGateway'), source.indexOf('async function handleSignIn'))
    expect(connect.indexOf('providers.testConnection')).toBeGreaterThanOrEqual(0)
    expect(connect.indexOf("setKey('verstak_gateway_api_key'")).toBeGreaterThan(connect.indexOf('if (!checked.ok)'))
    expect(connect.indexOf('activateProvider')).toBeGreaterThan(connect.indexOf("setKey('verstak_gateway_api_key'"))
  })

  it('пользователь видит три шага, ссылку лаборатории и подсказку по модели', () => {
    expect(source).toContain('https://agi-iri.ru/gateway/')
    expect(source).toContain('gg-auth-setup-steps')
    expect(ru.auth.setup.getKeyTitle).toMatch(/IRI Gateway/)
    expect(ru.auth.setup.chooseModelHint).toMatch(/рекомендован/i)
  })

  it('контроль: прежний мгновенный выход после создания профиля был бы пойман', () => {
    const broken = "await window.api.settings.setKey('auth_completed', 'true'); doLeave()"
    expect(broken).toContain("setKey('auth_completed'")
    expect(broken).toContain('doLeave()')
  })
})
