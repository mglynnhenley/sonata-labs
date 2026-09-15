import asyncio

import httpx
import pytest

from sonata_inspect.client import SessionClient, SessionError, public_clock
from sonata_inspect.task import assessment


def session(**updates):
    return {"sessionId": "sess_fixture", "status": "running", "live": True, "tick": 1,
            "plannedTicks": 3, "simTimeISO": "2026-09-17T09:00:00+01:00", **updates}


def result(**updates):
    return {"session": session(status="done", live=False, tick=3), "run": {
        "runId": "sess_fixture", "verdict": {"score": 0.5, "outcome": "partial", "checklist": [
            {"id": "one", "status": "passed", "evidence": "actual workbook mutation"},
            {"id": "two", "status": "failed", "evidence": "missing handoff"},
        ]}}, **updates}


@pytest.mark.asyncio
async def test_wait_is_not_finish_and_done_waits_for_artifact():
    calls = []
    views = iter([session(tick=1), session(tick=2), session(status="done", tick=3, live=True), session(status="done", tick=3, live=False)])
    async def handler(request):
        calls.append((request.method, request.url.path))
        if request.method == "POST":
            return httpx.Response(201, json={"session": session()})
        if request.url.path.endswith("/result"):
            assert calls[-2] == ("GET", "/api/sessions/sess_fixture")
            return httpx.Response(200, json=result())
        return httpx.Response(200, json={"session": next(views), "ticks": [{"private": "never expose"}]})
    client = SessionClient("http://fixture", transport=httpx.MockTransport(handler), poll_seconds=0.001)
    await client.start({"episodeId": "fixture"})
    waiting = await client.wait_update()
    assert waiting["tick"] == 2
    assert client.final_result is None
    assert not any(path.endswith("finalize") for _, path in calls)
    await client.wait_ended()
    assert client.final_result["run"]["runId"] == client.session_id
    await client.close()


@pytest.mark.asyncio
async def test_finalization_retains_id_and_runs_before_result():
    calls = []
    async def handler(request):
        calls.append(request.url.path)
        if request.url.path == "/api/sessions":
            return httpx.Response(201, json={"session": session()})
        if request.url.path.endswith("/result"):
            assert "/api/sessions/sess_fixture/finalize" in calls
            return httpx.Response(200, json=result(session=session(status="aborted", live=False)))
        return httpx.Response(200, json={"session": session(status="aborted", live=False)})
    client = SessionClient("http://fixture", transport=httpx.MockTransport(handler))
    await client.start({})
    await client.finalize(status="aborted", reason="test cancellation")
    await client.finalize(status="aborted", reason="idempotent cleanup")
    assert calls.count("/api/sessions/sess_fixture/finalize") == 1
    assert client.final_result["session"]["status"] == "aborted"
    await client.close()


@pytest.mark.asyncio
async def test_rejects_result_for_another_run():
    async def handler(request):
        if request.method == "POST":
            return httpx.Response(201, json={"session": session()})
        return httpx.Response(200, json=result(run={"runId": "wrong"}))
    client = SessionClient("http://fixture", transport=httpx.MockTransport(handler))
    await client.start({})
    with pytest.raises(SessionError, match="different session"):
        await client.result()
    await client.close()


def test_public_clock_has_no_private_evidence():
    clock = public_clock(session(lastEvent="private colleague decision", score=1, error="secret", caveats=["judge reason"]))
    assert set(clock) == {"status", "simTimeISO", "completedIntervals", "plannedIntervals", "dayEnded"}
    assert "secret" not in str(clock)


def test_imports_existing_score_and_keeps_evidence():
    score = assessment(result(), {"run_id": "sess_fixture"})
    assert score.value == 0.5
    assert score.metadata["checklist"][0]["evidence"] == "actual workbook mutation"
    assert score.metadata["run_id"] == "sess_fixture"


@pytest.mark.parametrize("changes", [
    {"session": session(status="failed", live=False)},
    {"session": session(status="aborted", live=False)},
    {"session": session(status="done", live=True)},
    {"run": None},
    {"run": {"verdict": {"score": 1, "outcome": "inconclusive", "checklist": [{"status": "passed"}]}}},
    {"run": {"verdict": {"score": 1, "outcome": "pass", "checklist": [{"status": "notApplicable"}]}}},
])
def test_missing_partial_or_inconclusive_evidence_is_never_zero_or_success(changes):
    assert assessment(result(**changes), {}).value == "UNMEASURED"


