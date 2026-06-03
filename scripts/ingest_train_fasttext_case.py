#!/usr/bin/env python3
"""Add the local train-fasttext case study assets to the ATIF viewer.

This script is intentionally local-path aware: it merges Hugo's SSD Codex
GPT-5.5 run into the public viewer dataset, writes its normalized trajectory,
and emits a case-study JSON + Markdown report for the train-fasttext analysis.

It does not publish private test data or model binaries. It only records the
agent trajectory, verifier summaries, and aggregate evidence needed to inspect
the case in the viewer.
"""

from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"
DATASET = PUBLIC / "dataset.json"
RUNS = PUBLIC / "runs"
CASES = PUBLIC / "cases"
BLOG = PUBLIC / "blog"
AFT_DIR = PUBLIC / "aft"

TASK_ID = "hi-tb-train-fasttext"
LOCAL_VENDOR_ID = "local-terminal-bench-ssd"
LOCAL_AGENT_ID = "host-codex-gpt-5-5-local-ssd"
LOCAL_RUN_ID = "local-tb21-train-fasttext-host-codex-gpt55-20260603t130932"
LOCAL_RUN_ROOT = Path(
    "/Volumes/SSD/terminal-bench-harbor/harbor/runs/"
    "tb21-train-fasttext-codex-gpt55-host-20260603T130932"
)
LOCAL_TRACE = LOCAL_RUN_ROOT / "agent" / "codex-exec.jsonl"
LOCAL_METADATA = LOCAL_RUN_ROOT / "metadata.json"
SUPPLEMENTAL_VERIFIER = LOCAL_RUN_ROOT / "supplemental_verifier" / "stdout.txt"
OFFICIAL_VERIFIER_STDOUT = LOCAL_RUN_ROOT / "verifier" / "runner" / "stdout.txt"
OFFICIAL_VERIFIER_STDERR = LOCAL_RUN_ROOT / "verifier" / "runner" / "stderr.txt"
ORACLE_SOLVE = (
    Path("/Users/hugo/Desktop/super-refactor/harbor/datasets/")
    / "terminal-bench-2.1-proxy/tasks/train-fasttext/solution/solve.sh"
)

LOCAL_CLAUDE_RUNS = [
    {
        "id": "local-tb21-train-fasttext-claude-code-kimi-k25-20260528",
        "root": Path("/Volumes/SSD/terminal-bench-harbor/harbor/runs/tb21-train-fasttext-claude-code-kimi-k25"),
        "trial": "train-fasttext__oLPYkcK",
        "agent_id": "claude-code-kimi-k2-5-local-ssd",
        "harness": "Claude Code",
        "model": "kimi-k2.5",
        "family": "unknown",
    },
    {
        "id": "local-tb21-train-fasttext-claude-code-kimi-k26-20260528",
        "root": Path("/Volumes/SSD/terminal-bench-harbor/harbor/runs/tb21-train-fasttext-claude-code-kimi-k26"),
        "trial": "train-fasttext__BxthwJx",
        "agent_id": "claude-code-kimi-k2-6-local-ssd",
        "harness": "Claude Code",
        "model": "kimi-k2.6",
        "family": "unknown",
    },
]


SECRET_PATTERNS = [
    re.compile(r"(?i)(api[_-]?key|access[_-]?token|secret|bearer)\s*[:=]\s*['\"]?[^'\"\s,;]+"),
    re.compile(r"sk-[A-Za-z0-9_\-]{16,}"),
    re.compile(r"(?i)(authorization:\s*bearer\s+)[A-Za-z0-9_\-.]+"),
]


def redact(value: Any) -> Any:
    if isinstance(value, str):
        out = value
        for pat in SECRET_PATTERNS:
            if pat.pattern.startswith("(?i)(authorization"):
                out = pat.sub(r"\1[REDACTED]", out)
            elif "api" in pat.pattern.lower() or "access" in pat.pattern.lower():
                out = pat.sub(lambda m: m.group(1) + "=[REDACTED]", out)
            else:
                out = pat.sub("[REDACTED_API_KEY]", out)
        return out
    if isinstance(value, list):
        return [redact(x) for x in value]
    if isinstance(value, dict):
        return {k: redact(v) for k, v in value.items()}
    return value


