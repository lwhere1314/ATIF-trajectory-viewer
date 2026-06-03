#!/usr/bin/env python3
"""Build a local ATIF Viewer dataset from Hugo's SSD Harbor runs.

The generated files live under `public/local/minimax-m3/`, which is intended
for local dev only and is ignored by git. Run from the repo root:

    python3 scripts/ingest_minimax_ssd.py
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
DEFAULT_RUNS_ROOT = Path("/Volumes/SSD/terminal-bench-harbor/harbor/runs")
DEFAULT_RUN_ROOT = Path("/Volumes/SSD/terminal-bench-harbor/harbor/runs/tb21-minimax-m3-local-019e737a-ssd-proxy")
DEFAULT_TB_TASKS = Path("/Users/hugo/Desktop/super-refactor/harbor/datasets/terminal-bench-2.1-proxy/tasks")
DEFAULT_OUT = ROOT / "public" / "local" / "minimax-m3"

spec = importlib.util.spec_from_file_location("atif_ingest_base", HERE / "ingest.py")
base = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(base)


def read_json(path: Path) -> dict | None:
    try:
        with path.open(encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def existing_path(path: str | None) -> Path | None:
    if not path:
        return None
    p = Path(path)
    if p.exists():
        return p
    if not p.is_absolute():
        for root in (Path("/Users/hugo/Desktop/super-refactor"), Path("/Volumes/SSD/terminal-bench-harbor")):
            alt = root / path
            if alt.exists():
                return alt
    # The batch metadata records /Users/hugo/Desktop/super-refactor/harbor,
    # which is a local convenience path to the SSD. Fall back to the mounted
    # SSD path when that link is absent.
    prefix = "/Users/hugo/Desktop/super-refactor/harbor"
    if path.startswith(prefix):
        alt = Path("/Volumes/SSD/terminal-bench-harbor/harbor") / path[len(prefix):].lstrip("/")
        if alt.exists():
            return alt
    return None


def task_name_from_job(job_name: str, model_suffix: str = "-claude-code-MiniMax-M3") -> str:
    name = job_name
    if name.startswith("tb21-"):
        name = name[len("tb21-"):]
    if name.endswith(model_suffix):
        name = name[:-len(model_suffix)]
    name = name.removesuffix("-claude-code-kimi-k25")
    name = name.removesuffix("-claude-code-kimi-k26")
    name = name.removesuffix("-claude-code-k6")
    return name


def task_dir_from_sources(task_name: str, trial_result: dict | None, job_config: dict | None, state: dict) -> Path | None:
    for d in (trial_result, job_config):
        task = ((d or {}).get("config") or {}).get("task") or (d or {}).get("task") or {}
        p = existing_path(task.get("path") if isinstance(task, dict) else None)
        if p:
            return p
        tasks = (d or {}).get("tasks")
        if isinstance(tasks, list) and tasks:
            first = tasks[0] if isinstance(tasks[0], dict) else {}
            p = existing_path(first.get("path"))
            if p:
                return p
    dataset_path = existing_path(state.get("dataset_path"))
    if dataset_path:
        p = dataset_path / task_name
        if p.exists():
            return p
    return None


def parse_reward(trial_dir: Path, result: dict | None) -> float | None:
    reward = (((result or {}).get("verifier_result") or {}).get("rewards") or {}).get("reward")
    if reward is not None:
        try:
            return float(reward)
        except Exception:
            pass
    txt = base.read_text(str(trial_dir / "verifier" / "reward.txt"))
    if txt:
        try:
            return float(txt.strip())
        except Exception:
            return None
    return None


def parse_tokens(result: dict | None) -> dict | None:
    ar = (result or {}).get("agent_result")
    if not isinstance(ar, dict):
        return None
    tok = {
        "prompt": ar.get("n_input_tokens"),
        "completion": ar.get("n_output_tokens"),
        "cached": ar.get("n_cache_tokens"),
        "costUsd": ar.get("cost_usd"),
    }
    return {k: v for k, v in tok.items() if v is not None} or None


def parse_ts(ts: str | None):
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except Exception:
        return None


def add_elapsed_times(steps: list[dict]) -> None:
    first = next((parse_ts(s.get("timestamp")) for s in steps if parse_ts(s.get("timestamp"))), None)
    if not first:
        return
    for s in steps:
        cur = parse_ts(s.get("timestamp"))
        if cur:
            s["tSec"] = max(0.0, (cur - first).total_seconds())


def load_task(task_name: str, task_dir: Path, vendor_id: str, run_root: Path, task_prefix: str = "tb21-minimax-m3") -> str:
    tid = base.slug(f"{task_prefix}-{task_name}")
    if any(t["id"] == tid for t in base.tasks):
        return tid
    instr = base.scrub_secrets(base.read_text(str(task_dir / "instruction.md")))
    toml_text = base.read_text(str(task_dir / "task.toml")) or ""
    meta = base.task_toml_meta(toml_text)
    files = base.collect_files(str(task_dir), str(task_dir))
    base.tasks.append({
        "id": tid,
        "vendorId": vendor_id,
        "title": task_name,
        "source": "harbor",
        "category": meta.get("category", "Terminal-Bench 2.1"),
        "difficulty": meta.get("difficulty", "medium"),
        "instruction": instr,
        "files": files,
        "metadata": {
            "tb_task_name": task_name,
            "tb_version": "2.1",
            "tags": meta.get("tags", []),
            "ssd_run_root": str(run_root),
            "task_dir": str(task_dir),
        },
    })
    return tid


def load_trial(job_dir: Path, trial_dir: Path, task_name: str, task_id: str, vendor_id: str, run_prefix: str = "tb21-minimax-m3") -> bool:
    result = read_json(trial_dir / "result.json") or read_json(job_dir / "result.json")
    config = read_json(trial_dir / "config.json") or read_json(job_dir / "config.json") or {}
    cfg_agent = ((result or {}).get("config") or {}).get("agent") or config.get("agent") or {}
    if not isinstance(cfg_agent, dict):
        cfg_agent = {}

    traj = read_json(trial_dir / "agent" / "trajectory.json")
    traj_agent = (traj or {}).get("agent") or {}
    if not isinstance(traj_agent, dict):
        traj_agent = {}
    harness = cfg_agent.get("name") or traj_agent.get("name") or "claude-code"
    model = cfg_agent.get("model_name") or traj_agent.get("model_name") or "MiniMax-M3"
    aid = base.agent(harness, model, vendor_id)
    if str(model).lower() == "minimax-m3":
        base.agents[aid]["model"] = "MiniMax-M3"
        base.agents[aid]["family"] = "MiniMax"

    raw_steps = (traj or {}).get("steps") or []
    steps = [base.step_from_atif(s, i) for i, s in enumerate(raw_steps[:base.MAX_STEPS])]
    add_elapsed_times(steps)

    reward = parse_reward(trial_dir, result)
    passed = reward is not None and reward >= 0.999
    status = "passed" if passed else ("failed" if reward is not None else ("error" if (result or {}).get("exception_info") else "completed"))
    vlog = base.read_text(str(trial_dir / "verifier" / "test-stdout.txt"))
    if vlog:
        vlog = base.scrub_secrets(vlog)

    trial_name = (result or {}).get("trial_name") or trial_dir.name
    run_id = base.slug(f"{run_prefix}-{task_name}-{trial_name}")[:120]
    grade_summary = f"{harness} · {model} · {trial_name}"
    if not steps:
        grade_summary += " · no trajectory exported"

    base.emit_run({
        "id": run_id,
        "taskId": task_id,
        "agentId": aid,
        "vendorId": vendor_id,
        "format": "atif",
        "status": status,
        "passed": passed,
        "reward": reward,
        "steps": steps,
        "verifierLog": vlog,
        "artifacts": base.run_artifacts(steps),
        "turns": sum(1 for s in steps if s["role"] == "agent"),
        "durationSec": base.iso_duration((result or {}).get("started_at"), (result or {}).get("finished_at")),
        "tokens": parse_tokens(result),
        "grade": {
            "score": reward,
            "maxScore": 1.0,
            "subscores": [],
            "summary": grade_summary,
            "gate": None,
            "breakdown": None,
            "findings": None,
        },
        "failureReason": base.clean_exc((result or {}).get("exception_info")),
    })
    return True


def text_file(path: Path, max_chars: int = 80_000) -> str | None:
    text = base.read_text(str(path))
    if text and len(text) > max_chars:
        return text[:max_chars] + f"\n...[truncated, {len(text) - max_chars} more chars]"
    return text


def command_json(path: Path) -> str | None:
    data = read_json(path)
    if data is None:
        return None
    return json.dumps(data, ensure_ascii=False)


def codex_log_steps(run_dir: Path) -> list[dict]:
    steps: list[dict] = []
    prompt = text_file(run_dir / "agent" / "prompt.txt", 10_000)
    if prompt:
        steps.append({"index": len(steps), "role": "user", "text": base.scrub_secrets(prompt), "reasoning": None, "toolCalls": None, "observation": None, "toolName": None, "tokens": None, "timestamp": None, "mutations": None, "edits": None})

    log_path = run_dir / "agent" / "codex-exec.jsonl"
    if log_path.is_file():
        for raw in log_path.read_text(encoding="utf-8", errors="replace").splitlines():
            if not raw.strip():
                continue
            obj = None
            if raw.lstrip().startswith("{"):
                try:
                    obj = json.loads(raw)
                except Exception:
                    obj = None
            if not obj:
                if len(steps) < 8 and (" ERROR " in raw or " WARN " in raw):
                    steps.append({"index": len(steps), "role": "system", "text": base._cap(raw), "reasoning": None, "toolCalls": None, "observation": None, "toolName": None, "tokens": None, "timestamp": None, "mutations": None, "edits": None})
                continue
            item = obj.get("item") if isinstance(obj, dict) else None
            if not isinstance(item, dict) or obj.get("type") != "item.completed":
                continue
            if item.get("type") == "agent_message":
                steps.append({"index": len(steps), "role": "agent", "text": base._cap(item.get("text")), "reasoning": None, "toolCalls": None, "observation": None, "toolName": None, "tokens": None, "timestamp": None, "mutations": None, "edits": None})
            elif item.get("type") == "command_execution":
                command = item.get("command") or ""
                args = json.dumps({"command": command}, ensure_ascii=False)
                mut = base.detect_mutation("bash", args)
                steps.append({
                    "index": len(steps),
                    "role": "agent",
                    "text": base._cap(f"Executed command: {command}"),
                    "reasoning": None,
                    "toolCalls": [{"name": "shell", "args": base._cap(args)}],
                    "observation": base._cap(item.get("aggregated_output")),
                    "toolName": None,
                    "tokens": None,
                    "timestamp": None,
                    "mutations": [mut] if mut else None,
                    "edits": None,
                })
            if len(steps) >= base.MAX_STEPS:
                break

    if len(steps) <= 1:
        for name in ("build", "logs/docker-run"):
            cmd = command_json(run_dir / name / "command.json")
            out = "\n".join(x for x in [
                text_file(run_dir / name / "stdout.txt", 20_000),
                text_file(run_dir / name / "stderr.txt", 20_000),
            ] if x)
            if cmd or out:
                steps.append({
                    "index": len(steps),
                    "role": "agent",
                    "text": f"Captured {name} command output.",
                    "reasoning": None,
                    "toolCalls": [{"name": name, "args": base._cap(cmd)}] if cmd else None,
                    "observation": base._cap(out),
                    "toolName": None,
                    "tokens": None,
                    "timestamp": None,
                    "mutations": None,
                    "edits": None,
                })
    return steps


def codex_host_duration(run_dir: Path) -> float | None:
    total = 0.0
    found = False
    for p in (run_dir / "build" / "elapsed-seconds.txt", run_dir / "logs" / "docker-run" / "elapsed-seconds.txt"):
        txt = text_file(p, 200)
        if not txt:
            continue
        try:
            total += float(txt.strip())
            found = True
        except Exception:
            pass
    return total if found else None


def codex_host_status(run_dir: Path) -> tuple[str, str | None]:
    build_rc = text_file(run_dir / "build" / "return-code.txt", 100)
    run_rc = text_file(run_dir / "logs" / "docker-run" / "return-code.txt", 100)
    if build_rc and build_rc.strip() != "0":
        return "error", f"Docker build exited {build_rc.strip()}"
    if run_rc and run_rc.strip() != "0":
        return "failed", f"Docker run exited {run_rc.strip()}"
    if run_rc and run_rc.strip() == "0":
        return "completed", None
    return "completed", None


def codex_host_verifier_log(run_dir: Path) -> str | None:
    chunks = []
    for p in (
        run_dir / "build" / "stdout.txt",
        run_dir / "build" / "stderr.txt",
        run_dir / "logs" / "docker-run" / "stdout.txt",
        run_dir / "logs" / "docker-run" / "stderr.txt",
    ):
        txt = text_file(p, 80_000)
        if txt:
            chunks.append(f"## {p.parent.name}/{p.name}\n{txt}")
    return base.scrub_secrets("\n\n".join(chunks)) if chunks else None


def load_codex_host_run(run_dir: Path, task_id: str, vendor_id: str) -> bool:
    meta = read_json(run_dir / "metadata.json") or {}
    harness = "Codex host"
    model = meta.get("model") or "gpt-5.5"
    aid = base.agent(harness, model, vendor_id)
    base.agents[aid]["harness"] = harness
    base.agents[aid]["model"] = model
    base.agents[aid]["family"] = "OpenAI"
    steps = codex_log_steps(run_dir)
    status, failure = codex_host_status(run_dir)
    vlog = codex_host_verifier_log(run_dir)
    run_id = base.slug(f"tb21-train-fasttext-{run_dir.name}")[:120]
    base.emit_run({
        "id": run_id,
        "taskId": task_id,
        "agentId": aid,
        "vendorId": vendor_id,
        "format": "atif",
        "status": status,
        "passed": False,
        "reward": None,
        "steps": steps,
        "verifierLog": vlog,
        "artifacts": base.run_artifacts(steps),
        "turns": sum(1 for s in steps if s["role"] == "agent"),
        "durationSec": codex_host_duration(run_dir),
        "tokens": None,
        "grade": {
            "score": None,
            "maxScore": 1.0,
            "subscores": [],
            "summary": f"{harness} · {model} · {run_dir.name}",
            "gate": None,
            "breakdown": None,
            "findings": None,
        },
        "failureReason": failure,
    })
    return True


def load_train_fasttext_runs(runs_root: Path, vendor_id: str) -> tuple[int, int]:
    task_name = "train-fasttext"
    task_dir = existing_path(str(DEFAULT_TB_TASKS / task_name))
    if not task_dir:
        return 0, 0
    task_id = load_task(task_name, task_dir, vendor_id, runs_root, task_prefix="tb21-ssd")
    loaded = 0
    seen: set[Path] = set()

    standard_roots = [
        p for p in runs_root.glob("tb21-train-fasttext-claude-code-*") if p.is_dir()
    ] + [
        p for p in runs_root.glob("*/jobs/tb21-train-fasttext-claude-code-*") if p.is_dir()
    ]
    for job_dir in sorted(standard_roots):
        if job_dir.resolve() in seen:
            continue
        seen.add(job_dir.resolve())
        trial_dirs = sorted(
            p for p in job_dir.iterdir()
            if p.is_dir() and p.name != "container_artifacts" and not p.name.startswith(".")
        )
        for trial_dir in trial_dirs:
            if load_trial(job_dir, trial_dir, task_name, task_id, vendor_id, run_prefix="tb21-train-fasttext"):
                loaded += 1

    codex_roots = sorted(p for p in runs_root.glob("tb21-train-fasttext-codex-gpt55-host-*") if p.is_dir())
    for run_dir in codex_roots:
        if load_codex_host_run(run_dir, task_id, vendor_id):
            loaded += 1
    return loaded, len(codex_roots)


def build_showcase() -> list[dict]:
    rows = []
    for task in base.tasks:
        task_runs = [r for r in base.runs if r["taskId"] == task["id"]]
        if not task_runs:
            continue
        task_runs.sort(key=lambda r: (r["stepCount"] == 0, r["passed"], -(r["stepCount"] or 0)))
        r = task_runs[0]
        rows.append({
            "vendorId": task["vendorId"],
            "taskId": task["id"],
            "runId": r["id"],
            "taskTitle": task["title"],
            "passed": r["passed"],
            "reward": r["reward"],
            "stepCount": r["stepCount"],
            "source": r["format"],
            "why": "MiniMax-M3 SSD trajectory",
        })
    return rows[:12]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-root", default=str(DEFAULT_RUN_ROOT), help="MiniMax-M3 Harbor batch root on SSD")
    ap.add_argument("--runs-root", default=str(DEFAULT_RUNS_ROOT), help="Harbor runs root to scan for train-fasttext comparisons")
    ap.add_argument("--out", default=str(DEFAULT_OUT), help="output directory under public/")
    args = ap.parse_args()

    run_root = Path(args.run_root).expanduser().resolve()
    runs_root = Path(args.runs_root).expanduser().resolve()
    out_dir = Path(args.out).expanduser().resolve()
    jobs_dir = run_root / "jobs"
    if not jobs_dir.is_dir():
        raise SystemExit(f"jobs dir not found: {jobs_dir}")

    state = read_json(run_root / "state.json") or {}
    if out_dir.exists():
        shutil.rmtree(out_dir)
    (out_dir / "runs").mkdir(parents=True, exist_ok=True)
    (out_dir / "aft").mkdir(parents=True, exist_ok=True)

    base.vendors.clear()
    base.agents.clear()
    base.tasks.clear()
    base.runs.clear()
    base.aft_runs.clear()
    base.RUNS_DIR = str(out_dir / "runs")

    vid = base.vendor("Terminal-Bench 2.1 · Local SSD")
    job_dirs = sorted(p for p in jobs_dir.iterdir() if p.is_dir() and not p.name.startswith("."))
    loaded_runs = 0
    skipped_jobs: list[str] = []

    for job_dir in job_dirs:
        task_name = task_name_from_job(job_dir.name)
        trial_dirs = sorted(
            p for p in job_dir.iterdir()
            if p.is_dir() and p.name != "container_artifacts" and not p.name.startswith(".")
        )
        trial_result = read_json(trial_dirs[0] / "result.json") if trial_dirs else read_json(job_dir / "result.json")
        task_dir = task_dir_from_sources(task_name, trial_result, read_json(job_dir / "config.json"), state)
        if not task_dir:
            skipped_jobs.append(f"{job_dir.name} (task dir missing)")
            continue
        tid = load_task(task_name, task_dir, vid, run_root)
        if not trial_dirs:
            skipped_jobs.append(f"{job_dir.name} (no trial dir)")
            continue
        for trial_dir in trial_dirs:
            if load_trial(job_dir, trial_dir, task_name, tid, vid):
                loaded_runs += 1

    train_runs, codex_runs = load_train_fasttext_runs(runs_root, vid)
    loaded_runs += train_runs

    mini_runs = sum(1 for r in base.runs if r["vendorId"] == vid)
    base.vendors[vid]["coverage"] = (
        f"Local SSD data from {run_root} plus train-fasttext comparisons scanned under {runs_root}. "
        f"Loaded {len(base.tasks)} Terminal-Bench 2.1 task directories and {mini_runs} runs. "
        f"Standard Harbor runs use jobs/<task>/<trial>/agent/trajectory.json; Codex host runs are "
        f"converted from metadata.json, agent/codex-exec.jsonl, and build/docker logs. The train-fasttext "
        f"comparison currently includes {train_runs} local SSD records ({codex_runs} Codex host run dirs)."
    )

    with (out_dir / "aft" / "index.json").open("w", encoding="utf-8") as f:
        json.dump([], f)

    dataset = {
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "vendors": list(base.vendors.values()),
        "agents": list(base.agents.values()),
        "tasks": base.tasks,
        "runs": base.runs,
        "showcase": build_showcase(),
    }
    with (out_dir / "dataset.json").open("w", encoding="utf-8") as f:
        json.dump(dataset, f, ensure_ascii=False)

    run_files = list((out_dir / "runs").glob("*.json"))
    run_bytes = sum(p.stat().st_size for p in run_files)
    print(f"Wrote {out_dir / 'dataset.json'}")
    print(f"Wrote {len(run_files)} trajectory payloads to {out_dir / 'runs'} ({run_bytes / 1e6:.1f} MB)")
    print(f"tasks={len(base.tasks)} runs={len(base.runs)} loaded_runs={loaded_runs} skipped_jobs={len(skipped_jobs)}")
    if skipped_jobs:
        print("Skipped:")
        for s in skipped_jobs:
            print(f"  - {s}")


if __name__ == "__main__":
    main()