@pytest.mark.asyncio
async def test_ready_hands_off_only_the_same_workplaces_provider_credentials():
    connection = {"twins": ["gmail"], "urls": {"gmail": "http://mailbox"},
                  "execution": {"kind": "docker", "container": "owned-worker"},
                  "token": "employee", "credentialsPath": "/api/sessions/sess_fixture/connection"}
    async def handler(request):
        if request.url.path.endswith("/connection"):
            assert request.headers["authorization"] == "Bearer employee"
            return httpx.Response(200, json={"connection": {**connection, "gmailOAuth": {
                "accessToken": "mailbox-access", "refreshToken": "mailbox-refresh", "clientId": "sonata-harness"}}})
        return httpx.Response(200, json={"session": session()})
    client = SessionClient("http://fixture", transport=httpx.MockTransport(handler))
    start = client.attach({"session": session(), "connection": connection})
    await client.wait_ready()
    assert start["connection"]["gmailOAuth"]["accessToken"] == "mailbox-access"
    assert start["connection"]["execution"] == connection["execution"]
    assert "controlToken" not in start["connection"]
    await client.close()


@pytest.mark.asyncio
async def test_credential_handoff_rejects_a_different_workplace():
    connection = {"twins": ["gmail"], "urls": {"gmail": "http://mailbox"},
                  "token": "employee", "credentialsPath": "/api/sessions/sess_fixture/connection"}
    async def handler(request):
        if request.url.path.endswith("/connection"):
            return httpx.Response(200, json={"connection": {**connection, "token": "other-run"}})
        return httpx.Response(200, json={"session": session()})
    client = SessionClient("http://fixture", transport=httpx.MockTransport(handler))
    client.attach({"session": session(), "connection": connection})
    with pytest.raises(SessionError, match="do not match"):
        await client.wait_ready()
    await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("change", [
    {"execution": {"kind": "docker", "container": "other-worker"}},
    {"execution": {"kind": "host", "container": "owned-worker"}},
    {"execution": None}, {"twins": ["gmail", "slack"]},
])
async def test_credential_handoff_cannot_replace_the_isolated_execution(change):
    connection = {"twins": ["gmail"], "urls": {"gmail": "http://sonata-gateway:8080/gmail"},
                  "execution": {"kind": "docker", "container": "owned-worker"},
                  "token": "employee", "credentialsPath": "/api/sessions/sess_fixture/connection"}

    async def handler(request):
        if request.url.path.endswith("/connection"):
            return httpx.Response(200, json={"connection": {**connection, **change}})
        return httpx.Response(200, json={"session": session()})

    client = SessionClient("http://fixture", transport=httpx.MockTransport(handler))
    start = client.attach({"session": session(), "connection": connection})
    with pytest.raises(SessionError, match="do not match"):
        await client.wait_ready()
    assert start["connection"] is connection
    await client.close()


@pytest.mark.asyncio
async def test_action_clock_uses_authenticated_advance_and_remembers_delivered_wakes():
    requests = []
    async def handler(request):
        import json
        assert request.url.path == "/api/sessions/sess_fixture/clock"
        assert request.headers["authorization"] == "Bearer employee"
        body = json.loads(request.content)
        requests.append(body)
        return httpx.Response(200, json={"session": session(tick=3),
            "wake": {"notificationSequence": 7, "reason": "notification"}})
    client = SessionClient("http://fixture", transport=httpx.MockTransport(handler))
    client.attach({"session": session(), "timing": {"policy": "provider-operations-v1", "workUnitsPerTick": 12},
                   "connection": {"token": "employee"}})
    await client.wait_update()
    await client.wait_update(until_tick=6)
    await client.finish_work()
    assert requests == [{"action": "wait", "afterNotification": 0},
                        {"action": "wait", "afterNotification": 7, "untilTick": 6}, {"action": "finish"}]
    await client.close()
