"""Thin Inspect integration. The existing Sonata session is the episode runner."""
from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import uuid4

import anyio
from inspect_ai import Task, task
from inspect_ai.dataset import Sample
from inspect_ai.model import ChatMessageSystem, ChatMessageUser, CompactionTrim, compaction
from inspect_ai.scorer import Score, Target, scorer
from inspect_ai.solver import Generate, Solver, TaskState, solver
from inspect_ai.tool import ToolError, ToolDef, mcp_connection, mcp_server_stdio, tool
from inspect_ai.util import LimitExceededError

from .client import SessionClient, SessionError, public_clock, settled

ADAPTER_VERSION = "session-timing-pilot-v2"


@dataclass
class EpisodeHandle:
    client: SessionClient
    finished_work: bool = False


def assessment(result: dict[str, Any], linkage: dict[str, Any]) -> Score:
    """Import the server verdict; never reconstruct/check a business criterion."""
    session = result["session"]
    run = result.get("run")
    verdict = (run or {}).get("verdict") or {}
    checklist = verdict.get("checklist") or []
    measured = [item for item in checklist if item.get("status") in {"passed", "failed"}]
    raw_score = verdict.get("score")
    complete = settled(session) and session.get("status") == "done" and not session.get("noResult")
    valid_score = isinstance(raw_score, (int, float)) and not isinstance(raw_score, bool) and math.isfinite(raw_score) and 0 <= raw_score <= 1
    # Inconclusive must not become a successful numeric headline merely because
    # an easy should-criterion was observable while essential work was not.
    numeric = complete and bool(measured) and valid_score and verdict.get("outcome") != "inconclusive"
    caveats = session.get("caveats", [])
    reason = session.get("noResult") or session.get("error") or (
        "No complete, conclusive deterministic assessment was available." if not numeric else None
    )
    return Score(
        value=raw_score if numeric else "UNMEASURED",
        answer=verdict.get("outcome") if numeric else "UNMEASURED",
        explanation=(
            "Existing Sonata deterministic checklist score; this is not overall business quality. "
            "LLM-judged responsibilities and legal correctness are not inferred from this number. "
            + (reason or "See criterion evidence and the linked Sonata report.")
        ),
        metadata={
            **linkage,
            "assessment_kind": "existing_sonata_deterministic_checklist",
            "session_status": session.get("status"),
            "ended_because": session.get("endedBecause"),
            "no_result": reason,
            "checklist": checklist,
            "judge": verdict.get("judge"),
            "world_cost": verdict.get("cost"),
            "caveats": caveats,
            "observed_criteria": len(measured),
            "unmeasured_checklist_criteria": len(checklist) - len(measured),
        },
    )


