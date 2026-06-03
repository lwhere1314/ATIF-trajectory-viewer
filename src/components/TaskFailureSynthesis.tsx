import { useMemo, useState } from 'react'
import { BrainCircuit, ChevronDown, ChevronRight, Sparkles } from 'lucide-react'
import clsx from 'clsx'
import { Link } from 'react-router-dom'
import { fmtDuration, fmtReward, prettyModel } from '../lib/format'
import { loadRunPayload } from '../lib/dataset'
import type { Agent, Run, Step, Task } from '../lib/types'

interface RunFinding {
  run: Run
  agent?: Agent
  steps: Step[]
  verifierLog: string | null
  verdict: string
  evidence: string
  finalMove: string
}

interface Synthesis {
  headline: string
  oracle: string
  consensus: string
  failures: string[]
  rows: RunFinding[]
}

function compact(s: string | null | undefined, max = 260): string {
  const text = (s ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}...` : text
}

function oracleText(task: Task): string {
  const files = task.files.filter((f) => /^solution\//i.test(f.path) && f.content)
  if (!files.length) return 'No oracle solution file was bundled for this task.'
  return files
    .slice(0, 2)
    .map((f) => `${f.path}\n${compact(f.content, 900)}`)
    .join('\n\n')
}

function testContract(task: Task): string | null {
  const tests = task.files.filter((f) => /^tests\//i.test(f.path) && f.content).map((f) => f.content ?? '').join('\n')
  const accuracy = tests.match(/ACCURACY_THRESHOLD\s*=\s*([0-9.]+)/)
  const size = tests.match(/MAX_MODEL_SIZE\s*=\s*([^\n]+)/)
  if (!accuracy && !size) return null
  return [accuracy ? `accuracy >= ${accuracy[1]}` : null, size ? `model size < ${compact(size[1], 60)}` : null]
    .filter(Boolean)
    .join(' and ')
}

function finalAgentMove(steps: Step[]): string {
  const final = [...steps].reverse().find((s) => s.role === 'agent' && (s.text || s.toolCalls?.length || s.observation))
  if (!final) return 'No final agent step was exported.'
  if (final.text) return compact(final.text, 280)
  if (final.toolCalls?.length) return `called ${final.toolCalls.map((t) => t.name).join(', ')}`
  return compact(final.observation, 280)
}

function verifierEvidence(run: Run, verifierLog: string | null): { verdict: string; evidence: string } {
  const log = verifierLog ?? ''
  const accuracy = log.match(/Accuracy\s+([0-9.]+)\s+is not at least\s+([0-9.]+)/i)
  if (accuracy) {
    return {
      verdict: 'accuracy shortfall',
      evidence: `Accuracy ${accuracy[1]} is below ${accuracy[2]}.`,
    }
  }
  if (/Agent execution timed out/i.test(run.failureReason ?? '')) {
    return { verdict: 'timeout', evidence: compact(run.failureReason, 220) }
  }
  if (/Could not parse accuracy/i.test(log)) {
    return { verdict: 'invalid verifier output', evidence: compact(log.match(/Could not parse accuracy[\s\S]{0,260}/)?.[0], 260) }
  }
  if (run.passed) return { verdict: 'passed', evidence: 'Verifier passed.' }
  if (run.failureReason) return { verdict: 'runtime error', evidence: compact(run.failureReason, 220) }
  if (run.reward === 0) return { verdict: 'failed verifier', evidence: compact(log.slice(-500), 260) || 'Reward is 0.00.' }
  return { verdict: run.status, evidence: compact(log.slice(-500), 260) || 'No verifier detail exported.' }
}

function dominant(findings: RunFinding[]): string {
  const failed = findings.filter((f) => !f.run.passed)
  if (!failed.length) return 'Every exported run passed; no common failure cluster is visible.'
  const counts = new Map<string, number>()
  for (const f of failed) counts.set(f.verdict, (counts.get(f.verdict) ?? 0) + 1)
  const [label, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  return `${count}/${failed.length} failed runs share the "${label}" cluster.`
}

function buildSynthesis(task: Task, findings: RunFinding[]): Synthesis {
  const contract = testContract(task)
  const scored = findings.filter((f) => f.run.reward != null)
  const passed = scored.filter((f) => f.run.passed).length
  const failed = scored.length - passed
  const unscored = findings.length - scored.length
  const oracle = oracleText(task)
  const failureGroups = [...new Set(findings.filter((f) => f.run.reward != null && !f.run.passed).map((f) => f.verdict))]
  const trainFasttext = task.title === 'train-fasttext' || task.id.includes('train-fasttext')
  const failures = failureGroups.map((g) => {
    const rows = findings.filter((f) => f.verdict === g)
    const example = rows.find((r) => r.evidence)?.evidence
    return `${g}: ${rows.length} run${rows.length === 1 ? '' : 's'}${example ? `; e.g. ${example}` : ''}`
  })
  const consensus = trainFasttext
    ? 'Mock cluster: most failing agents get close to the intended FastText recipe, but either over-tune around the 150MB size cap until accuracy slips under 0.62, or spend the full budget iterating on training scripts instead of converging on the compact oracle recipe.'
    : `Mock cluster: ${dominant(findings)}`

  return {
    headline: `${passed}/${scored.length} scored runs passed; ${failed} failed${unscored ? `; ${unscored} unscored host records kept as context` : ''}${contract ? ` against ${contract}` : ''}.`,
    oracle,
    consensus,
    failures,
    rows: findings,
  }
}

export default function TaskFailureSynthesis({
  task,
  runs,
  agents,
}: {
  task: Task
  runs: Run[]
  agents: Map<string, Agent>
}) {
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(true)
  const [synthesis, setSynthesis] = useState<Synthesis | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const agentCount = useMemo(() => new Set(runs.map((r) => `${agents.get(r.agentId)?.harness ?? 'agent'}:${agents.get(r.agentId)?.model ?? r.agentId}`)).size, [runs, agents])

  async function analyze() {
    setLoading(true)
    setErr(null)
    try {
      const findings: RunFinding[] = await Promise.all(runs.map(async (run) => {
        const payload = await loadRunPayload(run)
        const verdict = verifierEvidence(run, payload.verifierLog)
        return {
          run,
          agent: agents.get(run.agentId),
          steps: payload.steps,
          verifierLog: payload.verifierLog,
          verdict: verdict.verdict,
          evidence: verdict.evidence,
          finalMove: finalAgentMove(payload.steps),
        }
      }))
      setSynthesis(buildSynthesis(task, findings))
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e))
    } finally {
      setLoading(false)
    }
  }

  if (runs.length < 2) return null

  return (
    <section className="card overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 border-b border-ink-700 bg-ink-800/45 px-5 py-3 text-left hover:bg-ink-800"
      >
        {open ? <ChevronDown size={16} className="text-zinc-500" /> : <ChevronRight size={16} className="text-zinc-500" />}
        <BrainCircuit size={18} className="text-accent" />
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-white">Task failure synthesis</h2>
          <p className="truncate text-xs text-zinc-500">{runs.length} runs · {agentCount} harness/model pairs · oracle-aware mock analysis</p>
        </div>
        <span className={clsx('chip', synthesis ? 'bg-emerald-500/15 text-emerald-300' : 'bg-accent/15 text-accent')}>
          {synthesis ? 'ready' : 'mock'}
        </span>
      </button>
      {open && (
        <div className="space-y-4 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-3xl text-sm leading-relaxed text-zinc-400">
              Compare every run for this task, group failures by verifier signal, and draft a summary against the bundled oracle solution.
            </p>
            <button onClick={analyze} disabled={loading} className="btn-primary shrink-0">
              <Sparkles size={15} />
              {loading ? 'Analyzing...' : 'Mock AI synthesis'}
            </button>
          </div>

          {err && <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 text-xs text-rose-200">{err}</p>}

          {!synthesis ? (
            <div className="rounded-lg border border-dashed border-ink-700 p-5 text-sm text-zinc-500">
              No synthesis generated yet.
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid gap-3 lg:grid-cols-3">
                <div className="rounded-lg border border-ink-700 bg-ink-950 p-3 lg:col-span-2">
                  <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Summary</div>
                  <p className="text-sm leading-relaxed text-zinc-200">{synthesis.headline}</p>
                  <p className="mt-2 text-sm leading-relaxed text-zinc-300">{synthesis.consensus}</p>
                </div>
                <div className="rounded-lg border border-ink-700 bg-ink-950 p-3">
                  <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Failure clusters</div>
                  <ul className="space-y-1 text-xs leading-relaxed text-zinc-400">
                    {synthesis.failures.length ? synthesis.failures.map((f) => <li key={f}>{f}</li>) : <li>No failed runs.</li>}
                  </ul>
                </div>
              </div>

              <div className="rounded-lg border border-ink-700 bg-ink-950 p-3">
                <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Oracle signal</div>
                <pre className="max-h-52 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-zinc-400">{synthesis.oracle}</pre>
              </div>

              <div className="overflow-x-auto rounded-lg border border-ink-700">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-ink-700 bg-ink-800/40 text-left text-xs uppercase tracking-wide text-zinc-500">
                      <th className="px-3 py-2 font-medium">Model</th>
                      <th className="px-3 py-2 font-medium">Harness</th>
                      <th className="px-3 py-2 font-medium">Reward</th>
                      <th className="px-3 py-2 font-medium">Steps</th>
                      <th className="px-3 py-2 font-medium">Cluster</th>
                      <th className="px-3 py-2 font-medium">Evidence</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {synthesis.rows.map((row) => (
                      <tr key={row.run.id} className="border-b border-ink-800 last:border-0">
                        <td className="px-3 py-2 font-mono text-zinc-200">{prettyModel(row.agent?.model)}</td>
                        <td className="px-3 py-2 text-zinc-400">{row.agent?.harness ?? 'not reported'}</td>
                        <td className="px-3 py-2 tabular-nums text-zinc-300">{fmtReward(row.run.reward)}</td>
                        <td className="px-3 py-2 tabular-nums text-zinc-300" title={fmtDuration(row.run.durationSec)}>{row.run.stepCount}</td>
                        <td className="px-3 py-2"><span className="chip bg-ink-800 text-zinc-300">{row.verdict}</span></td>
                        <td className="max-w-md px-3 py-2 text-xs text-zinc-500">{row.evidence || row.finalMove}</td>
                        <td className="px-3 py-2 text-right">
                          <Link to={`/tasks/${task.id}/runs/${row.run.id}`} className="text-xs text-accent hover:underline">open</Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
