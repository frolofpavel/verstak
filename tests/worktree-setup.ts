// Карточка #2 (класс 747e3e0): прямой (без pre-commit-хука) прогон git-heavy тестов наблюдался
// как выставляющий `core.bare=true` на ОСНОВНОМ репо verstak → последующие git-операции падали
// «must be run in a work tree». Причина класса — унаследованные GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE
// и т.п.: git-субпроцесс адресует ЧУЖОЙ (главный) репозиторий вместо temp-репо теста. Хук pre-commit
// уже снимает эти переменные (scripts/precommit.cjs, фикс 747e3e0); здесь делаем то же для ПРЯМЫХ
// прогонов — снимаем GIT_*-переменные из окружения worktree-воркеров ДО любых git-субпроцессов
// (пояс поверх подтяжек: тесты и продуктовый git() уже используют clean-env, это последний рубеж).
for (const k of [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
  'GIT_NAMESPACE',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
]) {
  delete process.env[k]
}
