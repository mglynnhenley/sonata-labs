"""Assess a saved Sonata day with an Inspect scorer, without running its agent.

Sonata supplies its sole grading prompt/schema. Each pass has a separate log
linked to the source evidence; the original execution log is never rewritten.
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any

from inspect_ai import Task, eval
from inspect_ai.dataset import Sample
from inspect_ai.log import read_eval_log
from inspect_ai.model import ChatMessageSystem, ChatMessageUser, GenerateConfig, get_model
from inspect_ai.scorer import Score, Target, mean, scorer
from inspect_ai.solver import Generate, TaskState, solver
from jsonschema import validate

from .worker import export_log
from .lifecycle import watch_parent


@solver
def saved_day():
    async def solve(state: TaskState, generate: Generate):
        state.completed = True
        return state
    return solve


@scorer(metrics=[mean()])
def sonata_judge(request: dict[str, Any]):
    async def score(state: TaskState, target: Target):
        messages = [ChatMessageUser(content=request["prompt"])]
        if request.get("system"):
            messages.insert(0, ChatMessageSystem(content=request["system"]))
        response = await get_model().generate(messages, config=GenerateConfig(
            max_tokens=request.get("maxTokens", 48_000), max_retries=0, timeout=240,
            extra_body={"usage": {"include": True}, "response_format": {
                "type": "json_schema", "json_schema": {
                    "name": request.get("schemaName", "episode_judge_report"),
                    "strict": True, "schema": request["schema"],
                },
            }},
        ))
        if response.stop_reason == "max_tokens":
            raise ValueError("The judge ran out of output tokens; its incomplete answer is retained in the Inspect log.")
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", response.completion.strip())
        report = json.loads(text)
        validate(report, request["schema"])
        value = report["autonomyScore"]
        if isinstance(value, bool) or not isinstance(value, (float, int)) or not 0 <= value <= 1:
            raise ValueError("The judge returned an invalid autonomy score.")
        metadata = {"assessment_kind": "sonata_judge_autonomy", "report": report, **state.metadata}
        if state.metadata.get("numericScoreEligible") is not True or request.get("coverage", {}).get("complete") is not True:
            return Score.unscored(reason="incomplete_evaluation", explanation=report["summary"], metadata=metadata)
        return Score(value=value, explanation=report["summary"], metadata=metadata)

    return score

def judge_task(config: dict[str, Any]) -> Task:
    return Task(name="sonata_assessment", version=1,
                dataset=[Sample(id=config["assessmentId"], input=config["request"]["prompt"],
                                metadata=config["provenance"])],
                solver=saved_day(), scorer=sonata_judge(config["request"]),
                metadata={"runner": "inspect", "source_run_id": config["runId"]})


def main() -> int:
    config = json.load(sys.stdin)
    parent_watch = watch_parent(config.get("ownerPid"))
    log_dir = Path(config["logDir"])
    model_name = "openrouter/" + config["request"]["model"]
    model = get_model(model_name, base_url=os.environ.get("OPENROUTER_BASE_URL"))
    try:
        logs = eval(judge_task(config), model=model, log_dir=str(log_dir),
                    display="none", log_model_api=True, log_buffer=1, log_realtime=True)
        return 0 if logs and logs[0].status == "success" else 1
    finally:
        parent_watch.set()
        files = sorted(log_dir.glob("*.eval"))
        if files:
            log = read_eval_log(str(files[-1]))
            result = export_log(log, config["runId"], role="judge")
            result["assessmentId"] = config["assessmentId"]
            for sample in log.samples or []:
                for score in (sample.scores or {}).values():
                    if score.metadata and "report" in score.metadata:
                        result["report"] = score.metadata["report"]
            temporary = log_dir / "result.tmp"
            temporary.write_text(json.dumps(result))
            temporary.replace(log_dir / "result.json")


if __name__ == "__main__":
    raise SystemExit(main())
