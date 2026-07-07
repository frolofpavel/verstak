import { describe, expect, it } from 'vitest'
import {
  FORBIDDEN_ENV_PREFIXES,
  isForbiddenEnvKey,
  isForbiddenPath
} from '../../electron/ai/secret-scanner'

describe('workspace dotenv guard', () => {
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

  it('keeps Verstak, ClawHub, and OpenClaw env prefixes out of agent context', () => {
    expect([...FORBIDDEN_ENV_PREFIXES]).toEqual(['VERSTAK_', 'CLAWHUB_', 'OPENCLAW_'])

    for (const prefix of FORBIDDEN_ENV_PREFIXES) {
      expect(isForbiddenEnvKey(`${prefix}API_KEY`), prefix).toBe(true)
      expect(isForbiddenEnvKey(` ${prefix}TOKEN`), prefix).toBe(true)
      expect(isForbiddenEnvKey(prefix.toLowerCase() + 'secret'), prefix).toBe(true)
    }

    expect(isForbiddenEnvKey('NODE_ENV')).toBe(false)
    expect(isForbiddenEnvKey('PUBLIC_BASE_URL')).toBe(false)
  })
})
