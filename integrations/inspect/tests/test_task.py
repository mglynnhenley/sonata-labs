import asyncio
import importlib

import anyio
import pytest
from inspect_ai import eval_async
from inspect_ai.model import ChatMessageAssistant, ModelOutput, get_model
from inspect_ai.tool import tool

from sonata_inspect.smoke import scripted_model
from sonata_inspect.task import sonata_day
from test_client import result, session

adapter = importlib.import_module("sonata_inspect.task")


class FakeClient:
    instances = []

    def __init__(self, *args, **kwargs):
        self.session_id = None
        self.start_response = None
        self.final_result = None
        self.latest = session()
        self.events = []
        self.writes = []
        self.instances.append(self)

    async def start(self, request):
        self.events.append("start")
        self.request = request
        self.session_id = "sess_fixture"
        self.start_response = {"session": self.latest, "agentBrief": "PUBLIC ASSIGNMENT: edit the workbook.",
                               "timing": {"compression": request["compression"], **request["timing"]},
                               "isolation": "test-only"}
        return self.start_response

    async def wait_ready(self):
        return self.latest

    async def poll(self):
        return self.latest

    @property
    def action_timing(self):
        return self.start_response["timing"]["policy"] == "provider-operations-v1"

    async def finish_work(self):
        if self.action_timing:
            self.events.append("finish_work")

    async def wait_update(self, until_tick=None):
        self.events.append("wait_update")
        self.latest = session(tick=self.latest["tick"] + 1)
        return self.latest

    async def wait_ended(self):
        self.events.append("world_ended")
        self.latest = session(status="done", live=False, tick=3)
        return await self.result()

    async def result(self):
        self.events.append("result")
        self.final_result = result(session=self.latest)
        return self.final_result

    async def finalize(self, status, reason):
        self.events.append("finalize_" + status)
        self.latest = session(status=status, live=False)
        return await self.result()

    async def close(self):
        self.events.append("close")


class FakeTools:
    async def tools(self):
        @tool
        def workbook_write():
            async def execute(value: str) -> str:
                """Change the fixture workbook.

                Args:
                    value: The fixture value to write.
                """
                FakeClient.instances[-1].writes.append(value)
                return "Saved"
            return execute
        return [workbook_write()]


@pytest.fixture(autouse=True)
def fake_environment(monkeypatch):
    FakeClient.instances = []
    monkeypatch.setattr(adapter, "SessionClient", FakeClient)
    monkeypatch.setattr(adapter, "mcp_for", lambda *args: FakeTools())


@pytest.mark.asyncio
async def test_real_inspect_lifecycle_wait_write_finish_score_cleanup(tmp_path):
    logs = await eval_async(sonata_day(platform_url="http://fixture", memory_policy="none"),
                            model=scripted_model([{"tool": "wait_for_update"}, {"tool": "workbook_write", "arguments": {"value": "supported"}}]),
                            log_dir=str(tmp_path), max_samples=1)
    assert logs[0].status == "success", logs[0].error
    sample = logs[0].samples[0]
    assert next(iter(sample.scores.values())).value == 0.5
    assert sample.metadata["sonata"]["run_id"] == "sess_fixture"
    assert sample.metadata["sonata"]["timing"]["compression"] == 60
    client = FakeClient.instances[0]
    assert client.writes == ["supported"]
    assert client.events == ["start", "wait_update", "world_ended", "result", "close"]
    assert client.request["director"] is False and client.request["judge"] is False
    model_history = str(sample.messages)
    assert "PUBLIC ASSIGNMENT" in model_history
    assert "actual workbook mutation" not in model_history  # grader-only evidence


@pytest.mark.asyncio
async def test_no_tool_reply_waits_and_resumes_instead_of_finishing(tmp_path):
    finish = scripted_model([])
    calls = 0
    async def output(messages, tools, choice, config):
        nonlocal calls
        calls += 1
        if calls == 1:
            return ModelOutput.from_content("mockllm/model", "Waiting for the colleague.")
        return await finish.api.generate(messages, tools, choice, config)
    # Provider returns either ModelOutput or (ModelOutput, ModelCall); use the
    # simple output from the second mock rather than nesting provider records.
    async def generate_output(messages, tools, choice, config):
        out = await output(messages, tools, choice, config)
        return out[0] if isinstance(out, tuple) else out
    logs = await eval_async(sonata_day(platform_url="http://fixture", memory_policy="none"),
                            model=get_model("mockllm/model", custom_outputs=generate_output), log_dir=str(tmp_path))
    assert logs[0].status == "success", logs[0].error
    assert calls == 2
    assert "wait_update" in FakeClient.instances[0].events


