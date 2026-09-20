import pytest
from inspect_ai.model import ChatMessageTool, ChatMessageUser

from sonata_inspect.smoke import previous_tool_result, resolve_arguments

REPLY = {"messages": [{"id": "1570404bf10c3d37", "threadId": "t1"}], "workbook": {"id": "w", "revision": 1}}


def test_prev_reference_keeps_json_types_and_ignores_other_strings():
    resolved = resolve_arguments({"messageId": "$prev.messages[0].id", "revision": "$prev.workbook.revision",
                                  "changes": [{"value": "$prev.workbook.id"}], "text": "$prevailing text"}, REPLY)
    assert resolved == {"messageId": "1570404bf10c3d37", "revision": 1, "changes": [{"value": "w"}], "text": "$prevailing text"}
    assert isinstance(resolved["revision"], int)  # a stringified revision would be rejected by the twin


def test_unresolvable_reference_names_path_and_available_keys():
    with pytest.raises(RuntimeError, match=r"\$prev\.thread.*available: messages, workbook"):
        resolve_arguments({"id": "$prev.thread"}, REPLY)
    with pytest.raises(RuntimeError, match=r"\$prev\.messages\[3\]"):
        resolve_arguments({"id": "$prev.messages[3].id"}, REPLY)


def test_reference_needs_a_json_tool_reply_and_reads_the_latest_one():
    with pytest.raises(RuntimeError, match="before any tool has replied"):
        previous_tool_result([ChatMessageUser(content="clock")])
    with pytest.raises(RuntimeError, match="not JSON"):
        previous_tool_result([ChatMessageTool(content="Work declared finished.", function="finish_work")])
    messages = [ChatMessageTool(content='{"stale": true}', function="a"), ChatMessageTool(content='{"fresh": 2}', function="b"),
                ChatMessageUser(content="clock")]
    assert previous_tool_result(messages) == {"fresh": 2}
