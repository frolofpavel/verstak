import { createHash, timingSafeEqual } from 'node:crypto'

export type RelayRole = 'desktop' | 'mobile'
export interface RelayIdentity { accountId: string; deviceId: string; role: RelayRole }

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

export function verifyBearer(actual: string | undefined, expected: string): boolean {
  if (!actual?.startsWith('Bearer ')) return false
  const supplied = digest(actual.slice(7))
  const wanted = digest(expected)
  return timingSafeEqual(supplied, wanted)
}
