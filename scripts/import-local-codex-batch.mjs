#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

const DEFAULT_TASKS_ROOT = '/Users/hugo/Desktop/super-refactor/harbor/datasets/terminal-bench-2.1-proxy/tasks'
const MAX_TASK_FILE_BYTES = 200_000
const MAX_TASK_FILES = 100
const MAX_STEP_TEXT = 40_000
const MAX_REASONING_TEXT = 12_000
const MAX_VERIFIER_LOG = 100_000

function usage() {
  console.error('Usage: node scripts/import-local-codex-batch.mjs <batch-root> [--public-root public] [--tasks-root <path>] [--label <id>]')
  process.exit(2)
}

function parseArgs(argv) {
  const args = { batchRoot: '', publicRoot: 'public', tasksRoot: DEFAULT_TASKS_ROOT, label: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--public-root') args.publicRoot = argv[++i] || usage()
    else if (arg === '--tasks-root') args.tasksRoot = argv[++i] || usage()
    else if (arg === '--label') args.label = argv[++i] || usage()
    else if (arg.startsWith('--')) usage()
    else if (!args.batchRoot) args.batchRoot = arg
    else usage()
  }
  if (!args.batchRoot) usage()
  return {
    batchRoot: resolve(args.batchRoot),
    publicRoot: resolve(args.publicRoot),
    tasksRoot: resolve(args.tasksRoot),
    label: args.label,
  }
}

function safeId(value) {
  return String(value || 'item')
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'item'
}

function slug(value) {
  return safeId(String(value || '').toLowerCase())
}

function titleize(task) {
  return String(task || '')
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ')
}

function clip(value, limit = 6000) {
  if (value == null) return undefined
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const scrubbed = scrubText(text)
  return scrubbed.length <= limit ? scrubbed : `${scrubbed.slice(0, limit)}\n...[+${scrubbed.length - limit} chars]`
}

function scrubText(text) {
  return String(text)
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, 'REDACTED')
    .replace(/((?:TOKEN_PLAN|ANTHROPIC|OPENAI|MINIMAX|GITHUB|GH|DASHSCOPE)_[A-Z0-9_]*(?:KEY|TOKEN|SECRET)[A-Z0-9_]*=)[^\s]+/gi, '$1REDACTED')
    .replace(/((?:api[_-]?key|authorization)\s*[:=]\s*["']?)[^"',\s]+/gi, '$1REDACTED')
    .replace(/(Authorization:\s*Bearer\s+)[^\s]+/gi, '$1REDACTED')
}

async function readText(path, fallback = '') {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return fallback
  }
}

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`)
}

async function walkFiles(root, base = root, out = []) {
  let entries = []
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === '__pycache__' || entry.name === '.pytest_cache') continue
    const path = join(root, entry.name)
    if (entry.isDirectory()) await walkFiles(path, base, out)
    else if (entry.isFile()) out.push(path.slice(base.length + 1))
  }
  return out
}

function fileKind(path) {
  const lower = path.toLowerCase()
  if (/\.(png|jpe?g|gif|svg|webp)$/.test(lower)) return 'image'
  if (/\.(md|markdown)$/.test(lower)) return 'markdown'
  if (/\.json$/.test(lower)) return 'json'
  if (/\.(html?|vue)$/.test(lower)) return 'html'
  if (/\.(diff|patch)$/.test(lower)) return 'diff'
  if (/\.(csv|tsv|xlsx?)$/.test(lower)) return 'spreadsheet'
  if (/\.pdf$/.test(lower)) return 'pdf'
  if (/\.(toml|txt|ini|cfg|lock|env)$/.test(lower) || /dockerfile$/.test(lower)) return 'text'
  return 'code'
}

function languageFor(path) {
  const lower = path.toLowerCase()
  if (lower.endsWith('.py')) return 'python'
  if (lower.endsWith('.js')) return 'javascript'
  if (lower.endsWith('.ts')) return 'typescript'
  if (lower.endsWith('.tsx')) return 'tsx'
  if (lower.endsWith('.jsx')) return 'jsx'
  if (lower.endsWith('.sh')) return 'bash'
  if (lower.endsWith('.json')) return 'json'
  if (lower.endsWith('.toml')) return 'toml'
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml'
  if (lower.endsWith('.sql')) return 'sql'
  if (lower.endsWith('.rs')) return 'rust'
  if (lower.endsWith('.go')) return 'go'
  return undefined
}

async function collectTaskFiles(taskDir) {
  const paths = (await walkFiles(taskDir)).sort()
  const files = []
  for (const rel of paths) {
    if (files.length >= MAX_TASK_FILES) break
    const abs = join(taskDir, rel)
    const info = await stat(abs).catch(() => null)
    if (!info) continue
    if (info.size > MAX_TASK_FILE_BYTES) {
      files.push({ path: rel, kind: fileKind(rel), note: `Omitted: ${info.size} bytes` })
      continue
    }
    let content = ''
    try {
      content = await readFile(abs, 'utf8')
    } catch {
      files.push({ path: rel, kind: fileKind(rel), note: 'Binary or unreadable file' })
      continue
    }
    files.push({ path: rel, kind: fileKind(rel), language: languageFor(rel), content: clip(content, 30_000) })
  }
  return files
}

function tomlString(toml, key) {
  const match = new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*"([^"]*)"`, 'm').exec(toml || '')
  return match?.[1] || ''
}

