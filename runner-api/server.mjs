#!/usr/bin/env node
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const env = process.env
const HOST = env.RUNNER_API_HOST || '127.0.0.1'
const PORT = Number(env.RUNNER_API_PORT || 8787)
const API_TOKEN = env.RUNNER_API_TOKEN || ''
const REPO_ROOT = resolve(env.RUNNER_REPO_ROOT || process.cwd())
const PUBLIC_ROOT = resolve(env.RUNNER_PUBLIC_ROOT || join(REPO_ROOT, 'public'))
const REGISTRY_DIR = join(PUBLIC_ROOT, 'runner')
const REGISTRY_PATH = join(REGISTRY_DIR, 'registry.json')
const UI_RUNS_DIR = join(REGISTRY_DIR, 'runs')
const VIEWER_RUNS_DIR = join(PUBLIC_ROOT, 'runs')

const TB21_WORKDIR = env.TB21_WORKDIR || '/Users/hugo/Desktop/super-refactor'
const TB21_TASKS_DIR = env.TB21_TASKS_DIR || join(TB21_WORKDIR, 'harbor/datasets/terminal-bench-2.1-proxy/tasks')
const TB21_RUNS_DIR = env.TB21_RUNS_DIR || join(TB21_WORKDIR, 'harbor/runs')
const TB21_BATCH_SCRIPT = env.TB21_BATCH_SCRIPT || join(TB21_WORKDIR, 'harbor/scripts/run_tb21_kimi_k26_batch.py')
const TB21_PYTHON = env.TB21_PYTHON || '/opt/miniconda3/envs/terminal-bench/bin/python'
const TB21_HARBOR = env.TB21_HARBOR || '/opt/miniconda3/envs/terminal-bench/bin/harbor'
const TB21_DOCKER_HOST = env.TB21_DOCKER_HOST || 'unix:///Users/hugo/.colima/tb21-harbor/docker.sock'
const CLAUDE_CODE_BINARY = env.HARBOR_CLAUDE_CODE_BINARY || join(TB21_WORKDIR, 'harbor/cache/claude-code/claude-linux-arm64')

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
const running = new Map()
const launchLocks = new Set()

function nowIso() {
  return new Date().toISOString()
}

function safeId(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'run'
}

function assertSafeId(value, label) {
  if (!SAFE_ID_RE.test(String(value || ''))) {
    throw httpError(400, `${label} must match ${SAFE_ID_RE}`)
  }
}

function httpError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function scrubText(text) {
  return String(text)
    .replace(/(sk-[A-Za-z0-9_-]{12,})/g, 'REDACTED')
    .replace(/((?:TOKEN_PLAN|ANTHROPIC|OPENAI|MINIMAX|GITHUB|GH)_[A-Z0-9_]*(?:KEY|TOKEN|SECRET)[A-Z0-9_]*=)[^\s]+/gi, '$1REDACTED')
    .replace(/(Authorization:\s*Bearer\s+)[^\s]+/gi, '$1REDACTED')
}

function fileKind(path) {
  const lower = path.toLowerCase()
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown'
  if (lower.endsWith('.json')) return 'json'
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html'
  if (lower.endsWith('.diff') || lower.endsWith('.patch')) return 'diff'
  if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.gif') || lower.endsWith('.svg') || lower.endsWith('.webp')) return 'image'
  if (lower.endsWith('.csv') || lower.endsWith('.tsv') || lower.endsWith('.xlsx')) return 'spreadsheet'
  if (/\.(py|js|ts|tsx|jsx|sh|rb|go|rs|java|sql|c|cpp|h)$/.test(lower) || basename(lower) === 'dockerfile') return 'code'
  return 'text'
}

function languageFor(path) {
  const lower = path.toLowerCase()
  if (lower.endsWith('.py')) return 'python'
  if (lower.endsWith('.js')) return 'javascript'
  if (lower.endsWith('.ts')) return 'typescript'
  if (lower.endsWith('.tsx')) return 'tsx'
  if (lower.endsWith('.sh')) return 'bash'
  if (lower.endsWith('.json')) return 'json'
  if (lower.endsWith('.toml')) return 'toml'
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml'
  if (lower.endsWith('.sql')) return 'sql'
  return undefined
}

async function walkFiles(root, base = root, out = []) {
  let entries = []
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.git')) continue
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      await walkFiles(path, base, out)
    } else if (entry.isFile()) {
      out.push(path.slice(base.length + 1))
    }
  }
  return out
}

