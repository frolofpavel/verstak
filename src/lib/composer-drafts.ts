import { HELP_PROJECT_PATH } from './help-scope'
import type { AppliedSkillRef, Attachment } from '../types/api'

export interface ComposerDraft {
  text: string
  attachments: Attachment[]
  appliedSkills?: AppliedSkillRef[]
}

export const EMPTY_COMPOSER_DRAFT: ComposerDraft = { text: '', attachments: [], appliedSkills: [] }

export const HELP_COMPOSER_DRAFT_KEY = `help:${HELP_PROJECT_PATH}`

export function projectChatDraftKey(projectPath: string, chatId: number): string {
  return `chat:${projectPath}:${chatId}`
}

export function resolveComposerDraftKey(opts: {
  helpMode: boolean
  projectPath: string | null
  activeChatId: number | null
}): string | null {
  if (opts.helpMode) return HELP_COMPOSER_DRAFT_KEY
  if (opts.projectPath && opts.activeChatId != null) {
    return projectChatDraftKey(opts.projectPath, opts.activeChatId)
  }
  return null
}

export function isEmptyComposerDraft(d: ComposerDraft): boolean {
  return !d.text.trim() && d.attachments.length === 0 && !(d.appliedSkills?.length)
}

const PROJECT_CHAT_DRAFT_PREFIX = 'chat:'

export function pruneComposerDraftsForProject(
  drafts: Record<string, ComposerDraft>,
  projectPath: string
): Record<string, ComposerDraft> {
  const prefix = `${PROJECT_CHAT_DRAFT_PREFIX}${projectPath}:`
  let changed = false
  const next: Record<string, ComposerDraft> = {}
  for (const [key, draft] of Object.entries(drafts)) {
    if (key.startsWith(prefix)) {
      changed = true
      continue
    }
    next[key] = draft
  }
  return changed ? next : drafts
}
