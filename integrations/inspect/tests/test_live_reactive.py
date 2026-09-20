"""Paid, opt-in colleague pilot. Never enabled by SONATA_PLATFORM_URL alone.

Price six director ticks before setting SONATA_REACTIVE_PLATFORM_URL. The agent
is scripted and the judge is disabled. This reseeds the same shared clones as
test_live_wiring, so run it serially against the intended idle platform.
"""
import os
from pathlib import Path

import httpx
import pytest

from sonata_inspect.smoke import KNOWN_SUCCESS_FIXTURE, load_actions, run_scripted

PLATFORM_URL = os.environ.get("SONATA_REACTIVE_PLATFORM_URL")
REPO_ROOT = Path(__file__).resolve().parents[3]
pytestmark = pytest.mark.skipif(not PLATFORM_URL, reason="explicitly enable and price the reactive pilot")


def test_colleague_reply_is_captured_separately_from_agent_actions_and_costs(tmp_path):
    logs = run_scripted(platform_url=PLATFORM_URL, episode_id="tax-reporting-workbook-day",
                        actions=load_actions(KNOWN_SUCCESS_FIXTURE), compression=60, ticks=6,
                        repo_root=str(REPO_ROOT), seed_world=True, director=True, log_dir=str(tmp_path))
    assert logs[0].status == "success", logs[0].error
    sample = logs[0].samples[0]
    session_id = sample.metadata["sonata"]["session_id"]
    with httpx.Client(base_url=PLATFORM_URL.rstrip("/"), timeout=30) as client:
        response = client.get(f"/api/sessions/{session_id}/result")
        response.raise_for_status()
        result = response.json()
        response = client.get(f"/api/results/{session_id}")
        response.raise_for_status()
        cost = response.json()["cost"]

    assert result["session"]["status"] == "done" and not result["session"]["live"]
    assert result["session"]["tick"] == result["session"]["plannedTicks"] == 6
    run = result["run"]
    replies = [event for tick in run["ticks"] for event in tick["directorEvents"]
               if event.get("becauseSeq") is not None and event.get("handle") and not event.get("error")]
    assert replies, "No colleague answered an agent action; inspect the trace before claiming this gate passed"
    steps = [step for tick in run["ticks"] for step in tick["agentSteps"]]
    for reply in replies:
        assert any(step["seq"] == reply["becauseSeq"] for step in steps)
        assert reply.get("observation", {}).get("text")
        assert not any(row["twin"] == reply["twin"] and row.get("targetId") == reply["handle"]["id"]
                       for row in run["audit"])

    # External sessions previously discarded these calls after summing them.
    assert cost["hasPerCall"] and cost["complete"], cost
    assert cost["calls"] == run["verdict"]["cost"]["llmCalls"] > 0
    assert cost["totalUsd"] == pytest.approx(run["verdict"]["cost"]["usd"])
    assert cost["totalUsd"] > 0
    assert {role["role"] for role in cost["roles"]} == {"director"}
    assert next(iter(sample.scores.values())).value == "UNMEASURED"
