/**
 * Core Memory — Hermes-style постоянная память агента.
 *
 * Два файла в папке .verstak/ активного проекта:
 *   MEMORY.md — заметки о проекте: конвенции, находки, контекст окружения.
 *   USER.md   — заметки о пользователе: предпочтения, стиль общения, правила.
 *
 * Core memory ВСЕГДА инжектируется в system prompt при каждом turn'е (в отличие
 * от архивной памяти, которая ищется один раз за app-сессию). Агент может
 * обновлять её через tools: core_memory_append / core_memory_replace / core_memory_remove.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { scanText } from './secret-scanner'

const MEMORY_FILE = 'MEMORY.md'
const USER_FILE = 'USER.md'
const MAX_MEMORY_CHARS = 2000
const MAX_USER_CHARS = 1500

export interface CoreMemoryBlocks {
  memory: string   // содержимое MEMORY.md
  user: string     // содержимое USER.md
}

/** Прочитать оба блока core memory для проекта. Возвращает пустые строки если файлы не существуют.
 *  Ре-ревью 2.0.0: редакция и на ЧТЕНИИ — core-memory инжектится в system prompt каждый turn,
 *  а файлы .verstak/MEMORY.md|USER.md можно писать в обход saveCoreMemoryBlock (write_file:
 *  isForbiddenPath на .md = false). Read-side scanText закрывает этот путь: что бы ни лежало
 *  на диске, в промпт (и в возвращаемый content) уходит редактированное. */
export function loadCoreMemory(projectPath: string): CoreMemoryBlocks {
  const dir = join(projectPath, '.verstak')
  const memoryPath = join(dir, MEMORY_FILE)
  const userPath = join(dir, USER_FILE)
  return {
    memory: existsSync(memoryPath) ? scanText(readFileSync(memoryPath, 'utf-8')).redacted : '',
    user: existsSync(userPath) ? scanText(readFileSync(userPath, 'utf-8')).redacted : ''
  }
}

/** Перезаписать один блок целиком (с ограничением по длине).
 *  2.0.0 security: core-memory инжектится в system prompt КАЖДЫЙ turn — секрет,
 *  записанный сюда агентом, утёк бы во все будущие сессии проекта и всем провайдерам.
 *  Единая точка записи (append/replace/remove идут через неё) редактирует секреты.
 *  Редакция идемпотентна ([REDACTED:*] не матчит паттерны повторно). */
export function saveCoreMemoryBlock(projectPath: string, block: 'memory' | 'user', content: string): void {
  const dir = join(projectPath, '.verstak')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const file = block === 'memory' ? MEMORY_FILE : USER_FILE
  const max = block === 'memory' ? MAX_MEMORY_CHARS : MAX_USER_CHARS
  const safe = scanText(content).redacted
  writeFileSync(join(dir, file), safe.slice(0, max), 'utf-8')
}

/**
 * Найти oldText в блоке и заменить на newText.
 * Возвращает { success: false } если oldText не найден — агент получит
 * ошибку и сможет перечитать текущее содержимое перед повторной попыткой.
 */
export function replaceCoreMemory(
  projectPath: string,
  block: 'memory' | 'user',
  oldText: string,
  newText: string
): { success: boolean; content: string } {
  const blocks = loadCoreMemory(projectPath)
  const current = block === 'memory' ? blocks.memory : blocks.user
  if (!current.includes(oldText)) return { success: false, content: current }
  // Ре-ревью 2: редактируем newText до записи — консистентная длина disk/return.
  const updated = current.replace(oldText, scanText(newText).redacted)
  saveCoreMemoryBlock(projectPath, block, updated)
  return { success: true, content: updated.slice(0, block === 'memory' ? MAX_MEMORY_CHARS : MAX_USER_CHARS) }
}

