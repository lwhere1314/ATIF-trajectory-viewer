import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { GitBranch, Microscope, Network, ScrollText } from 'lucide-react'
import { PageHeader } from '../components/Layout'
import Markdown from '../components/Markdown'
import { Loading, Pill, StatusBadge } from '../components/ui'
import { fmtDuration, fmtReward } from '../lib/format'

interface CaseStats {
  count: number
  min: number | null
  max: number | null
  mean: number | null
}

interface CaseSummary {
  runsAnalyzed: number
  runsWithStartedAt?: number
  passedOrArtifactValid: number
  officialLeaderboardFailures: number
  featureFrequencies: Record<string, number>
  bestObservedPAt1: number | null
  pAt1: CaseStats
  durationSec: CaseStats
  stepCount: CaseStats
}

interface CaseCluster {
  id: string
  label: string
  count: number
  interpretation: string
  representativeRunIds: string[]
  models: string[]
}

interface CaseRun {
  runId: string
  harness: string | null
  model: string | null
  status: string
  passed: boolean
  reward: number | null
  stepCount: number
  durationSec: number | null
  startedAt?: string | null
  finishedAt?: string | null
  sourceRunRoot?: string | null
  failureReason: string | null
  cluster: string
  features: {
    trained_supervised: boolean
    quantized: boolean
    char_ngrams: boolean
    autotune: boolean
    best_p_at_1: number | null
    max_size_bytes: number | null
    dims: number[]
    wordNgrams: number[]
    buckets: number[]
  }
  trajectoryUrl: string
}

interface LocalComparison {
  runId: string
  label: string
  outcome: string
  verifierPAt1: number | null
  modelBytes: number | null
  startedAt?: string | null
  finishedAt?: string | null
  sourceRunRoot?: string | null
  takeaway: string
}

interface TrainFastTextCase {
  title: string
  taskId: string
  generatedAt: string
  oracle: {
    solvePath: string
    coreCommand: string
    recipe: { insight: string; wordNgrams: number; dim: number; quantize: boolean }
  }
  summary: CaseSummary
  hivemindConclusion: string[]
  localComparisons?: LocalComparison[]
  clusters: CaseCluster[]
  runs: CaseRun[]
  blogMarkdownPath: string
}

function assetUrl(path: string): string {
  return `${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`
}

function fmtNumber(n: number | null | undefined, digits = 3): string {
  if (n == null) return '—'
  if (Math.abs(n) >= 1000) return Math.round(n).toLocaleString()
  return n.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '')
}

