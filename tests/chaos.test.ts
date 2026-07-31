import { describe, it, expect, beforeEach } from "vitest";
import { evaluateChaos, setChaos, resetChaos, getChaos, recentFaults } from "@/lib/slack/chaos";

beforeEach(() => resetChaos());

describe("fault injection", () => {
  it("is inert when disabled", () => {
    for (let i = 0; i < 50; i++) {
      expect(evaluateChaos("chat.postMessage")).toEqual({ delayMs: 0 });
    }
    expect(recentFaults()).toHaveLength(0);
  });

  it("enabling with no faults configured still passes calls through", () => {
    setChaos({ enabled: true });
    expect(evaluateChaos("chat.postMessage")).toEqual({ delayMs: 0 });
  });

  it("scoped outages fail one method deterministically and leave others alone", () => {
    setChaos({ enabled: true, failures: { "chat.postMessage": "is_archived" } });
    for (let i = 0; i < 5; i++) {
      expect(evaluateChaos("chat.postMessage").error?.code).toBe("is_archived");
    }
    expect(evaluateChaos("conversations.history").error).toBeUndefined();
  });

  it("errorRate=1 fails every call with the configured code", () => {
    setChaos({ enabled: true, errorRate: 1, errorCode: "service_unavailable" });
    for (let i = 0; i < 10; i++) {
      expect(evaluateChaos("users.list").error?.code).toBe("service_unavailable");
    }
  });

  it("is reproducible: same seed → same fault sequence", () => {
    const run = () => {
      resetChaos();
      setChaos({ enabled: true, errorRate: 0.5, seed: 42 });
      return Array.from({ length: 30 }, () => !!evaluateChaos("users.list").error);
    };
    expect(run()).toEqual(run());
  });

  it("different seeds produce different sequences", () => {
    const run = (seed: number) => {
      resetChaos();
      setChaos({ enabled: true, errorRate: 0.5, seed });
      return Array.from({ length: 30 }, () => !!evaluateChaos("users.list").error).join("");
    };
    expect(run(1)).not.toEqual(run(999));
  });

  it("errorRate is approximately honored", () => {
    setChaos({ enabled: true, errorRate: 0.3, seed: 7 });
    const n = 2000;
    let failures = 0;
    for (let i = 0; i < n; i++) if (evaluateChaos("users.list").error) failures++;
    expect(failures / n).toBeGreaterThan(0.2);
    expect(failures / n).toBeLessThan(0.4);
  });

  it("rate limits after capacity, with retry-after", () => {
    setChaos({
      enabled: true,
      rateLimit: { enabled: true, capacity: 3, windowSec: 60, retryAfterSec: 12 },
    });
    const now = 1_000_000;
    for (let i = 0; i < 3; i++) {
      expect(evaluateChaos("chat.postMessage", now).error).toBeUndefined();
    }
    const limited = evaluateChaos("chat.postMessage", now);
    expect(limited.error).toMatchObject({
      code: "ratelimited",
      rateLimited: true,
      retryAfterSec: 12,
    });
  });

  it("rate limit buckets are per method family", () => {
    setChaos({
      enabled: true,
      rateLimit: { enabled: true, capacity: 2, windowSec: 60, retryAfterSec: 5 },
    });
    const now = 2_000_000;
    evaluateChaos("chat.postMessage", now);
    evaluateChaos("chat.update", now);
    // chat.* is exhausted...
    expect(evaluateChaos("chat.delete", now).error?.code).toBe("ratelimited");
    // ...but conversations.* has its own budget.
    expect(evaluateChaos("conversations.history", now).error).toBeUndefined();
  });

  it("rate limit window refills", () => {
    setChaos({
      enabled: true,
      rateLimit: { enabled: true, capacity: 1, windowSec: 60, retryAfterSec: 5 },
    });
    const t0 = 3_000_000;
    expect(evaluateChaos("chat.postMessage", t0).error).toBeUndefined();
    expect(evaluateChaos("chat.postMessage", t0).error?.code).toBe("ratelimited");
    // one window later
    expect(evaluateChaos("chat.postMessage", t0 + 60_001).error).toBeUndefined();
  });

  it("adds latency with bounded jitter", () => {
    setChaos({ enabled: true, latencyMs: 100, jitterMs: 50, seed: 3 });
    for (let i = 0; i < 25; i++) {
      const { delayMs } = evaluateChaos("users.list");
      expect(delayMs).toBeGreaterThanOrEqual(100);
      expect(delayMs).toBeLessThan(150);
    }
  });

  it("records what it injected", () => {
    setChaos({ enabled: true, failures: { "chat.delete": "message_not_found" } });
    evaluateChaos("chat.delete");
    const faults = recentFaults();
    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatchObject({
      method: "chat.delete",
      kind: "outage",
      detail: "message_not_found",
    });
  });

  it("reset clears config and log", () => {
    setChaos({ enabled: true, errorRate: 1 });
    evaluateChaos("users.list");
    expect(recentFaults().length).toBeGreaterThan(0);
    resetChaos();
    expect(getChaos().enabled).toBe(false);
    expect(recentFaults()).toHaveLength(0);
  });
});
