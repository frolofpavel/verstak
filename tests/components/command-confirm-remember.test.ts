// @vitest-environment jsdom
//
// A1 (10.08): галочка «Больше не спрашивать» перестаёт врать.
//
// ДЕФЕКТ. К модалке CommandConfirm ходят шесть инструментов (run_command /
// spawn_process / connector_query / execute_code / файлы / MCP / браузер), а
// чекбокс был захардкожен на rememberApproval('run_command', …). Для
// connector_query / execute_code derivePrefixRule возвращает null — галочка
// нажималась, визуально исчезала и НЕ писала ничего в ~/.verstak/permissions.json,
// обещая обратное.
//
// ЗАКРЕПЛЕНО. Чекбокс виден ТОЛЬКО когда правило реально формируется
// (canRememberRule === true). Зеркальная пара обязательна (§3.1: пин «не
// произошло» без контрольного кейса не измеряет ничего): безопасная команда →
// галочка есть и правило пишется; connector_query(yookassa) / execute_code →
// галочки нет и запись не зовётся.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, cleanup, act } from '@testing-library/react'
import { derivePrefixRule } from '../../electron/ai/permission-rules'

const { useProject } = await import('../../src/store/projectStore')
const { CommandConfirm } = await import('../../src/components/CommandConfirm')

// canRememberRule повторяет ПРОДОВЫЙ handler permissions:can-remember — та же
// derivePrefixRule, а не рукописный bool: фикстура обязана совпадать с продовой
// формой вызова (§3.1, инцидент responsible-pause-gate 30.07).
const canRememberRule = vi.fn(async (toolName: string, argText: string) => derivePrefixRule(toolName, argText) !== null)
const rememberApproval = vi.fn(async (_toolName: string, _argText: string) => null as string | null)
const resolveCommand = vi.fn(async () => {})

function mountWith(pending: { callId: string; command: string; toolName?: string }) {
  useProject.setState({ path: '/p', activeChatId: 7 }, false)
  useProject.getState().updateChatBundle(7, () => ({ pendingCommand: { ...pending, sendId: 11 } }))
  return render(createElement(CommandConfirm))
}

const checkbox = (container: HTMLElement) => container.querySelector('.gg-remember-approval input') as HTMLInputElement | null

beforeEach(() => {
  vi.stubGlobal('window', Object.assign(globalThis.window, {
    api: {
      settings: { canRememberRule, rememberApproval },
      ai: { resolveCommand },
    },
  }))
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('A1: чекбокс «больше не спрашивать» показывается только там, где правило реально пишется', () => {
  it('КОНТРОЛЬ: безопасная команда → чекбокс есть, клик по «Выполнить» пишет правило', async () => {
    const { container } = mountWith({ callId: 'c1', command: 'git status', toolName: 'run_command' })
    await act(async () => {}) // дать canRememberRule зарезолвиться
    const box = checkbox(container)
    expect(box, 'чекбокс исчез у безопасной команды — контрольный кейс пары').not.toBeNull()

    await act(async () => { box!.click() })
    const acceptBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Выполнить')!
    await act(async () => { acceptBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    expect(rememberApproval).toHaveBeenCalledWith('run_command', 'git status')
    expect(resolveCommand).toHaveBeenCalledWith('c1', true, 11)
  })

  it('connector_query(yookassa) → чекбокса НЕТ, принятие не пишет правило', async () => {
    const { container } = mountWith({ callId: 'c2', command: 'Коннектор yookassa → payments.list', toolName: 'connector_query' })
    await act(async () => {})
    expect(checkbox(container), 'чекбокс обещает правило, которое не сформируется (SEC-CMD-04/05)').toBeNull()

    const acceptBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Выполнить')!
    await act(async () => { acceptBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(rememberApproval).not.toHaveBeenCalled()
    expect(resolveCommand).toHaveBeenCalledWith('c2', true, 11)
  })

  it('execute_code → чекбокса НЕТ', async () => {
    const { container } = mountWith({ callId: 'c3', command: 'execute_code:\nconsole.log(1)', toolName: 'execute_code' })
    await act(async () => {})
    expect(checkbox(container)).toBeNull()
  })

  it('опасная команда run_command (rm -rf) → чекбокса НЕТ (правило не выводится)', async () => {
    const { container } = mountWith({ callId: 'c4', command: 'rm -rf build', toolName: 'run_command' })
    await act(async () => {})
    expect(checkbox(container)).toBeNull()
  })

  it('событие без toolName (старый снапшот) → чекбокс скрыт, canRememberRule не зовётся', async () => {
    const { container } = mountWith({ callId: 'c5', command: 'git status' })
    await act(async () => {})
    expect(checkbox(container)).toBeNull()
    expect(canRememberRule).not.toHaveBeenCalled()
  })
})
