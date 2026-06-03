import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { Play, RefreshCw, Server, Square, Terminal, Search } from 'lucide-react'
import { PageHeader } from '../components/Layout'
import { Pill } from '../components/ui'
import {
  getRunnerConfig,
  getRunnerLog,
  listRunnerRuns,
  listRunnerTasks,
  startRunnerRun,
  stopRunnerRun,
  type RunnerConfig,
  type RunnerRun,
} from '../lib/runnerApi'

const TOKEN_KEY = 'atif-runner-api-token'

function statusClass(status: string) {
  if (status === 'finished') return 'bg-emerald-500/15 text-emerald-300'
  if (status === 'running' || status === 'starting') return 'bg-sky-500/15 text-sky-300'
  if (status === 'stopping') return 'bg-amber-500/15 text-amber-300'
  if (status === 'error') return 'bg-rose-500/15 text-rose-300'
  return 'bg-ink-800 text-zinc-300'
}

function taskRow(run: RunnerRun) {
  const rows = run.state?.tasks ? Object.values(run.state.tasks) : []
  return rows[0] ?? null
}

function rewardOf(run: RunnerRun) {
  const row = taskRow(run)
  return row?.result_summary?.reward ?? row?.result_summary?.trial_results?.find((item) => item.reward != null)?.reward ?? null
}

