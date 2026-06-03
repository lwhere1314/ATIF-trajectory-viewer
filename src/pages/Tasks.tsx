import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  Sparkles, ScrollText, Award, Table2, Globe, MonitorPlay, FileType2,
  MessagesSquare, Container, Code2, Layers, Gauge, Search, X, type LucideIcon,
} from 'lucide-react'
import { PageHeader } from '../components/Layout'
import { Loading, Pill } from '../components/ui'
import { FORMAT_LABELS, fmtPct } from '../lib/format'
import { useDatasetStore, visibleTasks } from '../lib/dataset'
import { useAuth } from '../lib/auth'
import type { Agent, Run, Task, Vendor } from '../lib/types'

const DIFFICULTY: Record<string, string> = {
  easy: 'bg-emerald-500/15 text-emerald-300',
  medium: 'bg-amber-500/15 text-amber-300',
  hard: 'bg-rose-500/15 text-rose-300',
}

interface Badge { key: string; Icon: LucideIcon; cls: string; title: string }

const LEGEND: Badge[] = [
  { key: 'aft', Icon: Sparkles, cls: 'bg-accent/15 text-accent', title: 'AFT analysis' },
  { key: 'log', Icon: ScrollText, cls: 'bg-sky-500/15 text-sky-300', title: 'Verifier log' },
  { key: 'reward', Icon: Award, cls: 'bg-emerald-500/15 text-emerald-300', title: 'Graded / reward' },
  { key: 'sheet', Icon: Table2, cls: 'bg-emerald-500/15 text-emerald-300', title: 'Spreadsheet' },
  { key: 'web', Icon: Globe, cls: 'bg-sky-500/15 text-sky-300', title: 'Web page' },
  { key: 'screen', Icon: MonitorPlay, cls: 'bg-violet-500/15 text-violet-300', title: 'Computer-use / screenshots' },
  { key: 'doc', Icon: FileType2, cls: 'bg-violet-500/15 text-violet-300', title: 'Document' },
  { key: 'chat', Icon: MessagesSquare, cls: 'bg-sky-500/15 text-sky-300', title: 'Simulated-user conversation' },
  { key: 'env', Icon: Container, cls: 'bg-amber-500/15 text-amber-300', title: 'Dockerfile environment' },
  { key: 'code', Icon: Code2, cls: 'bg-zinc-500/15 text-zinc-300', title: 'Code / diff files' },
  { key: 'multi', Icon: Layers, cls: 'bg-zinc-500/15 text-zinc-300', title: 'Multiple runs' },
  { key: 'metrics', Icon: Gauge, cls: 'bg-zinc-500/15 text-zinc-400', title: 'Metrics-only (no trajectory)' },
]

/** Detect which viewer features/components a task supports, from its runs + files. */
function taskBadges(task: Task, runs: Run[], aftIds: Set<string>): Badge[] {
  const b: Badge[] = []
  const editKinds = new Set<string>()
  let hasSteps = false
  for (const r of runs) {
    // Lazy runs carry stepCount but an empty inline steps array (the trajectory
    // lives in public/runs/<id>.json); uploaded/tour runs keep steps inline.
    if (r.stepCount > 0 || r.steps.length) hasSteps = true
    for (const s of r.steps) for (const e of s.edits ?? []) editKinds.add(e.t)
  }
  const has = (t: string) => editKinds.has(t)
  const fileKind = (k: string) => task.files.some((f) => f.kind === k)

  if (runs.some((r) => aftIds.has(r.id))) b.push({ key: 'aft', Icon: Sparkles, cls: 'bg-accent/15 text-accent', title: 'AFT analysis available' })
  if (runs.some((r) => r.grade?.summary || r.failureReason)) b.push({ key: 'log', Icon: ScrollText, cls: 'bg-sky-500/15 text-sky-300', title: 'Verifier log' })
  if (runs.some((r) => r.reward != null)) b.push({ key: 'reward', Icon: Award, cls: 'bg-emerald-500/15 text-emerald-300', title: 'Graded / reward' })
  if (has('sheet') || has('formula') || fileKind('spreadsheet')) b.push({ key: 'sheet', Icon: Table2, cls: 'bg-emerald-500/15 text-emerald-300', title: 'Spreadsheet' })
  if (has('web')) b.push({ key: 'web', Icon: Globe, cls: 'bg-sky-500/15 text-sky-300', title: 'Web page' })
  if (has('screenshot') || has('computer')) b.push({ key: 'screen', Icon: MonitorPlay, cls: 'bg-violet-500/15 text-violet-300', title: 'Computer-use / screenshots' })
  if (has('doc')) b.push({ key: 'doc', Icon: FileType2, cls: 'bg-violet-500/15 text-violet-300', title: 'Document' })
  if (runs.some((r) => r.multiUser || r.steps.filter((s) => s.role === 'user').length > 1)) b.push({ key: 'chat', Icon: MessagesSquare, cls: 'bg-sky-500/15 text-sky-300', title: 'Simulated-user conversation' })
  if (task.files.some((f) => /dockerfile|docker-compose/i.test(f.path))) b.push({ key: 'env', Icon: Container, cls: 'bg-amber-500/15 text-amber-300', title: 'Dockerfile environment' })
  if (fileKind('code') || fileKind('diff')) b.push({ key: 'code', Icon: Code2, cls: 'bg-zinc-500/15 text-zinc-300', title: 'Code / diff files' })
  if (runs.length > 1) b.push({ key: 'multi', Icon: Layers, cls: 'bg-zinc-500/15 text-zinc-300', title: `${runs.length} runs` })
  if (runs.length > 0 && !hasSteps) b.push({ key: 'metrics', Icon: Gauge, cls: 'bg-zinc-500/15 text-zinc-400', title: 'Metrics-only (no trajectory)' })
  return b
}