function parseTaskMetadata(toml) {
  return {
    name: tomlString(toml, 'name'),
    description: tomlString(toml, 'description'),
    difficulty: tomlString(toml, 'difficulty'),
    category: tomlString(toml, 'category'),
  }
}

function eventTime(event) {
  const raw = event?.timestamp || event?.created_at || event?.time
  if (!raw) return { iso: null, ms: null }
  const ms = Date.parse(raw)
  return { iso: raw, ms: Number.isFinite(ms) ? ms : null }
}

function commandMutation(command) {
  const summary = String(command || '').replace(/\s+/g, ' ').trim().slice(0, 160)
  return summary ? [{ kind: 'command', tool: 'Bash', summary }] : null
}

function fileChangeMutations(changes) {
  const out = []
  for (const change of changes || []) {
    const target = change?.path || change?.file || change?.target
    const kind = change?.kind || change?.type || 'change'
    out.push({
      kind: 'file',
      tool: 'file_change',
      target: target ? String(target) : undefined,
      summary: `${kind}${target ? ` ${target}` : ''}`.slice(0, 180),
    })
  }
  return out.length ? out : null
}

function codexEventToStep(event, index, firstMs) {
  if (event?.type !== 'item.completed') return null
  const item = event.item || {}
  const { iso, ms } = eventTime(event)
  const base = {
    index,
    timestamp: iso,
    tSec: firstMs != null && ms != null ? Math.max(0, (ms - firstMs) / 1000) : null,
  }

  if (item.type === 'agent_message') {
    return {
      ...base,
      role: 'assistant',
      text: clip(item.text || '', MAX_STEP_TEXT) || null,
    }
  }

  if (item.type === 'command_execution') {
    const command = scrubText(item.command || '')
    const statusLine = [
      item.status ? `status=${item.status}` : null,
      item.exit_code != null ? `exit_code=${item.exit_code}` : null,
    ].filter(Boolean).join(' ')
    const output = clip(item.aggregated_output || statusLine, MAX_STEP_TEXT) || null
    return {
      ...base,
      role: 'assistant',
      text: statusLine || null,
      toolCalls: [{ name: 'Bash', args: JSON.stringify({ command }) }],
      observation: output,
      mutations: commandMutation(command),
    }
  }

  if (item.type === 'file_change') {
    const mutations = fileChangeMutations(item.changes)
    return {
      ...base,
      role: 'assistant',
      text: mutations ? mutations.map((m) => m.summary).join('\n') : 'file change',
      toolName: 'file_change',
      mutations,
    }
  }

  if (item.text || item.message || item.type) {
    return {
      ...base,
      role: 'assistant',
      text: clip(item.text || item.message || JSON.stringify(item), MAX_STEP_TEXT) || null,
    }
  }

  return null
}

async function parseCodexEvents(path) {
  const content = await readText(path)
  if (!content.trim()) return []
  const raw = []
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      raw.push(JSON.parse(line))
    } catch {
      raw.push({ type: 'item.completed', item: { type: 'agent_message', text: line } })
    }
  }
  const firstMs = raw.map((event) => eventTime(event).ms).find((ms) => ms != null) ?? null
  const steps = []
  for (const event of raw) {
    const step = codexEventToStep(event, steps.length, firstMs)
    if (step) steps.push(step)
  }
  return steps
}

function pytestSummary(log) {
  const lines = String(log || '').split(/\r?\n/)
  const resultLine = [...lines].reverse().find((line) => /\d+\s+(?:failed|passed|error|skipped|warning|warnings)/i.test(line) && /\bin\s+[\d.]+s\b/i.test(line))
  const failedTests = []
  for (const line of lines) {
    const failed = line.match(/^FAILED\s+(.+)/)
    if (failed) failedTests.push(failed[1].trim())
  }
  return {
    resultLine: resultLine?.replace(/^=+|=+$/g, '').trim() || null,
    failedTests: [...new Set(failedTests)],
  }
}

function ctrfFailedTests(ctrf) {
  const tests = ctrf?.results?.tests
  if (!Array.isArray(tests)) return []
  return tests
    .filter((test) => String(test?.status || '').toLowerCase() === 'failed')
    .map((test) => test?.name)
    .filter(Boolean)
}