export default function Runner() {
  const [config, setConfig] = useState<RunnerConfig | null>(null)
  const [runs, setRuns] = useState<RunnerRun[]>([])
  const [logRun, setLogRun] = useState<string | null>(null)
  const [logText, setLogText] = useState('')
  const [task, setTask] = useState('cancel-async-tasks')
  const [taskQuery, setTaskQuery] = useState('cancel')
  const [taskOptions, setTaskOptions] = useState<string[]>([])
  const [model, setModel] = useState('kimi-k2.5')
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) ?? '')
  const [forceRerun, setForceRerun] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const activeRun = useMemo(() => runs.find((run) => run.id === logRun) ?? runs[0] ?? null, [logRun, runs])

  const refresh = async () => {
    try {
      const [cfg, runList] = await Promise.all([getRunnerConfig(), listRunnerRuns()])
      setConfig(cfg)
      setRuns(runList.runs)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    refresh()
    const timer = window.setInterval(refresh, 5000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    listRunnerTasks(taskQuery).then((data) => setTaskOptions(data.tasks.slice(0, 20))).catch(() => setTaskOptions([]))
  }, [taskQuery])

  useEffect(() => {
    if (!activeRun) return
    getRunnerLog(activeRun.id).then(setLogText).catch((err) => setLogText(err instanceof Error ? err.message : String(err)))
    const timer = window.setInterval(() => {
      getRunnerLog(activeRun.id).then(setLogText).catch(() => {})
    }, 5000)
    return () => window.clearInterval(timer)
  }, [activeRun?.id])

  const saveToken = (value: string) => {
    setToken(value)
    localStorage.setItem(TOKEN_KEY, value)
  }

  const start = async () => {
    setBusy(true)
    try {
      const run = await startRunnerRun({ token, task, model, forceRerun })
      setLogRun(run.id)
      await refresh()
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const stop = async (run: RunnerRun) => {
    setBusy(true)
    try {
      await stopRunnerRun(run.id, token)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader
        title="Runner"
        subtitle="Start Terminal-Bench 2.1 Claude Code jobs and watch their live status."
        actions={
          <button
            onClick={refresh}
            className="inline-flex items-center gap-2 rounded-md border border-ink-700 px-3 py-2 text-sm text-zinc-300 hover:bg-ink-800"
          >
            <RefreshCw size={15} />
            Refresh
          </button>
        }
      />
      <div className="grid gap-6 p-8 xl:grid-cols-[420px_minmax(0,1fr)]">
        <section className="space-y-4">
          <div className="card p-5">
            <div className="mb-4 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">
              <Play size={16} />
              Start job
            </div>
            <div className="space-y-4">
              <label className="block">
                <span className="text-xs uppercase tracking-wide text-zinc-500">Task search</span>
                <div className="mt-1 flex items-center gap-2 rounded-md border border-ink-700 bg-ink-950 px-3">
                  <Search size={15} className="text-zinc-600" />
                  <input
                    value={taskQuery}
                    onChange={(event) => setTaskQuery(event.target.value)}
                    className="h-10 min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none"
                  />
                </div>
              </label>
              {taskOptions.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {taskOptions.map((name) => (
                    <button
                      key={name}
                      onClick={() => setTask(name)}
                      className={clsx('chip', task === name ? 'bg-accent/20 text-accent' : 'bg-ink-800 text-zinc-300 hover:bg-ink-700')}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              )}
              <label className="block">
                <span className="text-xs uppercase tracking-wide text-zinc-500">Task</span>
                <input
                  value={task}
                  onChange={(event) => setTask(event.target.value)}
                  className="mt-1 h-10 w-full rounded-md border border-ink-700 bg-ink-950 px-3 font-mono text-sm text-zinc-100 outline-none focus:border-accent"
                />
              </label>
              <label className="block">
                <span className="text-xs uppercase tracking-wide text-zinc-500">Model</span>
                <select
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  className="mt-1 h-10 w-full rounded-md border border-ink-700 bg-ink-950 px-3 text-sm text-zinc-100 outline-none focus:border-accent"
                >
                  <option value="kimi-k2.5">kimi-k2.5</option>
                  <option value="kimi-k2.6">kimi-k2.6</option>
                </select>
              </label>
              <label className="block">
                <span className="text-xs uppercase tracking-wide text-zinc-500">Runner API token</span>
                <input
                  value={token}
                  onChange={(event) => saveToken(event.target.value)}
                  placeholder={config?.hasToken ? 'Required by server' : 'Not required for localhost'}
                  type="password"
                  className="mt-1 h-10 w-full rounded-md border border-ink-700 bg-ink-950 px-3 text-sm text-zinc-100 outline-none focus:border-accent"
                />
              </label>
              <label className="flex items-center gap-2 text-sm text-zinc-400">
                <input type="checkbox" checked={forceRerun} onChange={(event) => setForceRerun(event.target.checked)} />
                Force rerun even if this task already has a finished row
              </label>
              <button
                onClick={start}
                disabled={busy || !task || !model}
                className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-accent px-4 py-2.5 text-sm font-semibold text-ink-950 hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Play size={16} />
                Start Claude Code run
              </button>
              {error && <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</div>}
            </div>
          </div>

          <div className="card p-5">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">
              <Server size={16} />
              Runner profile
            </div>
            {config ? (
              <dl className="space-y-2 text-xs">
                <PathRow label="Workdir" value={config.tb21Workdir} />
                <PathRow label="Tasks" value={config.tb21TasksDir} />
                <PathRow label="Runs" value={config.tb21RunsDir} />
                <PathRow label="Docker" value={config.dockerHost} />
              </dl>
            ) : (
              <div className="text-sm text-zinc-500">Runner API unavailable.</div>
            )}
          </div>
        </section>

        <section className="min-w-0 space-y-4">
          <div className="card overflow-hidden">
            <div className="grid grid-cols-[minmax(0,1.2fr)_110px_110px_90px_110px] border-b border-ink-700 px-4 py-3 text-xs uppercase tracking-wide text-zinc-500">
              <div>Run</div>
              <div>Task</div>
              <div>Status</div>
              <div>Reward</div>
              <div />
            </div>
            {runs.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-zinc-600">No runner jobs yet.</div>
            ) : (
              runs.map((run) => {
                const row = taskRow(run)
                const traceCount = row?.result_summary?.trace_artifact_count ?? row?.result_summary?.trace_artifacts?.length ?? 0
                const exports = row?.trace_exports?.length ?? 0
                return (
                  <button
                    key={run.id}
                    onClick={() => setLogRun(run.id)}
                    className={clsx(
                      'grid w-full grid-cols-[minmax(0,1.2fr)_110px_110px_90px_110px] items-center gap-2 border-b border-ink-800 px-4 py-3 text-left text-sm last:border-0 hover:bg-ink-800/40',
                      activeRun?.id === run.id && 'bg-ink-800/50',
                    )}
                  >
                    <div className="min-w-0">
                      <div className="truncate font-mono text-zinc-100">{run.runName}</div>
                      <div className="mt-1 truncate text-xs text-zinc-500">{run.commandSummary}</div>
                    </div>
                    <div className="truncate font-mono text-xs text-zinc-400">{run.task}</div>
                    <div><Pill className={statusClass(run.status)}>{run.status}</Pill></div>
                    <div className="font-mono text-zinc-300">{rewardOf(run) ?? '—'}</div>
                    <div className="text-right text-xs text-zinc-500">{traceCount} traces · {exports} exports</div>
                  </button>
                )
              })
            )}
          </div>

          {activeRun && (
            <div className="card overflow-hidden">
              <div className="flex items-center justify-between border-b border-ink-700 px-4 py-3">
                <div className="min-w-0">
                  <div className="truncate font-mono text-sm text-zinc-100">{activeRun.id}</div>
                  <div className="mt-1 text-xs text-zinc-500">{activeRun.runRoot}</div>
                </div>
                {activeRun.status === 'running' && (
                  <button
                    onClick={() => stop(activeRun)}
                    disabled={busy}
                    className="inline-flex items-center gap-2 rounded-md border border-rose-500/40 px-3 py-2 text-sm text-rose-300 hover:bg-rose-500/10 disabled:opacity-50"
                  >
                    <Square size={14} />
                    Stop
                  </button>
                )}
              </div>
              <div className="grid gap-3 border-b border-ink-800 px-4 py-3 text-xs text-zinc-400 md:grid-cols-3">
                <PathRow label="State" value={activeRun.statePath ?? '—'} />
                <PathRow label="API log" value={activeRun.apiLogPath ?? '—'} />
                <PathRow label="Public status" value={activeRun.publicStatusUrl ?? '—'} />
              </div>
              <div className="flex items-center gap-2 border-b border-ink-800 px-4 py-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">
                <Terminal size={16} />
                Live log
              </div>
              <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap bg-ink-950 p-4 font-mono text-xs leading-relaxed text-zinc-300">
                {logText || 'No log yet.'}
              </pre>
            </div>
          )}
        </section>
      </div>
    </>
  )
}

function PathRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wide text-zinc-600">{label}</dt>
      <dd className="truncate font-mono text-zinc-300" title={value}>{value}</dd>
    </div>
  )
}