function searchFold(value: string) {
  return value.toLowerCase().replace(/[_./:-]+/g, ' ')
}

function metadataText(metadata?: Record<string, unknown>) {
  if (!metadata) return ''
  try {
    return JSON.stringify(metadata)
  } catch {
    return Object.values(metadata).map(String).join(' ')
  }
}

function taskSearchText(task: Task, runs: Run[], agents: Map<string, Agent>, vendor?: Vendor) {
  const agentText = runs.flatMap((run) => {
    const agent = agents.get(run.agentId)
    return [
      run.id,
      run.status,
      run.failureReason,
      agent?.harness,
      agent?.model,
      agent?.family,
    ]
  })

  return [
    task.id,
    task.title,
    task.category,
    task.difficulty,
    task.source,
    FORMAT_LABELS[task.source],
    vendor?.name,
    task.instruction,
    metadataText(task.metadata),
    ...task.files.map((f) => `${f.path} ${f.kind} ${f.language ?? ''}`),
    ...agentText,
  ].filter(Boolean).join(' ')
}

function taskMatchesSearch(task: Task, query: string, runs: Run[], agents: Map<string, Agent>, vendor?: Vendor) {
  const tokens = searchFold(query).trim().split(/\s+/).filter(Boolean)
  if (!tokens.length) return true

  const text = taskSearchText(task, runs, agents, vendor)
  const raw = text.toLowerCase()
  const folded = searchFold(text)
  return tokens.every((token) => raw.includes(token) || folded.includes(token))
}

