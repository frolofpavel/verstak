export type StagingStep = 'setup' | 'payload' | 'verify' | 'done'

type StagingStepLabels = {
  updateStagingSetup: string
  updateStagingPayload: string
  updateStagingVerify: string
  updateStagingDone: string
}

export function formatStagingStepLabel(
  step: StagingStep | undefined,
  version: string,
  percent: number,
  labels: StagingStepLabels,
): string {
  const pct = String(Math.max(0, Math.min(100, Math.round(percent))))
  const v = version
  switch (step) {
    case 'payload':
      return labels.updateStagingPayload.replace('{version}', v).replace('{percent}', pct)
    case 'verify':
      return labels.updateStagingVerify.replace('{version}', v).replace('{percent}', pct)
    case 'done':
      return labels.updateStagingDone.replace('{version}', v).replace('{percent}', pct)
    case 'setup':
    default:
      return labels.updateStagingSetup.replace('{version}', v).replace('{percent}', pct)
  }
}