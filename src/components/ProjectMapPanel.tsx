import { useEffect, useMemo, useState, useCallback } from 'react'
import { useProject } from '../store/projectStore'
import type { ProjectMapDTO, DependencyMapDTO, ProjectFileEntryDTO } from '../types/api'

/**
 * Панель «Карта проекта» — видимое окно той самой карты, что фоном строится
 * при открытии проекта (warmProjectMaps) и инжектится в контекст агента.
 *
 * Показывает:
 *   (а) дерево файлов, сгруппированное по top-level папкам, с числом файлов
 *       и строк; символы файла раскрываются по клику;
 *   (б) граф зависимостей: узлы = файлы, рёбра = imports. Хабы (много
 *       importedBy) крупнее и ярче — это архитектурные опоры.
 *
 * Данные — через window.api.projectMap (тёплый кэш после warm на открытии).
 * Кнопка «Обновить» форсит refresh=true (полная пересборка обеих карт).
 */

// ── Граф: сколько хабов показывать и сколько соседей у каждого ──
const MAX_HUBS = 8
const MAX_NEIGHBORS = 6

interface HubNode {
  path: string
  importedBy: number
  imports: string[]
}

/** Топ-хабы графа: файлы с наибольшим числом importedBy. */
function computeHubs(dep: DependencyMapDTO): HubNode[] {
  const hubs: HubNode[] = []
  for (const [path, info] of Object.entries(dep.files)) {
    if (info.importedBy.length > 0) {
      hubs.push({ path, importedBy: info.importedBy.length, imports: info.imports })
    }
  }
  hubs.sort((a, b) => b.importedBy - a.importedBy || a.path.localeCompare(b.path))
  return hubs.slice(0, MAX_HUBS)
}

/** Короткое имя файла для подписи узла (basename без расширения, обрезка). */
function shortName(path: string): string {
  const base = path.split('/').pop() ?? path
  const noExt = base.replace(/\.(tsx?|jsx?|mjs|cjs)$/, '')
  return noExt.length > 16 ? noExt.slice(0, 15) + '…' : noExt
}

interface GraphLayout {
  nodes: Array<{ id: string; x: number; y: number; r: number; label: string; title: string; hub: boolean }>
  edges: Array<{ from: string; to: string }>
  width: number
  height: number
}

/**
 * Простой слоистый layout: хабы в центральном столбце, их прямые соседи
 * (importedBy) — вокруг. Не force-directed (не нужно), но читаемо: видно
 * кто опора и кто от него зависит.
 */
function layoutGraph(dep: DependencyMapDTO): GraphLayout | null {
  const hubs = computeHubs(dep)
  if (hubs.length === 0) return null

  const colGap = 230
  const rowGap = 64
  const padX = 90
  const padY = 44

  const nodes: GraphLayout['nodes'] = []
  const edges: GraphLayout['edges'] = []
  const placed = new Set<string>()

  // Радиус хаба пропорционален числу импортов (8..22).
  const maxImp = Math.max(...hubs.map(h => h.importedBy), 1)
  const hubX = padX + colGap

  hubs.forEach((hub, i) => {
    const y = padY + i * (rowGap + 8)
    const r = 8 + Math.round((hub.importedBy / maxImp) * 14)
    nodes.push({ id: hub.path, x: hubX, y, r, label: shortName(hub.path), title: `${hub.path} · импортируют ×${hub.importedBy}`, hub: true })
    placed.add(hub.path)
  })

  // Соседи слева: те, кто импортирует хаб (importedBy). Берём по MAX_NEIGHBORS.
  const neighborX = padX
  let neighborRow = 0
  for (const hub of hubs) {
    const importers = (dep.files[hub.path]?.importedBy ?? []).slice(0, MAX_NEIGHBORS)
    for (const imp of importers) {
      if (!placed.has(imp)) {
        const y = padY + neighborRow * rowGap
        nodes.push({ id: imp, x: neighborX, y, r: 5, label: shortName(imp), title: imp, hub: false })
        placed.add(imp)
        neighborRow++
      }
      edges.push({ from: imp, to: hub.path })
    }
  }

  const maxY = Math.max(padY, ...nodes.map(n => n.y)) + padY
  const width = hubX + colGap
  const height = Math.max(maxY, 200)
  return { nodes, edges, width, height }
}

// ── Дерево файлов, сгруппированное по top-level папке ──
interface FolderGroup {
  top: string
  files: ProjectFileEntryDTO[]
  totalLines: number
}

