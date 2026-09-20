import json

import pytest
from inspect_ai import eval_async
from inspect_ai.model import ModelOutput, get_model

from sonata_inspect.judging import judge_task
from sonata_inspect.worker import export_log


def config():
    return {"runId": "saved-day", "assessmentId": "assessment-one",
            "provenance": {"sourceRunId": "saved-day", "evidenceSha256": "fixed", "numericScoreEligible": True},
            "request": {"prompt": "Assess the saved day", "coverage": {"complete": True}, "schema": {
                "type": "object", "required": ["autonomyScore", "summary"],
                "properties": {"autonomyScore": {"type": "number"}, "summary": {"type": "string"}},
            }}}


@pytest.mark.asyncio
async def test_scorer_runs_only_judge_and_links_evidence(tmp_path):
    model = get_model("mockllm/model", custom_outputs=[ModelOutput.from_content(
        "mockllm/model", json.dumps({"autonomyScore": 0.7, "summary": "Saved the requested draft."}))])
    logs = await eval_async(judge_task(config()), model=model,
                            log_dir=str(tmp_path))
    log = logs[0]
    assert log.status == "success", log.error
    score = next(iter(log.samples[0].scores.values()))
    assert score.value == 0.7
    assert score.metadata["sourceRunId"] == "saved-day"
    assert score.metadata["report"]["summary"] == "Saved the requested draft."
    calls = export_log(log, "saved-day", role="judge")["llmCalls"]
    assert len(calls) == 1
    assert calls[0]["role"] == "judge"
    assert "costUsd" not in calls[0]
    assert not any(event.event == "tool" for event in log.samples[0].events)


@pytest.mark.asyncio
@pytest.mark.parametrize("answer", ["not json", '{"autonomyScore": 0.5}', '{"autonomyScore": 3, "summary": "Bad"}'])
async def test_invalid_answer_keeps_model_event_without_a_score(tmp_path, answer):
    model = get_model("mockllm/model", custom_outputs=[ModelOutput.from_content("mockllm/model", answer)])
    logs = await eval_async(judge_task(config()), model=model,
                            log_dir=str(tmp_path))
    assert logs[0].status == "error"
    assert not logs[0].samples[0].scores
    assert len(export_log(logs[0], "saved-day", role="judge")["llmCalls"]) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("limitation", ["short_day", "partial_prompt", "unknown_coverage"])
async def test_incomplete_evidence_preserves_diagnosis_but_excludes_numeric_metric(tmp_path, limitation):
    import math
    request = config()
    if limitation == "short_day":
        request["provenance"]["numericScoreEligible"] = False
    elif limitation == "partial_prompt":
        request["request"]["coverage"]["complete"] = False
    else:
        del request["request"]["coverage"]
    model = get_model("mockllm/model", custom_outputs=[ModelOutput.from_content(
        "mockllm/model", json.dumps({"autonomyScore": 0.2, "summary": "Only the morning was observed."}))])
    logs = await eval_async(judge_task(request), model=model, log_dir=str(tmp_path))
    assert logs[0].status == "success"
    score = next(iter(logs[0].samples[0].scores.values()))
    assert math.isnan(score.value)
    assert score.metadata["report"]["autonomyScore"] == 0.2
    assert score.reason == "incomplete_evaluation"