async function collectTaskFiles(task) {
  const root = join(TB21_TASKS_DIR, task)
  const paths = (await walkFiles(root)).sort()
  const files = []
  for (const rel of paths) {
    const abs = join(root, rel)
    let info
    try {
      info = await stat(abs)
    } catch {
      continue
    }
    if (info.size > 200_000) {
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
    files.push({ path: rel, kind: fileKind(rel), language: languageFor(rel), content })
  }
  return files
}

function shouldUseDirectTaskCopy() {
  const mode = (process.env.RUNNER_CONTAINER_NETWORK || '').toLowerCase()
  if (mode === 'direct') return true
  if (mode === 'proxy') return false
  const baseUrl = process.env.ANTHROPIC_BASE_URL || process.env.TOKEN_PLAN_BASE_URL || ''
  return baseUrl.includes('coding.dashscope.aliyuncs.com')
}

async function prepareTasksDirForRun(task, runRoot) {
  if (!shouldUseDirectTaskCopy()) {
    return { tasksDir: TB21_TASKS_DIR, mode: 'proxy-task-source' }
  }

  const tasksDir = join(runRoot, 'task-copy')
  const source = join(TB21_TASKS_DIR, task)
  const destination = join(tasksDir, task)
  await mkdir(tasksDir, { recursive: true })
  await cp(source, destination, { recursive: true, force: true })

  const dockerfile = join(destination, 'environment', 'Dockerfile')
  try {
    const original = await readFile(dockerfile, 'utf8')
    const stripped = original
      .split(/\r?\n/)
      .filter((line) => !/^ENV\s+(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|http_proxy|https_proxy|all_proxy)=/i.test(line.trim()))
      .join('\n')
    await writeFile(dockerfile, `${stripped.replace(/\n*$/, '')}\n`)
  } catch {
    // Some tasks do not have a Dockerfile; Harbor will report the real error.
  }

  return { tasksDir, mode: 'direct-task-copy' }
}

function contentToText(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(contentToText).filter(Boolean).join('\n')
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text
    if (typeof content.content === 'string') return content.content
    return JSON.stringify(content)
  }
  return String(content)
}

function textFromContentBlocks(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks.map((block) => {
    if (!block || typeof block !== 'object') return String(block ?? '')
    if (typeof block.text === 'string') return block.text
    if (typeof block.content === 'string') return block.content
    if (block.type === 'tool_use') return `[tool_use ${block.name || 'tool'}] ${JSON.stringify(block.input ?? {})}`
    if (block.type === 'tool_result') return `[tool_result] ${typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '')}`
    return JSON.stringify(block)
  }).filter(Boolean).join('\n')
}

function mutationsForToolCalls(toolCalls) {
  const mutations = []
  for (const toolCall of toolCalls || []) {
    let args = {}
    try {
      args = JSON.parse(toolCall.args || '{}')
    } catch {
      args = {}
    }
    const name = String(toolCall.name || '')
    const lower = name.toLowerCase()
    const path = args.file_path || args.filepath || args.path || args.filename
    if (path && /(write|edit|replace|insert|patch)/i.test(name)) {
      mutations.push({ kind: 'file', tool: name, target: String(path), summary: lower.includes('write') ? 'file write' : 'file edit' })
    } else if (lower === 'bash') {
      const command = String(args.command || args.cmd || '').trim()
      mutations.push({ kind: 'command', tool: name, summary: command ? command.slice(0, 120) : 'terminal command' })
    }
  }
  return mutations.length ? mutations : null
}

function stepFromClaudeEvent(event, index) {
  const type = String(event?.type || event?.role || 'agent')
  if (type === 'system') return null
  const message = event?.message || event
  const blocks = Array.isArray(message?.content) ? message.content : null
  const toolResultBlocks = blocks ? blocks.filter((block) => block?.type === 'tool_result') : []
  const role = toolResultBlocks.length
    ? 'tool'
    : type === 'user'
      ? 'user'
      : type === 'assistant'
        ? 'assistant'
        : type === 'result'
          ? 'assistant'
          : 'agent'

  const toolCalls = blocks
    ? blocks
        .filter((block) => block?.type === 'tool_use')
        .map((block) => ({ name: block.name || 'tool', args: scrubText(JSON.stringify(block.input ?? {})) }))
    : null
  const textBlocks = blocks ? blocks.filter((block) => block?.type === 'text' || typeof block?.text === 'string') : null
  const reasoningBlocks = blocks ? blocks.filter((block) => block?.type === 'thinking' || typeof block?.thinking === 'string') : null
  let text = ''
  let reasoning = ''
  let observation = ''
  if (toolResultBlocks.length) {
    observation = toolResultBlocks.map((block) => contentToText(block.content)).filter(Boolean).join('\n')
  } else if (textBlocks?.length) {
    text = textBlocks.map((block) => contentToText(block.text ?? block.content)).filter(Boolean).join('\n')
  } else if (toolCalls?.length) {
    text = ''
  } else if (reasoningBlocks?.length) {
    text = ''
  } else if (typeof message?.content === 'string') text = message.content
  else if (Array.isArray(message?.content)) text = textFromContentBlocks(message.content)
  else if (typeof event?.result === 'string') text = event.result
  else if (typeof event?.summary === 'string') text = event.summary
  else text = JSON.stringify(event)
  if (reasoningBlocks?.length) {
    reasoning = reasoningBlocks.map((block) => contentToText(block.thinking ?? block.text ?? block.content)).filter(Boolean).join('\n')
  }

  return {
    index,
    role,
    text: text ? scrubText(text).slice(0, 40000) : null,
    reasoning: reasoning ? scrubText(reasoning).slice(0, 12000) : null,
    toolCalls,
    observation: observation ? scrubText(observation).slice(0, 40000) : null,
    mutations: mutationsForToolCalls(toolCalls),
  }
}

