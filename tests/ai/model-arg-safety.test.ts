import { describe, it, expect } from 'vitest'
import { isSafeCliModel, safeCliModelArg } from '../../electron/ai/model-arg-safety'

// Open Design #2 (безопасность): CLI-провайдеры кладут model в argv: spawn(bin, ['-m', model]).
// spawn с МАССИВОМ не идёт через шелл — шелл-инъекции нет, НО элемент, начинающийся с '-',
// ребёнок-CLI трактует как ФЛАГ, а не модель. Модель '--dangerously-...' протащила бы флаг.
// Санитайзер отклоняет флагоподобные / многотокенные / управляющие имена ДО спавна.
describe('isSafeCliModel — форма имени модели для argv', () => {
  it('пропускает нормальные id моделей', () => {
    for (const m of ['claude-opus-4-8', 'gpt-4o', 'gemini-3-flash', 'deepseek-v4-flash', 'moonshotai/kimi-k2', 'o1', 'grok-composer-2.5-fast']) {
      expect(isSafeCliModel(m)).toBe(true)
    }
  })
  it('отклоняет флагоподобные (начинается с «-»)', () => {
    for (const m of ['--dangerously-skip-permissions', '-m', '--model', '-p']) {
      expect(isSafeCliModel(m)).toBe(false)
    }
  })
  it('отклоняет многотокенные/пробельные/управляющие', () => {
    for (const m of ['model --flag', 'a b', 'model\nnext', 'model;rm -rf', 'model$(x)', 'model|y', '', '   ']) {
      expect(isSafeCliModel(m)).toBe(false)
    }
  })
  it('отклоняет слишком длинные', () => {
    expect(isSafeCliModel('a'.repeat(200))).toBe(false)
  })
})

describe('safeCliModelArg — вернуть безопасную модель или null', () => {
  it('безопасная → сама модель (с тримом)', () => {
    expect(safeCliModelArg('  gpt-4o  ')).toBe('gpt-4o')
  })
  it('флагоподобная/пустая/undefined → null (не кладём в argv)', () => {
    expect(safeCliModelArg('--danger')).toBeNull()
    expect(safeCliModelArg('')).toBeNull()
    expect(safeCliModelArg(undefined)).toBeNull()
    expect(safeCliModelArg(null)).toBeNull()
  })
})
