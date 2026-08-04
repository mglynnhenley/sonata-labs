// Part 3 of the acceptance harness: fault injection. Proves the sandbox can
// deliberately fail in the ways real Slack fails, and that the official SDK
// reacts the way it would in production.
//
// Imported by smoke-sdk.ts.

import { WebClient, ErrorCode, type CodedError } from "@slack/web-api";

interface Harness {
  client: WebClient;
  check: (name: string, cond: boolean, detail?: unknown) => void;
}

const ROOT_URL =
  process.env.SANDBOX_ROOT_URL || `http://localhost:${process.env.PORT || "3200"}`;
const TOKEN = process.env.SANDBOX_TOKEN || "sandbox-token";

const chaosOff = () => fetch(`${ROOT_URL}/api/sandbox/chaos`, { method: "DELETE" });
const chaosSet = (body: unknown) =>
  fetch(`${ROOT_URL}/api/sandbox/chaos`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

export async function part3Chaos({ client, check }: Harness): Promise<void> {
  console.log("\n\x1b[1mPart 3 — Fault injection\x1b[0m");

  const noRetry = new WebClient(TOKEN, {
    slackApiUrl: `${ROOT_URL}/api/`,
    retryConfig: { retries: 0 },
  });

  try {
    // --- baseline: chaos off changes nothing ---
    await chaosOff();
    const clean = await client.auth.test();
    check("chaos disabled → calls succeed normally", clean.ok === true);

    // --- scoped outage ---
    await chaosSet({ enabled: true, failures: { "chat.postMessage": "is_archived" } });
    let outageCode: string | undefined;
    try {
      await noRetry.chat.postMessage({ channel: "C0ENGINEER1", text: "should fail" });
    } catch (e) {
      outageCode = (e as CodedError & { data?: { error?: string } }).data?.error;
    }
    check("scoped outage: chat.postMessage → is_archived", outageCode === "is_archived", outageCode);
    const unaffected = await noRetry.conversations.history({ channel: "C0ENGINEER1", limit: 1 });
    check("scoped outage leaves other methods working", unaffected.ok === true);

    // The failure must be real — nothing should have been written.
    const histAfter = await noRetry.conversations.history({ channel: "C0ENGINEER1", limit: 5 });
    check(
      "injected failure did NOT write a message",
      !((histAfter.messages ?? []) as Array<{ text?: string }>).some((m) =>
        m.text?.includes("should fail"),
      ),
    );

    // --- transient errors ---
    await chaosOff();
    await chaosSet({ enabled: true, errorRate: 1, errorCode: "service_unavailable" });
    let transient: CodedError & { data?: { error?: string } } | undefined;
    try {
      await noRetry.users.list({ limit: 1 });
    } catch (e) {
      transient = e as CodedError & { data?: { error?: string } };
    }
    check(
      "errorRate=1 → SDK throws a PlatformError with our code",
      transient?.code === ErrorCode.PlatformError &&
        transient?.data?.error === "service_unavailable",
      { code: transient?.code, error: transient?.data?.error },
    );

    // --- determinism ---
    const sequence = async (seed: number) => {
      await chaosOff();
      await chaosSet({ enabled: true, errorRate: 0.5, seed });
      const out: boolean[] = [];
      for (let i = 0; i < 12; i++) {
        try {
          await noRetry.users.list({ limit: 1 });
          out.push(false);
        } catch {
          out.push(true);
        }
      }
      return out.join("");
    };
    const runA = await sequence(1234);
    const runB = await sequence(1234);
    const runC = await sequence(4321);
    check("same seed → identical fault sequence (reproducible runs)", runA === runB, {
      runA,
      runB,
    });
    check("different seed → different sequence", runA !== runC, { runA, runC });

    // --- rate limiting: the wire shape ---
    await chaosOff();
    await chaosSet({
      enabled: true,
      rateLimit: { enabled: true, capacity: 1, windowSec: 60, retryAfterSec: 3 },
    });
    await fetch(`${ROOT_URL}/api/users.list`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    }); // consume the single token
    const raw = await fetch(`${ROOT_URL}/api/users.list`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    check("rate limit returns HTTP 429 (the one status Slack uses)", raw.status === 429, raw.status);
    check("rate limit sets Retry-After", raw.headers.get("retry-after") === "3");
    const body = (await raw.json()) as { ok: boolean; error: string };
    check(
      "rate limit body is {ok:false, error:'ratelimited'}",
      body.ok === false && body.error === "ratelimited",
      body,
    );

    // --- rate limiting: the SDK recovers when it is allowed to retry ---
    await chaosOff();
    await chaosSet({
      enabled: true,
      rateLimit: { enabled: true, capacity: 1, windowSec: 2, retryAfterSec: 1 },
    });
    const retrying = new WebClient(TOKEN, {
      slackApiUrl: `${ROOT_URL}/api/`,
      retryConfig: { retries: 3 },
    });
    await retrying.users.list({ limit: 1 });
    const recovered = await retrying.users.list({ limit: 1 });
    check("SDK transparently recovers from 429 when retries are enabled", recovered.ok === true);

    // --- per-tier budgets ---
    await chaosOff();
    await chaosSet({
      enabled: true,
      rateLimit: { enabled: true, capacity: 1, windowSec: 60, retryAfterSec: 1 },
    });
    await noRetry.chat.getPermalink({ channel: "C0ENGINEER1", message_ts: "1.0" }).catch(() => {});
    const otherTier = await fetch(`${ROOT_URL}/api/conversations.list`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    check("rate limit budgets are per method family", otherTier.status === 200, otherTier.status);

    // --- latency ---
    await chaosOff();
    await chaosSet({ enabled: true, latencyMs: 300 });
    const t0 = Date.now();
    await noRetry.auth.test();
    const elapsed = Date.now() - t0;
    check("latency injection delays calls", elapsed >= 300, `${elapsed}ms`);

    // --- the control surface reports what it injected ---
    const status = (await fetch(`${ROOT_URL}/api/sandbox/chaos`).then((r) => r.json())) as {
      config: { enabled: boolean };
      faults: Array<{ method: string; kind: string }>;
    };
    check("chaos endpoint reports enabled state", status.config.enabled === true);
    check("chaos endpoint logs injected faults", status.faults.length > 0, status.faults.length);
  } finally {
    // Never leave the sandbox in a chaotic state — later runs depend on it.
    await chaosOff();
  }

  const after = await client.auth.test();
  check("chaos reset restores normal operation", after.ok === true);
}
