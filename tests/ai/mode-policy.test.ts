import { describe, it, expect } from 'vitest'
import { decide, blockReason, type AgentMode } from '../../electron/ai/mode-policy'

// mode-policy.decide() — единственный security-гейт авто-выполнения правок и
// команд. Эти тесты фиксируют контракт: что блокируется, что подтверждается,
// что проходит молча — в каждом из 5 режимов. Если кто-то случайно ослабит
// гейт (например, перестанет гейтить connector_query), тест упадёт.

const EDITS = ['write_file', 'apply_patch', 'propose_edits']
const COMMANDS = ['run_command', 'connector_query']
const READS = ['read_file', 'list_directory', 'search_project', 'get_project_map']

describe('mode-policy decide()', () => {
  describe('режим ask — подтверждение на всё, что меняет состояние', () => {
    for (const t of [...EDITS, ...COMMANDS]) {
      it(`${t} → confirm`, () => expect(decide(t, 'ask')).toBe('confirm'))
    }
    for (const t of READS) {
      it(`${t} → auto-accept (чтение всегда проходит)`, () => expect(decide(t, 'ask')).toBe('auto-accept'))
    }
  })

  describe('режим accept-edits — правки авто, команды через подтверждение', () => {
    for (const t of EDITS) {
      it(`${t} → auto-accept`, () => expect(decide(t, 'accept-edits')).toBe('auto-accept'))
    }
    for (const t of COMMANDS) {
      it(`${t} → confirm`, () => expect(decide(t, 'accept-edits')).toBe('confirm'))
    }
  })

  describe('режим plan — только чтение, всё остальное блокируется', () => {
    for (const t of [...EDITS, ...COMMANDS]) {
      it(`${t} → block`, () => expect(decide(t, 'plan')).toBe('block'))
    }
    for (const t of READS) {
      it(`${t} → auto-accept`, () => expect(decide(t, 'plan')).toBe('auto-accept'))
    }
  })

  describe('режимы auto и bypass — всё авто-принимается', () => {
    for (const mode of ['auto', 'bypass'] as AgentMode[]) {
      for (const t of [...EDITS, ...COMMANDS, ...READS]) {
        it(`${mode}: ${t} → auto-accept`, () => expect(decide(t, mode)).toBe('auto-accept'))
      }
    }
  })

  // Регрессия-гард: connector_query (SSH/HTTP/Telegram) — side-effecting, его
  // нельзя пускать в plan-режиме, который UI заявляет как «только чтение».
  it('connector_query блокируется в plan (защита от обхода гейта)', () => {
    expect(decide('connector_query', 'plan')).toBe('block')
  })
  it('connector_query требует подтверждения в ask', () => {
    expect(decide('connector_query', 'ask')).toBe('confirm')
  })
})

// СЕДЬМОЙ ОБХОД ГЕЙТА (08.08): generate_docx/html/render_chart ПИШУТ ФАЙЛ на диск, но
// не входили ни в edit/command/browser → auto-accept во ВСЕХ режимах, включая plan
// («ничего не менять»). Правка alongside в тот же день увеличила радиус: файл ложится
// в реальные документы человека, не в .verstak. Артефакт = запись файла = класс write_file.
describe('mode-policy decide() — артефакты пишут файл на диск', () => {
  const ARTIFACTS = ['generate_docx', 'generate_html', 'render_chart']
  // Гейтятся как браузерная мутация: block в plan (запись запрещена), иначе auto-accept.
  // Confirm в ask («файл есть файл») — отдельная задача (нет модалки), вынесена штабу.
  for (const t of ARTIFACTS) {
    it(`${t}: plan→block; ask/accept-edits/auto→auto-accept`, () => {
      expect(decide(t, 'plan')).toBe('block')
      expect(decide(t, 'ask')).toBe('auto-accept')
      expect(decide(t, 'accept-edits')).toBe('auto-accept')
      expect(decide(t, 'auto')).toBe('auto-accept')
    })
  }
  // Артефакт = тот же класс, что браузерная мутация (block в plan, иначе auto) —
  // симметрию проверяем с browser_click, чтобы обе категории не разъехались.
  it('артефакт и browser_click ведут себя ОДИНАКОВО во всех режимах', () => {
    for (const mode of ['ask', 'accept-edits', 'plan', 'auto', 'bypass'] as AgentMode[]) {
      expect(decide('generate_docx', mode)).toBe(decide('browser_click', mode))
    }
  })
})

describe('mode-policy blockReason()', () => {
  it('plan + connector_query → упоминает внешние системы', () => {
    const msg = blockReason('connector_query', 'plan')
    expect(msg).toContain('Режим планирования')
    expect(msg.toLowerCase()).toMatch(/коннектор|внешн/)
  })
  it('plan + write_file → объясняет режим планирования', () => {
    expect(blockReason('write_file', 'plan')).toContain('планирования')
  })
  it('plan + артефакт → по-русски объясняет, что файл не создан', () => {
    const msg = blockReason('generate_docx', 'plan')
    expect(msg).toContain('планирования')
    expect(msg.toLowerCase()).toMatch(/файл|артефакт|документ|диаграмм/)
  })
})

describe('mode-policy decide() — per-tool auto-approve (ось 3 I)', () => {
  it('autoApprove.commands повышает confirm→auto-accept в ask (не трогая plan-block)', () => {
    expect(decide('run_command', 'ask', { commands: true })).toBe('auto-accept')
    expect(decide('connector_query', 'ask', { commands: true })).toBe('auto-accept')
    // plan строгий — auto-approve НЕ перекрывает block
    expect(decide('run_command', 'plan', { commands: true })).toBe('block')
  })
  it('autoApprove.edits повышает правки в ask; команды без своего тумблера остаются confirm', () => {
    expect(decide('write_file', 'ask', { edits: true })).toBe('auto-accept')
    expect(decide('run_command', 'ask', { edits: true })).toBe('confirm') // другой тумблер
  })
  it('без тумблеров поведение прежнее; чтение всегда auto', () => {
    expect(decide('run_command', 'ask')).toBe('confirm')
    expect(decide('read_file', 'ask', { commands: true })).toBe('auto-accept')
  })
  it('accept-edits + autoApprove.commands → команды тоже авто', () => {
    expect(decide('run_command', 'accept-edits', { commands: true })).toBe('auto-accept')
  })
})
