export interface RunnerConfig {
  tb21Workdir: string
  tb21TasksDir: string
  tb21RunsDir: string
  tb21BatchScript: string
  tb21Python: string
  dockerHost: string
  publicRoot: string
  hasToken: boolean
}

export interface RunnerTaskList {
  tasks: string[]
}

export interface RunnerRun {
  id: string
  benchmark: string
  task: string
  agent: string
  model: string
  runName: string
  status: 'starting' | 'running' | 'stopping' | 'finished' | 'error' | string
  startedAt?: string
  finishedAt?: string
  runRoot?: string
  statePath?: string
  apiLogPath?: string
  commandSummary?: string
  pid?: number
  returncode?: number | null
  signal?: string | null
  isProcessAttached?: boolean
  logUrl?: string
  publicStatusUrl?: string
  viewer?: {
    taskId: string
    runId: string
    url: string
    bundleUrl: string
    steps: number
  }
  viewerError?: string
  state?: {
    counts?: Record<string, number>
    tasks?: Record<string, {
      status?: string
      reward?: number | null
      result_summary?: {
        reward?: number | null
        trace_artifact_count?: number
        trace_artifacts?: string[]
        trial_results?: Array<{
          reward?: number | null
          agent_error?: string | null
          verifier_error?: string | null
          exception_type?: string | null
          exception_message?: string | null
        }>
      }
      trace_exports?: string[]
      container_artifacts?: {
        container_count?: number
        copy_paths?: string[]
      }
      started_at?: string
      finished_at?: string
      duration_sec?: number
      job_dir?: string
    }>
  } | null
}

function authHeaders(token: string): HeadersInit {
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/runner${path}`, init)
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) throw new Error(data?.error || `runner API ${res.status}`)
  return data as T
}

export function getRunnerConfig() {
  return api<RunnerConfig>('/config')
}

export function listRunnerTasks(q = '') {
  return api<RunnerTaskList>(`/tasks${q ? `?q=${encodeURIComponent(q)}` : ''}`)
}

export function listRunnerRuns() {
  return api<{ runs: RunnerRun[] }>('/runs')
}

export function getRunnerLog(id: string) {
  return fetch(`/api/runner/runs/${encodeURIComponent(id)}/log`).then(async (res) => {
    const text = await res.text()
    if (!res.ok) throw new Error(text || `runner API ${res.status}`)
    return text
  })
}

export function startRunnerRun(input: {
  token: string
  task: string
  model: string
  forceRerun?: boolean
}) {
  return api<RunnerRun>('/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(input.token) },
    body: JSON.stringify({
      benchmark: 'terminal-bench-2.1',
      agent: 'claude-code',
      task: input.task,
      model: input.model,
      forceRerun: input.forceRerun,
    }),
  })
}

export function stopRunnerRun(id: string, token: string) {
  return api<RunnerRun>(`/runs/${encodeURIComponent(id)}/stop`, {
    method: 'POST',
    headers: authHeaders(token),
  })
}