async function stepsFromTraceArtifact(path) {
  let content = ''
  try {
    content = await readFile(path, 'utf8')
  } catch {
    return []
  }
  const lines = content.split(/\r?\n/).filter((line) => line.trim())
  const steps = []
  for (const line of lines) {
    try {
      const step = stepFromClaudeEvent(JSON.parse(line), steps.length)
      if (step) steps.push(step)
    } catch {
      if (steps.length < 200) {
        steps.push({ index: steps.length, role: 'agent', text: scrubText(line).slice(0, 40000) })
      }
    }
  }
  if (!steps.length && content.trim()) {
    steps.push({ index: 0, role: 'agent', text: scrubText(content).slice(0, 40000) })
  }
  return steps
}

async function findVerifierLog(jobDir) {
  const candidates = [
    join(jobDir, 'verifier', 'test-stdout.txt'),
    join(jobDir, 'verifier', 'stdout.txt'),
  ]
  const entries = await readdir(jobDir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name === 'container_artifacts') continue
    candidates.push(join(jobDir, entry.name, 'verifier', 'test-stdout.txt'))
    candidates.push(join(jobDir, entry.name, 'verifier', 'stdout.txt'))
  }

  const artifactsRoot = join(jobDir, 'container_artifacts')
  const artifactEntries = await readdir(artifactsRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of artifactEntries) {
    if (!entry.isDirectory()) continue
    candidates.push(join(artifactsRoot, entry.name, 'logs', 'verifier', 'test-stdout.txt'))
    candidates.push(join(artifactsRoot, entry.name, 'logs', 'verifier', 'stdout.txt'))
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'container_artifacts') continue
    candidates.push(join(jobDir, entry.name, 'verifier', 'reward.txt'))
  }
  for (const entry of artifactEntries) {
    if (!entry.isDirectory()) continue
    candidates.push(join(artifactsRoot, entry.name, 'logs', 'verifier', 'reward.txt'))
  }

  const candidate = candidates.find((path) => existsSync(path))
  if (!candidate) return null
  try {
    return scrubText(await readFile(candidate, 'utf8')).slice(0, 80000)
  } catch {
    return null
  }
}

function evidenceLines(log, patterns, limit = 4) {
  if (!log) return []
  const lines = String(log).split(/\r?\n/)
  const matches = []
  for (const line of lines) {
    if (patterns.some((pattern) => pattern.test(line))) {
      matches.push(line.trim())
      if (matches.length >= limit) break
    }
  }
  return matches
}

function pytestSummary(log) {
  const text = String(log || '')
  const lines = text.split(/\r?\n/)
  const resultLine = [...lines].reverse().find((line) => /\d+\s+(?:failed|passed|error|skipped|warning)/i.test(line) && /\bin\s+[\d.]+s\b/i.test(line))
  const failedTests = []
  for (const line of lines) {
    const match = line.match(/^FAILED\s+.*?::([A-Za-z0-9_]+)/)
    if (match) failedTests.push(match[1])
  }
  return {
    resultLine: resultLine?.replace(/^=+|=+$/g, '').trim() || null,
    failedTests: [...new Set(failedTests)],
  }
}

