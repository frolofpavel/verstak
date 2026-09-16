/**
 * Shift+Esc may only make the renderer look stopped after main has waited for
 * every owned Computer helper lineage. A rejected/negative ACK deliberately
 * leaves the UI in its existing streaming state (fail closed).
 */
export async function settleEmergencyStop(
  stopAll: (sendId: number) => Promise<boolean>,
  resetRendererAfterAck: () => void,
): Promise<boolean> {
  try {
    const acknowledged = await stopAll(0)
    if (acknowledged !== true) return false
    resetRendererAfterAck()
    return true
  } catch {
    return false
  }
}
