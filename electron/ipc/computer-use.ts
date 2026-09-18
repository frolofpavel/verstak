// Narrow renderer IPC for R2 Computer Use. The renderer may select an opaque
// candidate and revoke/stop the capability, but never receives PID, HWND,
// process creation time, geometry fingerprints or raw helper messages.
import { dialog, ipcMain } from 'electron'

interface PublicCandidate {
  candidateId: string
  processName: string
  title: string
  blockedReason?: string | null
}

interface ComputerUseControllerFacade {
  getBinding(): null | {
    bindingGeneration?: number
    generation?: number
    source?: 'manual' | 'automatic'
    processName?: string
    title?: string
    expiresAt?: number | null
    reconciliationRequired?: boolean
    reconciliationAcknowledgementAvailable?: boolean
  }
  listCandidates(): Promise<PublicCandidate[]>
  bindCandidate(candidateId: string): Promise<{
    ok: boolean
    bindingGeneration?: number
    error?: string
  }>
  prepareUncertainAcknowledgement(): null | {
    challenge: string
    bindingGeneration: number
    processName: string
    title: string
  }
  acknowledgePreparedUncertain(challenge: string): Promise<boolean>
  unbind(): void | Promise<void>
  stop(): Promise<{
    acknowledged: true
    targetAckMs: number
    realTimeGuaranteed: false
  }>
}

export interface ComputerUseIpcDeps {
  controller: ComputerUseControllerFacade | null
  supported?: boolean
  /** Main-owned durable ledger verdict. Renderer receives only a boolean. */
  isChatTainted: (chatId: number) => boolean
}

function validCandidateId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

function publicState(deps: ComputerUseIpcDeps) {
  const supported = deps.supported ?? process.platform === 'win32'
  const binding = supported ? deps.controller?.getBinding() ?? null : null
  return {
    supported,
    helperReady: supported && deps.controller != null,
    bound: binding != null,
    bindingGeneration: binding?.bindingGeneration ?? binding?.generation ?? 0,
    bindingSource: binding?.source === 'automatic' ? 'automatic' : binding ? 'manual' : null,
    target: binding
      ? {
          processName: safeLabel(binding.processName),
          title: safeLabel(binding.title),
        }
      : null,
    expiresAt: binding && Number.isSafeInteger(binding.expiresAt) && Number(binding.expiresAt) > 0
      ? Number(binding.expiresAt)
      : null,
    reconciliationRequired: binding?.reconciliationRequired === true,
    reconciliationAcknowledgementAvailable:
      binding?.reconciliationAcknowledgementAvailable === true,
  }
}

function safeLabel(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\r\n\t]+/gu, ' ').slice(0, 200) : ''
}

export function registerComputerUseIpc(deps: ComputerUseIpcDeps): void {
  let acknowledgementDialogInFlight = false
  ipcMain.handle('computer-use:get-state', async () => publicState(deps))

  ipcMain.handle('computer-use:is-chat-tainted', async (_event, chatId: unknown) => {
    if (typeof chatId !== 'number' || !Number.isSafeInteger(chatId) || chatId <= 0) return true
    try {
      return deps.isChatTainted(chatId) === true
    } catch {
      return true
    }
  })

  ipcMain.handle('computer-use:list-candidates', async () => {
    if (!deps.controller) return []
    const candidates = await deps.controller.listCandidates()
    return candidates.map(candidate => ({
      candidateId: String(candidate.candidateId),
      processName: String(candidate.processName ?? ''),
      title: String(candidate.title ?? ''),
      blockedReason: candidate.blockedReason == null ? null : String(candidate.blockedReason),
    }))
  })

  ipcMain.handle('computer-use:bind', async (_event, candidateId: unknown) => {
    if (!validCandidateId(candidateId)) {
      return { ok: false, error: 'Некорректный идентификатор окна' }
    }
    if (!deps.controller) return { ok: false, error: 'Computer Use недоступен' }
    const result = await deps.controller.bindCandidate(candidateId)
    return result.ok
      ? { ok: true, bindingGeneration: result.bindingGeneration ?? 0 }
      : { ok: false, error: result.error ?? 'Не удалось выбрать окно' }
  })

  ipcMain.handle('computer-use:unbind', async () => {
    if (!deps.controller) return { ok: true }
    await deps.controller.unbind()
    return { ok: true }
  })

  ipcMain.handle('computer-use:acknowledge-uncertain', async () => {
    if (!deps.controller) return { ok: false, error: 'Нет ожидающего подтверждения результата' }
    if (acknowledgementDialogInFlight) {
      return { ok: false, error: 'Подтверждение уже открыто' }
    }
    // This opaque challenge never crosses IPC. It binds the human-visible
    // dialog to the exact generation, target and uncertain action that main
    // inspected before opening the native confirmation.
    const prepared = deps.controller.prepareUncertainAcknowledgement()
    if (!prepared) return { ok: false, error: 'Нет ожидающего подтверждения результата' }
    acknowledgementDialogInFlight = true
    try {
      // Renderer can request this flow, but cannot commit the acknowledgement:
      // only a human response in this main-owned native dialog reaches storage.
      const confirmation = await dialog.showMessageBox({
        type: 'warning',
        title: 'Computer Use — неизвестный результат',
        message: 'Вы вручную проверили результат прошлого действия?',
        detail: `Verstak не знает, произошло ли действие в выбранном окне «${safeLabel(prepared.title)}» (${safeLabel(prepared.processName)}). Подтверждайте только после фактической проверки именно этого окна.`,
        buttons: ['Отмена', 'Я проверил результат'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      if (confirmation.response !== 1) {
        return { ok: false, error: 'Подтверждение отменено' }
      }
      if (!await deps.controller.acknowledgePreparedUncertain(prepared.challenge)) {
        return { ok: false, error: 'Нет ожидающего подтверждения результата' }
      }
      return { ok: true }
    } catch {
      return { ok: false, error: 'Не удалось подтвердить проверку результата' }
    } finally {
      acknowledgementDialogInFlight = false
    }
  })

  ipcMain.handle('computer-use:stop', async () => {
    if (!deps.controller) {
      return { acknowledged: true, targetAckMs: 500, realTimeGuaranteed: false }
    }
    return await deps.controller.stop()
  })
}