function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`
  return `${n.toLocaleString()} B`
}

function fmtDateTime(value: string | null | undefined): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value.replace('T', ' ').replace(/Z$/, '')
  return d.toLocaleString([], {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function clusterTone(id: string): string {
  if (id === 'closed-loop-valid-artifact') return 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30'
  if (id.includes('near') || id.includes('valid')) return 'bg-amber-500/15 text-amber-300 ring-amber-500/30'
  if (id.includes('bootstrap')) return 'bg-zinc-500/15 text-zinc-300 ring-zinc-500/30'
  return 'bg-sky-500/15 text-sky-300 ring-sky-500/30'
}

export default function CaseStudy() {
  const [caseData, setCaseData] = useState<TrainFastTextCase | null>(null)
  const [blog, setBlog] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(assetUrl('cases/train-fasttext-hivemind.json'), { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error(`case json HTTP ${r.status}`); return r.json() })
      .then((d: TrainFastTextCase) => {
        if (!cancelled) setCaseData(d)
        return fetch(assetUrl(d.blogMarkdownPath), { cache: 'no-store' })
      })
      .then((r) => { if (!r.ok) throw new Error(`blog HTTP ${r.status}`); return r.text() })
      .then((md) => { if (!cancelled) setBlog(md) })
      .catch((e) => { if (!cancelled) setError(String(e)) })
    return () => { cancelled = true }
  }, [])

  const clusterLabels = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of caseData?.clusters ?? []) m.set(c.id, c.label)
    return m
  }, [caseData])

  const runs = useMemo(() => {
    if (!caseData) return []
    return [...caseData.runs].sort((a, b) => {
      if (a.passed !== b.passed) return a.passed ? -1 : 1
      return (b.features.best_p_at_1 ?? -1) - (a.features.best_p_at_1 ?? -1)
    })
  }, [caseData])

  if (error) return <div className="p-8 text-rose-400">Failed to load case study: {error}</div>
  if (!caseData) return <Loading />

  const ff = caseData.summary.featureFrequencies

  return (
    <>
      <PageHeader
        title={caseData.title}
        subtitle="A single-case research view for Terminal-Bench train-fasttext trajectories"
        actions={(
          <>
            <Link to={`/tasks/${caseData.taskId}`} className="btn-ghost">Task</Link>
            <a href={assetUrl(caseData.blogMarkdownPath)} className="btn-primary" target="_blank" rel="noreferrer">
              Blog Markdown
            </a>
          </>
        )}
      />

      <div className="space-y-8 p-8">
        <section className="grid gap-4 lg:grid-cols-4">
          <Metric label="Runs analyzed" value={caseData.summary.runsAnalyzed} detail={`${caseData.summary.passedOrArtifactValid} artifact-valid; ${caseData.summary.runsWithStartedAt ?? 0} timestamped`} />
          <Metric label="Best observed P@1" value={fmtNumber(caseData.summary.bestObservedPAt1)} detail={`mean ${fmtNumber(caseData.summary.pAt1.mean)}`} />
          <Metric label="Mean steps" value={fmtNumber(caseData.summary.stepCount.mean, 1)} detail={`range ${fmtNumber(caseData.summary.stepCount.min, 0)}-${fmtNumber(caseData.summary.stepCount.max, 0)}`} />
          <Metric label="Mean duration" value={fmtDuration(caseData.summary.durationSec.mean)} detail={`${caseData.summary.officialLeaderboardFailures} official reward-0 runs`} />
        </section>

        <section className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
          <div className="card p-5">
            <div className="mb-3 flex items-center gap-2">
              <Microscope size={16} className="text-accent" />
              <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Oracle signal</h2>
            </div>
            <pre className="overflow-x-auto rounded-lg border border-line bg-code p-3 font-mono text-[12.5px] text-zinc-200">
              {caseData.oracle.coreCommand}
            </pre>
            <p className="mt-3 text-sm leading-6 text-zinc-400">{caseData.oracle.recipe.insight}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Pill>wordNgrams={caseData.oracle.recipe.wordNgrams}</Pill>
              <Pill>dim={caseData.oracle.recipe.dim}</Pill>
              <Pill>quantize={String(caseData.oracle.recipe.quantize)}</Pill>
            </div>
          </div>

          <div className="card p-5">
            <div className="mb-3 flex items-center gap-2">
              <Network size={16} className="text-accent" />
              <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Hivemind conclusion</h2>
            </div>
            <div className="space-y-3 text-sm leading-6 text-zinc-300">
              {caseData.hivemindConclusion.map((x, i) => <p key={i}>{x}</p>)}
            </div>
          </div>
        </section>

        <section>
          <div className="mb-3 flex items-center gap-2">
            <GitBranch size={16} className="text-accent" />
            <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Trajectory clusters</h2>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            {caseData.clusters.map((c) => (
              <div key={c.id} className="card p-4">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span className={`chip ring-1 ${clusterTone(c.id)}`}>{c.label}</span>
                  <span className="text-sm tabular-nums text-zinc-400">{c.count} runs</span>
                </div>
                <p className="text-sm leading-6 text-zinc-400">{c.interpretation}</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {c.models.slice(0, 4).map((m) => <Pill key={m} className="max-w-full truncate">{m}</Pill>)}
                  {c.models.length > 4 && <Pill>+{c.models.length - 4}</Pill>}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <FeatureStat label="converted parquet" value={ff.converted_parquet ?? 0} total={caseData.summary.runsAnalyzed} />
          <FeatureStat label="trained supervised fastText" value={ff.trained_supervised ?? 0} total={caseData.summary.runsAnalyzed} />
          <FeatureStat label="used quantization" value={ff.quantized ?? 0} total={caseData.summary.runsAnalyzed} />
          <FeatureStat label="used char n-grams" value={ff.char_ngrams ?? 0} total={caseData.summary.runsAnalyzed} />
        </section>

        {caseData.localComparisons?.length ? (
          <section>
            <div className="mb-3 flex items-center gap-2">
              <Microscope size={16} className="text-accent" />
              <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Local SSD comparisons</h2>
            </div>
            <div className="card overflow-x-auto">
              <table className="w-full min-w-[960px] text-sm">
                <thead>
                  <tr className="border-b border-ink-700 text-left text-xs uppercase tracking-wide text-zinc-500">
                    <th className="px-4 py-3 font-medium">Run</th>
                    <th className="px-4 py-3 font-medium">Outcome</th>
                    <th className="px-4 py-3 font-medium">Started</th>
                    <th className="px-4 py-3 font-medium">Verifier P@1</th>
                    <th className="px-4 py-3 font-medium">Model size</th>
                    <th className="px-4 py-3 font-medium">Takeaway</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {caseData.localComparisons.map((row) => (
                    <tr key={row.runId} className="border-b border-ink-800 last:border-0">
                      <td className="px-4 py-3 font-mono text-zinc-200">{row.label}</td>
                      <td className="px-4 py-3"><span className="chip bg-ink-800 text-zinc-300">{row.outcome}</span></td>
                      <td className="px-4 py-3 tabular-nums text-zinc-400">{fmtDateTime(row.startedAt)}</td>
                      <td className="px-4 py-3 tabular-nums text-zinc-300">{fmtNumber(row.verifierPAt1)}</td>
                      <td className="px-4 py-3 tabular-nums text-zinc-300">{fmtBytes(row.modelBytes)}</td>
                      <td className="px-4 py-3 leading-6 text-zinc-400">{row.takeaway}</td>
                      <td className="px-4 py-3 text-right">
                        <Link to={`/tasks/${caseData.taskId}/runs/${row.runId}`} className="btn-ghost">Trace</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        <section>
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <ScrollText size={16} className="text-accent" />
              <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Runs in this case</h2>
            </div>
            <span className="text-xs text-zinc-500">Sorted by artifact-valid first, then best observed P@1</span>
          </div>
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[1040px] text-sm">
              <thead>
                <tr className="border-b border-ink-700 text-left text-xs uppercase tracking-wide text-zinc-500">
                  <th className="px-4 py-3 font-medium">Harness / Model</th>
                  <th className="px-4 py-3 font-medium">Started</th>
                  <th className="px-4 py-3 font-medium">Cluster</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Reward</th>
                  <th className="px-4 py-3 font-medium">P@1</th>
                  <th className="px-4 py-3 font-medium">Size</th>
                  <th className="px-4 py-3 font-medium">Steps</th>
                  <th className="px-4 py-3 font-medium">Duration</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.runId} className="border-b border-ink-800 last:border-0 hover:bg-ink-800/40">
                    <td className="px-4 py-3">
                      <div className="text-zinc-200">{run.harness ?? 'unknown harness'}</div>
                      <div className="font-mono text-xs text-zinc-500">{run.model ?? 'unknown model'}</div>
                    </td>
                    <td className="px-4 py-3 tabular-nums text-zinc-400">{fmtDateTime(run.startedAt)}</td>
                    <td className="px-4 py-3">
                      <span className={`chip ring-1 ${clusterTone(run.cluster)}`}>{clusterLabels.get(run.cluster) ?? run.cluster}</span>
                    </td>
                    <td className="px-4 py-3"><StatusBadge status={run.status} /></td>
                    <td className="px-4 py-3 tabular-nums text-zinc-300">{fmtReward(run.reward)}</td>
                    <td className="px-4 py-3 tabular-nums text-zinc-300">{fmtNumber(run.features.best_p_at_1)}</td>
                    <td className="px-4 py-3 tabular-nums text-zinc-300">{fmtBytes(run.features.max_size_bytes)}</td>
                    <td className="px-4 py-3 tabular-nums text-zinc-300">{run.stepCount}</td>
                    <td className="px-4 py-3 tabular-nums text-zinc-300">{fmtDuration(run.durationSec)}</td>
                    <td className="px-4 py-3 text-right">
                      <Link to={run.trajectoryUrl} className="btn-ghost">View</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <div className="mb-3 flex items-center gap-2">
            <ScrollText size={16} className="text-accent" />
            <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Blog draft</h2>
          </div>
          <div className="card p-5">
            <Markdown content={blog} />
          </div>
        </section>
      </div>
    </>
  )
}

function Metric({ label, value, detail }: { label: string; value: string | number; detail: string }) {
  return (
    <div className="card px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-white">{value}</div>
      <div className="mt-0.5 text-xs text-zinc-500">{detail}</div>
    </div>
  )
}

function FeatureStat({ label, value, total }: { label: string; value: number; total: number }) {
  const pct = total ? value / total : 0
  return (
    <div className="card p-4">
      <div className="mb-2 flex items-center justify-between gap-3 text-sm">
        <span className="text-zinc-300">{label}</span>
        <span className="tabular-nums text-zinc-500">{value}/{total}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-ink-800">
        <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round(pct * 100)}%` }} />
      </div>
    </div>
  )
}
