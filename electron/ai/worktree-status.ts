import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

const GIT_REPO_ENV_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
  'GIT_NAMESPACE',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
]

export interface WorktreeGitState {
  dirty: boolean
  unpushed: boolean
  clean: boolean
  dirtyFiles?: number
  unpushedCommits?: number
}

export type WorktreeStatusErrorCode = 'not-git' | 'git-error'

export class WorktreeStatusError extends Error {
  code: WorktreeStatusErrorCode

  constructor(code: WorktreeStatusErrorCode, message: string) {
    super(message)
    this.name = 'WorktreeStatusError'
    this.code = code
  }
}

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of GIT_REPO_ENV_VARS) delete env[key]
  return env
}

async function git(worktreePath: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', worktreePath, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      env: gitEnv(),
    })
    return String(stdout)
  } catch (error) {
    const stderr = typeof error === 'object' && error != null && 'stderr' in error
      ? String((error as { stderr?: unknown }).stderr ?? '').trim()
      : ''
    throw new WorktreeStatusError('git-error', stderr || `git ${args.join(' ')} failed`)
  }
}

function countNonEmptyLines(text: string): number {
  return text.split(/\r?\n/).filter(line => line.trim().length > 0).length
}

export async function detectWorktreeState(worktreePath: string): Promise<WorktreeGitState> {
  let inside = ''
  try {
    inside = (await git(worktreePath, ['rev-parse', '--is-inside-work-tree'])).trim()
  } catch {
    throw new WorktreeStatusError('not-git', `not a git worktree: ${worktreePath}`)
  }

  if (inside !== 'true') {
    throw new WorktreeStatusError('not-git', `not a git worktree: ${worktreePath}`)
  }

  const dirtyOutput = await git(worktreePath, ['status', '--porcelain=v1'])
  const unpushedOutput = await git(worktreePath, ['log', 'HEAD', '--not', '--remotes', '--oneline'])
  const dirtyFiles = countNonEmptyLines(dirtyOutput)
  const unpushedCommits = countNonEmptyLines(unpushedOutput)
  const dirty = dirtyFiles > 0
  const unpushed = unpushedCommits > 0
  return {
    dirty,
    unpushed,
    clean: !dirty && !unpushed,
    dirtyFiles,
    unpushedCommits,
  }
}