/**
 * Добавить текст в конец блока.
 *
 * При переполнении (>max) НЕ теряем факты обрезкой: эвакуируем СТАРЕЙШИЕ строки
 * (голову) в архив через onEvacuate (Hermes-style memory pressure — вытолкнуть
 * старое из core в archival, оставив новое), а не режем хвост с только что
 * добавленным фактом. Раньше `joined.slice(0,max)` держал начало и молча ронял
 * НОВЫЙ текст — реальная потеря данных (token-audit 01.07).
 *
 * @param onEvacuate — колбэк сохранения вытесненного в долговременную память (archival).
 */
export function appendCoreMemory(
  projectPath: string,
  block: 'memory' | 'user',
  rawText: string,
  onEvacuate?: (evacuated: string) => void
): { success: boolean; content: string; overflow: boolean; evacuated?: string } {
  const blocks = loadCoreMemory(projectPath)
  const current = block === 'memory' ? blocks.memory : blocks.user
  const max = block === 'memory' ? MAX_MEMORY_CHARS : MAX_USER_CHARS
  // Ре-ревью 2: редактируем ВХОД до всех расчётов длины. Иначе overflow решался по
  // сырой длине, а на диск шло scanText(joined) (редакция УДЛИНЯЕТ: --token X→[REDACTED:
  // cli-secret], +11) → slice(max) молча срезал хвост нового факта МИМО эвакуации
  // (реинтродукция потери данных). Теперь длина стабильна: current(редакт)+red — идемпотентно.
  const text = scanText(rawText).redacted
  const joined = current.length > 0 ? current + '\n' + text : text
  if (joined.length <= max) {
    saveCoreMemoryBlock(projectPath, block, joined)
    return { success: true, content: joined, overflow: false }
  }
  // Переполнение: режем по строкам, отрезаем старейшие (голову) пока хвост не влезет.
  const lines = joined.split('\n')
  const evacuated: string[] = []
  while (lines.join('\n').length > max && lines.length > 1) {
    evacuated.push(lines.shift()!)
  }
  let tail = lines.join('\n')
  // Вырожденный случай (ревью MEDIUM): единственная строка всё ещё длиннее max — НЕ
  // режем молча, а вытесняем хвост строки в архив тоже (иначе кусок нового факта терялся).
  if (tail.length > max) {
    evacuated.push(tail.slice(max))
    tail = tail.slice(0, max)
  }
  // Ре-ревью 2.0.0: эвакуированное идёт в архивную память (ctx.saveMemory storage —
  // БЕЗ scanText) и всплывает в recall других чатов → редактируем ЗДЕСЬ, у источника.
  const evacuatedText = scanText(evacuated.join('\n').trim()).redacted
  // АРХИВ-ПЕРВЫМ (ревью HIGH): сохраняем эвакуированное ДО обрезки core-файла. Если
  // onEvacuate кинул (напр. SQLITE_BUSY) — бросаем ДО saveCoreMemoryBlock, core-файл
  // остаётся ЦЕЛ (голова не потеряна). Раньше обрезали первым → падение saveMemory =
  // безвозвратная потеря вытесненного. Порядок критичен: не менять местами.
  if (evacuatedText && onEvacuate) onEvacuate(evacuatedText)
  saveCoreMemoryBlock(projectPath, block, tail)
  return { success: true, content: scanText(tail).redacted, overflow: true, evacuated: evacuatedText || undefined }
}

/**
 * Удалить фрагмент из блока.
 * Лишние пустые строки после удаления схлопываются.
 */
export function removeCoreMemory(
  projectPath: string,
  block: 'memory' | 'user',
  text: string
): { success: boolean; content: string } {
  const blocks = loadCoreMemory(projectPath)
  const current = block === 'memory' ? blocks.memory : blocks.user
  if (!current.includes(text)) return { success: false, content: current }
  const updated = current.replace(text, '').replace(/\n{3,}/g, '\n\n').trim()
  saveCoreMemoryBlock(projectPath, block, updated)
  // Ре-ревью 2: удаление разделителя между фрагментами склеивает соседей — может
  // СОЗДАТЬ секрет, которого не было в целых частях. Редактируем return (единая политика).
  return { success: true, content: scanText(updated).redacted }
}
