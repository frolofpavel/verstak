// Детерминированное предложение coding-recipe по черновику задачи (Этап 4, Блок D).
// Чистая логика без React/IPC. ТОЛЬКО предложение через chip — без auto-run.
// Порядок правил = приоритет: первое совпадение выигрывает. Фоллбэк — small-edit.

export type RecipeId =
  | 'typescript-error'
  | 'test-fix'
  | 'bugfix'
  | 'refactor-safe'
  | 'review-before-commit'
  | 'small-edit'

interface Rule {
  id: Exclude<RecipeId, 'small-edit'>
  keywords: string[]
}

// Приоритет сверху вниз. Ключевые слова матчатся как подстроки по lower-case тексту.
const RULES: Rule[] = [
  { id: 'typescript-error', keywords: ['tsc', 'typescript', 'npm run type'] },
  { id: 'test-fix', keywords: ['test failed', 'vitest', 'jest', 'npm test'] },
  { id: 'bugfix', keywords: ['bug', 'broken', 'не работает', 'ошибка'] },
  { id: 'refactor-safe', keywords: ['refactor', 'cleanup', 'rename'] },
  { id: 'review-before-commit', keywords: ['review', 'commit', 'проверь перед коммитом'] },
]

/**
 * Возвращает id рекомендованного recipe по тексту задачи. Всегда что-то возвращает:
 * при отсутствии явного сигнала — 'small-edit' (безопасный дефолт мелкой правки).
 */
export function suggestRecipe(text: string): RecipeId {
  const t = (text || '').toLowerCase()
  for (const rule of RULES) {
    if (rule.keywords.some(k => t.includes(k))) return rule.id
  }
  return 'small-edit'
}

/**
 * Явный ли coding-интент (сработало конкретное правило, не фоллбэк small-edit).
 * Используется для гейта chip: small-edit по умолчанию НЕ навязываем, чтобы не
 * показывать предложение на каждый ввод.
 */
export function hasExplicitRecipeIntent(text: string): boolean {
  return suggestRecipe(text) !== 'small-edit'
}
