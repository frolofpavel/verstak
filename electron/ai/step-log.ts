/**
 * V2-5 (agent-runtime-v2.md §4) — наблюдаемость шага.
 *
 * ЕДИНСТВЕННЫЙ источник формата — `scripts/agent-step-log.mjs`, этот файл его
 * ре-экспортирует: одна и та же строка обязана получаться на десктопном пути и
 * на CLI-пути, иначе сравнивать прогоны между собой (ради чего строка и
 * заводится) было бы нельзя. Схема та же, что у V2-3 и V2-4.
 *
 * Новой шины нет: на десктопе строка едет существующим `agent_run_events`
 * (kind='step'), в CLI — существующим трейсом (`trace.steps`).
 */
export { formatStepLine } from '../../scripts/agent-step-log.mjs'
export type { StepLogCall, StepLogInput } from '../../scripts/agent-step-log.mjs'
