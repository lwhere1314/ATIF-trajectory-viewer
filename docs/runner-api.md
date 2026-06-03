# Runner API

The runner API lets this viewer start and monitor local or server-side
Terminal-Bench 2.1 Harbor runs without routing deployments through an inherited
Vercel project.

The API is intentionally separate from the static viewer. It should run on the
same trusted machine that owns Docker, Harbor, Claude Code, and model API
credentials.

## Start the local SSD runner

```bash
cd /Users/hugo/Documents/terminal-bench-3.0-PR/ATIF-trajectory-viewer
source ~/.bashrc >/dev/null 2>&1 || true
npm run runner:api
```

Defaults mirror Hugo's local SSD setup:

```text
TB21_WORKDIR=/Users/hugo/Desktop/super-refactor
TB21_TASKS_DIR=/Users/hugo/Desktop/super-refactor/harbor/datasets/terminal-bench-2.1-proxy/tasks
TB21_RUNS_DIR=/Users/hugo/Desktop/super-refactor/harbor/runs
TB21_BATCH_SCRIPT=/Users/hugo/Desktop/super-refactor/harbor/scripts/run_tb21_kimi_k26_batch.py
TB21_PYTHON=/opt/miniconda3/envs/terminal-bench/bin/python
TB21_HARBOR=/opt/miniconda3/envs/terminal-bench/bin/harbor
TB21_DOCKER_HOST=unix:///Users/hugo/.colima/tb21-harbor/docker.sock
HARBOR_CLAUDE_CODE_BINARY=/Users/hugo/Desktop/super-refactor/harbor/cache/claude-code/claude-linux-arm64
```

Keep `TOKEN_PLAN_API_KEY`, `ANTHROPIC_API_KEY`, or other provider secrets in the
process environment or `~/.bashrc`; never commit them.

## Start a task

```bash
curl -sS http://127.0.0.1:8787/api/runner/runs \
  -H 'Content-Type: application/json' \
  -d '{
    "benchmark": "terminal-bench-2.1",
    "agent": "claude-code",
    "model": "kimi-k2.5",
    "task": "cancel-async-tasks"
  }'
```

Then open `/runner` in the viewer. The page polls:

- `GET /api/runner/runs`
- `GET /api/runner/runs/<runId>`
- `GET /api/runner/runs/<runId>/log`

The API stores public status snapshots under `public/runner/runs/<runId>/` and
the authoritative Harbor state under `TB21_RUNS_DIR/<runName>/state.json`.

## Safety

- By default the API binds to `127.0.0.1:8787`.
- If you set `RUNNER_API_HOST=0.0.0.0`, you must also set `RUNNER_API_TOKEN`.
- Mutating endpoints require `Authorization: Bearer <RUNNER_API_TOKEN>` when a
  token is configured.
- Do not expose the runner API directly to the public internet. Put it behind
  SSH, VPN, or a private reverse proxy.

## What gets preserved

The API launches the existing SSD batch runner in single-task mode. That runner
preserves trace exports and container artifacts before cleanup, including
`/logs`, `/app`, `/workspace`, and `/tests`, then removes matching Harbor task
containers/images so the machine does not fill up.
