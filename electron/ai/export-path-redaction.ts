/**
 * Нормализация путей для безопасного экспорта — срез 2.0.11-C.
 *
 * Экспорт диалога человек отправляет наружу (code-review, багрепорт, архив). Абсолютные
 * пути раскрывают имя пользователя (`C:\Users\Pavel`), структуру машины и внутренние
 * сетевые шары (UNC). scanText чистит секреты, но НЕ пути — это отдельная утечка.
 *
 * СТРУКТУРНО, а не слепым regex по code blocks (требование карточки): заменяем ИЗВЕСТНЫЕ
 * корни — домашнюю папку и корни проектов, которые знаем точно, — и UNC по его чёткому
 * структурному маркеру `\\хост\шара`. Ничего не угадываем «на глаз»: угадывание ломало бы
 * легитимный текст и пропускало бы нестандартное.
 */

export interface PathRedactionContext {
  /** Домашняя папка пользователя (os.homedir()). Её вхождения → `~`. */
  homeDir?: string
  /** Корни известных проектов. Их вхождения → `<проект>`. */
  projectRoots?: string[]
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

/** Варианты одного корня в тексте: как есть и с прямыми слэшами (пути бывают forward-slash). */
function rootVariants(root: string): string[] {
  const back = root.replace(/\//g, '\\')
  const fwd = root.replace(/\\/g, '/')
  return back === fwd ? [back] : [back, fwd]
}

export function redactPathsForExport(text: string, ctx: PathRedactionContext): string {
  if (!text) return text

  // Правила: [корень, плейсхолдер]. Проекты раньше home — длинный корень заменяется первым,
  // иначе home «съел» бы начало пути проекта и замена на <проект> не сработала бы.
  const rules: Array<{ root: string; placeholder: string }> = []
  for (const r of ctx.projectRoots ?? []) if (r) rules.push({ root: r, placeholder: '<проект>' })
  if (ctx.homeDir) rules.push({ root: ctx.homeDir, placeholder: '~' })
  rules.sort((a, b) => b.root.length - a.root.length)

  let out = text
  for (const { root, placeholder } of rules) {
    for (const variant of rootVariants(root)) {
      // 'i' — регистронезависимо: диск может прийти как c:\ при home C:\ (Windows); риск
      // ложных замен мал, корни специфичны, а для приватности перестраховка уместна.
      out = out.replace(new RegExp(escapeRegExp(variant), 'gi'), placeholder)
    }
  }

  // UNC: `\\хост...` раскрывает имя внутреннего сервера. Маскируем ТОЛЬКО хост по
  // структурному маркеру, остальной путь/текст сохраняем. Хост — до разделителя, пробела
  // или конца строки: ловим и `\\хост\шара`, и голый `\\хост` (в конце / перед пробелом —
  // «ping \\FILESRV01»), который прежний вариант с обязательным разделителем пропускал (#3).
  //
  // ГРАНИЦА СЛЕВА (ре-ревью C, точность): настоящий UNC начинается с `\\` в НАЧАЛЕ токена
  // (слева — начало строки, пробел, кавычка, скобка). Экранированный backslash в коде
  // (`"C:\\Users"` в JSON, `\\d` в regex) имеет `\\` в СЕРЕДИНЕ токена (слева буква/`:`) —
  // его НЕ трогаем, иначе экспорт для code-review исказил бы легитимный код. Границу
  // сохраняем через $1.
  //
  // ГРАНИЦА СПРАВА: forward-slash UNC (`//хост`) не трогаем — слепая замена `//` сломала бы
  // `https://хост`. Нативная UNC-форма — backslash; forward-форму редко встретишь, а порча
  // URL хуже редкой утечки (ре-ревью C #4/#5, severity low).
  out = out.replace(/(^|[\s"'(=])\\\\[^\\/\s]+/g, '$1\\\\[скрыто]')

  return out
}
