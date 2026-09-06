/**
 * Служба реестра возможностей: связывает живые источники, оверлей и потребителей.
 *
 * Здесь же происходит единственный побочный эффект реестра — отметка увиденной
 * версии. Она нужна, чтобы подмена содержимого скилла роняла доверие САМА, без
 * участия того, кто в этот момент открыл экран.
 */
import { buildCapabilities, type CapabilitySources, type OverlayReader } from './registry'
import type { Capability } from '../../shared/contracts/capability'
import type { CapabilityOverlayStore } from '../storage/capability-overlay'

export interface CapabilityService {
  list: () => Capability[]
  get: (id: string) => Capability | null
  /** Причина текущего уровня доверия — человек видит основание, а не только цифру. */
  reason: (id: string) => string | null
}

export function createCapabilityService(
  readSources: () => CapabilitySources,
  overlay: CapabilityOverlayStore
): CapabilityService {
  const read: OverlayReader = id => overlay.get(id)

  const listAll = (): Capability[] => {
    const caps = buildCapabilities(readSources(), read)
    // Записываем увиденную версию ПОСЛЕ сборки: сборка уже показала честный
    // уровень для этого содержимого, а отметка закрепляет понижение в БД, чтобы
    // оно пережило перезапуск и не зависело от следующего читателя.
    for (const cap of caps) overlay.observeVersion(cap.id, cap.version)
    return caps
  }

  return {
    list: listAll,
    get: id => listAll().find(c => c.id === id) ?? null,
    reason: id => overlay.reason(id),
  }
}
