export type ComputerUseComposerActivationProof =
  | { kind: 'mouse'; x: number; y: number }
  | { kind: 'keyboard'; key: 'Enter' }

export function parseComputerUseComposerActivationProof(
  value: unknown,
): ComputerUseComposerActivationProof | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  if (source.kind === 'keyboard' && source.key === 'Enter') {
    return { kind: 'keyboard', key: 'Enter' }
  }
  if (
    source.kind === 'mouse'
    && Number.isSafeInteger(source.x)
    && Number.isSafeInteger(source.y)
  ) {
    return { kind: 'mouse', x: source.x as number, y: source.y as number }
  }
  return null
}
