from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from sonata_inspect.client import SessionClient, SessionError
from sonata_inspect.worker import export_log


def test_attach_reuses_the_created_session_without_a_second_post():
    client = SessionClient("http://localhost:3000")
    launch = {"session": {"sessionId": "run-product"}, "agentBrief": "Public assignment"}
    assert client.attach(launch) is launch
    assert client.session_id == "run-product"
    assert client.start_response is launch
    with pytest.raises(SessionError, match="already owns"):
        client.attach(launch)


@pytest.mark.parametrize("price", [None, 0, 0.123])
def test_export_retains_raw_calls_and_never_invents_a_provider_price(price):
    response = {"usage": {"prompt_tokens": 42, "completion_tokens": 8, "cost": price}}
    event = SimpleNamespace(event="model", call=SimpleNamespace(response=response, request={"model": "x"}, time=0.5),
                            timestamp=datetime.now(timezone.utc), model="openrouter/vendor/model", error=None)
    sample = SimpleNamespace(events=[event], messages=[SimpleNamespace(role="assistant", text="Done")])
    log = SimpleNamespace(samples=[sample], location="test.eval", status="success", error=None)
    output = export_log(log, "run-product")
    call = output["llmCalls"][0]
    assert call["response"] is response
    assert call["role"] == "agent"
    assert call["model"] == "vendor/model"
    assert call["tokens"] == {"prompt": 42, "completion": 8}
    if price is None:
        assert "costUsd" not in call
    else:
        assert call["costUsd"] == price
    assert output["agentSummary"] == "Done"