export default function Tasks() {
  const { data, error } = useDatasetStore()
  const { isMember } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [aftIds, setAftIds] = useState<Set<string>>(new Set())
  const query = searchParams.get('q') ?? ''

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}aft/index.json`)
      .then((r) => (r.ok ? r.json() : []))
      .then((ids: string[]) => setAftIds(new Set(ids)))
      .catch(() => {})
  }, [])

  const runsByTask = useMemo(() => {
    const m = new Map<string, Run[]>()
    data?.runs.forEach((r) => { const a = m.get(r.taskId) ?? []; a.push(r); m.set(r.taskId, a) })
    return m
  }, [data])

  const agentsById = useMemo(() => new Map(data?.agents.map((a) => [a.id, a]) ?? []), [data])
  const vendorsById = useMemo(() => new Map(data?.vendors.map((v) => [v.id, v]) ?? []), [data])

  if (error) return <div className="p-8 text-rose-400">Failed to load dataset: {error}</div>
  if (!data) return <Loading />

  const tasks = visibleTasks(data, isMember)
  const trimmedQuery = query.trim()
  const filteredTasks = trimmedQuery
    ? tasks.filter((task) => taskMatchesSearch(task, trimmedQuery, runsByTask.get(task.id) ?? [], agentsById, vendorsById.get(task.vendorId)))
    : tasks

  const updateQuery = (next: string) => {
    const params = new URLSearchParams(searchParams)
    if (next.trim()) params.set('q', next)
    else params.delete('q')
    setSearchParams(params, { replace: true })
  }

  // group: vendor -> category -> tasks
  const byVendor = new Map<string, Map<string, Task[]>>()
  for (const t of filteredTasks) {
    const cat = t.category?.trim() || 'Other'
    if (!byVendor.has(t.vendorId)) byVendor.set(t.vendorId, new Map())
    const cats = byVendor.get(t.vendorId)!
    if (!cats.has(cat)) cats.set(cat, [])
    cats.get(cat)!.push(t)
  }

  return (
    <>
      <PageHeader
        title="Tasks"
        subtitle={trimmedQuery
          ? `${filteredTasks.length} of ${tasks.length} tasks · grouped by source · environment/category`
          : `${tasks.length} tasks · grouped by source · environment/category`}
      />
      <div className="space-y-6 p-8">
        <section className="card p-3">
          <label className="relative block">
            <Search size={17} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
            <input
              type="search"
              value={query}
              onChange={(event) => updateQuery(event.target.value)}
              placeholder="Search tasks, ids, models, files..."
              aria-label="Search tasks"
              className="h-11 w-full rounded-lg border border-ink-700 bg-ink-950/70 pl-10 pr-11 text-sm text-zinc-100 outline-none transition-colors placeholder:text-zinc-600 focus:border-accent/70 focus:ring-2 focus:ring-accent/20"
            />
            {query && (
              <button
                type="button"
                onClick={() => updateQuery('')}
                aria-label="Clear search"
                title="Clear search"
                className="absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-zinc-500 hover:bg-ink-800 hover:text-zinc-200"
              >
                <X size={15} />
              </button>
            )}
          </label>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            <span>{trimmedQuery ? `${filteredTasks.length} matches` : `${tasks.length} tasks indexed`}</span>
            {trimmedQuery && <Pill className="max-w-full truncate bg-accent/15 text-accent">{trimmedQuery}</Pill>}
          </div>
        </section>

        <details className="text-xs text-zinc-500">
          <summary className="cursor-pointer hover:text-zinc-300">What the task badges mean</summary>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
            {LEGEND.map((l) => (
              <span key={l.key} className="flex items-center gap-1.5">
                <span className={'grid h-5 w-5 place-items-center rounded ' + l.cls}><l.Icon size={12} /></span>
                {l.title}
              </span>
            ))}
          </div>
        </details>

        {filteredTasks.length === 0 && (
          <section className="card p-8 text-center">
            <h2 className="text-sm font-medium text-white">No matching tasks</h2>
            <p className="mt-1 text-sm text-zinc-500">Try a task id, model name, category, or file path.</p>
            <button type="button" onClick={() => updateQuery('')} className="btn-ghost mt-4">
              Clear search
            </button>
          </section>
        )}

        {data.vendors.map((vendor) => {
          const cats = byVendor.get(vendor.id)
          if (!cats) return null
          const vendorTaskCount = [...cats.values()].reduce((n, ts) => n + ts.length, 0)
          const isCollapsed = collapsed[vendor.id]
          return (
            <section key={vendor.id} className="card overflow-hidden">
              <button
                onClick={() => setCollapsed((c) => ({ ...c, [vendor.id]: !c[vendor.id] }))}
                className="flex w-full items-center gap-3 bg-ink-800/50 px-5 py-3 text-left hover:bg-ink-800"
              >
                <span className="text-zinc-500">{isCollapsed ? '▸' : '▾'}</span>
                <span className="font-semibold text-white">{vendor.name}</span>
                <span className="text-xs text-zinc-500">
                  {cats.size} {cats.size === 1 ? 'group' : 'groups'} · {vendorTaskCount} tasks
                </span>
              </button>

              {!isCollapsed && (
                <div className="divide-y divide-ink-800">
                  {vendor.coverage && (
                    <div className="bg-ink-900/40 px-5 py-2.5 text-xs leading-relaxed text-zinc-400">
                      <span className="mr-1.5 font-medium uppercase tracking-wide text-zinc-500">Coverage</span>
                      {vendor.coverage}
                    </div>
                  )}
                  {[...cats.entries()].map(([cat, ts]) => (
                    <div key={cat} className="px-5 py-4">
                      <div className="mb-3 flex items-center gap-2">
                        <h3 className="text-sm font-medium uppercase tracking-wide text-zinc-400">{cat}</h3>
                        <span className="text-xs text-zinc-600">{ts.length}</span>
                      </div>
                      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                        {ts.map((task) => {
                          const taskRuns = runsByTask.get(task.id) ?? []
                          const runCount = taskRuns.length
                          const passRate = runCount ? taskRuns.filter((r) => r.passed).length / runCount : 0
                          const badges = taskBadges(task, taskRuns, aftIds)
                          return (
                            <Link
                              key={task.id}
                              to={`/tasks/${task.id}`}
                              className="flex flex-col rounded-lg border border-ink-700 p-4 transition-colors hover:border-accent/50 hover:bg-ink-800/40"
                            >
                              <div className="flex flex-wrap items-center gap-1.5">
                                <Pill>{FORMAT_LABELS[task.source]}</Pill>
                                {task.difficulty && (
                                  <Pill className={DIFFICULTY[task.difficulty.toLowerCase()] ?? ''}>
                                    {task.difficulty}
                                  </Pill>
                                )}
                              </div>
                              <h4 className="mt-2 line-clamp-2 text-sm font-medium text-white">{task.title}</h4>
                              {badges.length > 0 && (
                                <div className="mt-2 flex flex-wrap gap-1">
                                  {badges.map((bd) => (
                                    <span key={bd.key} title={bd.title}
                                      className={'grid h-5 w-5 place-items-center rounded ' + bd.cls}>
                                      <bd.Icon size={12} />
                                    </span>
                                  ))}
                                </div>
                              )}
                              <div className="mt-auto flex items-center justify-between border-t border-ink-800 pt-2.5 text-xs text-zinc-500">
                                <span>{task.files.length} files</span>
                                <span>{runCount} runs</span>
                                <span>
                                  {runCount ? <>pass <span className="text-zinc-300">{fmtPct(passRate)}</span></> : 'no runs'}
                                </span>
                              </div>
                            </Link>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )
        })}
      </div>
    </>
  )
}
