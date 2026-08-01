/**
 * VSK-PRODUCT-A1 шероховатость 3 (3b): КОД-СВОДКА чтения материалов.
 *
 * «Молчаливое „прочитал 2 из 5“» недопустимо. Сводку собирает НАШ код из
 * фактических исходов read-вызовов, а не сочиняет модель (просьбе к модели мы не
 * верим — доказано на директиве планов). Три категории плюс страховочная:
 *   · прочитано   — файл из набора, чтение успешно;
 *   · не смог     — файл из набора, чтение с ошибкой (причина);
 *   · не открывал — файл из набора, read по нему не вызывался;
 *   · вне набора  — read успешен, но файл НЕ из набора материалов.
 *
 * НАПРАВЛЕНИЕ ОШИБКИ (требование ревьюера). Если сопоставление read↔набор
 * промахнётся, прочитанный файл не найдёт пары и его файл-из-набора ложно уйдёт в
 * «не открывал» — сводка соврёт про НАШ успех в сторону тревоги. Ложный сигнал
 * дороже молчания. Поэтому пути нормализуются (регистр Windows + относительный →
 * абсолютный от базы), а несопоставленный УСПЕШНЫЙ read идёт в «вне набора», а не
 * исчезает и не превращается в «не открывал».
 */
import { resolve, isAbsolute } from 'node:path'

export interface ReadOutcome {
  /** Путь, по которому модель звала read (может быть относительным/другого регистра). */
  path: string
  ok: boolean
  /** Причина при ok=false — попадает в сводку. */
  reason?: string
}

export type MaterialsSource = 'attachments' | 'folder' | 'none'

export interface MaterialsSummary {
  source: MaterialsSource
  /** |M| — размер объявленного набора. */
  total: number
  read: string[]
  failed: { path: string; reason: string }[]
  notOpened: string[]
  readOutside: string[]
}

/** Нормализация для сопоставления: абсолютный путь от базы + регистр (Windows). */
function normalizePath(p: string, base: string): string {
  const abs = isAbsolute(p) ? resolve(p) : resolve(base, p)
  // Windows файловая система регистронезависима — сопоставляем без регистра.
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

export interface SummarizeInput {
  /** Набор материалов M (исходные пути — как объявлены: вложения/файлы папки). */
  materials: string[]
  /** База для разрешения относительных путей (корень проекта/папки). */
  base: string
  /** Фактические исходы read-вызовов хода. */
  outcomes: ReadOutcome[]
  source: MaterialsSource
}

export function summarizeMaterials(input: SummarizeInput): MaterialsSummary {
  const { materials, base, outcomes, source } = input
  // Индекс исходов по нормализованному пути. Для одного файла берём ЛУЧШИЙ исход:
  // успех важнее провала (модель могла сначала ошибиться, потом прочитать).
  const byNorm = new Map<string, ReadOutcome>()
  for (const o of outcomes) {
    const key = normalizePath(o.path, base)
    const prev = byNorm.get(key)
    if (!prev || (o.ok && !prev.ok)) byNorm.set(key, o)
  }
  const read: string[] = []
  const failed: { path: string; reason: string }[] = []
  const notOpened: string[] = []
  const matchedKeys = new Set<string>()

  for (const m of materials) {
    const key = normalizePath(m, base)
    const o = byNorm.get(key)
    if (o) matchedKeys.add(key)
    if (!o) notOpened.push(m)
    else if (o.ok) read.push(m)
    else failed.push({ path: m, reason: o.reason || 'не удалось прочитать' })
  }
  // Успешные read вне набора — отдельная категория, НЕ «не открывал».
  const readOutside: string[] = []
  for (const o of outcomes) {
    if (!o.ok) continue
    const key = normalizePath(o.path, base)
    if (!matchedKeys.has(key)) readOutside.push(o.path)
  }
  const uniqOutside = [...new Set(readOutside)]
  return { source, total: materials.length, read, failed, notOpened, readOutside: uniqOutside }
}

/**
 * Строка для потока чата. null — когда сказать НЕЧЕГО (ничего не провалилось и
 * ничего не осталось неоткрытым): «прочитано 5 из 5» на каждом прогоне это шум,
 * его выключат вместе с полезным. Граница набора названа явно (корень папки /
 * приложено), чтобы человек с материалами в подпапках не получил ту же тишину
 * этажом ниже.
 */
export function formatMaterialsLine(s: MaterialsSummary): string | null {
  if (s.failed.length === 0 && s.notOpened.length === 0) return null
  const head = s.source === 'folder'
    ? `В корне папки ${s.total} ${plural(s.total, 'документ', 'документа', 'документов')}`
    : s.source === 'attachments'
      ? `Приложено ${s.total} ${plural(s.total, 'файл', 'файла', 'файлов')}`
      : `Материалов ${s.total}`
  const parts: string[] = [`прочитано ${s.read.length}`]
  if (s.failed.length) {
    parts.push(`не удалось ${s.failed.length} (${s.failed.map(f => `${short(f.path)} — ${f.reason}`).join('; ')})`)
  }
  if (s.notOpened.length) {
    parts.push(`не открывал ${s.notOpened.length} (${s.notOpened.map(short).join(', ')})`)
  }
  if (s.readOutside.length) {
    parts.push(`прочитано вне набора ${s.readOutside.length}`)
  }
  return `${head}: ${parts.join(', ')}.`
}

function short(p: string): string {
  const parts = p.split(/[/\\]/)
  return parts[parts.length - 1] || p
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few
  return many
}