function decorateRerunDiagnosis(diagnosis, verifierRerun, verifierLog, reward) {
  if (!diagnosis && reward !== 0 && reward !== 0.0) return null
  const summary = pytestSummary(verifierLog)
  const result = summary.resultLine || `reward ${reward ?? 'unknown'}`
  const failed = summary.failedTests.length ? ` Failed test: ${summary.failedTests.join(', ')}.` : ''
  const base = diagnosis || {
    kind: 'verifier_rerun_failure',
    severity: 'agent',
    label: 'Verifier rerun failure',
    evidence: [],
  }
  return {
    ...base,
    kind: base.kind === 'semantic_failure' ? 'semantic_failure' : base.kind,
    label: base.severity === 'infra' ? base.label : 'Verifier rerun semantic failure',
    summary: `Verifier rerun completed cleanly: ${result}.${failed}`.replace('..', '.'),
    evidence: [
      ...summary.failedTests.map((name) => `FAILED ${name}`),
      ...(base.evidence || []),
    ].slice(0, 6),
    recommendation: reward === 0 || reward === 0.0
      ? 'Use this as a clean negative/repair sample; the verifier infrastructure issue has been resolved by the rerun.'
      : 'Use the rerun reward as the corrected label; keep the original verifier log as raw infrastructure context.',
    rerunPath: verifierRerun?.dir,
  }
}

async function findVerifierRerun(runRoot) {
  if (!runRoot) return null
  const root = join(runRoot, 'verifier-reruns')
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const candidates = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    const stdoutPath = join(dir, 'test-stdout.txt')
    const rewardPath = join(dir, 'reward.txt')
    const verifierLog = await readFile(stdoutPath, 'utf8').catch(() => '')
    const rewardText = await readFile(rewardPath, 'utf8').catch(() => '')
    if (!verifierLog && !rewardText) continue
    const info = await stat(dir).catch(() => null)
    const rewardNumber = Number(rewardText.trim())
    candidates.push({
      id: entry.name,
      dir,
      stdoutPath,
      rewardPath,
      reward: Number.isFinite(rewardNumber) ? rewardNumber : null,
      verifierLog: scrubText(verifierLog),
      summary: pytestSummary(verifierLog),
      mtimeMs: info?.mtimeMs || 0,
    })
  }
  return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0] || null
}

function diagnoseVerifierLog(verifierLog, reward, row = {}) {
  const log = verifierLog || ''
  const lowered = log.toLowerCase()
  if (!log) {
    if (reward === 0 || reward === 0.0) {
      return {
        kind: 'verifier_unknown_zero',
        severity: 'warning',
        label: 'Verifier zero without log',
        summary: 'Reward is 0 but no verifier stdout was captured, so this should be reviewed before treating it as an agent failure.',
        evidence: [],
        recommendation: 'Keep the trace, but exclude it from clean preference/RL labels until a verifier log or rerun is available.',
      }
    }
    return null
  }

  const uvInstallFailed = /astral\.sh|uvx: command not found|\/root\/\.local\/bin\/env: no such file|uv: command not found/i.test(log)
  const networkFailed = /ssl_error|ssl_connect|connection reset|connection refused|failed to connect|could not resolve|temporary failure|operation timed out|unexpected_eof|eof occurred/i.test(log)
  const pytestStarted = /(?:^|\n)(?:=+ test session starts|collected \d+ items|FAILED|PASSED|ERRORS?|test_)/i.test(log)
  const rewardZero = reward === 0 || reward === 0.0 || row?.result_summary?.reward === 0 || row?.result_summary?.reward === 0.0

  if (uvInstallFailed && (networkFailed || !pytestStarted)) {
    return {
      kind: 'verifier_setup_network',
      severity: 'infra',
      label: 'Verifier infra failure',
      summary: 'The verifier failed while installing uv before pytest could run, so reward=0 is not a clean model-quality signal.',
      evidence: evidenceLines(log, [
        /astral\.sh/i,
        /SSL_ERROR|SSL_connect|connection reset|connection refused|failed to connect|could not resolve|temporary failure|operation timed out/i,
        /\/root\/\.local\/bin\/env: no such file/i,
        /uvx: command not found|uv: command not found/i,
      ]),
      recommendation: 'Treat this run as verifier-infra false-kill; rerun verifier with a working HTTPS path, cached uv, or a verifier-safe network profile.',
    }
  }

  if (networkFailed && !pytestStarted) {
    return {
      kind: 'verifier_setup_network',
      severity: 'infra',
      label: 'Verifier infra failure',
      summary: 'Network/setup failed before pytest started, so the reward is likely an infrastructure artifact.',
      evidence: evidenceLines(log, [
        /SSL_ERROR|SSL_connect|connection reset|connection refused|failed to connect|could not resolve|temporary failure|operation timed out|unexpected_eof/i,
      ]),
      recommendation: 'Do not use this as a clean negative label; rerun with verifier network fixed.',
    }
  }

  if (rewardZero && !pytestStarted && /command not found|no such file or directory|permission denied/i.test(lowered)) {
    return {
      kind: 'verifier_setup_error',
      severity: 'infra',
      label: 'Verifier setup failure',
      summary: 'The verifier failed in setup before running the task assertions.',
      evidence: evidenceLines(log, [/command not found/i, /no such file or directory/i, /permission denied/i]),
      recommendation: 'Review as infrastructure/setup failure before assigning model blame.',
    }
  }

  if (rewardZero && pytestStarted) {
    return {
      kind: 'semantic_failure',
      severity: 'agent',
      label: 'Verifier semantic failure',
      summary: 'Pytest appears to have run, so reward=0 is more likely a real task failure.',
      evidence: evidenceLines(log, [/FAILED/i, /AssertionError/i, /E\s+assert/i, /short test summary/i]),
      recommendation: 'This can be used as a negative/repair sample after checking the assertion.',
    }
  }

  return null
}

