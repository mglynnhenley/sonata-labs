"""Product subprocess: run the existing task and export its captured agent calls.

Configuration arrives on stdin; a scoped model-gateway credential arrives through stdin. Neither credentials nor launch material are
command-line arguments. The .eval file remains the original Inspect evidence.
"""
from __future__ import annotations

import json
import math
import os
import sys
from pathlib import Path
from typing import Any

from inspect_ai import eval
from inspect_ai.log import read_eval_log
from inspect_ai.model import GenerateConfig, get_model

from .task import sonata_day

from .lifecycle import watch_parent

def export_log(log: Any, run_id: str, role: str = "agent") -> dict[str, Any]:
    calls = []
    summary = ""
    for sample in log.samples or []:
        for event in sample.events:
            if event.event != "model":
                continue
            call = event.call
            response = call.response if call else None
            usage = response.get("usage", {}) if isinstance(response, dict) else {}
            price = usage.get("cost")
            start = int(event.timestamp.timestamp() * 1000)
            captured = {
                "seq": len(calls) + 1, "role": role,
                "model": event.model.removeprefix("openrouter/"),
                "request": call.request if call else {"input": [m.model_dump(mode="json") for m in event.input]},
                "response": response,
                "startedAt": start,
                "endedAt": start + int((call.time if call and call.time else 0) * 1000),
            }
            if isinstance(price, (int, float)) and not isinstance(price, bool) and math.isfinite(price):
                captured["costUsd"] = price
            if usage:
                captured["tokens"] = {"prompt": usage.get("prompt_tokens", 0), "completion": usage.get("completion_tokens", 0)}
            if event.error:
                captured["error"] = str(event.error)
            calls.append(captured)
        for msg in reversed(sample.messages):
            if msg.role == "assistant" and msg.text.strip():
                summary = msg.text
                break
    return {
        "runId": run_id, "log": log.location, "status": log.status,
        "error": log.error.message if log.error else None,
        "llmCalls": calls, "agentSummary": summary,
    }


def main() -> int:
    config = json.load(sys.stdin)
    parent_watch = watch_parent(config.get("ownerPid"))
    run_id = config["launch"]["session"]["sessionId"]
    log_dir = Path(config["logDir"])
    log_dir.mkdir(parents=True, exist_ok=True)
    task = sonata_day(
        platform_url=config["platformUrl"], episode_id=config["episodeId"],
        repo_root=config["repoRoot"], session_launch=config["launch"],
        compression=config["launch"]["timing"]["compression"],
        ticks=config["launch"]["timing"]["plannedTicks"],
        director=config["director"], judge=config["judge"],
        max_turns=config.get("maxTurns", 120),
        timeout_seconds=config["timeoutSeconds"],
        progress_path=str(log_dir / "progress.json"),
        agent_cost_limit=config.get("maxCostUsd"),
    )
    model = get_model(
        "openrouter/" + config["model"],
        base_url=config["modelGateway"]["url"], api_key=config["modelGateway"]["token"],
        stream=False,
        config=GenerateConfig(max_tokens=8192, max_retries=1, timeout=90,
                              extra_body={"usage": {"include": True}}),
    )
    try:
        logs = eval(task, model=model, log_dir=str(log_dir), display="none",
                    log_model_api=True, log_buffer=1, log_realtime=True)
        return 0 if logs and logs[0].status == "success" else 1
    finally:
        parent_watch.set()
        # Inspect flushes interrupted/failed evaluations too. Export whatever
        # was actually captured, never fabricate calls after process failure.
        files = sorted(log_dir.glob("*.eval"))
        if files:
            result = export_log(read_eval_log(str(files[-1])), run_id)
            target = log_dir / "agent.json"
            temporary = log_dir / "agent.tmp"
            temporary.write_text(json.dumps(result))
            temporary.replace(target)


if __name__ == "__main__":
    raise SystemExit(main())