@pytest.mark.asyncio
async def test_provider_error_finalizes_failed_before_cleanup(tmp_path):
    def explode(*args):
        raise RuntimeError("fixture provider failure")
    logs = await eval_async(sonata_day(platform_url="http://fixture", memory_policy="none"),
                            model=get_model("mockllm/model", custom_outputs=explode),
                            max_retries=0, log_dir=str(tmp_path))
    assert logs[0].status == "error"
    assert FakeClient.instances[0].events == ["start", "finalize_failed", "result", "close"]
    assert not logs[0].samples[0].scores


@pytest.mark.asyncio
async def test_turn_budget_is_declared_and_partial_is_unmeasured(tmp_path):
    logs = await eval_async(sonata_day(platform_url="http://fixture", max_turns=1, memory_policy="none"),
                            model="mockllm/model", log_dir=str(tmp_path))
    assert logs[0].status == "success", logs[0].error
    sample = logs[0].samples[0]
    assert sample.metadata["sonata_termination"] == "declared_turn_budget_exhausted"
    assert next(iter(sample.scores.values())).value == "UNMEASURED"
    assert "finalize_aborted" in FakeClient.instances[0].events


@pytest.mark.asyncio
async def test_trim_keeps_full_transcript_and_does_not_make_daily_summary(tmp_path):
    # The real Inspect compactor is used; a mock context window of 128K means a
    # small threshold forces trimming without any summarizer model. The
    # threshold must still leave room for tools, the prefix and one long
    # message, otherwise Inspect raises "Compaction insufficient".
    calls = 0
    finish = scripted_model([])
    async def output(messages, tools, choice, config):
        nonlocal calls
        calls += 1
        if calls <= 3:
            return ModelOutput.from_content("mockllm/model", f"Old work {calls}: " + "details " * 2000)
        out = await finish.api.generate(messages, tools, choice, config)
        return out[0] if isinstance(out, tuple) else out
    logs = await eval_async(sonata_day(platform_url="http://fixture", memory_policy="trim", compaction_threshold=0.05),
                            model=get_model("mockllm/model", custom_outputs=output), log_dir=str(tmp_path))
    assert logs[0].status == "success", logs[0].error
    history = str(logs[0].samples[0].messages)
    assert "Old work 1:" in history and "Old work 3:" in history
    assert logs[0].eval.metadata["daily_summary"] is False


def test_refuses_implicit_or_invalid_environment():
    with pytest.raises(ValueError):
        sonata_day(platform_url="localhost")
    with pytest.raises(ValueError):
        sonata_day(platform_url="http://fixture", compression=0)


@pytest.mark.asyncio
async def test_day_ending_during_generation_refuses_late_action_without_crashing(tmp_path):
    player = scripted_model([{"tool": "workbook_write", "arguments": {"value": "too late"}}])

    async def output(messages, tools, choice, config):
        FakeClient.instances[0].latest = session(status="done", live=False, tick=3)
        reply = await player.api.generate(messages, tools, choice, config)
        return reply[0] if isinstance(reply, tuple) else reply

    logs = await eval_async(sonata_day(platform_url="http://fixture", memory_policy="none"),
                            model=get_model("mockllm/model", custom_outputs=output), log_dir=str(tmp_path))
    assert logs[0].status == "success", logs[0].error
    assert FakeClient.instances[0].writes == []
    assert "finalize_failed" not in FakeClient.instances[0].events
    assert "The agent work period has ended" in logs[0].samples[0].model_dump_json()
    assert logs[0].samples[0].scores


@pytest.mark.asyncio
async def test_action_timing_is_declared_to_the_model_and_finish_advances_world(tmp_path):
    logs = await eval_async(sonata_day(platform_url="http://fixture", memory_policy="none",
                                     timing_policy="provider-operations-v1", work_units_per_tick=24),
                            model=scripted_model([]), log_dir=str(tmp_path), max_samples=1)
    assert logs[0].status == "success", logs[0].error
    assert "24 abstract work units" in str(logs[0].samples[0].messages)
    assert "finish_work" in FakeClient.instances[0].events
    assert logs[0].eval.metadata["clock_policy"] == "provider-operations-v1"