def read_text(path: Path, limit: int | None = None) -> str:
    if not path.exists():
        return ""
    text = path.read_text(encoding="utf-8", errors="replace")
    if limit and len(text) > limit:
        return text[:limit] + "\n...[truncated]..."
    return redact(text)


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def dump_json(path: Path, data: Any, pretty: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        if pretty:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
        else:
            json.dump(data, f, ensure_ascii=False)


def parse_jsonl(path: Path) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return events


def command_observation(item: dict[str, Any]) -> str:
    pieces = [
        f"Command: {item.get('command', '')}",
        f"Status: {item.get('status', '')}",
    ]
    if item.get("exit_code") is not None:
        pieces.append(f"Exit code: {item.get('exit_code')}")
    output = item.get("aggregated_output") or ""
    if output:
        pieces.append("Output:\n" + output)
    return redact("\n".join(pieces))


def command_mutations(command: str, output: str) -> list[dict[str, str]]:
    mutations: list[dict[str, str]] = []
    lower = command.lower()
    if "fasttext supervised" in lower:
        mutations.append(
            {
                "kind": "command",
                "tool": "exec_command",
                "target": "fasttext supervised",
                "summary": "Trained a supervised FastText candidate.",
            }
        )
    if "fasttext quantize" in lower:
        mutations.append(
            {
                "kind": "command",
                "tool": "exec_command",
                "target": "fasttext quantize",
                "summary": "Quantized a FastText candidate to reduce model size.",
            }
        )
    if "/app/model.bin" in command or "model.bin" in output:
        mutations.append(
            {
                "kind": "file",
                "tool": "exec_command",
                "target": "/app/model.bin",
                "summary": "Created or checked the final model artifact.",
            }
        )
    if "read_parquet" in lower or "__label__" in command:
        mutations.append(
            {
                "kind": "file",
                "tool": "exec_command",
                "target": "FastText training text",
                "summary": "Converted Yelp parquet rows into FastText label-text format.",
            }
        )
    return mutations


def local_steps_and_usage() -> tuple[list[dict[str, Any]], dict[str, int]]:
    events = parse_jsonl(LOCAL_TRACE)
    steps: list[dict[str, Any]] = []
    usage: dict[str, int] = {}

    def add(step: dict[str, Any]) -> None:
        step["index"] = len(steps)
        steps.append(redact(step))

    for ev in events:
        typ = ev.get("type")
        if typ == "thread.started":
            add(
                {
                    "role": "system",
                    "text": f"Codex thread started: {ev.get('thread_id')}",
                    "reasoning": None,
                    "toolCalls": None,
                    "observation": None,
                    "toolName": None,
                    "tokens": None,
                    "timestamp": None,
                    "mutations": None,
                    "edits": None,
                }
            )
        elif typ == "turn.started":
            add(
                {
                    "role": "system",
                    "text": "Turn started.",
                    "reasoning": None,
                    "toolCalls": None,
                    "observation": None,
                    "toolName": None,
                    "tokens": None,
                    "timestamp": None,
                    "mutations": None,
                    "edits": None,
                }
            )
        elif typ == "turn.completed":
            usage = ev.get("usage") or {}
        elif typ == "item.completed":
            item = ev.get("item") or {}
            item_type = item.get("type")
            if item_type == "agent_message":
                add(
                    {
                        "role": "agent",
                        "text": item.get("text") or "",
                        "reasoning": None,
                        "toolCalls": None,
                        "observation": None,
                        "toolName": None,
                        "tokens": None,
                        "timestamp": None,
                        "mutations": None,
                        "edits": None,
                    }
                )
            elif item_type == "command_execution":
                command = item.get("command") or ""
                observation = command_observation(item)
                add(
                    {
                        "role": "agent",
                        "text": "Executed shell command.",
                        "reasoning": None,
                        "toolCalls": [
                            {
                                "name": "exec_command",
                                "args": json.dumps({"cmd": command}, ensure_ascii=False),
                            }
                        ],
                        "observation": observation,
                        "toolName": "exec_command",
                        "tokens": None,
                        "timestamp": None,
                        "mutations": command_mutations(command, observation),
                        "edits": None,
                    }
                )
    return steps, {k: int(v) for k, v in usage.items() if isinstance(v, int)}


def atif_observation(raw: dict[str, Any]) -> str | None:
    obs = raw.get("observation")
    if not obs:
        return None
    if isinstance(obs, str):
        return redact(obs)
    if isinstance(obs, dict):
        chunks: list[str] = []
        for result in obs.get("results") or []:
            if isinstance(result, dict):
                if result.get("source_call_id"):
                    chunks.append(f"[{result['source_call_id']}]")
                if result.get("content"):
                    chunks.append(str(result["content"]))
        if chunks:
            return redact("\n".join(chunks))
    return redact(json.dumps(obs, ensure_ascii=False))


def normalize_atif_trajectory(path: Path) -> tuple[list[dict[str, Any]], dict[str, int]]:
    obj = load_json(path)
    steps: list[dict[str, Any]] = []
    for raw in obj.get("steps", []):
        source = raw.get("source") or "agent"
        role = source if source in {"user", "agent", "assistant", "system", "tool"} else "agent"
        tool_calls = []
        command_blob = ""
        for tc in raw.get("tool_calls") or []:
            fn = tc.get("function_name") or tc.get("name") or "tool"
            args_obj = tc.get("arguments")
            args = json.dumps(args_obj, ensure_ascii=False) if isinstance(args_obj, dict) else str(args_obj or "")
            tool_calls.append({"name": fn, "args": args})
            if isinstance(args_obj, dict) and args_obj.get("command"):
                command_blob += "\n" + str(args_obj["command"])
        observation = atif_observation(raw)
        message = raw.get("message") or ""
        if not message and tool_calls:
            message = "Executed " + ", ".join(tc["name"] for tc in tool_calls)
        metrics = raw.get("metrics") or {}
        tokens = {
            "prompt": metrics.get("prompt_tokens"),
            "completion": metrics.get("completion_tokens"),
        } if metrics else None
        mutation_text = "\n".join([command_blob, observation or ""])
        steps.append(
            redact(
                {
                    "index": len(steps),
                    "role": role,
                    "text": message,
                    "reasoning": None,
                    "toolCalls": tool_calls or None,
                    "observation": observation,
                    "toolName": tool_calls[0]["name"] if tool_calls else None,
                    "tokens": tokens,
                    "timestamp": raw.get("timestamp"),
                    "mutations": command_mutations(command_blob, mutation_text) or None,
                    "edits": None,
                }
            )
        )
    fm = obj.get("final_metrics") or {}
    return steps, {
        "input_tokens": int(fm.get("total_prompt_tokens") or 0),
        "output_tokens": int(fm.get("total_completion_tokens") or 0),
        "cached_input_tokens": int(fm.get("total_cached_tokens") or 0),
    }


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        if value.endswith("Z"):
            value = value[:-1] + "+00:00"
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def duration_from_result(result: dict[str, Any]) -> float | None:
    start = parse_iso(result.get("started_at"))
    finish = parse_iso(result.get("finished_at"))
    if start and finish:
        return (finish - start).total_seconds()
    return None


def payload_time_bounds(run_id: str) -> tuple[str | None, str | None]:
    payload_path = RUNS / f"{run_id}.json"
    if not payload_path.exists():
        return None, None
    payload = load_json(payload_path)
    timestamps = [
        str(step["timestamp"])
        for step in payload.get("steps", [])
        if step.get("timestamp")
    ]
    if not timestamps:
        return None, None
    return timestamps[0], timestamps[-1]


def run_time_bounds(run: dict[str, Any]) -> tuple[str | None, str | None]:
    started = run.get("startedAt")
    finished = run.get("finishedAt")
    if started and finished:
        return str(started), str(finished)
    payload_started, payload_finished = payload_time_bounds(str(run["id"]))
    return str(started or payload_started) if started or payload_started else None, str(finished or payload_finished) if finished or payload_finished else None


def short_time(value: Any) -> str:
    if not value:
        return "—"
    parsed = parse_iso(str(value))
    if parsed:
        return parsed.strftime("%Y-%m-%d %H:%M")
    return str(value).replace("T", " ").replace("Z", "")


def verifier_log_for_trial(trial_dir: Path, limit: int = 16000) -> str:
    parts = []
    test_stdout = read_text(trial_dir / "verifier" / "test-stdout.txt", limit)
    ctrf = read_text(trial_dir / "verifier" / "ctrf.json", 4000)
    exception = read_text(trial_dir / "exception.txt", 4000)
    if test_stdout:
        parts.append("Verifier test-stdout excerpt:\n" + test_stdout)
    if ctrf:
        parts.append("Verifier CTRF excerpt:\n" + ctrf)
    if exception:
        parts.append("Agent exception excerpt:\n" + exception)
    return "\n\n".join(parts) if parts else None


def verifier_log() -> str:
    official = read_text(OFFICIAL_VERIFIER_STDOUT, 7000)
    official_err = read_text(OFFICIAL_VERIFIER_STDERR, 2500)
    supplemental = read_text(SUPPLEMENTAL_VERIFIER, 4000)
    return "\n\n".join(
        [
            "Official Harbor-like verifier result: reward.txt = 0. The verifier process returned 0, but test.sh failed before pytest because the uv installer path was unavailable in the run environment.",
            "Official verifier stdout excerpt:\n" + official,
            "Official verifier stderr excerpt:\n" + official_err,
            "Supplemental private-distribution verifier summary, run after installing the Debian fasttext CLI:\n" + supplemental,
        ]
    )


def upsert_by_id(rows: list[dict[str, Any]], item: dict[str, Any]) -> None:
    for i, row in enumerate(rows):
        if row.get("id") == item.get("id"):
            rows[i] = item
            return
    rows.append(item)


def upsert_aft_index(run_ids: list[str]) -> None:
    index_path = AFT_DIR / "index.json"
    if index_path.exists():
        current = load_json(index_path)
    else:
        current = []
    merged = sorted(set(str(x) for x in current) | set(run_ids))
    dump_json(index_path, merged, pretty=True)


def write_local_aft_reports() -> None:
    reports = [
        {
            "task": {
                "id": "terminal-bench/train-fasttext",
                "benchmark": "terminal-bench",
                "task_broken": False,
                "broken_reason": None,
            },
            "trial": {
                "id": LOCAL_RUN_ID,
                "harness": "Host Codex",
                "model": "gpt-5.5",
                "reward": 1.0,
                "exception_type": None,
                "n_steps": 73,
            },
            "outcome": {
                "closeness": "success",
                "step_where_lost": None,
                "unproductive_iteration_count": 0,
                "headline": "Closed-loop FastText run produced a valid quantized artifact: supplemental private-distribution P@1=0.622 with a 124,531,872-byte /app/model.bin.",
                "what_verifier_checked": "FastText CLI P@1 on private-distribution examples and /app/model.bin size under 150 MiB.",
                "what_agent_produced": "A quantized FastText model at /app/model.bin using wordNgrams=3, dim=100, bucket=4M, character n-grams, qnorm, and dsub=4.",
                "exact_failure_quote": "N 40000; P@1 0.622; under_150MiB True 124531872",
                "test_stdout_available": True,
            },
            "failure_modes": [],
            "reward_hacking": {
                "verdict": "clean",
                "categories_triggered": [],
                "evidence": "The trajectory trained on the provided public training parquet, evaluated on public validation slices, and validated against held-out private-distribution examples; no private labels or verifier bypass were used.",
            },
            "task_quality": {
                "verdict": "accept_with_caveats",
                "issues": [
                    "The local official verifier path failed before pytest because uv/uvx bootstrap was unavailable, so this report uses the saved supplemental private-distribution verifier evidence for artifact validity."
                ],
                "verifier_structurally_hackable": False,
                "structural_hackability_notes": "The semantic gate is accuracy plus size on hidden examples; the observed official failure is infrastructure setup, not a hackable scoring loophole.",
            },
            "notes_for_aggregation": "Curated local SSD AFT-style report generated from preserved trace, model artifact metadata, and verifier logs.",
        },
        {
            "task": {
                "id": "terminal-bench/train-fasttext",
                "benchmark": "terminal-bench",
                "task_broken": False,
                "broken_reason": None,
            },
            "trial": {
                "id": "local-tb21-train-fasttext-claude-code-kimi-k26-20260528",
                "harness": "Claude Code",
                "model": "kimi-k2.6",
                "reward": 0.0,
                "exception_type": None,
                "n_steps": 90,
            },
            "outcome": {
                "closeness": "near-miss",
                "step_where_lost": 89,
                "unproductive_iteration_count": 1,
                "headline": "Completed the FastText workflow and produced /app/model.bin, but the private verifier landed just below threshold at P@1=0.617.",
                "what_verifier_checked": "FastText CLI P@1 must reach at least 0.62 and the final model must stay under 150 MiB.",
                "what_agent_produced": "A final FastText model artifact that satisfied the size check but missed the private accuracy threshold by roughly 0.003 P@1.",
                "exact_failure_quote": "P@1 0.617",
                "test_stdout_available": True,
            },
            "failure_modes": [
                {
                    "name": "Stopped at a threshold-near model without a final repair loop",
                    "description": "The run found the correct tool family and produced an artifact, but did not perform the last round of accuracy-margin search needed to move private P@1 from 0.617 to at least 0.62.",
                    "evidence_quote": "P@1 0.617",
                    "step_indices": [89],
                    "aft": {"A": "A5", "B": "B1", "C": "C6.5", "D": "D2"},
                    "counterfactual": {
                        "single_step_fix": False,
                        "X": "Continue the validation loop by adjusting the size-accuracy frontier, then re-run the private-style verifier before finalizing /app/model.bin.",
                        "Y": "The run finalized a near-miss artifact whose measured private P@1 stayed below the acceptance threshold.",
                    },
                    "seen_by": ["local-curated:r1"],
                    "occurrences": 1,
                },
                {
                    "name": "Insufficient final verifier closure",
                    "description": "The trajectory was semantically close, but the final decision criterion was the conjunction of accuracy and size; the artifact was promoted without evidence that both gates were above threshold.",
                    "evidence_quote": "Completed normally but reward remained 0.0.",
                    "step_indices": [89],
                    "aft": {"A": "A4", "B": "B1", "C": "C7.3", "D": "D2"},
                    "counterfactual": {
                        "single_step_fix": False,
                        "X": "Treat any P@1 below 0.62 as a hard failure and search one more constrained model candidate before stopping.",
                        "Y": "The final model was close enough to be useful as repair/margin data, but not a clean positive trajectory.",
                    },
                    "seen_by": ["local-curated:r1"],
                    "occurrences": 1,
                },
            ],
            "reward_hacking": {
                "verdict": "clean",
                "categories_triggered": [],
                "evidence": "The run trained a real FastText classifier and produced a normal model artifact; the failure is margin/verification, not grader manipulation.",
            },
            "task_quality": {
                "verdict": "accept",
                "issues": [],
                "verifier_structurally_hackable": False,
                "structural_hackability_notes": "The task gate is straightforward: hidden-distribution FastText P@1 and model byte size.",
            },
            "notes_for_aggregation": "Curated local SSD AFT-style report; treat as near-miss repair/margin data rather than a generic negative.",
        },
        {
            "task": {
                "id": "terminal-bench/train-fasttext",
                "benchmark": "terminal-bench",
                "task_broken": False,
                "broken_reason": None,
            },
            "trial": {
                "id": "local-tb21-train-fasttext-claude-code-kimi-k25-20260528",
                "harness": "Claude Code",
                "model": "kimi-k2.5",
                "reward": 0.0,
                "exception_type": "AgentTimeoutError",
                "n_steps": 76,
            },
            "outcome": {
                "closeness": "far",
                "step_where_lost": 75,
                "unproductive_iteration_count": 2,
                "headline": "Timed out before producing the required /app/model.bin artifact; the verifier could not load a model.",
                "what_verifier_checked": "The verifier loads /app/model.bin, checks FastText P@1, and enforces the size limit.",
                "what_agent_produced": "No final model artifact was available at /app/model.bin by the time the agent timed out.",
                "exact_failure_quote": "/app/model.bin cannot be opened for loading",
                "test_stdout_available": True,
            },
            "failure_modes": [
                {
                    "name": "Timeout before required artifact creation",
                    "description": "The agent exhausted its execution budget before placing a final FastText model at /app/model.bin, so the verifier failed before any meaningful accuracy/size measurement.",
                    "evidence_quote": "AgentTimeoutError: Agent execution timed out after 3600.0 seconds",
                    "step_indices": [75],
                    "aft": {"A": "A6", "B": "B4", "C": "C6.2", "D": "D3"},
                    "counterfactual": {
                        "single_step_fix": True,
                        "X": "Before continuing exploration, promote the best current candidate to /app/model.bin and run a quick load/size check.",
                        "Y": "The run ended with no loadable final artifact.",
                    },
                    "seen_by": ["local-curated:r1"],
                    "occurrences": 1,
                },
                {
                    "name": "Missing final artifact validation",
                    "description": "The trajectory did not close with a minimal verifier-equivalent check that /app/model.bin exists and can be loaded by the FastText CLI.",
                    "evidence_quote": "/app/model.bin cannot be opened for loading",
                    "step_indices": [75],
                    "aft": {"A": "A4", "B": "B5", "C": "C7.4", "D": "D3"},
                    "counterfactual": {
                        "single_step_fix": True,
                        "X": "Run `test -s /app/model.bin` and `fasttext test /app/model.bin ...` before ending or starting any long loop.",
                        "Y": "The final verifier encountered a missing model file.",
                    },
                    "seen_by": ["local-curated:r1"],
                    "occurrences": 1,
                },
            ],
            "reward_hacking": {
                "verdict": "clean",
                "categories_triggered": [],
                "evidence": "No evidence of private-test access or grader manipulation; the run failed through timeout and missing artifact.",
            },
            "task_quality": {
                "verdict": "accept",
                "issues": [],
                "verifier_structurally_hackable": False,
                "structural_hackability_notes": "The verifier failure is aligned with the task requirement: no loadable model means no valid solution.",
            },
            "notes_for_aggregation": "Curated local SSD AFT-style report generated from timeout exception and verifier logs.",
        },
    ]
    AFT_DIR.mkdir(parents=True, exist_ok=True)
    ids = []
    for report in reports:
        run_id = report["trial"]["id"]
        ids.append(str(run_id))
        dump_json(AFT_DIR / f"{run_id}.json", report, pretty=True)
    upsert_aft_index(ids)


def ensure_local_run(dataset: dict[str, Any], steps: list[dict[str, Any]], usage: dict[str, int]) -> None:
    metadata = load_json(LOCAL_METADATA)
    elapsed_path = LOCAL_RUN_ROOT / "agent" / "elapsed-seconds.txt"
    duration = None
    if elapsed_path.exists():
        try:
            duration = float(elapsed_path.read_text().strip())
        except ValueError:
            duration = None

    upsert_by_id(
        dataset["vendors"],
        {
            "id": LOCAL_VENDOR_ID,
            "name": "Local Terminal-Bench SSD",
            "coverage": "Local SSD reproduction runs with preserved agent traces, container artifacts, verifier logs, and cleanup metadata.",
        },
    )
    upsert_by_id(
        dataset["agents"],
        {
            "id": LOCAL_AGENT_ID,
            "harness": "Host Codex",
            "model": "gpt-5.5",
            "family": "OpenAI",
            "vendorId": LOCAL_VENDOR_ID,
        },
    )

    payload = {"steps": steps, "verifierLog": verifier_log()}
    dump_json(RUNS / f"{LOCAL_RUN_ID}.json", payload, pretty=False)

    prompt = usage.get("input_tokens")
    completion = usage.get("output_tokens")
    cached = usage.get("cached_input_tokens")
    run = {
        "id": LOCAL_RUN_ID,
        "taskId": TASK_ID,
        "agentId": LOCAL_AGENT_ID,
        "vendorId": LOCAL_VENDOR_ID,
        "format": "harbor",
        "status": "passed",
        "passed": True,
        "reward": 1.0,
        "steps": [],
        "stepCount": len(steps),
        "multiUser": False,
        "hasVerifierLog": True,
        "turns": 1,
        "durationSec": duration,
        "startedAt": metadata.get("started_at"),
        "finishedAt": metadata.get("finished_at"),
        "sourceRunRoot": str(LOCAL_RUN_ROOT),
        "artifacts": [
            "/app/model.bin",
            "agent/codex-exec.jsonl",
            "container_artifacts/app/model.bin",
            "supplemental_verifier/stdout.txt",
        ],
        "tokens": {
            "prompt": prompt,
            "completion": completion,
            "cached": cached,
            "costUsd": None,
        },
        "grade": {
            "score": 1.0,
            "maxScore": 1.0,
            "subscores": [
                {"label": "supplemental private accuracy", "score": 1.0},
                {"label": "model size", "score": 1.0},
                {"label": "official verifier infrastructure", "score": 0.0},
            ],
            "summary": (
                "Host Codex/GPT-5.5 produced a valid 124,531,872-byte quantized "
                "FastText model. Supplemental private-distribution verification "
                "reported P@1=0.622; the official Harbor-like reward file stayed 0 "
                "because test.sh failed in the uv installer path before pytest."
            ),
            "gate": {
                "official_reward_file_is_one": False,
                "supplemental_private_verifier_passed": True,
                "model_under_150mb": True,
                "accuracy_at_least_0_62": True,
            },
            "breakdown": {
                "final_recipe": "wordNgrams=3, dim=100, bucket=4,000,000, minn=3, maxn=6, softmax, quantized with qnorm/dsub=4",
                "public_validation": "P@1=0.628 on the public 10k validation parquet converted to FastText format",
                "supplemental_private_validation": "P@1=0.622 on 40k private-distribution examples; model size 124,531,872 bytes",
                "official_reward_note": str(metadata.get("reward")),
            },
            "findings": [
                {
                    "category": "verifier",
                    "severity": "minor",
                    "summary": "Official reward disagrees with artifact quality.",
                    "detail": "The final artifact passes the supplemental private-distribution check, but the official test script failed in dependency setup before pytest.",
                }
            ],
            "verifier": {
                "checked": "FastText CLI P@1 and /app/model.bin size",
                "produced": "124,531,872-byte quantized FastText model with supplemental P@1=0.622",
                "quote": "N 40000; P@1 0.622; under_150MiB True 124531872",
            },
        },
        "failureReason": None,
    }
    upsert_by_id(dataset["runs"], run)


def ensure_local_claude_runs(dataset: dict[str, Any]) -> None:
    upsert_by_id(
        dataset["vendors"],
        {
            "id": LOCAL_VENDOR_ID,
            "name": "Local Terminal-Bench SSD",
            "coverage": "Local SSD reproduction runs with preserved agent traces, container artifacts, verifier logs, and cleanup metadata.",
        },
    )

    for spec in LOCAL_CLAUDE_RUNS:
        root = spec["root"]
        trial_dir = root / spec["trial"]
        trajectory = trial_dir / "agent" / "trajectory.json"
        result_path = trial_dir / "result.json"
        if not trajectory.exists() or not result_path.exists():
            continue

        result = load_json(result_path)
        steps, usage = normalize_atif_trajectory(trajectory)
        verifier = verifier_log_for_trial(trial_dir)
        dump_json(RUNS / f"{spec['id']}.json", {"steps": steps, "verifierLog": verifier}, pretty=False)

        upsert_by_id(
            dataset["agents"],
            {
                "id": spec["agent_id"],
                "harness": spec["harness"],
                "model": spec["model"],
                "family": spec["family"],
                "vendorId": LOCAL_VENDOR_ID,
            },
        )

        reward = (
            result.get("verifier_result", {})
            .get("rewards", {})
            .get("reward")
        )
        exception = result.get("exception_info")
        failure_reason = None
        if exception:
            failure_reason = f"{exception.get('exception_type')}: {exception.get('exception_message')}"

        agent_result = result.get("agent_result") or {}
        prompt = agent_result.get("n_input_tokens") or usage.get("input_tokens")
        completion = agent_result.get("n_output_tokens") or usage.get("output_tokens")
        cached = agent_result.get("n_cache_tokens") or usage.get("cached_input_tokens")
        model = spec["model"]
        if model == "kimi-k2.6":
            summary = "Claude Code/Kimi K2.6 completed normally but produced a near-miss model: private verifier P@1=0.617, below the 0.62 threshold."
            findings = [
                {
                    "category": "accuracy",
                    "severity": "major",
                    "summary": "Near-miss below the private accuracy threshold.",
                    "detail": "The verifier found /app/model.bin, but P@1 was 0.617 rather than >=0.62.",
                }
            ]
            breakdown = {"private_verifier": "P@1=0.617; size test passed"}
        else:
            summary = "Claude Code/Kimi K2.5 timed out before producing /app/model.bin; the verifier could not load the model."
            findings = [
                {
                    "category": "timeout",
                    "severity": "critical",
                    "summary": "Agent timed out before final artifact creation.",
                    "detail": "The subsequent verifier failed both accuracy parsing and model-size checks because /app/model.bin was missing.",
                }
            ]
            breakdown = {"private_verifier": "/app/model.bin missing; accuracy could not be parsed"}

        run = {
            "id": spec["id"],
            "taskId": TASK_ID,
            "agentId": spec["agent_id"],
            "vendorId": LOCAL_VENDOR_ID,
            "format": "atif",
            "status": "failed",
            "passed": False,
            "reward": float(reward) if reward is not None else None,
            "steps": [],
            "stepCount": len(steps),
            "multiUser": False,
            "hasVerifierLog": bool(verifier),
            "turns": len([s for s in steps if s["role"] in {"agent", "assistant"}]),
            "durationSec": duration_from_result(result),
            "startedAt": result.get("started_at"),
            "finishedAt": result.get("finished_at"),
            "sourceRunRoot": str(trial_dir),
            "artifacts": ["/app/model.bin"] if model == "kimi-k2.6" else [],
            "tokens": {
                "prompt": prompt,
                "completion": completion,
                "cached": cached,
                "costUsd": agent_result.get("cost_usd"),
            },
            "grade": {
                "score": reward,
                "maxScore": 1.0,
                "subscores": [],
                "summary": summary,
                "gate": {
                    "official_reward_file_is_one": reward == 1.0,
                    "model_under_150mb": True if model == "kimi-k2.6" else None,
                    "accuracy_at_least_0_62": False,
                },
                "breakdown": breakdown,
                "findings": findings,
                "verifier": {
                    "checked": "FastText CLI P@1 and /app/model.bin size",
                    "produced": "Near-miss model" if model == "kimi-k2.6" else "No final model artifact",
                    "quote": "P@1 0.617" if model == "kimi-k2.6" else "/app/model.bin cannot be opened for loading",
                },
            },
            "failureReason": failure_reason,
        }
        upsert_by_id(dataset["runs"], run)


def text_for_run(run_id: str) -> str:
    payload_path = RUNS / f"{run_id}.json"
    if not payload_path.exists():
        return ""
    payload = load_json(payload_path)
    chunks: list[str] = []
    for step in payload.get("steps", []):
        for key in ("text", "observation", "reasoning"):
            val = step.get(key)
            if val:
                chunks.append(str(val))
        for tc in step.get("toolCalls") or []:
            chunks.append(str(tc.get("name") or ""))
            chunks.append(str(tc.get("args") or ""))
    if payload.get("verifierLog"):
        chunks.append(str(payload["verifierLog"]))
    return "\n".join(chunks)


def extract_features(blob: str) -> dict[str, Any]:
    lower = blob.lower()
    p_values = [float(x) for x in re.findall(r"P@1\s*[\t =:]+([0-9.]+)", blob)]
    sizes = [int(x) for x in re.findall(r"\b([1-9][0-9]{7,9})\b", blob)]
    dims = [int(x) for x in re.findall(r"-dim\s+([0-9]+)", blob)]
    word_ngrams = [int(x) for x in re.findall(r"-wordNgrams\s+([0-9]+)", blob)]
    buckets = [int(x) for x in re.findall(r"-bucket\s+([0-9]+)", blob)]
    quantized = bool(re.search(r"fasttext\s+quantize\b|\b-qnorm\b|\.ftz\b", lower))
    autotune = bool(re.search(r"fasttext\s+supervised\b[^\n\r]*(?:-autotune|-autotune-validation)", lower))
    trained_supervised = bool(re.search(r"fasttext\s+supervised\b|supervised\s+-input\b", lower))
    likely_model_sizes = [x for x in sizes if x >= 50_000_000]
    return {
        "mentions_fasttext": "fasttext" in lower,
        "converted_parquet": "read_parquet" in lower or "__label__" in blob,
        "trained_supervised": trained_supervised,
        "quantized": quantized,
        "autotune": autotune,
        "char_ngrams": "-minn" in lower or "-maxn" in lower,
        "dims": sorted(set(dims)),
        "wordNgrams": sorted(set(word_ngrams)),
        "buckets": sorted(set(buckets)),
        "best_p_at_1": max(p_values) if p_values else None,
        "max_size_bytes": max(likely_model_sizes) if likely_model_sizes else None,
        "under_150mb_mentioned": "under_150" in lower or "under 150" in lower,
    }


def classify_run(run: dict[str, Any], features: dict[str, Any]) -> str:
    failure = (run.get("failureReason") or "").lower()
    if run["id"] == LOCAL_RUN_ID:
        return "closed-loop-valid-artifact"
    if "nonzeroagentexitcode" in failure:
        return "agent-bootstrap-failure"
    if not features["mentions_fasttext"]:
        return "agent-bootstrap-failure"
    if features["quantized"] and features["best_p_at_1"] and features["best_p_at_1"] >= 0.62:
        if "timeout" in failure or run.get("durationSec", 0) and run["durationSec"] > 7000:
            return "valid-or-near-valid-but-timeout"
        return "compressed-ngram-near-miss"
    if features["best_p_at_1"] and features["best_p_at_1"] >= 0.60:
        return "accuracy-near-miss"
    if features["trained_supervised"] and not features["quantized"]:
        return "uncompressed-or-size-blind"
    return "exploratory-tooling-failure"


CLUSTER_META = {
    "closed-loop-valid-artifact": {
        "label": "Validated closed-loop artifact",
        "interpretation": "The agent trained, measured, compressed, promoted /app/model.bin, and rechecked size/accuracy. This is the best agent-derived trajectory for positive RL signal.",
    },
    "valid-or-near-valid-but-timeout": {
        "label": "Valid or near-valid, but timed out",
        "interpretation": "The run found the right fastText ingredients but spent too long in training, quantization, or cleanup, so the official harness timed out.",
    },
    "compressed-ngram-near-miss": {
        "label": "Compressed n-gram near miss",
        "interpretation": "The run used quantization/ngrams and saw plausible validation numbers, but did not land a clean final verified artifact.",
    },
    "accuracy-near-miss": {
        "label": "Accuracy near miss",
        "interpretation": "The run pursued the right classifier family and got close on P@1, but its threshold/size/verification closure was incomplete.",
    },
    "uncompressed-or-size-blind": {
        "label": "Uncompressed or size-blind fastText",
        "interpretation": "The run trained supervised fastText but did not close the model-size constraint early enough.",
    },
    "exploratory-tooling-failure": {
        "label": "Exploratory tooling failure",
        "interpretation": "The trajectory spent most work on environment, package, or data handling rather than the size-accuracy frontier.",
    },
    "agent-bootstrap-failure": {
        "label": "Agent bootstrap failure",
        "interpretation": "The harness or agent command failed before meaningful task search.",
    },
}


def build_case(dataset: dict[str, Any]) -> dict[str, Any]:
    runs = [r for r in dataset["runs"] if r["taskId"] == TASK_ID]
    agents = {a["id"]: a for a in dataset["agents"]}
    analyzed: list[dict[str, Any]] = []
    cluster_counts: Counter[str] = Counter()
    feature_counts: Counter[str] = Counter()
    p_values: list[float] = []
    durations: list[float] = []
    step_counts: list[int] = []

    for run in runs:
        blob = text_for_run(run["id"])
        features = extract_features(blob)
        cluster = classify_run(run, features)
        cluster_counts[cluster] += 1
        for key in ("mentions_fasttext", "converted_parquet", "trained_supervised", "quantized", "char_ngrams", "autotune"):
            if features[key]:
                feature_counts[key] += 1
        if features["best_p_at_1"] is not None:
            p_values.append(features["best_p_at_1"])
        if run.get("durationSec"):
            durations.append(float(run["durationSec"]))
        if run.get("stepCount"):
            step_counts.append(int(run["stepCount"]))
        agent = agents.get(run["agentId"], {})
        started_at, finished_at = run_time_bounds(run)
        analyzed.append(
            {
                "runId": run["id"],
                "agentId": run["agentId"],
                "harness": agent.get("harness"),
                "model": agent.get("model"),
                "status": run.get("status"),
                "passed": run.get("passed"),
                "reward": run.get("reward"),
                "stepCount": run.get("stepCount"),
                "durationSec": run.get("durationSec"),
                "startedAt": started_at,
                "finishedAt": finished_at,
                "sourceRunRoot": run.get("sourceRunRoot"),
                "failureReason": run.get("failureReason"),
                "cluster": cluster,
                "features": features,
                "trajectoryUrl": f"/tasks/{TASK_ID}/runs/{run['id']}",
            }
        )

    def stat(xs: list[float]) -> dict[str, float | int | None]:
        if not xs:
            return {"count": 0, "min": None, "max": None, "mean": None}
        return {
            "count": len(xs),
            "min": min(xs),
            "max": max(xs),
            "mean": sum(xs) / len(xs),
        }

    oracle_line = ""
    if ORACLE_SOLVE.exists():
        for line in ORACLE_SOLVE.read_text(encoding="utf-8", errors="replace").splitlines():
            if "fasttext supervised" in line:
                oracle_line = line.strip()
                break

    clusters = []
    by_cluster: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in analyzed:
        by_cluster[row["cluster"]].append(row)
    for cluster, rows in sorted(by_cluster.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        meta = CLUSTER_META[cluster]
        clusters.append(
            {
                "id": cluster,
                "label": meta["label"],
                "count": len(rows),
                "interpretation": meta["interpretation"],
                "representativeRunIds": [r["runId"] for r in rows[:4]],
                "models": sorted({f"{r.get('harness') or 'unknown'} / {r.get('model') or 'unknown'}" for r in rows}),
            }
        )

    by_run = {row["runId"]: row for row in analyzed}

    def comparison_row(
        run_id: str,
        label: str,
        outcome: str,
        verifier_p_at_1: float | None,
        model_bytes: int | None,
        takeaway: str,
    ) -> dict[str, Any]:
        row = by_run.get(run_id, {})
        return {
            "runId": run_id,
            "label": label,
            "outcome": outcome,
            "verifierPAt1": verifier_p_at_1,
            "modelBytes": model_bytes,
            "startedAt": row.get("startedAt"),
            "finishedAt": row.get("finishedAt"),
            "sourceRunRoot": row.get("sourceRunRoot"),
            "takeaway": takeaway,
        }

    local_comparisons = [
        comparison_row(
            "local-tb21-train-fasttext-host-codex-gpt55-20260603t130932",
            "Host Codex / GPT-5.5",
            "artifact-valid",
            0.622,
            124531872,
            "Closed the validation loop: public P@1=0.628, supplemental private-distribution P@1=0.622, final artifact under 150 MiB.",
        ),
        comparison_row(
            "local-tb21-train-fasttext-claude-code-kimi-k26-20260528",
            "Claude Code / Kimi K2.6",
            "private near-miss",
            0.617,
            None,
            "Completed the task flow and produced /app/model.bin, but the official private verifier landed just below threshold at P@1=0.617.",
        ),
        comparison_row(
            "local-tb21-train-fasttext-claude-code-kimi-k25-20260528",
            "Claude Code / Kimi K2.5",
            "timeout/no artifact",
            None,
            None,
            "Timed out before final artifact creation; verifier could not open /app/model.bin.",
        ),
    ]

    return {
        "id": "train-fasttext-hivemind",
        "title": "Train FastText: Agent Autoresearch Hivemind",
        "taskId": TASK_ID,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "localRunRoot": str(LOCAL_RUN_ROOT),
        "oracle": {
            "solvePath": str(ORACLE_SOLVE),
            "coreCommand": oracle_line,
            "recipe": {
                "wordNgrams": 2,
                "dim": 5,
                "quantize": False,
                "insight": "Optimize the size constraint first; Yelp same-distribution classification does not need a high-dimensional embedding to cross 0.62.",
            },
        },
        "summary": {
            "runsAnalyzed": len(analyzed),
            "runsWithStartedAt": sum(1 for r in analyzed if r.get("startedAt")),
            "passedOrArtifactValid": sum(1 for r in analyzed if r["passed"]),
            "officialLeaderboardFailures": sum(1 for r in analyzed if not r["passed"] and r["reward"] == 0),
            "featureFrequencies": dict(feature_counts),
            "bestObservedPAt1": max(p_values) if p_values else None,
            "pAt1": stat(p_values),
            "durationSec": stat(durations),
            "stepCount": stat([float(x) for x in step_counts]),
        },
        "hivemindConclusion": [
            "Across harnesses and models, the search converges on the same decomposition: convert parquet to FastText label-text format, train supervised fastText, and manage the accuracy-size frontier with n-grams, dimension, bucket size, and sometimes quantization.",
            "The main behavioral difference is not task understanding; it is optimization order. Human oracle starts with a tiny dim=5 bigram model because model size is the binding constraint. Agents usually start with a stronger model and try to compress later.",
            "The cleanest RL signal is the validation loop: runs that measure P@1 and bytes after each candidate make recoverable progress; runs that produce plausible recipes without final verifier closure are much weaker preference negatives.",
        ],
        "localComparisons": local_comparisons,
        "clusters": clusters,
        "runs": analyzed,
        "blogMarkdownPath": "/blog/train-fasttext-agent-autoresearch-hivemind.md",
    }


def blog_markdown(case: dict[str, Any]) -> str:
    cluster_rows = "\n".join(
        f"| {c['label']} | {c['count']} | {c['interpretation']} |"
        for c in case["clusters"]
    )
    local_rows = "\n".join(
        f"| {row['label']} | {short_time(row.get('startedAt'))} | {row['outcome']} | {row['verifierPAt1'] if row['verifierPAt1'] is not None else '—'} | {row['takeaway']} |"
        for row in case["localComparisons"]
    )
    ff = case["summary"]["featureFrequencies"]
    oracle = case["oracle"]["coreCommand"]
    return f"""# Train FastText: 一个 agent-autoresearch-hivemind 案例

## 结论先行

这个任务表面上是训练 Yelp fastText 分类器，实际考的是 agent 是否能同时管理两个约束：`P@1 >= 0.62` 和 `/app/model.bin < 150MB`。所有认真展开搜索的 agent 最后都会趋同到同一个解法骨架：把 parquet 转成 `__label__` 文本，训练 supervised fastText，再围绕 n-gram、embedding 维度、bucket 和 quantization 做大小-精度折中。

真正的分叉不在“知不知道 fastText”，而在优化顺序。Oracle 直接命中：

```bash
{oracle}
```

它用 `wordNgrams=2` 保留 Yelp 情感分类最有效的局部词组特征，同时把 `dim` 压到 5。这个选择看起来很小，但对同分布 Yelp、0.62 门槛、150MB 上限来说正好够用。

## 为什么人类专家更容易想到 oracle

人类专家会先看绑定约束：模型大小。fastText 的模型大小近似随 `dim` 和 hash bucket 规模增长，所以 `dim` 是最直接的大小旋钮。Yelp full-review 五分类在同分布测试上并不需要很强的语义 embedding；很多信号来自 unigram/bigram 的线性分类边界。因此专家会先问：“最低维度能不能过线？”

GPT-5.5 这类 agent 的默认路线更像现代 ML 工程师：先训练一个较强模型，确认 P@1，再压缩。我们本机 Host Codex/GPT-5.5 的有效轨迹最终用了 `wordNgrams=3`、`dim=100`、`bucket=4M`、字符 n-gram 和 quantization，得到 124,531,872 bytes，补充私有验证 `P@1=0.622`。它成功闭环，但路线比 oracle 长很多。

## 统计特征

- 已纳入轨迹数：{case['summary']['runsAnalyzed']}
- artifact-valid / passed 轨迹数：{case['summary']['passedOrArtifactValid']}
- 轨迹里明确触达 fastText：{ff.get('mentions_fasttext', 0)}
- 明确做 parquet 到 FastText 格式转换：{ff.get('converted_parquet', 0)}
- 明确训练 supervised fastText：{ff.get('trained_supervised', 0)}
- 明确使用 quantization：{ff.get('quantized', 0)}
- 观测到的最高公开或补充 `P@1`：{case['summary']['bestObservedPAt1']}

## 本地 SSD 三条补充轨迹

| Run | Started | Outcome | Verifier P@1 | Takeaway |
| --- | --- | --- | ---: | --- |
{local_rows}

## 聚类结果

| Cluster | Count | Interpretation |
| --- | ---: | --- |
{cluster_rows}

## 对 RL 数据的启发

最干净的偏好信号不是“谁写出了看起来合理的 fastText 命令”，而是谁完成了验证闭环。好的轨迹有三个稳定特征：反复测 `P@1`，反复测 byte size，把最终 artifact 放到 `/app/model.bin` 后再次验证。差轨迹往往也知道 fastText，但缺少最后一轮收口，或者把大模型训练、包安装、autotune、quantization 放在过长链条里，导致 timeout。

因此这个 case 的 preference pair 可以这样组织：Host Codex/GPT-5.5 的 closed-loop run 作为正例；同样识别了 fastText 但没有稳定 artifact closure 的 near-miss 作为 hard negative；纯 harness/bootstrap failure 则不适合作为普通建模能力负例。

## Hivemind insight

“所有 agent 都趋同的解法”不是同一个命令，而是同一个研究程序：数据格式转换、supervised fastText、约束驱动压缩、验证闭环。Oracle 的价值在于展示了一个更短的专家路径：先压维度，再用 bigram 补足最低必要性能。
"""


def main() -> None:
    dataset = load_json(DATASET)
    steps, usage = local_steps_and_usage()
    ensure_local_run(dataset, steps, usage)
    ensure_local_claude_runs(dataset)
    dataset["generatedAt"] = datetime.now(timezone.utc).isoformat()
    dump_json(DATASET, dataset, pretty=False)
    write_local_aft_reports()

    case = build_case(dataset)
    dump_json(CASES / "train-fasttext-hivemind.json", case, pretty=True)
    BLOG.mkdir(parents=True, exist_ok=True)
    (BLOG / "train-fasttext-agent-autoresearch-hivemind.md").write_text(
        blog_markdown(case), encoding="utf-8"
    )
    print(f"Wrote {RUNS / (LOCAL_RUN_ID + '.json')}")
    print(f"Wrote {CASES / 'train-fasttext-hivemind.json'}")
    print(f"Wrote {BLOG / 'train-fasttext-agent-autoresearch-hivemind.md'}")
    print(f"Dataset runs for {TASK_ID}: {sum(1 for r in dataset['runs'] if r['taskId'] == TASK_ID)}")


if __name__ == "__main__":
    main()
