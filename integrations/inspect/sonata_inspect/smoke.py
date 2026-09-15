"""Run explicit tool calls through real Inspect/MCP, without a language model.

This is a wiring test, never a benchmark performance result. The target Sonata
server still runs the real session engine and existing deterministic assessment.
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

from inspect_ai import eval
from inspect_ai.model import ChatCompletionChoice, ChatMessageAssistant, ModelOutput, get_model
from inspect_ai.tool import ToolCall

from .task import sonata_day


PREV_REF = re.compile(r"^\$prev(?=$|[.\[])")
PATH_SEGMENT = re.compile(r"\.([A-Za-z0-9_-]+)|\[(\d+)\]")


def previous_tool_result(messages: list[Any]) -> Any:
    """The parsed JSON of the most recent tool reply, or a clear failure."""
    for message in reversed(messages):
        if getattr(message, "role", None) != "tool":
            continue
        if getattr(message, "error", None) is not None:
            raise RuntimeError(f"Fixture references $prev but the previous tool call failed: {message.error.message}")
        try:
            return json.loads(message.text)
        except ValueError as exc:
            raise RuntimeError(f"Fixture references $prev but the previous tool result is not JSON: {message.text[:120]!r}") from exc
    raise RuntimeError("Fixture references $prev before any tool has replied")


def resolve_reference(reference: str, previous: Any) -> Any:
    """Walk a "$prev.key[0].key" path; the JSON type of the leaf is preserved."""
    path = reference[len("$prev"):]
    position = 0
    current = previous
    while position < len(path):
        match = PATH_SEGMENT.match(path, position)
        if not match:
            raise RuntimeError(f"Fixture reference {reference!r} has an unparseable path at {path[position:]!r}")
        key, index = match.group(1), match.group(2)
        try:
            current = current[key] if key is not None else current[int(index)]
        except (KeyError, IndexError, TypeError):
            available = ", ".join(sorted(map(str, current))) if isinstance(current, dict) else f"a {type(current).__name__}"
            raise RuntimeError(
                f"Fixture reference {reference!r} could not be resolved at {reference[:len('$prev') + match.end()]!r}; "
                f"available: {available}"
            ) from None
        position = match.end()
    return current


def resolve_arguments(value: Any, previous: Any) -> Any:
    if isinstance(value, str) and PREV_REF.match(value):
        return resolve_reference(value, previous)
    if isinstance(value, dict):
        return {k: resolve_arguments(v, previous) for k, v in value.items()}
    if isinstance(value, list):
        return [resolve_arguments(v, previous) for v in value]
    return value


def references_previous(value: Any) -> bool:
    if isinstance(value, str):
        return bool(PREV_REF.match(value))
    if isinstance(value, dict):
        return any(references_previous(v) for v in value.values())
    if isinstance(value, list):
        return any(references_previous(v) for v in value)
    return False


def scripted_model(actions: list[dict]):
    """A fixture player, not an agent: it only substitutes explicit "$prev" paths.

    Ids the world assigns at runtime (an injected email's message id, a workbook
    revision) cannot be hard-coded, so a string argument of the form
    "$prev.<path>" is read from the JSON of the most recent tool reply. Nothing
    else is inferred, and a dangling reference fails loudly rather than guessing.
    """
    if not all(isinstance(a, dict) and isinstance(a.get("tool"), str) and isinstance(a.get("arguments", {}), dict) for a in actions):
        raise ValueError("Each scripted action needs a tool name and an arguments object")
    sequence = [*actions, {"tool": "finish_work", "arguments": {}}]
    position = 0

    def output(messages, tools, choice, config):
        nonlocal position
        if position >= len(sequence):
            raise RuntimeError("Scripted fixture exhausted; it is not an autonomous agent")
        action = sequence[position]
        position += 1
        available = {t.name for t in tools}
        if action["tool"] not in available:
            raise RuntimeError(f"Fixture tool {action['tool']} not available; tools: {', '.join(sorted(available))}")
        arguments = action.get("arguments", {})
        if references_previous(arguments):
            arguments = resolve_arguments(arguments, previous_tool_result(messages))
        return ModelOutput(model="mockllm/model", choices=[ChatCompletionChoice(
            message=ChatMessageAssistant(content="Scripted wiring-test action", tool_calls=[ToolCall(
                id=f"fixture-{position}", function=action["tool"], arguments=arguments,
            )]), stop_reason="tool_calls",
        )])
    return get_model("mockllm/model", custom_outputs=output)


FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
KNOWN_SUCCESS_FIXTURE = FIXTURES / "tax-workbook-known-success.json"


def load_actions(path: Path) -> list[dict]:
    actions = json.loads(path.read_text())
    if not isinstance(actions, list):
        raise ValueError(f"{path}: actions must be a JSON list")
    return actions


def run_scripted(*, platform_url: str, episode_id: str, actions: list[dict], compression: float = 60,
                 ticks: int | None = None, repo_root: str = "", seed_world: bool = False,
                 log_dir: str = ".context/inspect-logs", director: bool = False,
                 timing_policy: str = "compressed-wall-time", work_units_per_tick: int = 12):
    """One scripted sample; opting into the real director incurs model costs."""
    return eval(
        sonata_day(platform_url=platform_url, episode_id=episode_id,
                   compression=compression, ticks=ticks, repo_root=repo_root,
                   timing_policy=timing_policy, work_units_per_tick=work_units_per_tick,
                   seed_world=seed_world, director=director, judge=False,
                   agent_label="SCRIPTED WIRING TEST (no agent model)", max_turns=len(actions) + 2),
        model=scripted_model(actions), log_dir=log_dir, max_samples=1, retry_on_error=0,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform-url", required=True)
    parser.add_argument("--episode-id", required=True)
    parser.add_argument("--actions", required=True, type=Path, help="JSON list of explicit {tool, arguments} fixture actions")
    parser.add_argument("--compression", type=float, default=60)
    parser.add_argument("--ticks", type=int)
    parser.add_argument("--timing-policy", choices=["compressed-wall-time", "provider-operations-v1"], default="compressed-wall-time")
    parser.add_argument("--work-units-per-tick", type=int, default=12)
    parser.add_argument("--repo-root", default="")
    parser.add_argument("--log-dir", default=".context/inspect-logs")
    parser.add_argument("--seed-world", action="store_true", help="Reset/reseed the intended environment before the session")
    parser.add_argument("--director", action="store_true", help="Enable real colleague model calls (paid); price the pilot first")
    args = parser.parse_args()
    try:
        actions = load_actions(args.actions)
    except (OSError, ValueError) as exc:
        parser.error(str(exc))
    logs = run_scripted(platform_url=args.platform_url, episode_id=args.episode_id, actions=actions,
                        compression=args.compression, ticks=args.ticks, repo_root=args.repo_root,
                        seed_world=args.seed_world, log_dir=args.log_dir, director=args.director,
                        timing_policy=args.timing_policy, work_units_per_tick=args.work_units_per_tick)
    for log in logs:
        print(json.dumps({"status": log.status, "log": log.location,
                          "sessions": [(s.metadata or {}).get("sonata") for s in log.samples or []]}))
    if any(log.status != "success" for log in logs):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
