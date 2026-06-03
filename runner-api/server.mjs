#!/usr/bin/env node
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
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
  const counts = {}
  for (const row of taskRows) {
    const status = row?.status || 'unknown'
    counts[status] = (counts[status] || 0) + 1
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

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').toLowerCase()
  const runName = safeId(body.runName || `tb21-${task}-claude-code-${model}-${stamp}`)
  const id = runName
  if (running.has(id)) throw httpError(409, `run already attached: ${id}`)

  const runUiDir = join(UI_RUNS_DIR, id)
  await mkdir(runUiDir, { recursive: true })
  const apiLogPath = join(runUiDir, 'runner-api.log')
  const runRoot = join(TB21_RUNS_DIR, runName)
  const statePath = join(runRoot, 'state.json')

  const args = [
    TB21_BATCH_SCRIPT,
    '--workdir', TB21_WORKDIR,
    '--tasks-dir', TB21_TASKS_DIR,
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
    await writeJson(join(runUiDir, 'status.json'), await enrichRun(finalRun))
  })

  return enrichRun(await upsertRun({ id, status: 'running', pid: child.pid }))
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
