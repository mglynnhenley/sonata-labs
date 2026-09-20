"""Lifecycle transport only. No business clock, scenario rules or grading here."""
from __future__ import annotations

import asyncio
import time
from typing import Any, Literal
from urllib.parse import quote

import httpx

TERMINAL = {"done", "failed", "aborted"}


class SessionError(RuntimeError):
    """The environment could not supply a complete, linked episode."""


def settled(session: dict[str, Any]) -> bool:
    # status=done can precede judge/artifact flush. Both conditions are required.
    return session.get("status") in TERMINAL and session.get("live") is False


def public_clock(session: dict[str, Any]) -> dict[str, Any]:
    """Allowlist; polling includes hidden ticks and grading information."""
    return {
        "status": session.get("status"),
        "simTimeISO": session.get("simTimeISO"),
        "completedIntervals": session.get("tick"),
        "plannedIntervals": session.get("plannedTicks"),
        "dayEnded": session.get("status") in TERMINAL,
    }


class SessionClient:
    def __init__(self, base_url: str, *, transport: httpx.AsyncBaseTransport | None = None,
                 poll_seconds: float = 0.5, timeout_seconds: float = 1800):
        self.base_url = base_url.rstrip("/")
        self.http = httpx.AsyncClient(base_url=self.base_url, timeout=120, transport=transport)
        self.poll_seconds = poll_seconds
        self.timeout_seconds = timeout_seconds
        self.session_id: str | None = None
        self.start_response: dict[str, Any] | None = None
        self.latest: dict[str, Any] | None = None
        self.final_result: dict[str, Any] | None = None
        self.notification_sequence = 0

    async def _request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        response = await self.http.request(method, path, **kwargs)
        try:
            payload = response.json()
        except ValueError as exc:
            raise SessionError(f"Sonata returned non-JSON ({response.status_code})") from exc
        if response.is_error:
            raise SessionError(f"Sonata {method} {path}: {response.status_code}: {payload.get('error', 'request failed')}")
        if not isinstance(payload, dict):
            raise SessionError("Sonata returned an invalid response object")
        return payload

    @property
    def path(self) -> str:
        if not self.session_id:
            raise SessionError("Session has not been created")
        return f"/api/sessions/{quote(self.session_id, safe='')}"

    def _remember(self, payload: dict[str, Any]) -> dict[str, Any]:
        session = payload.get("session")
        if not isinstance(session, dict) or not isinstance(session.get("sessionId"), str):
            raise SessionError("Sonata did not return a session identifier")
        if self.session_id and session["sessionId"] != self.session_id:
            raise SessionError("Sonata response changed the session identifier")
        self.session_id = session["sessionId"]
        self.latest = session
        return session

    async def start(self, request: dict[str, Any]) -> dict[str, Any]:
        if self.session_id:
            raise SessionError("This client already owns a session")
        # Caller shields setup cancellation: once POST succeeds, retain its ID
        # before any subsequent await. Never retry POST and start a second world.
        payload = await self._request("POST", "/api/sessions", json=request)
        self._remember(payload)
        self.start_response = payload
        return payload

    def attach(self, launch: dict[str, Any]) -> dict[str, Any]:
        """Adopt the one session already created by the product launcher."""
        if self.session_id:
            raise SessionError("This client already owns a session")
        self._remember(launch)
        self.start_response = launch
        return launch

    async def poll(self) -> dict[str, Any]:
        payload = await self._request("GET", self.path, params={"sinceTick": self.latest.get("tick", 0) if self.latest else 0})
        return self._remember(payload)

    async def wait_ready(self) -> dict[str, Any]:
        session = await self._until(lambda s: (s.get("status") == "running" and s.get("tick", 0) > 0) or settled(s))
        connection = (self.start_response or {}).get("connection") or {}
        if not settled(session) and connection.get("credentialsPath"):
            if connection["credentialsPath"] != self.path + "/connection" or not connection.get("token"):
                raise SessionError("Invalid session credential handoff")
            payload = await self._request("GET", connection["credentialsPath"],
                                          headers={"Authorization": "Bearer " + connection["token"]})
            credentials = payload.get("connection")
            if (not isinstance(credentials, dict) or credentials.get("token") != connection["token"]
                    or credentials.get("urls") != connection.get("urls")
                    or credentials.get("twins") != connection.get("twins")
                    or credentials.get("execution") != connection.get("execution")):
                raise SessionError("Provider credentials do not match this workplace")
            self.start_response["connection"] = credentials
        return session

    @property
    def action_timing(self) -> bool:
        return (self.start_response or {}).get("timing", {}).get("policy") == "provider-operations-v1"

    async def _clock(self, body: dict[str, Any]) -> dict[str, Any]:
        token = (self.start_response or {}).get("connection", {}).get("token")
        if not token:
            raise SessionError("Clock control needs this workplace's provider credential")
        payload = await self._request("POST", self.path + "/clock", json=body,
                                      headers={"Authorization": "Bearer " + token})
        session = self._remember(payload)
        self.notification_sequence = payload.get("wake", {}).get("notificationSequence", self.notification_sequence)
        return session

    async def finish_work(self) -> None:
        if self.action_timing and (self.latest or {}).get("status") not in TERMINAL:
            await self._clock({"action": "finish"})

    async def wait_update(self, until_tick: int | None = None) -> dict[str, Any]:
        if self.action_timing:
            return await self._clock({"action": "wait", "afterNotification": self.notification_sequence,
                                      **({"untilTick": until_tick} if until_tick is not None else {})})
        previous = (self.latest or {}).get("tick", -1)
        return await self._until(lambda s: s.get("tick", -1) > previous or s.get("status") in TERMINAL)

    async def wait_ended(self) -> dict[str, Any]:
        await self._until(settled)
        return await self.result()

    async def _until(self, predicate: Any) -> dict[str, Any]:
        deadline = time.monotonic() + self.timeout_seconds
        while True:
            session = await self.poll()
            if predicate(session):
                return session
            if time.monotonic() >= deadline:
                raise SessionError("Timed out waiting for Sonata; the episode is not complete")
            await asyncio.sleep(self.poll_seconds)

    async def result(self) -> dict[str, Any]:
        payload = await self._request("GET", self.path + "/result")
        session = self._remember(payload)
        if not settled(session):
            raise SessionError("Sonata returned an assessment before finalization")
        run = payload.get("run")
        if run is not None and run.get("runId") != self.session_id:
            raise SessionError("Assessment is linked to a different session")
        self.final_result = payload
        return payload

    async def finalize(self, *, status: Literal["aborted", "failed"], reason: str) -> dict[str, Any]:
        if self.final_result is not None:
            return self.final_result
        payload = await self._request("POST", self.path + "/finalize", json={"status": status, "reason": reason})
        self._remember(payload)
        return await self.wait_ended()

    async def close(self) -> None:
        await self.http.aclose()
