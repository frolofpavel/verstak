import { describe, it, expect } from 'vitest'
import {
  EMPTY_COMPOSER_DRAFT,
  HELP_COMPOSER_DRAFT_KEY,
  isEmptyComposerDraft,
  projectChatDraftKey,
  pruneComposerDraftsForProject,
  resolveComposerDraftKey,
} from '../../src/lib/composer-drafts'

describe('composer-drafts', () => {
  it('ключ проектного чата включает путь и chatId', () => {
    expect(projectChatDraftKey('D:\\zapret', 42)).toBe('chat:D:\\zapret:42')
  })

  it('resolveComposerDraftKey: справка, проект, пусто', () => {
    expect(resolveComposerDraftKey({ helpMode: true, projectPath: 'D:\\a', activeChatId: 1 }))
      .toBe(HELP_COMPOSER_DRAFT_KEY)
    expect(resolveComposerDraftKey({ helpMode: false, projectPath: 'D:\\a', activeChatId: 5 }))
      .toBe('chat:D:\\a:5')
    expect(resolveComposerDraftKey({ helpMode: false, projectPath: null, activeChatId: 1 }))
      .toBeNull()
  })

  it('isEmptyComposerDraft учитывает пробелы', () => {
    expect(isEmptyComposerDraft({ text: '  ', attachments: [] })).toBe(true)
    expect(isEmptyComposerDraft({ text: 'hi', attachments: [] })).toBe(false)
  })

  it('pruneComposerDraftsForProject удаляет только черновики проекта', () => {
    const drafts = {
      'chat:D:\\a:1': { text: 'a', attachments: [] },
      'chat:D:\\b:2': { text: 'b', attachments: [] },
      [HELP_COMPOSER_DRAFT_KEY]: { text: 'help', attachments: [] },
    }
    const next = pruneComposerDraftsForProject(drafts, 'D:\\a')
    expect(next).toEqual({
      'chat:D:\\b:2': { text: 'b', attachments: [] },
      [HELP_COMPOSER_DRAFT_KEY]: { text: 'help', attachments: [] },
    })
    expect(pruneComposerDraftsForProject(drafts, 'D:\\c')).toBe(drafts)
  })

  it('EMPTY_COMPOSER_DRAFT — пустой шаблон', () => {
    expect(EMPTY_COMPOSER_DRAFT).toEqual({ text: '', attachments: [], appliedSkills: [] })
  })
})