function diagnoseVerifierLog(verifierLog, reward) {
  const log = verifierLog || ''
  const lowered = log.toLowerCase()
  const pytestStarted = /(?:^|\n)(?:=+ test session starts|collected \d+ items|FAILED|PASSED|ERRORS?|test_)/i.test(log)
  const networkFailed = /ssl_error|ssl_connect|connection reset|connection refused|failed to connect|could not resolve|temporary failure|operation timed out|unexpected_eof|eof occurred|failed to download/i.test(log)
  const uvInstallFailed = /astral\.sh|uvx: command not found|uv: command not found|\/root\/\.local\/bin\/env: no such file/i.test(log)
  if ((reward === 0 || reward === 0.0) && (uvInstallFailed || networkFailed) && !pytestStarted) {
    return {
      category: 'verifier-infra',
      severity: 'major',
      summary: 'Verifier infrastructure failure',
      detail: 'Setup or network failed before pytest started; do not treat this as a clean model-quality negative.',
    }
  }
  if ((reward === 0 || reward === 0.0) && !pytestStarted && /command not found|no such file or directory|permission denied/i.test(lowered)) {
    return {
      category: 'verifier-infra',
      severity: 'major',
      summary: 'Verifier setup failure',
      detail: 'The verifier failed before task assertions ran.',
    }
  }
  if (reward === 0 || reward === 0.0) {
    return {
      category: 'verifier',
      severity: 'major',
      summary: pytestStarted ? 'Verifier semantic failure' : 'Verifier zero without clear pytest evidence',
      detail: pytestStarted
        ? 'Pytest appears to have run; inspect the failed assertion before labeling the trajectory.'
        : 'Reward is 0, but the log does not clearly show pytest execution.',
    }
  }
  return null
}

function buildGrade(reward, verifierLog, ctrf) {
  const summary = pytestSummary(verifierLog)
  const failedTests = [...new Set([...summary.failedTests, ...ctrfFailedTests(ctrf)])]
  const diagnosis = diagnoseVerifierLog(verifierLog, reward)
  const findings = []
  if (diagnosis) {
    findings.push({
      ...diagnosis,
      detail: failedTests.length ? `${diagnosis.detail}\nFailed tests: ${failedTests.join(', ')}` : diagnosis.detail,
    })
  }
  return {
    score: reward,
    maxScore: 1,
    subscores: [],
    summary: summary.resultLine || (reward != null ? `reward ${reward}` : null),
    findings,
    verifier: verifierLog
      ? {
          checked: 'Terminal-Bench verifier',
          produced: summary.resultLine || null,
          quote: failedTests.slice(0, 5).join('\n') || null,
        }
      : null,
  }
}

async function readReward(taskRunDir, row) {
  const text = await readText(join(taskRunDir, 'verifier', 'reward.txt'))
  const parsed = Number(text.trim())
  if (Number.isFinite(parsed)) return parsed
  return typeof row.reward === 'number' ? row.reward : null
}

async function readDuration(taskRunDir, row) {
  const agent = Number((await readText(join(taskRunDir, 'agent', 'elapsed-seconds.txt'))).trim())
  if (Number.isFinite(agent)) return agent
  if (row.started_at && row.finished_at) {
    const start = Date.parse(row.started_at)
    const end = Date.parse(row.finished_at)
    if (Number.isFinite(start) && Number.isFinite(end)) return Math.max(0, (end - start) / 1000)
  }
  return null
}

function runArtifacts(steps, row) {
  const targets = new Set()
  for (const step of steps) {
    for (const mutation of step.mutations || []) {
      if (mutation.target) targets.add(mutation.target)
    }
  }
  for (const item of row.container_artifacts?.copied || []) {
    if (item?.returncode === 0 && item.destination) targets.add(item.destination)
  }
  if (row.container_artifacts?.docker_diff) targets.add(row.container_artifacts.docker_diff)
  if (row.container_artifacts?.inspect) targets.add(row.container_artifacts.inspect)
  return [...targets].slice(0, 80)
}

