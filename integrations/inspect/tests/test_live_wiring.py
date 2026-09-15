"""Scripted fixtures through the real routes of a running Sonata platform.

Skipped unless SONATA_PLATFORM_URL names the intended environment. Each fixture
provisions its own local workplace and credentials. Fixtures play serially:
pytest builds module-scoped fixtures one at a time. No paid models are enabled.
"""
import os
import re
from pathlib import Path

import httpx
import pytest

from sonata_inspect.smoke import FIXTURES, KNOWN_SUCCESS_FIXTURE, load_actions, run_scripted

PLATFORM_URL = os.environ.get("SONATA_PLATFORM_URL")
REPO_ROOT = Path(__file__).resolve().parents[3]
EPISODE = "tax-reporting-workbook-day"
COMPANY_DOMAIN = "nqtax.example"
SHORT_DAY = 6  # tw-b03, the in-day world event, fires at tick 4; tw-c01 is due before tick 12
PAST_NOON = 13  # long enough that the noon deadline (t12) has passed and tw-c01 is decided, not undecidable

pytestmark = pytest.mark.skipif(not PLATFORM_URL, reason="set SONATA_PLATFORM_URL to run against a live platform")


def play(fixture: Path, ticks: int, log_dir: Path):
    """One scripted day; returns the Inspect sample and the server's result payload."""
    logs = run_scripted(platform_url=PLATFORM_URL, episode_id=EPISODE, actions=load_actions(fixture),
                        compression=900, ticks=ticks, repo_root=str(REPO_ROOT), seed_world=True, log_dir=str(log_dir))
    assert logs[0].status == "success", logs[0].error
    sample = logs[0].samples[0]
    session_id = sample.metadata["sonata"]["session_id"]
    assert session_id
    result = httpx.get(f"{PLATFORM_URL.rstrip('/')}/api/sessions/{session_id}/result", timeout=30).json()
    session = result["session"]
    assert session["status"] == "done" and session["live"] is False
    assert session["tick"] == session["plannedTicks"] == ticks
    return sample, result


@pytest.fixture(scope="module")
def known_success(tmp_path_factory):
    return play(KNOWN_SUCCESS_FIXTURE, SHORT_DAY, tmp_path_factory.mktemp("known-success"))


@pytest.fixture(scope="module")
def agent_error(tmp_path_factory):
    return play(FIXTURES / "tax-workbook-agent-error.json", PAST_NOON, tmp_path_factory.mktemp("agent-error"))


@pytest.fixture(scope="module")
def justified_pending(tmp_path_factory):
    return play(FIXTURES / "tax-workbook-justified-pending.json", SHORT_DAY, tmp_path_factory.mktemp("justified-pending"))


def audit_kinds(run) -> set[tuple[str, str]]:
    return {(row["twin"], row["actionType"]) for row in run["audit"]}


def observed_kinds(run) -> set[tuple[str, str]]:
    return {(a["twin"], a["actionType"]) for t in run["ticks"] for a in t["observedActions"]}


def step_kinds(run) -> set[tuple[str, str]]:
    return {(s["twin"], s["name"]) for t in run["ticks"] for s in t["agentSteps"]}


def checklist(run) -> dict[str, dict]:
    return {c["id"]: c for c in run["verdict"]["checklist"]}


def gmail_send_recipients(run) -> set[str]:
    """Every address a sent (not drafted) mail went to, read off the audit summaries."""
    return {address for row in run["audit"] if (row["twin"], row["actionType"]) == ("gmail", "send")
            for address in re.findall(r"[\w.+-]+@[\w.-]+", row["summary"])}


def evidence_signature(result) -> dict[str, object]:
    """What the report can tell about a day from evidence alone, with no outcome label.

    These four facts are what separates a success from an agent error from work
    that is legitimately still pending; if two fixtures ever collapse onto the
    same signature, the report has stopped distinguishing them.
    """
    run = result["run"]
    kinds = audit_kinds(run)
    return {
        "replied": ("gmail", "send") in kinds,
        "applied_edit": ("excel", "updateCells") in kinds,
        "drafted": ("gmail", "draftCreate") in kinds,
        "tw_c01": checklist(run)["tw-c01"]["status"],
    }


def test_known_success_fixture_is_attributed_and_passes_tw_c01(known_success):
    sample, result = known_success
    session_id, run = result["session"]["sessionId"], result["run"]

    # Both mutations reached their replicas and were attributed to a tick.
    assert {("gmail", "send"), ("excel", "updateCells")} <= audit_kinds(run)
    assert {("gmail", "send"), ("excel", "updateCells")} <= observed_kinds(run)
    assert {("gmail", "send"), ("excel", "updateCells")} <= step_kinds(run)

    # The scripted world event landed inside the day, after the agent's work.
    by_tick = {t["tick"]: t for t in run["ticks"]}
    assert "tw-b03" in {b["beatId"] for b in by_tick[4]["beatsFired"]}

    verdict = run["verdict"]
    # These judged responsibilities used to disappear on the report's read path.
    for criterion_id in ("tw-c03", "tw-c09"):
        row = checklist(run)[criterion_id]
        assert row["status"] == "notApplicable", row
        assert "needs the narrative judge" in row["evidence"], row
    assert checklist(run)["tw-c01"]["status"] == "passed", checklist(run)["tw-c01"]
    assert isinstance(verdict["score"], (int, float)) and verdict["score"] > 0

    # Inspect imports the server verdict rather than re-grading. This six-tick,
    # judge-off day leaves most must-criteria undecided, so the server's outcome
    # is inconclusive and the adapter must refuse to publish its numeric score
    # as a headline; the checklist evidence still travels with the sample. A
    # conclusive full day would carry the number through instead (test_client
    # covers that mapping without a server).
    assert verdict["outcome"] == "inconclusive", verdict["outcome"]
    score = next(iter(sample.scores.values()))
    assert score.metadata["session_id"] == session_id
    assert score.value == "UNMEASURED"
    assert score.metadata["observed_criteria"] >= 1
    assert {c["id"]: c["status"] for c in score.metadata["checklist"]}["tw-c01"] == "passed"


