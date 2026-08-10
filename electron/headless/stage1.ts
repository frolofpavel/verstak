// Состав инструментов Этапа 1 облачного Verstak (постановка online-verstak.md:
// «веб-чтение, коннекторы, артефакты, файлы workspace — БЕЗ shell/run_command/браузера»).
//
// Сознательно ЯВНЫЙ allowlist, а не deny-список поверх TOOL_DEFS: новый инструмент,
// добавленный в десктоп позже, НЕ просачивается на общий сервер молча (fail-closed).
// Исключены и почему:
//  - run_command / run_until_green / spawn_process / process_* / dev_server — shell;
//  - browser_* — требуют renderer/webview (Этап 2 — драйвер в песочнице);
//  - screen_* — desktopCapturer, на сервере бессмысленны;
//  - execute_code — vm-песочница, включается только с ОС-песочницей Этапа 2;
//  - delegate_* / orchestrate / swarm / oracle / new_task — мультиагент, отдельная постановка;
//  - review_diff / review_before_commit — тянут delegate;
//  - check_diagnostics / impact_analysis / find_definition / find_references —
//    child_process/LSP-серверы на хосте;
//  - create_proof_video — внешний ffmpeg (shell-класс).

export const STAGE1_TOOLS_ALLOW: string[] = [
  // Веб-чтение
  'web_fetch', 'web_search',
  // Коннекторы (op-политика read-only — connector-readonly.ts, гейт ctx.readOnlyConnectors)
  'list_connectors', 'connector_query',
  // Артефакты
  'render_chart', 'generate_html', 'generate_docx',
  // Файлы workspace: чтение
  'read_file', 'list_directory', 'find_files', 'search_project',
  'read_document', 'read_pdf', 'read_spreadsheet',
  'get_project_map', 'refresh_project_map',
  // Файлы workspace: запись (заперта path-policy + allowed_write_roots)
  'write_file', 'apply_patch', 'propose_edits', 'convert_file', 'edit_spreadsheet',
  // План/итог задачи
  'create_plan', 'replan_plan', 'submit_task_contract', 'report_step_outcome',
  'preflight', 'attest_verification',
  // Память/журнал/оргструктура прогона
  'read_journal', 'memory_save', 'memory_search', 'memory_invalidate', 'save_decision',
  'core_memory_update', 'core_memory_append', 'core_memory_replace', 'core_memory_remove',
  'checklist_add', 'checklist_complete', 'checklist_list',
  'todo_create', 'todo_update', 'todo_list',
  'conversation_search',
  // C1 (P5): расписание — фасад scheduledJobs есть только у headless-хоста
  'schedule'
]

/** Коннекторы, выключенные на общем сервере Этапа 1 (ssh = удалённый shell). */
export const STAGE1_CONNECTOR_DENY = new Set(['ssh'])