function groupByTopFolder(map: ProjectMapDTO): FolderGroup[] {
  const groups = new Map<string, ProjectFileEntryDTO[]>()
  for (const f of map.files) {
    const top = f.path.includes('/') ? f.path.split('/')[0] : '(root)'
    if (!groups.has(top)) groups.set(top, [])
    groups.get(top)!.push(f)
  }
  return Array.from(groups.entries())
    .map(([top, files]) => ({ top, files, totalLines: files.reduce((s, f) => s + f.lines, 0) }))
    .sort((a, b) => b.files.length - a.files.length || a.top.localeCompare(b.top))
}

function DependencyGraph({ dep }: { dep: DependencyMapDTO }) {
  const layout = useMemo(() => layoutGraph(dep), [dep])
  if (!layout) {
    return <div className="gg-panel-empty">Связей между файлами не найдено.</div>
  }
  const pos = new Map(layout.nodes.map(n => [n.id, n]))
  return (
    <div className="gg-pmap-graph-wrap">
      <svg
        className="gg-pmap-graph"
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        width={layout.width}
        height={layout.height}
        preserveAspectRatio="xMinYMin meet"
      >
        {/* Рёбра: importer → hub */}
        {layout.edges.map((e, i) => {
          const a = pos.get(e.from)
          const b = pos.get(e.to)
          if (!a || !b) return null
          return (
            <line
              key={i}
              x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              className="gg-pmap-edge"
            />
          )
        })}
        {/* Узлы */}
        {layout.nodes.map(n => (
          <g key={n.id} className={`gg-pmap-node ${n.hub ? 'is-hub' : ''}`}>
            <title>{n.title}</title>
            <circle cx={n.x} cy={n.y} r={n.r} />
            <text x={n.x + n.r + 5} y={n.y + 3}>{n.label}</text>
          </g>
        ))}
      </svg>
    </div>
  )
}

