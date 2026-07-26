import { describe, expect, it } from 'vitest'
import {
  FORBIDDEN_ENV_PREFIXES,
  isForbiddenPath
} from '../../electron/ai/secret-scanner'

describe('workspace dotenv guard', () => {
  it('keeps Verstak, ClawHub, and OpenClaw env prefixes out of agent context', () => {
    expect([...FORBIDDEN_ENV_PREFIXES]).toEqual(['VERSTAK_', 'CLAWHUB_', 'OPENCLAW_'])
  })

  it('blocks dotenv files anywhere in the workspace path', () => {
    const paths = [
      '.env',
      '.env.local',
      '.env.production',
      'apps/api/.env',
      'apps/api/.env.verstak',
      'C:/work/project/.env',
      'C:\\work\\project\\.env.local'
    ]

    for (const path of paths) {
      expect(isForbiddenPath(path), path).toBe(true)
    }
  })

})