async function materializeViewerRun(run) {
  const enriched = await enrichRun(run)
  const row = enriched.state?.tasks?.[run.task]
  if (!row) return null
  const viewerTaskId = `runner-${safeId(run.task)}`
  const viewerRunId = `runner-${safeId(run.id)}`
  const agentId = `runner-${safeId(run.agent)}-${safeId(run.model)}`
  const vendorId = 'runner-api'
  const traceArtifacts = row.result_summary?.trace_artifacts || []
  const tracePath = traceArtifacts.find((path) => /claude-code\.txt$/.test(path))
    || traceArtifacts.find((path) => /\.jsonl$/.test(path))
    || traceArtifacts[0]
  const steps = tracePath ? await stepsFromTraceArtifact(tracePath) : []
  const originalVerifierLog = row.job_dir ? await findVerifierLog(row.job_dir) : null
  const originalReward = row.result_summary?.reward ?? row.result_summary?.trial_results?.find((item) => item.reward != null)?.reward ?? null
  const verifierRerun = await findVerifierRerun(run.runRoot)
  const verifierLog = verifierRerun?.verifierLog || originalVerifierLog
  const reward = verifierRerun?.reward ?? originalReward
  const diagnosisRow = verifierRerun
    ? { ...row, result_summary: { ...(row.result_summary || {}), reward } }
    : row
  let verifierDiagnosis = verifierRerun
    ? diagnoseVerifierLog(verifierLog, reward, diagnosisRow)
    : row.verifier_diagnosis || diagnoseVerifierLog(verifierLog, reward, row)
  if (verifierRerun) {
    verifierDiagnosis = decorateRerunDiagnosis(verifierDiagnosis, verifierRerun, verifierLog, reward)
  }
  const status = row.status === 'finished' ? 'completed' : row.status === 'process_error' ? 'error' : 'failed'
  const failureReason = verifierDiagnosis
    ? `${verifierDiagnosis.label}: ${verifierDiagnosis.summary}`
    : row.status === 'finished'
      ? null
      : row.status
  const grade = reward != null || verifierDiagnosis || verifierLog
    ? {
        score: reward,
        maxScore: 1,
        subscores: [],
        summary: verifierDiagnosis?.summary || null,
        findings: verifierDiagnosis ? [{
          category: verifierDiagnosis.severity === 'infra' ? 'verifier-infra' : 'verifier',
          severity: verifierDiagnosis.severity === 'infra' ? 'major' : 'minor',
          summary: verifierDiagnosis.label,
          detail: verifierDiagnosis.recommendation,
        }] : [],
        verifier: verifierDiagnosis ? {
          checked: 'Verifier setup and task assertions',
          produced: verifierDiagnosis.summary,
          quote: verifierDiagnosis.evidence?.join('\n') || null,
        } : null,
      }
    : null

  await mkdir(VIEWER_RUNS_DIR, { recursive: true })
  await writeJson(join(VIEWER_RUNS_DIR, `${viewerRunId}.json`), { steps, verifierLog })

  const bundle = {
    vendors: [{ id: vendorId, name: 'Runner API', coverage: 'Live Harbor / Terminal-Bench runs launched from the local runner API.' }],
    agents: [{ id: agentId, harness: 'Claude Code', model: run.model, family: run.model.includes('kimi') ? 'Moonshot' : 'unknown', vendorId }],
    tasks: [{
      id: viewerTaskId,
      vendorId,
      title: run.task,
      source: 'harbor',
      category: 'Terminal-Bench 2.1 live runner',
      difficulty: '',
      files: await collectTaskFiles(run.task),
      metadata: {
        runnerRunId: run.id,
        runRoot: run.runRoot,
        jobDir: row.job_dir,
        traceExports: row.trace_exports || [],
        containerArtifacts: row.container_artifacts || null,
        originalReward,
        originalVerifierDiagnosis: row.verifier_diagnosis || diagnoseVerifierLog(originalVerifierLog, originalReward, row),
        verifierRerun,
        verifierDiagnosis,
      },
    }],
    runs: [{
      id: viewerRunId,
      taskId: viewerTaskId,
      agentId,
      vendorId,
      format: 'harbor',
      status,
      passed: reward === 1 || reward === 1.0,
      reward,
      steps: [],
      stepCount: steps.length,
      turns: steps.filter((step) => step.role === 'assistant' || step.role === 'agent').length,
      durationSec: row.duration_sec ?? null,
      hasVerifierLog: Boolean(verifierLog),
      artifacts: row.trace_exports || [],
      grade,
      failureReason,
    }],
  }
  const bundlePath = join(UI_RUNS_DIR, run.id, 'viewer-bundle.json')
  await writeJson(bundlePath, bundle)
  return {
    taskId: viewerTaskId,
    runId: viewerRunId,
    url: `/tasks/${viewerTaskId}/runs/${viewerRunId}`,
    bundleUrl: `/runner/runs/${encodeURIComponent(run.id)}/viewer-bundle.json`,
    steps: steps.length,
  }
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJson(path, data) {
  await mkdir(resolve(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`)
}

async function registry() {
  const data = await readJson(REGISTRY_PATH, { runs: [] })
  return Array.isArray(data.runs) ? data : { runs: [] }
}

async function saveRegistry(data) {
  data.updatedAt = nowIso()
  await writeJson(REGISTRY_PATH, data)
}

async function upsertRun(patch) {
  const data = await registry()
  const index = data.runs.findIndex((run) => run.id === patch.id)
  if (index >= 0) data.runs[index] = { ...data.runs[index], ...patch, updatedAt: nowIso() }
  else data.runs.unshift({ ...patch, createdAt: patch.createdAt || nowIso(), updatedAt: nowIso() })
  await saveRegistry(data)
  return data.runs.find((run) => run.id === patch.id)
}

async function taskExists(task) {
  try {
    const info = await stat(join(TB21_TASKS_DIR, task))
    return info.isDirectory()
  } catch {
    return false
  }
}

async function listTasks(query = '') {
  const entries = await readdir(TB21_TASKS_DIR, { withFileTypes: true }).catch(() => [])
  const q = query.trim().toLowerCase()
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !q || name.toLowerCase().includes(q))
    .sort()
}

async function readState(run) {
  const state = await readJson(run.statePath, null)
  if (!state) return null
  const taskRows = state.tasks && typeof state.tasks === 'object' ? Object.values(state.tasks) : []
  const verifierRerun = await findVerifierRerun(run.runRoot)
  const counts = {}
  for (const row of taskRows) {
    const status = row?.status || 'unknown'
    counts[status] = (counts[status] || 0) + 1
    const reward = row?.result_summary?.reward ?? row?.result_summary?.trial_results?.find((item) => item.reward != null)?.reward ?? null
    const originalVerifierLog = row?.job_dir ? await findVerifierLog(row.job_dir) : null
    const verifierLog = verifierRerun?.verifierLog || originalVerifierLog
    const effectiveReward = verifierRerun?.reward ?? reward
    const diagnosis = verifierRerun
      ? decorateRerunDiagnosis(diagnoseVerifierLog(verifierLog, effectiveReward, row), verifierRerun, verifierLog, effectiveReward)
      : diagnoseVerifierLog(verifierLog, reward, row)
    if (verifierRerun) row.verifier_rerun = verifierRerun
    if (diagnosis) row.verifier_diagnosis = diagnosis
  }
  return { ...state, counts }
}

async function readTail(path, maxBytes = 60000) {
  try {
    const info = await stat(path)
    const start = Math.max(0, info.size - maxBytes)
    const handle = await import('node:fs/promises').then((fs) => fs.open(path, 'r'))
    try {
      const buffer = Buffer.alloc(info.size - start)
      await handle.read(buffer, 0, buffer.length, start)
      return scrubText(buffer.toString('utf8'))
    } finally {
      await handle.close()
    }
  } catch {
    return ''
  }
}

async function enrichRun(run) {
  const state = await readState(run)
  let status = run.status
  let finishedAt = run.finishedAt
  if (state?.tasks) {
    const rows = Object.values(state.tasks)
    if (rows.length && rows.every((row) => ['finished', 'harbor_error', 'process_error', 'interrupted_by_runner_restart'].includes(row.status))) {
      status = rows.every((row) => row.status === 'finished') ? 'finished' : 'error'
      finishedAt = rows.map((row) => row.finished_at).filter(Boolean).sort().at(-1) || finishedAt
    } else if (rows.some((row) => row.status === 'running')) {
      status = 'running'
    }
  }
  return {
    ...run,
    status,
    finishedAt,
    state,
    isProcessAttached: running.has(run.id),
    logUrl: `/api/runner/runs/${encodeURIComponent(run.id)}/log`,
    stateUrl: `/api/runner/runs/${encodeURIComponent(run.id)}`,
    publicStatusUrl: `/runner/runs/${encodeURIComponent(run.id)}/status.json`,
  }
}

async function requestBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!chunks.length) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  return JSON.parse(text)
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(`${JSON.stringify(data, null, 2)}\n`)
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

function requireToken(req) {
  if (!API_TOKEN) return
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (token !== API_TOKEN) throw httpError(401, 'runner API token is missing or invalid')
}

async function startRun(body) {
  const benchmark = body.benchmark || 'terminal-bench-2.1'
  const task = body.task || ''
  const agent = body.agent || 'claude-code'
  const model = body.model || 'kimi-k2.5'
  assertSafeId(task, 'task')
  assertSafeId(model, 'model')
  if (benchmark !== 'terminal-bench-2.1') throw httpError(400, 'only terminal-bench-2.1 is supported')
  if (agent !== 'claude-code') throw httpError(400, 'only claude-code is supported')
  if (!(await taskExists(task))) throw httpError(404, `task not found under ${TB21_TASKS_DIR}: ${task}`)

  const launchKey = `${benchmark}:${agent}:${model}:${task}`
  const registryData = await registry()
  const activeDuplicate = registryData.runs.find((run) => (
    run.benchmark === benchmark &&
    run.agent === agent &&
    run.model === model &&
    run.task === task &&
    ['starting', 'running', 'stopping'].includes(run.status)
  ))
  if (activeDuplicate || launchLocks.has(launchKey)) {
    throw httpError(409, `run already active for ${task} / ${model}: ${activeDuplicate?.id || 'starting'}`)
  }
  launchLocks.add(launchKey)

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').toLowerCase()
  const runName = safeId(body.runName || `tb21-${task}-claude-code-${model}-${stamp}`)
  const id = runName

  const runUiDir = join(UI_RUNS_DIR, id)
  await mkdir(runUiDir, { recursive: true })
  const apiLogPath = join(runUiDir, 'runner-api.log')
  const runRoot = join(TB21_RUNS_DIR, runName)
  const statePath = join(runRoot, 'state.json')
  const prepared = await prepareTasksDirForRun(task, runRoot)

  const args = [
    TB21_BATCH_SCRIPT,
    '--workdir', TB21_WORKDIR,
    '--tasks-dir', prepared.tasksDir,
    '--runs-dir', TB21_RUNS_DIR,
    '--run-name', runName,
    '--model', model,
    '--task', task,
    '--min-concurrency', String(Number(body.minConcurrency || 1)),
    '--max-concurrency', String(Number(body.maxConcurrency || 1)),
    '--max-task-memory-mb', String(Number(body.maxTaskMemoryMb || 16384)),
    '--low-disk-gb', String(Number(body.lowDiskGb || 35)),
    '--prune-cache-below-gb', String(Number(body.pruneCacheBelowGb || 45)),
    '--harbor-retries', String(Number(body.harborRetries || 1)),
    '--include-verifier-metadata',
  ]
  if (body.forceRerun) args.push('--force-rerun')
  if (body.noForceBuild) args.push('--no-force-build')

  const shell = [
    'set -euo pipefail',
    'source ~/.bashrc >/dev/null 2>&1 || true',
    `export DOCKER_HOST=${shellQuote(TB21_DOCKER_HOST)}`,
    `export HARBOR_CLAUDE_CODE_BINARY=${shellQuote(CLAUDE_CODE_BINARY)}`,
    `export HARBOR_BIN=${shellQuote(TB21_HARBOR)}`,
    'export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="${CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:-1}"',
    `exec ${shellQuote(TB21_PYTHON)} ${args.map(shellQuote).join(' ')}`,
  ].join('\n')

  try {
    const run = await upsertRun({
      id,
      benchmark,
      task,
      agent,
      model,
      runName,
      status: 'starting',
      startedAt: nowIso(),
      runRoot,
      statePath,
      apiLogPath,
      containerNetwork: prepared.mode,
      tasksDir: prepared.tasksDir,
      commandSummary: `${basename(TB21_PYTHON)} ${basename(TB21_BATCH_SCRIPT)} --run-name ${runName} --model ${model} --task ${task}`,
    })
    await writeJson(join(runUiDir, 'status.json'), run)

    const logStream = createWriteStream(apiLogPath, { flags: 'a' })
    logStream.write(`[${nowIso()}] starting ${run.commandSummary}\n`)
    const child = spawn('bash', ['-lc', shell], {
      cwd: TB21_WORKDIR,
      env: { ...process.env },
      detached: true,
    })
    running.set(id, child)
    await upsertRun({ id, status: 'running', pid: child.pid })

    child.stdout.on('data', (chunk) => logStream.write(scrubText(chunk.toString())))
    child.stderr.on('data', (chunk) => logStream.write(scrubText(chunk.toString())))
    child.on('exit', async (code, signal) => {
      running.delete(id)
      const nextStatus = code === 0 ? 'finished' : 'error'
      logStream.write(`[${nowIso()}] exited code=${code} signal=${signal || ''}\n`)
      logStream.end()
      const finalRun = await upsertRun({ id, status: nextStatus, returncode: code, signal, finishedAt: nowIso() })
      try {
        const viewer = await materializeViewerRun(finalRun)
        if (viewer) {
          await upsertRun({ id, viewer })
        }
      } catch (err) {
        await upsertRun({ id, viewerError: err instanceof Error ? err.message : String(err) })
      }
      await writeJson(join(runUiDir, 'status.json'), await enrichRun(finalRun))
    })

    return enrichRun(await upsertRun({ id, status: 'running', pid: child.pid }))
  } finally {
    launchLocks.delete(launchKey)
  }
}

async function stopRun(id) {
  const child = running.get(id)
  if (!child) throw httpError(404, 'run is not attached to this runner process')
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  return upsertRun({ id, status: 'stopping', stoppedAt: nowIso() })
}

async function route(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  const path = url.pathname

  if (req.method === 'GET' && path === '/api/runner/health') {
    return sendJson(res, 200, { ok: true, host: HOST, port: PORT, hasToken: Boolean(API_TOKEN) })
  }
  if (req.method === 'GET' && path === '/api/runner/config') {
    return sendJson(res, 200, {
      tb21Workdir: TB21_WORKDIR,
      tb21TasksDir: TB21_TASKS_DIR,
      tb21RunsDir: TB21_RUNS_DIR,
      tb21BatchScript: TB21_BATCH_SCRIPT,
      tb21Python: TB21_PYTHON,
      dockerHost: TB21_DOCKER_HOST,
      publicRoot: PUBLIC_ROOT,
      hasToken: Boolean(API_TOKEN),
    })
  }
  if (req.method === 'GET' && path === '/api/runner/tasks') {
    return sendJson(res, 200, { tasks: await listTasks(url.searchParams.get('q') || '') })
  }
  if (req.method === 'GET' && path === '/api/runner/runs') {
    const data = await registry()
    return sendJson(res, 200, { runs: await Promise.all(data.runs.map(enrichRun)) })
  }
  if (req.method === 'POST' && path === '/api/runner/runs') {
    requireToken(req)
    return sendJson(res, 201, await startRun(await requestBody(req)))
  }

  const runMatch = path.match(/^\/api\/runner\/runs\/([^/]+)(?:\/([^/]+))?$/)
  if (runMatch) {
    const id = decodeURIComponent(runMatch[1])
    const action = runMatch[2] || ''
    const data = await registry()
    const run = data.runs.find((item) => item.id === id)
    if (!run) throw httpError(404, `run not found: ${id}`)
    if (req.method === 'GET' && !action) return sendJson(res, 200, await enrichRun(run))
    if (req.method === 'GET' && action === 'log') {
      const state = await readState(run)
      const rows = state?.tasks ? Object.values(state.tasks) : []
      const jobLog = rows.map((row) => row?.job_dir && join(row.job_dir, 'runner.log')).filter(Boolean).at(-1)
      const text = [await readTail(run.apiLogPath), jobLog ? await readTail(jobLog) : ''].filter(Boolean).join('\n\n--- job runner.log ---\n')
      return sendText(res, 200, text || 'No log yet.\n')
    }
    if (req.method === 'GET' && action === 'viewer-bundle.json') {
      let bundle = await readJson(join(UI_RUNS_DIR, id, 'viewer-bundle.json'), null)
      if (!bundle) {
        const viewer = await materializeViewerRun(run)
        if (viewer) await upsertRun({ id, viewer })
        bundle = await readJson(join(UI_RUNS_DIR, id, 'viewer-bundle.json'), null)
      }
      if (!bundle) throw httpError(404, `viewer bundle is not ready for ${id}`)
      return sendJson(res, 200, bundle)
    }
    if (req.method === 'POST' && action === 'stop') {
      requireToken(req)
      return sendJson(res, 200, await stopRun(id))
    }
  }

  throw httpError(404, 'not found')
}

if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !API_TOKEN) {
  console.error('Refusing to bind a non-local runner API without RUNNER_API_TOKEN.')
  process.exit(2)
}

await mkdir(UI_RUNS_DIR, { recursive: true })
await saveRegistry(await registry())

createServer((req, res) => {
  route(req, res).catch((err) => {
    sendJson(res, err.status || 500, { error: err.message || 'internal error' })
  })
}).listen(PORT, HOST, () => {
  console.log(`runner-api listening on http://${HOST}:${PORT}`)
})