def mcp_for(start: dict[str, Any], repo_root: Path):
    """Run the existing MCP bundle inside this session's restricted container."""
    connection = start.get("connection") or {}
    if not isinstance(connection, dict):
        raise SessionError("Session did not provide its complete MCP connection map")
    twins = connection.get("twins")
    urls = connection.get("urls")
    known_twins = {"gmail", "slack", "calendar", "attio", "google-docs", "google-ads", "linkedin", "excel"}
    if (not isinstance(twins, list) or not twins or any(not isinstance(t, str) or t not in known_twins for t in twins)
            or len(set(twins)) != len(twins) or not isinstance(urls, dict)
            or any(not isinstance(urls.get(t), str) or not urls[t] for t in twins)):
        raise SessionError("Session did not provide its complete MCP connection map")
    session = start.get("session")
    session_id = session.get("sessionId") if isinstance(session, dict) else None
    if not isinstance(session_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", session_id):
        raise SessionError("Session did not provide a valid workplace identifier")
    directory = repo_root / ".context" / "workplaces" / session_id
    container = f"sonata-{hashlib.sha256(str(directory).encode()).hexdigest()[:16]}-worker"
    execution = connection.get("execution")
    if not isinstance(execution, dict) or execution.get("kind") != "docker" or execution.get("container") != container:
        raise SessionError("Session did not provide its owned Docker execution container")
    env = {f"SONATA_{t.upper().replace('-', '_')}_URL": urls[t] for t in twins}
    if not isinstance(connection.get("token"), str) or not connection["token"]:
        raise SessionError("Session did not provide its provider credential")
    env["SONATA_TOKEN"] = connection["token"]
    if start.get("timing", {}).get("policy") == "provider-operations-v1":
        env["SONATA_PROVIDER_TIMEOUT_MS"] = "180000"
    if connection.get("credentialsPath") and "gmail" in twins and not connection.get("gmailOAuth"):
        raise SessionError("Gmail provider credentials were not issued for this workplace")
    if connection.get("gmailOAuth"):
        env["SONATA_GMAIL_OAUTH"] = json.dumps(connection["gmailOAuth"])
    # Docker obtains --env NAME values from this host process environment. Do
    # not put credential values in argv or forward the host's other secrets.
    args = ["exec", "--interactive"]
    for name in env:
        args.extend(["--env", name])
    args.extend([container, "node", "/opt/sonata/mcp.mjs", *twins])
    # Respect the same explicit Docker context as the platform launcher. These
    # settings configure the trusted Docker CLI and are not passed into MCP.
    for name in ("DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"):
        if name in os.environ:
            env[name] = os.environ[name]
    return mcp_server_stdio(name="sonata", command="docker", args=args, cwd=repo_root, env=env)


async def generate_turn(state: TaskState, generate: Generate, compact) -> TaskState:
    if compact is None:
        return await generate(state, tool_calls="single", parallel_tool_calls=False)
    # Inspect's compactor reads full history but returns a bounded model view.
    # Keep that view out of the durable transcript: earlier evidence is still
    # inspectable even when the model has to rely on its own saved notes.
    history = list(state.messages)
    model_input, supplemental = await compact.compact_input(history)
    if supplemental is not None:
        history.append(supplemental)
    state.messages = list(model_input)
    try:
        state = await generate(state, tool_calls="single", parallel_tool_calls=False)
        additions = state.messages[len(model_input):]
        await compact.record_output(model_input, state.output)
        history.extend(additions)
        return state
    finally:
        state.messages = history


def guard_tool(original, handle: EpisodeHandle):
    """Do not execute another app call after finish_work or a closed day."""
    definition = ToolDef(original)
    # `**kwargs: Any` tells Inspect to pass the model's arguments straight
    # through; the wrapped tool keeps its own declared parameter schema.
    async def execute(**kwargs: Any):
        if handle.finished_work or (await handle.client.poll()).get("status") in {"done", "failed", "aborted"}:
            raise ToolError("The agent work period has ended; no further app actions are allowed")
        return await original(**kwargs)
    return ToolDef(execute, name=definition.name, description=definition.description,
                   parameters=definition.parameters, parallel=False).as_tool()


@tool(parallel=False)
def wait_for_update(handle: EpisodeHandle):
    async def execute(until_tick: int | None = None) -> str:
        """Wait for an update, then inspect your apps for changes.

        In action timing, advances to an incoming notification visible to your
        account, an optional timer, or day end. In wall timing, waits for the
        next interval. Returns the public clock only, never hidden events.

        Args:
            until_tick: Optional future interval index (zero is the day start)
                at which to wake even without an incoming message. Action timing only.
        """
        return json.dumps(public_clock(await handle.client.wait_update(until_tick)))
    return execute


@tool(parallel=False)
def finish_work(handle: EpisodeHandle):
    async def execute() -> str:
        """Declare that you will take no more actions for the rest of this episode.

        Save your handoff in the business apps first. The world continues to its
        scheduled end; action timing advances it without further agent work.
        """
        handle.finished_work = True
        await handle.client.finish_work()
        return "Work declared finished. No further agent actions will run; the world continues."
    return execute


@task
def sonata_day(
    platform_url: str,
    episode_id: str = "tax-reporting-workbook-day",
    compression: float = 60,
    timing_policy: str = "compressed-wall-time",
    work_units_per_tick: int = 12,
    repo_root: str = "",
    seed_world: bool = True,
    director: bool = False,
    judge: bool = False,
    ticks: int | None = None,
    max_turns: int = 120,
    timeout_seconds: int = 1800,
    poll_seconds: float = 0.5,
    agent_label: str = "Inspect pilot",
    memory_policy: str = "trim",
    compaction_threshold: float = 0.8,
    session_launch: dict[str, Any] | None = None,
    progress_path: str = "",
    agent_cost_limit: float | None = None,
) -> Task:
    """Run one complete scenario as one sample against an explicit Sonata server.

    Defaults are a scripted-only diagnostic pilot with no paid world/judge calls.
    Supplying a real Inspect model still costs money. This adapter does not create
    an isolated environment; point it at the environment intended for this run.
    """
    if not platform_url.startswith(("http://", "https://")):
        raise ValueError("platform_url must be the explicit HTTP(S) URL of the intended environment")
    if not math.isfinite(compression) or not 1 <= compression <= 3600:
        raise ValueError("compression must be between 1 and 3600")
    if timing_policy not in {"compressed-wall-time", "provider-operations-v1"}:
        raise ValueError("Unknown timing policy")
    if isinstance(work_units_per_tick, bool) or not isinstance(work_units_per_tick, int) or not 1 <= work_units_per_tick <= 10000:
        raise ValueError("work_units_per_tick must be an integer between 1 and 10000")
    if memory_policy not in {"none", "trim"}:
        raise ValueError("memory_policy must be none or trim")
    if not 0 < compaction_threshold < 1:
        raise ValueError("compaction_threshold must be a fraction between 0 and 1")
    if max_turns < 1 or timeout_seconds < 1 or poll_seconds <= 0:
        raise ValueError("Execution limits and polling interval must be positive")
    if ticks is not None and ticks < 1:
        raise ValueError("ticks must be positive")
    root = Path(repo_root).resolve() if repo_root else Path(__file__).resolve().parents[3]
    handles: dict[str, EpisodeHandle] = {}

    def key(state: TaskState) -> str:
        return state.metadata.get("sonata_sample_key", f"{state.sample_id}:{state.epoch}")

    def handle_for(state: TaskState) -> EpisodeHandle:
        return handles[key(state)]

    async def interrupt(state: TaskState, status: str, reason: str) -> None:
        handle = handles.get(key(state))
        if not handle or not handle.client.session_id or handle.client.final_result is not None:
            return
        # Cancellation may come from Inspect's AnyIO scope. Shield only bounded
        # finalization; do not let it orphan a running timer/database lease.
        with anyio.move_on_after(130, shield=True) as scope:
            try:
                await handle.client.finalize(status=status, reason=reason)  # type: ignore[arg-type]
            except Exception as exc:
                state.metadata["sonata_cleanup_error"] = str(exc)
        if scope.cancel_called:
            state.metadata["sonata_cleanup_error"] = "Timed out finalizing the session; inspect the linked Sonata session"

    @solver
    def setup_session() -> Solver:
        async def solve(state: TaskState, generate: Generate) -> TaskState:
            state.metadata["sonata_sample_key"] = uuid4().hex
            client = SessionClient(platform_url, poll_seconds=poll_seconds, timeout_seconds=timeout_seconds)
            handles[key(state)] = EpisodeHandle(client)
            try:
                # Preserve a successful POST's id even if the sample is canceled
                # while the response is arriving. Never retry a creation request.
                with anyio.CancelScope(shield=True):
                    start = client.attach(session_launch) if session_launch is not None else await client.start({
                        "episodeId": episode_id, "compression": compression,
                        "timing": {"policy": timing_policy, **({"workUnitsPerTick": work_units_per_tick} if timing_policy == "provider-operations-v1" else {})},
                        "seedWorld": seed_world, "director": director, "judge": judge,
                        "agentLabel": f"{agent_label}: {state.model} [sample {state.sample_id}, epoch {state.epoch}]",
                        **({"ticks": ticks} if ticks is not None else {}),
                    })
                    state.metadata["sonata"] = {
                        "adapter_version": ADAPTER_VERSION,
                        "session_id": client.session_id,
                        "run_id": client.session_id,
                        "session_url": f"{platform_url.rstrip('/')}/sessions/{client.session_id}",
                        "report_url": f"{platform_url.rstrip('/')}/runs/{client.session_id}",
                        "episode_id": episode_id,
                        "timing": start.get("timing"),
                        "isolation": start.get("isolation"),
                    }
                brief = start.get("agentBrief")
                if not isinstance(brief, str) or not brief.strip():
                    raise SessionError("Session did not provide a public agent brief")
                timing = start.get("timing", {})
                clock_rules = (
                    "The world uses experimental provider-operation timing. Model and network latency do not advance business time. "
                    f"Each interval allows {timing.get('workUnitsPerTick')} abstract work units: reads cost 1, changes cost 2, "
                    "and batches are charged by item. A tool may issue several provider operations. This is not calibrated human working time. "
                    "Events due at an operation's completion run first; work at or after day end is refused. "
                    "Waiting advances to an incoming Gmail, Slack or Calendar notification visible to your account, your requested timer, or day end. "
                    "Other apps require an explicit timer and polling. A no-tool reply waits for an update. "
                    if client.action_timing else
                    "The world runs on a compressed wall clock, including while model calls run. "
                    "A no-tool reply ends your current work burst; the harness waits for the next clock interval before asking again. "
                )
                state.messages.append(ChatMessageSystem(content=(
                    "You are an AI colleague working in the provided business apps. Follow the public assignment. " + clock_rules +
                    "Use wait_for_update when waiting for others. Only finish_work declares no more actions for the entire episode. "
                    "Clock wakeups are not reminders about forgotten tasks. Save work and handoffs in the apps.\n\n"
                    + brief
                )))
                ready = await client.wait_ready()
                if settled(ready):
                    await client.result()
                    state.completed = True
                else:
                    state.messages.append(ChatMessageUser(content=json.dumps(public_clock(ready))))
                return state
            except BaseException as exc:
                await interrupt(state, "aborted" if isinstance(exc, asyncio.CancelledError) else "failed", f"Inspect setup interrupted: {type(exc).__name__}")
                raise
        return solve

    @solver
    def run_agent() -> Solver:
        async def solve(state: TaskState, generate: Generate) -> TaskState:
            handle = handle_for(state)
            client = handle.client
            try:
                if client.final_result is not None:
                    return state
                server = mcp_for(client.start_response or {}, root)
                # Only the real app tools and two lifecycle controls reach the
                # model. The session control/result endpoints are never tools.
                async with mcp_connection(server):
                    state.tools = [guard_tool(t, handle) for t in await server.tools()] + [wait_for_update(handle), finish_work(handle)]
                    compact = compaction(CompactionTrim(threshold=compaction_threshold, preserve=0.6, memory=False),
                                         prefix=list(state.messages), tools=state.tools) if memory_policy == "trim" else None
                    turns = 0
                    while not state.completed:
                        session = await client.poll()
                        if session.get("status") in {"done", "failed", "aborted"}:
                            break
                        if turns >= max_turns:
                            state.metadata["sonata_termination"] = "declared_turn_budget_exhausted"
                            await interrupt(state, "aborted", "Inspect declared turn budget exhausted; partial diagnostic episode")
                            break
                        turns += 1
                        state = await generate_turn(state, generate, compact)
                        if progress_path:
                            # Raw provider prices, for the product's combined
                            # agent/world budget. This is control data, not a tool.
                            from inspect_ai.log import transcript
                            calls = [e for e in transcript().events if e.event == "model"]
                            prices = [(e.call.response or {}).get("usage", {}).get("cost") if e.call else None for e in calls]
                            known = [p for p in prices if isinstance(p, (int, float)) and not isinstance(p, bool) and math.isfinite(p)]
                            target = Path(progress_path)
                            temporary = target.with_suffix(".tmp")
                            temporary.write_text(json.dumps({"usd": sum(known), "calls": len(calls), "unpriced": len(prices) - len(known)}))
                            temporary.replace(target)
                            if agent_cost_limit is not None and (len(known) != len(prices) or sum(known) >= agent_cost_limit):
                                await interrupt(state, "aborted", "Declared spend budget exhausted or provider price unavailable; partial evaluation")
                                break
                        if handle.finished_work:
                            break
                        if not state.output.message.tool_calls:
                            session = await client.wait_update()
                            state.messages.append(ChatMessageUser(content="Clock update. Inspect your apps if needed. " + json.dumps(public_clock(session))))
                if client.final_result is None:
                    if state.completed:
                        state.metadata["sonata_termination"] = "inspect_limit_or_completion"
                        await interrupt(state, "aborted", "Inspect stopped the agent before world completion")
                    else:
                        await client.wait_ended()
                state.completed = True
                return state
            except BaseException as exc:
                budget = isinstance(exc, LimitExceededError)
                state.metadata["sonata_termination"] = "declared_budget_exhausted" if budget else ("cancelled" if isinstance(exc, asyncio.CancelledError) else "execution_error")
                await interrupt(state, "aborted" if budget or isinstance(exc, asyncio.CancelledError) else "failed", f"Inspect {state.metadata['sonata_termination']}: {type(exc).__name__}")
                raise
        return solve

    @scorer(metrics=[])
    def existing_assessment():
        async def score(state: TaskState, target: Target) -> Score:
            client = handle_for(state).client
            if client.final_result is None:
                # Solvers may be overridden. A scorer must never read mutable
                # live state or wait forever for an abandoned partial episode.
                await interrupt(state, "aborted", "Inspect solver returned before Sonata episode completion")
            if client.final_result is None:
                return Score(value="UNMEASURED", explanation="Session could not be finalized; see linked session and cleanup error.", metadata=state.metadata)
            return assessment(client.final_result, state.metadata.get("sonata", {}))
        return score

    async def cleanup(state: TaskState) -> None:
        handle = handles.get(key(state))
        if handle:
            await interrupt(state, "aborted", "Inspect sample cleanup before world completion")
            with anyio.CancelScope(shield=True):
                await handle.client.close()
            handles.pop(key(state), None)

    selected_timing = (session_launch or {}).get("timing", {"policy": timing_policy, "workUnitsPerTick": work_units_per_tick})
    action_clock = selected_timing.get("policy") == "provider-operations-v1"
    return Task(
        dataset=[Sample(id=episode_id, input="Complete the public assignment supplied by this Sonata environment.")],
        setup=setup_session(), solver=run_agent(), scorer=existing_assessment(), cleanup=cleanup,
        version=ADAPTER_VERSION, name="sonata_day", display_name="Sonata business day — Inspect pilot",
        time_limit=timeout_seconds, fail_on_error=True, score_on_error=False,
        metadata={
            "diagnostic_pilot": True, "episode_id": episode_id,
            "clock_policy": selected_timing["policy"], "compression": compression,
            "work_units_per_tick": selected_timing.get("workUnitsPerTick") if action_clock else None,
            "world_mode": "reactive" if director else "scripted", "judge_enabled": judge,
            "poll_seconds": poll_seconds, "max_agent_turns": max_turns,
            "memory_policy": memory_policy,
            "compaction": {"strategy": "Inspect CompactionTrim", "threshold": compaction_threshold, "preserve": 0.6, "memory": False} if memory_policy == "trim" else None,
            "daily_summary": False,
            "no_tool_response": "wait for visible notification or day end" if action_clock else "wait until next interval; periodic clock-only wake",
            "finish_work": "stop agent actions; allow world to reach natural end",
            "budget_exhaustion": "abort and report partial episode as unmeasured in this pilot",
            "isolation": "provided by target server; adapter does not provision a sandbox",
            "mcp_startup": "real execution budget only" if action_clock else "included in elapsed compressed wall time",
        },
    )
