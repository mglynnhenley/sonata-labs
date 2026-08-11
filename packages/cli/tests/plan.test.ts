import { describe, expect, it } from "vitest";
import type { PortState } from "../src/diagnose";
import { planStart, planStop } from "../src/plan";

// `up` twice must not start two servers, and `down` must not stop a server
// somebody else is watching. Both properties live entirely in these two
// functions, so they are checked here against every state a port can be in.

const ctx = { label: "Gmail", port: 3101, startCommand: "sonata up gmail" };

const serving: PortState = { kind: "sonata", detail: "2 messages" };
const free: PortState = { kind: "free" };
const foreign: PortState = { kind: "foreign", detail: "answered 404 on /api/health" };
const broken: PortState = { kind: "sonata-broken", detail: "answered 500: no such table" };

describe("planStart", () => {
  it("starts nothing when the port is already serving Sonata", () => {
    expect(planStart(serving, null, ctx).action).toBe("reuse");
    expect(planStart(serving, 4242, ctx).action).toBe("reuse");
  });

  it("says so when the running one is not ours", () => {
    const plan = planStart(serving, null, ctx);
    expect(plan.action === "reuse" && plan.reason).toContain("started outside Sonata");
  });

  // Next's first compile takes seconds. A second `next dev` started in that
  // window dies on EADDRINUSE and takes the log with it.
  it("waits, rather than spawning again, while a process of ours is still booting", () => {
    expect(planStart(free, 4242, ctx).action).toBe("wait");
  });

  it("starts only when the port is free and nothing of ours is alive", () => {
    expect(planStart(free, null, ctx)).toEqual({ action: "start" });
  });

  it("refuses a port held by something that is not Sonata, and says how to free it", () => {
    const plan = planStart(foreign, null, ctx);
    expect(plan.action).toBe("refuse");
    expect(plan.action === "refuse" && plan.fix).toContain("lsof -ti tcp:3101");
  });

  it("refuses a clone that is up and answering errors, and sends it to doctor", () => {
    for (const pid of [null, 4242]) {
      const plan = planStart(broken, pid, ctx);
      expect(plan.action).toBe("refuse");
      expect(plan.action === "refuse" && plan.fix).toContain("sonata doctor");
    }
  });
});

describe("planStop", () => {
  it("stops what Sonata started", () => {
    expect(planStop(serving, 4242, ctx)).toEqual({ action: "stop", pid: 4242 });
  });

  it("does nothing to an already stopped app", () => {
    expect(planStop(free, null, ctx).action).toBe("nothing");
  });

  // Killing a dev server someone is watching in their own terminal would be a
  // surprise arriving from a different window.
  it("will not stop a server it did not start", () => {
    const plan = planStop(serving, null, ctx);
    expect(plan.action).toBe("cannot");
    expect(plan.action === "cannot" && plan.fix).toContain("Ctrl-C");
  });

  it("will not kill a stranger on the port either", () => {
    for (const state of [foreign, broken]) {
      const plan = planStop(state, null, ctx);
      expect(plan.action).toBe("cannot");
      expect(plan.action === "cannot" && plan.fix).toContain("lsof");
    }
  });
});