export function ProjectMapPanel() {
  const path = useProject(s => s.path)
  const [map, setMap] = useState<ProjectMapDTO | null>(null)
  const [dep, setDep] = useState<DependencyMapDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set())
  const [openSymbols, setOpenSymbols] = useState<Set<string>>(new Set())
  // Граф зависимостей свёрнут по умолчанию — см. комментарий у разметки.
  const [graphOpen, setGraphOpen] = useState(false)

  const load = useCallback(async (refresh: boolean) => {
    if (!path) return
    if (refresh) setRefreshing(true)
    else setLoading(true)
    try {
      const [m, d] = await Promise.all([
        window.api.projectMap.get(path, refresh),
        window.api.projectMap.deps(path, refresh)
      ])
      setMap(m)
      setDep(d)
    } catch {
      /* IPC может быть недоступен в dev — панель покажет пусто */
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [path])

  // На открытии панели / смене проекта — читаем тёплый кэш (warm на открытии
  // уже запущен на сервере, так что обычно карта готова мгновенно).
  useEffect(() => {
    setMap(null)
    setDep(null)
    void load(false)
  }, [load])

  const groups = useMemo(() => (map ? groupByTopFolder(map) : []), [map])

  /** Итог графа строкой — считается из ТОГО ЖЕ layoutGraph, что и рисует граф.
   *  Иначе заголовок однажды скажет «12 связей» там, где картинка пуста: два
   *  независимых счёта расходятся молча. */
  const graphSummary = useMemo(() => {
    const layout = dep ? layoutGraph(dep) : null
    if (!layout || layout.nodes.length === 0) return { empty: true, label: 'связей не найдено' }
    const hubs = layout.nodes.filter(n => n.hub).length
    return { empty: false, label: `${hubs} узл. · ${layout.edges.length} связ.` }
  }, [dep])

  function toggleFolder(top: string) {
    setOpenFolders(prev => {
      const next = new Set(prev)
      next.has(top) ? next.delete(top) : next.add(top)
      return next
    })
  }
  function toggleSymbols(p: string) {
    setOpenSymbols(prev => {
      const next = new Set(prev)
      next.has(p) ? next.delete(p) : next.add(p)
      return next
    })
  }
  function reveal(relPath: string) {
    if (!path) return
    const abs = `${path}/${relPath}`.replace(/\//g, '\\')
    void window.api.files.revealInExplorer(abs).catch(() => {})
  }

  if (!path) {
    return (
      <div className="gg-panel">
        <div className="gg-panel-empty" style={{ marginTop: 80 }}>Открой проект чтобы видеть карту</div>
      </div>
    )
  }

  return (
    <div className="gg-panel">
      <div className="gg-panel-header">
        <h2 className="gg-panel-title">Карта проекта</h2>
        <div className="gg-panel-meta">
          {map
            ? `${map.stats.totalFiles} файлов (${map.stats.codeFiles} с кодом) · ${map.stats.totalLines} строк${map.stats.truncated ? ' · усечено' : ''}`
            : 'Строю карту проекта…'}
        </div>
      </div>

      <div className="gg-inspector-toolbar">
        <div className="gg-agents-toolbar-spacer" />
        <button className="gg-btn gg-btn-ghost" onClick={() => void load(true)} disabled={refreshing} title="Пересобрать карту и граф">
          {refreshing ? '…' : '↻ Обновить'}
        </button>
      </div>

      <div className="gg-panel-body">
        {loading && !map && <div className="gg-panel-empty">Строю карту проекта…</div>}

        {map && (
          <>
            {/* Дерево файлов по top-level папкам — ПЕРВЫМ.
                До 22.08 верх экрана занимал граф зависимостей, а структура уходила под
                него. Живая проверка на клиентском проекте (351 файл, 71 с кодом, у
                большинства разделов «0 строк» — креативы, отчёты, логи) показала: граф
                там технически верен и практически бесполезен, а полезное вытеснено вниз.
                Структура папок осмысленна для ЛЮБОГО проекта, граф — только для кода, и
                продукт не может знать заранее какой перед ним. Поэтому порядок обратный,
                а решение «нужен ли граф» не выносится человеку вопросом: он свёрнут,
                итог виден строкой, разворачивается одним кликом. */}
            <div className="gg-pmap-section-title">Структура ({groups.length} разделов)</div>
            <div className="gg-pmap-tree">
              {groups.map(g => {
                const open = openFolders.has(g.top)
                return (
                  <div key={g.top} className="gg-pmap-folder">
                    <button className="gg-pmap-folder-head" onClick={() => toggleFolder(g.top)}>
                      <span className="gg-pmap-caret">{open ? '▾' : '▸'}</span>
                      <span className="gg-pmap-folder-name">{g.top}/</span>
                      <span className="gg-pmap-folder-meta">{g.files.length} файлов · {g.totalLines} строк</span>
                    </button>
                    {open && (
                      <div className="gg-pmap-files">
                        {g.files.map(f => {
                          const hasSyms = f.symbols.length > 0
                          const symOpen = openSymbols.has(f.path)
                          return (
                            <div key={f.path} className="gg-pmap-file">
                              <div className="gg-pmap-file-row">
                                <button
                                  className="gg-pmap-file-name"
                                  onClick={() => hasSyms && toggleSymbols(f.path)}
                                  title={hasSyms ? 'Показать символы' : f.path}
                                >
                                  {hasSyms && <span className="gg-pmap-caret">{symOpen ? '▾' : '▸'}</span>}
                                  <span className="gg-pmap-file-label">{f.path}</span>
                                  {f.lines > 0 && <span className="gg-pmap-file-lines">{f.lines}L</span>}
                                </button>
                                <button className="gg-pmap-file-reveal" title="Показать в проводнике" onClick={() => reveal(f.path)}>↗</button>
                              </div>
                              {symOpen && hasSyms && (
                                <div className="gg-pmap-symbols">
                                  {f.symbols.map(s => (
                                    <span key={`${s.kind}:${s.name}`} className="gg-pmap-symbol">
                                      <span className="gg-pmap-symbol-kind">{s.kind}</span> {s.name}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {/* Граф зависимостей — вторым и свёрнутым. Заголовок сам говорит, есть ли
                что показывать: разворачивать пустоту незачем. */}
            <button
              className="gg-pmap-section-title gg-pmap-graph-toggle"
              onClick={() => setGraphOpen(o => !o)}
              disabled={graphSummary.empty}
              title={graphSummary.empty ? 'Связей между файлами не найдено' : 'Показать граф зависимостей'}
            >
              <span className="gg-pmap-caret">{graphSummary.empty ? '·' : graphOpen ? '▾' : '▸'}</span>
              {' '}Граф зависимостей
              <span className="gg-pmap-folder-meta">{graphSummary.label}</span>
            </button>
            {graphOpen && !graphSummary.empty && dep && <DependencyGraph dep={dep} />}
          </>
        )}
      </div>
    </div>
  )
}