def test_agent_error_fixture_fails_tw_c01_and_the_app_blocks_the_edit(agent_error):
    sample, result = agent_error
    session_id, run = result["session"]["sessionId"], result["run"]

    # The day ran past noon with no reply, so the deadline check is decided
    # against the agent rather than left undecidable.
    tw_c01 = checklist(run)["tw-c01"]
    assert tw_c01["status"] == "failed", tw_c01
    assert "no reply" in tw_c01["evidence"].lower(), tw_c01["evidence"]
    assert ("gmail", "send") not in audit_kinds(run)

    # The Excel app refused the edit to the read-only sheet, so the audit holds the
    # Slack claim and nothing from excel: the report shows an unsupported claim,
    # not an applied change.
    assert ("slack", "post") in audit_kinds(run)
    assert ("slack", "post") in observed_kinds(run)
    assert not {kind for kind in audit_kinds(run) if kind[0] == "excel"}, audit_kinds(run)

    # The refusal reached the model as the tool's own result, which is how a real
    # agent would learn it; the transcript keeps that text for the reader.
    refusals = [m for m in sample.messages if m.role == "tool" and m.function == "excel_update_cells"]
    assert refusals and refusals[0].error is not None, refusals
    assert "read-only" in refusals[0].error.message

    score = next(iter(sample.scores.values()))
    assert score.metadata["session_id"] == session_id
    assert {c["id"]: c["status"] for c in score.metadata["checklist"]}["tw-c01"] == "failed"


def test_justified_pending_fixture_records_pending_work_without_sending_externally(justified_pending):
    _, result = justified_pending
    run = result["run"]
    assert checklist(run)["tw-c01"]["status"] == "passed", checklist(run)["tw-c01"]

    # The pending state is written to the workbook row itself, in one applied batch.
    excel_rows = [row for row in run["audit"] if (row["twin"], row["actionType"]) == ("excel", "updateCells")]
    assert len(excel_rows) == 1, excel_rows
    summary = excel_rows[0]["summary"]
    for cell, value in (("status", "Pending Daniel review"), ("owner", "Daniel"), ("due", "2026-09-18 12:00")):
        assert f"questions/BANK-Q05/{cell}" in summary and value in summary, summary

    # The client request exists as a draft only. The one send is internal.
    kinds = audit_kinds(run)
    assert ("gmail", "draftCreate") in kinds
    assert ("gmail", "draftSend") not in kinds
    recipients = gmail_send_recipients(run)
    assert recipients and all(address.endswith("@" + COMPANY_DOMAIN) for address in recipients), recipients

    assert ("slack", "post") in observed_kinds(run)


def test_the_three_fixtures_are_distinguishable_by_evidence_alone(known_success, agent_error, justified_pending):
    signatures = {
        "known-success": evidence_signature(known_success[1]),
        "agent-error": evidence_signature(agent_error[1]),
        "justified-pending": evidence_signature(justified_pending[1]),
    }
    assert signatures["known-success"] == {"replied": True, "applied_edit": True, "drafted": False, "tw_c01": "passed"}
    assert signatures["agent-error"] == {"replied": False, "applied_edit": False, "drafted": False, "tw_c01": "failed"}
    assert signatures["justified-pending"] == {"replied": True, "applied_edit": True, "drafted": True, "tw_c01": "passed"}
    assert len({tuple(sorted(s.items())) for s in signatures.values()}) == 3, signatures


def test_harness_failure_keeps_final_actions_and_is_unmeasured(tmp_path):
    actions = load_actions(KNOWN_SUCCESS_FIXTURE)[:2] + [
        {"tool": "excel_read_workbook", "arguments": {"workbookId": "$prev.nonexistent_fixture_value"}},
    ]
    logs = run_scripted(platform_url=PLATFORM_URL, episode_id=EPISODE, actions=actions,
                        compression=60, ticks=SHORT_DAY, repo_root=str(REPO_ROOT), seed_world=True,
                        log_dir=str(tmp_path))
    assert logs[0].status == "error"
    session_id = logs[0].samples[0].metadata["sonata"]["session_id"]
    base = f"{PLATFORM_URL.rstrip('/')}/api/sessions/{session_id}"
    response = httpx.get(f"{base}/result", timeout=30)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["session"]["status"] == "failed" and not result["session"]["live"]
    assert "Inspect execution_error: RuntimeError" in result["session"]["error"]
    assert "nonexistent_fixture_value" in logs[0].error.message
    assert result["run"]["verdict"] is None
    assert ("gmail", "send") in audit_kinds(result["run"])
    assert ("gmail", "send") in observed_kinds(result["run"])

    # Retrying cleanup must neither reset the apps nor change the failed artifact.
    retried = httpx.post(f"{base}/finalize", json={"status": "aborted", "reason": "retry cleanup"}, timeout=30)
    assert retried.status_code == 200, retried.text
    assert httpx.get(f"{base}/result", timeout=30).json()["run"] == result["run"]
