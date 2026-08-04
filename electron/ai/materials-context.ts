/**
 * VSK-PRODUCT-A1 3b (часть 2/2): вывод НАБОРА материалов (M) и источника на старте
 * прогона. Ядро сводки (materials-summary.ts) считает исходы; здесь — откуда берётся
 * САМ набор и его источник.
 *
 * У двух источников РАЗНАЯ ПРАВДА, и путать их нельзя:
 *  · ВЛОЖЕНИЯ — read-инструменты по ним НЕ вызываются вообще; docx разворачивается в
 *    текст на сервере (attachment-text), прочие документные типы доставляются модели
 *    инлайном. Исход берётся ИЗ КОНВЕЙЕРА, а не из tool-вызовов; категории «не открывал»
 *    у вложений НЕТ по построению (их не выбирают — они все пришли).
 *  · ПАПКА — M = документы В КОРНЕ выбранного каталога (без рекурсии); исходы трекаются
 *    read-вызовами в самом прогоне (runner-api), «не открывал» здесь осмысленно.
 */
import { readdirSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { ChatMessage } from './types'
import type { ReadOutcome } from './materials-summary'
import { extractOfficeAttachment, isOfficeAttachment } from './attachment-text'

/** Документные расширения набора (общие для папки и вложений). Совпадает с accept
 *  композера по документам; изображения материалами НЕ считаются. */
export const DOC_EXTENSIONS = new Set(['.docx', '.xlsx', '.pdf', '.txt', '.md', '.csv'])

export function isDocumentName(name: string): boolean {
  return DOC_EXTENSIONS.has(extname(name).toLowerCase())
}

/** Исходы КОНВЕЙЕРА вложений последнего пользовательского хода. null — документных
 *  вложений нет. Каждый материал получает исход → notOpened у вложений всегда пуст. */
export async function deriveAttachmentMaterials(
  lastUser: ChatMessage | null | undefined,
): Promise<{ items: string[]; outcomes: ReadOutcome[] } | null> {
  const atts = (lastUser?.attachments ?? []).filter(a => isOfficeAttachment(a) || isDocumentName(a.name))
  if (atts.length === 0) return null
  const items: string[] = []
  const outcomes: ReadOutcome[] = []
  for (const a of atts) {
    items.push(a.name)
    if (isOfficeAttachment(a)) {
      // docx/xlsx разворачиваются на сервере (mammoth/exceljs) — исход из конвейера.
      const res = await extractOfficeAttachment(a)
      outcomes.push(res.ok ? { path: a.name, ok: true } : { path: a.name, ok: false, reason: res.reason })
    } else {
      // pdf/txt/md/csv доставляются модели инлайном — считаем прочитанными.
      outcomes.push({ path: a.name, ok: true })
    }
  }
  return { items, outcomes }
}

/** Документы В КОРНЕ папки (без рекурсии), абсолютными путями, отсортированы.
 *  Граница набора НАМЕРЕННО плоская: материалы в подпапках в M не входят — строка
 *  сводки называет эту границу явно («В корне папки N документов»). */
export function listFolderMaterials(root: string): string[] {
  let entries: string[]
  try { entries = readdirSync(root) } catch { return [] }
  const out: string[] = []
  for (const name of entries) {
    if (!isDocumentName(name)) continue
    const abs = join(root, name)
    try { if (statSync(abs).isFile()) out.push(abs) } catch { /* недоступный элемент пропускаем */ }
  }
  return out.sort()
}

function pluralDocs(n: number): string {
  const m10 = n % 10, m100 = n % 100
  if (m10 === 1 && m100 !== 11) return 'документ'
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return 'документа'
  return 'документов'
}

/**
 * ЗАДАЧА 2, пункт 2: НАБОР материалов как ЯВНЫЙ ПЕРЕЧЕНЬ-ФАКТ для инъекции в контекст.
 *
 * Различие директива/данные — несущее (штаб): «прочитай все» — просьба, модели ей не
 * следуют (доказано на автопланах, §4.1); а вот ФАКТ «материалы задачи: эти пять, с
 * именами/типами/размерами» модель не может «не выполнить». Раньше файлы папки были
 * растворены в карте проекта наравне с чем угодно — модель не знала, что вот эти пять
 * назначены. Это не непослушание, а отсутствие информации; чиним информацией.
 *
 * СОДЕРЖИМОЕ файлов сюда НЕ кладём: на большой папке это разнесло бы контекст и деньги
 * (а счётчик расхода на дешёвых моделях врёт — docs/cache-audit-2026-08-05.md). Контент
 * читается read_file'ом, как сейчас. Строка-подсказка в конце — НЕ несущая: если модель
 * читает набор и без неё, её можно снять без последствий; гарантию даёт не она, а пункт 3
 * (недочитанное видно в сводке), см. materials-summary.ts.
 */
export function buildMaterialsManifest(items: string[]): string {
  if (items.length === 0) return ''
  const lines = [`## Материалы задачи (${items.length} ${pluralDocs(items.length)} в корне выбранной папки)`, '']
  for (const abs of items) {
    let sizeNote = ''
    try { sizeNote = ` · ${(statSync(abs).size / 1024).toFixed(1)} КБ` } catch { /* недоступен — без размера */ }
    const type = extname(abs).replace('.', '').toUpperCase() || '?'
    lines.push(`- ${basename(abs)} · ${type}${sizeNote}`)
  }
  lines.push('')
  // Подсказка НЕ несущая (см. док-строку выше): факт-перечень выше — вот что решает.
  lines.push('_Это назначенный набор материалов задачи — прочитай их (read_file) перед сборкой отчёта. Чего не прочтёшь, будет отмечено в сводке._')
  return lines.join('\n')
}

/** Дописать перечень-факт к ПОСЛЕДНЕМУ user-сообщению (первому, что увидит модель на
 *  этом ходе). Пусто/нет user — возвращаем как есть. Чистая функция для пина. */
export function appendMaterialsManifest(messages: ChatMessage[], manifest: string): ChatMessage[] {
  if (!manifest) return messages
  const idx = messages.map(m => m.role).lastIndexOf('user')
  if (idx < 0) return messages
  return messages.map((m, i) => i === idx ? { ...m, content: `${m.content}\n\n${manifest}` } : m)
}
