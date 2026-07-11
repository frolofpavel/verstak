import { basename, join } from 'node:path'
import { isForbiddenPath } from '../ai/secret-scanner'

export const MAX_MOBILE_ATTACHMENT_BYTES = 20 * 1024 * 1024
export function validateAttachment(input: { name: string; size: number; stagingDir: string }): { name: string; stagingPath: string } {
  const name = basename(input.name.trim())
  if (!name || name !== input.name || isForbiddenPath(name)) throw new Error('forbidden attachment name')
  if (!Number.isSafeInteger(input.size) || input.size < 0 || input.size > MAX_MOBILE_ATTACHMENT_BYTES) throw new Error('attachment is too large')
  return { name, stagingPath: join(input.stagingDir, `${crypto.randomUUID()}-${name}`) }
}