async function importBatch({ batchRoot, publicRoot, tasksRoot, label }) {
  const statePath = join(batchRoot, 'state.json')
  const state = await readJson(statePath)
  if (!state || !state.tasks || typeof state.tasks !== 'object') {
    throw new Error(`No state.tasks found in ${statePath}`)
  }

  const batchName = label || safeId(state.run_name || basename(batchRoot))
  const batchSlug = slug(batchName)
  const vendorId = `local-${batchSlug}`
  const agentId = `local-${slug(state.agent || 'codex-host')}-${slug(state.model || 'model')}`
  const runsDir = join(publicRoot, 'runs')
  const localBundleDir = join(publicRoot, 'runner', 'runs', batchName)

  const vendors = [{
    id: vendorId,
    name: 'Local Codex Batch',
    coverage: `Imported from ${batchRoot}; trajectories from agent/codex-events.jsonl and verifier stdout/reward files.`,
  }]
  const agents = [{
    id: agentId,
    harness: state.agent === 'codex-host' ? 'Codex CLI' : state.agent || 'Codex CLI',
    model: state.model || null,
    family: String(state.model || '').toLowerCase().includes('gpt') ? 'OpenAI' : 'unknown',
    vendorId,
  }]
  const tasks = []
  const runs = []
  const rows = Object.values(state.tasks).sort((a, b) => String(a.task).localeCompare(String(b.task)))

  for (const row of rows) {
    const taskName = row.task
    const taskId = `local-codex-clean4-${slug(taskName)}`
    const runId = `runner-local-codex-clean4-${slug(taskName)}`
    const taskDir = row.task_dir && existsSync(row.task_dir) ? row.task_dir : join(tasksRoot, taskName)
    const taskRunDir = row.task_run_dir && existsSync(row.task_run_dir) ? row.task_run_dir : join(batchRoot, 'tasks', taskName)
    const instruction = await readText(join(taskDir, 'instruction.md'))
    const readme = await readText(join(taskDir, 'README.md'))
    const toml = await readText(join(taskDir, 'task.toml'))
    const meta = parseTaskMetadata(toml)
    const steps = await parseCodexEvents(join(taskRunDir, 'agent', 'codex-events.jsonl'))
    const verifierLog = clip(await readText(join(taskRunDir, 'verifier', 'stdout.txt')), MAX_VERIFIER_LOG) || null
    const ctrf = await readJson(join(taskRunDir, 'verifier', 'ctrf.json'), null)
    const reward = await readReward(taskRunDir, row)
    const durationSec = await readDuration(taskRunDir, row)
    const passed = reward === 1 || reward === 1.0
    const grade = buildGrade(reward, verifierLog, ctrf)
    const artifacts = runArtifacts(steps, row)

    await writeJson(join(runsDir, `${runId}.json`), { steps, verifierLog })

    tasks.push({
      id: taskId,
      vendorId,
      title: meta.name ? meta.name.replace(/^terminal-bench\//, '') : titleize(taskName),
      source: 'harbor',
      category: meta.category || 'Terminal-Bench 2.1 local batch',
      difficulty: meta.difficulty || '',
      instruction: clip(instruction || readme, 12_000),
      files: await collectTaskFiles(taskDir),
      tier: 'example',
      metadata: {
        batchRoot,
        batchName,
        taskName,
        taskDir,
        taskRunDir,
        container: row.container || null,
        image: row.image || null,
        workdir: row.workdir || null,
        codexThreadId: row.codex_thread_id || null,
        containerArtifacts: row.container_artifacts || null,
        sourceDescription: meta.description || null,
      },
    })

    runs.push({
      id: runId,
      taskId,
      agentId,
      vendorId,
      format: 'harbor',
      status: passed ? 'passed' : reward != null ? 'failed' : 'completed',
      passed,
      reward,
      steps: [],
      stepCount: steps.length,
      multiUser: false,
      hasVerifierLog: Boolean(verifierLog),
      turns: steps.filter((step) => step.role === 'assistant' || step.role === 'agent').length,
      durationSec,
      artifacts,
      tokens: null,
      grade,
      failureReason: passed ? null : grade.findings?.[0]?.summary || (reward === 0 ? 'Verifier failed' : null),
    })
  }

  const bundle = { vendors, agents, tasks, runs }
  const bundlePath = join(localBundleDir, 'viewer-bundle.json')
  await writeJson(bundlePath, bundle)

  const indexPath = join(publicRoot, 'runner', 'local-bundles.json')
  const previous = await readJson(indexPath, [])
  const entries = Array.isArray(previous) ? previous.filter((item) => item?.id !== batchName) : []
  entries.push({
    id: batchName,
    title: state.run_name || batchName,
    bundleUrl: `runner/runs/${batchName}/viewer-bundle.json`,
    importedAt: new Date().toISOString(),
    runCount: runs.length,
  })
  await writeJson(indexPath, entries)

  const rewardCounts = runs.reduce((acc, run) => {
    const key = run.reward == null ? 'null' : String(run.reward)
    acc[key] = (acc[key] || 0) + 1
    return acc
  }, {})

  return {
    batchName,
    bundlePath,
    indexPath,
    runPayloadDir: runsDir,
    taskCount: tasks.length,
    runCount: runs.length,
    rewardCounts,
    sampleRunUrl: `/tasks/${tasks.find((task) => task.id.includes('query-optimize'))?.id || tasks[0]?.id}/runs/${runs.find((run) => run.id.includes('query-optimize'))?.id || runs[0]?.id}`,
  }
}

try {
  const result = await importBatch(parseArgs(process.argv.slice(2)))
  console.log(JSON.stringify(result, null, 2))
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
