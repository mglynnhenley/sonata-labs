import copy
import hashlib
import importlib
import json

import pytest

from sonata_inspect.client import SessionError
from sonata_inspect.task import mcp_for

adapter = importlib.import_module("sonata_inspect.task")


def launch(root, session_id="sess_fixture"):
    directory = root / ".context" / "workplaces" / session_id
    container = "sonata-" + hashlib.sha256(str(directory).encode()).hexdigest()[:16] + "-worker"
    return {"session": {"sessionId": session_id}, "connection": {
        "twins": ["gmail", "slack"],
        "urls": {"gmail": "http://sonata-gateway:8080/gmail", "slack": "http://sonata-gateway:8080/slack"},
        "token": "employee-secret", "credentialsPath": f"/api/sessions/{session_id}/connection",
        "execution": {"kind": "docker", "container": container},
        "gmailOAuth": {"accessToken": "access-secret", "refreshToken": "refresh-secret", "clientId": "sonata-harness"},
    }}


@pytest.fixture
def capture_launch(monkeypatch):
    calls = []

    def capture(**kwargs):
        calls.append(kwargs)
        return kwargs

    monkeypatch.setattr(adapter, "mcp_server_stdio", capture)
    return calls


def test_mcp_executes_only_in_owned_container_and_keeps_credentials_out_of_argv(tmp_path, capture_launch, monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "model-secret")
    monkeypatch.setenv("SANDBOX_CONTROL_TOKEN", "control-secret")
    monkeypatch.setenv("DOCKER_CONTEXT", "sonata-local")
    start = launch(tmp_path)
    config = mcp_for(start, tmp_path)
    assert config["command"] == "docker"
    assert config["args"] == [
        "exec", "--interactive", "--env", "SONATA_GMAIL_URL", "--env", "SONATA_SLACK_URL",
        "--env", "SONATA_TOKEN", "--env", "SONATA_GMAIL_OAUTH",
        start["connection"]["execution"]["container"], "node", "/opt/sonata/mcp.mjs", "gmail", "slack",
    ]
    assert config["cwd"] == tmp_path
    assert config["env"]["SONATA_TOKEN"] == "employee-secret"
    assert config["env"]["SONATA_GMAIL_URL"] == "http://sonata-gateway:8080/gmail"
    assert json.loads(config["env"]["SONATA_GMAIL_OAUTH"])["refreshToken"] == "refresh-secret"
    assert config["env"]["DOCKER_CONTEXT"] == "sonata-local"
    assert "DOCKER_CONTEXT" not in config["args"]  # Docker CLI setting, never a container setting.
    assert "OPENROUTER_API_KEY" not in config["env"]
    assert "SANDBOX_CONTROL_TOKEN" not in config["env"]
    for secret in ["employee-secret", "access-secret", "refresh-secret", "model-secret", "control-secret"]:
        assert secret not in " ".join(config["args"])
    # There is no requirement for a host checkout of the MCP launcher anymore.
    assert not (tmp_path / "packages").exists()
    assert len(capture_launch) == 1


@pytest.mark.parametrize("execution", [None, {}, {"kind": "host", "container": "anything"},
    {"kind": "docker", "container": "other-run-worker"},
    {"kind": "docker", "container": "--privileged"}])
def test_missing_or_unowned_execution_fails_without_host_fallback(tmp_path, capture_launch, execution):
    start = launch(tmp_path)
    start["connection"]["execution"] = execution
    with pytest.raises(SessionError, match="owned Docker"):
        mcp_for(start, tmp_path)
    assert capture_launch == []


def test_other_repository_or_session_container_cannot_be_adopted(tmp_path, capture_launch):
    start = launch(tmp_path)
    with pytest.raises(SessionError, match="owned Docker"):
        mcp_for(start, tmp_path / "another-repo")
    changed = copy.deepcopy(start)
    changed["session"]["sessionId"] = "sess_other"
    with pytest.raises(SessionError, match="owned Docker"):
        mcp_for(changed, tmp_path)
    assert capture_launch == []


@pytest.mark.parametrize("session_id", ["../sess_other", "/tmp/run", "sess/other", "", None])
def test_invalid_session_id_cannot_choose_a_container_path(tmp_path, capture_launch, session_id):
    start = launch(tmp_path)
    start["session"]["sessionId"] = session_id
    with pytest.raises(SessionError, match="valid workplace"):
        mcp_for(start, tmp_path)
    assert capture_launch == []


@pytest.mark.parametrize("change", [
    {"twins": ["slack", "--privileged"]}, {"twins": ["slack", "slack"]}, {"twins": "slack"},
    {"urls": {"gmail": "http://sonata-gateway:8080/gmail"}}, {"token": None}, {"gmailOAuth": None},
])
def test_incomplete_connection_is_rejected_before_docker_launch(tmp_path, capture_launch, change):
    start = launch(tmp_path)
    start["connection"].update(change)
    with pytest.raises(SessionError):
        mcp_for(start, tmp_path)
    assert capture_launch == []
