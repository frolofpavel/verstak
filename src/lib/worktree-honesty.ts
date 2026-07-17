import { capabilitiesFor, type ProviderTransport } from '../../shared/contracts/provider'

/**
 * Честность изоляции и отката — honesty-срез (ре-ревью 2.0.11-B, находки #1/#3).
 *
 * Здесь решается, что интерфейс ИМЕЕТ ПРАВО пообещать. Вынесено из компонента, чтобы
 * правило проверялось тестами, а не глазами в jsdom.
 *
 * Обе ситуации — про одно: кнопка обещала то, чего движок не делает. Это дороже, чем
 * отсутствующая кнопка: человек уверен, что защищён, и узнаёт правду поздно.
 */

export interface IsolationTarget {
  transport: ProviderTransport
  supportsTools: boolean
  /** Человеческое имя провайдера — для причины отказа. */
  label: string
}

/**
 * Можно ли честно предложить изоляцию чата.
 *
 * Изоляция сделана подменой корня у НАШИХ file-тулзов. CLI-провайдер (Claude Code, Codex)
 * ходит своим бинарём с cwd реального проекта — правки пойдут в настоящий репозиторий,
 * а вывеска покажет «🌿 Изолировано». Правило считается тем же контрактом, что в main
 * (capabilitiesFor), а не второй копией.
 */
export function canIsolateChat(p: IsolationTarget): boolean {
  return capabilitiesFor(p.transport, p.supportsTools).worktreeIsolation
}

/** Почему изоляция недоступна. null — доступна. Текст читает человек, не разработчик. */
export function isolationBlockedReason(p: IsolationTarget): string | null {
  if (canIsolateChat(p)) return null
  if (p.transport !== 'API') {
    return `Изоляция недоступна на ${p.label}: он правит файлы сам, мимо Verstak — они пошли бы в реальный проект, а не в копию. Работает на API-провайдерах.`
  }
  // API без тулзов: агент файлы не пишет вовсе — изолировать нечего.
  return `${p.label} не правит файлы — изолировать нечего.`
}

/** Короткая подпись под кнопкой (в меню места мало). */
export function isolationBlockedHint(p: IsolationTarget): string | null {
  if (canIsolateChat(p)) return null
  return p.transport !== 'API'
    ? `недоступно на ${p.label} — правки шли бы в реальный проект`
    : `${p.label} не правит файлы`
}

/**
 * Почему откат ФАЙЛОВ недоступен. null — доступен.
 *
 * В изолированном чате правки живут в git-копии, а откат смотрит на основной проект: своё
 * не откатит, чужое (правки параллельного чата) откатит — и отрапортует успехом. Пока
 * механика не починена, честнее не давать нажать: у изоляции есть свой штатный откат.
 */
export function fileRevertBlockedReason(worktreeActive: boolean): string | null {
  if (!worktreeActive) return null
  return 'В изолированной сессии правки откатываются кнопкой «✕ Отбросить» над полем чата.'
}

/** Короткая подпись под кнопкой отката файлов. */
export function fileRevertBlockedHint(worktreeActive: boolean): string | null {
  return worktreeActive ? 'в изоляции — жми «✕ Отбросить» над чатом' : null
}
