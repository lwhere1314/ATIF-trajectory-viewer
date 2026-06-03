---
name: terminal-bench-runner-api
description: Start and monitor Hugo's local/SSD Terminal-Bench 2.1 Harbor runs through the ATIF Trajectory Viewer runner API.
---

# Terminal-Bench Runner API

Use this when Hugo asks to run a Terminal-Bench 2.1 task from this viewer, for
example: "跑一下 claude-code kimi-k2.5 的 terminal-bench-2.1 的
cancel-async-tasks 实验".

## Local SSD profile

The runner API defaults to Hugo's SSD setup:

- Workdir: `/Users/hugo/Desktop/super-refactor`
- Tasks: `/Users/hugo/Desktop/super-refactor/harbor/datasets/terminal-bench-2.1-proxy/tasks`
- Runs: `/Users/hugo/Desktop/super-refactor/harbor/runs`
- Harbor CLI: `/opt/miniconda3/envs/terminal-bench/bin/harbor`
- Python: `/opt/miniconda3/envs/terminal-bench/bin/python`
- Docker socket: `unix:///Users/hugo/.colima/tb21-harbor/docker.sock`
- Claude Code binary: `/Users/hugo/Desktop/super-refactor/harbor/cache/claude-code/claude-linux-arm64`

## Start the API

```bash
cd /Users/hugo/Documents/terminal-bench-3.0-PR/ATIF-trajectory-viewer
source ~/.bashrc >/dev/null 2>&1 || true
npm run runner:api
```

## Launch one task

```bash
curl -sS http://127.0.0.1:8787/api/runner/runs \
  -H 'Content-Type: application/json' \
  -d '{"benchmark":"terminal-bench-2.1","agent":"claude-code","model":"kimi-k2.5","task":"cancel-async-tasks"}'
```

Then watch `/runner` in the viewer. Use the returned `id` to inspect:

```bash
curl -sS http://127.0.0.1:8787/api/runner/runs/<id>
curl -sS http://127.0.0.1:8787/api/runner/runs/<id>/log
```

## Completion expectations

A run is useful for later analysis only when `state.json` records the task row
and the row has nonempty `trace_exports` or raw trace fallback data. Container
artifacts should include sanitized inspect data, Docker diff, copied `/logs`,
copied `/tests`, and copied code directories such as `/app` or `/workspace`.

Never print or store provider API keys. Report rewards, status counts, file
paths, timestamps, and artifact coverage instead of dumping full model traces.
