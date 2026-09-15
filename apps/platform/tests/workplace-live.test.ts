import { expect, it } from "vitest";
import { prepareWorkplace, type Workplace } from "../src/lib/engine/workplace";
import { injectWorld, TEMPLATES } from "@sonata/world";
import { createSlackAdapter, createTwinHttp, slackTools } from "@sonata/engine";

// No model calls and no shared-app reset. Explicitly enabled because this
// provisions four real app containers and exercises their actual HTTP routes.
it.runIf(process.env.SONATA_ISOLATION_LIVE === "1")("keeps concurrent workplace writes, resets and audits separate", async () => {
  const workplaces: Workplace[] = [];
  try {
    for (const suffix of ["a", "b"]) {
      const w = await prepareWorkplace(`test-isolation-${suffix}-${Date.now()}`, ["slack", "excel"], false);
      workplaces.push(w);
      await w.start(new AbortController().signal);
      const seed = await injectWorld(TEMPLATES[0], { twins: ["slack", "excel"], baseUrls: w.urls, token: w.controlToken, promoteToSnapshot: true });
      expect(seed.ok).toBe(true);
    }
    const [a, b] = workplaces;
    const baselines = workplaces.map(w => w.snapshotHashes());
    expect(a.urls.slack).not.toBe(b.urls.slack);
    const tool = slackTools(createTwinHttp("slack", { baseUrl: a.urls.slack!, token: a.agentToken })).find(t => t.name === "send_message")!;
    await tool.run({ channel: "reporting-ops", text: "Only workplace A has this message" });
    for (const twin of ["slack", "excel"] as const) {
      for (const token of [a.agentToken, b.controlToken, "sandbox-token"]) {
        const response = await fetch(`${a.urls[twin]}/api/sandbox/reset`, {
          method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}",
        });
        expect(response.status).toBe(401);
      }
    }
    const aa = createSlackAdapter({ baseUrl: a.urls.slack, token: a.agentToken, controlToken: a.controlToken });
    const bb = createSlackAdapter({ baseUrl: b.urls.slack, token: b.agentToken, controlToken: b.controlToken });
    expect(JSON.stringify(await bb.snapshot())).not.toContain("Only workplace A");
    await bb.reset();
    expect(JSON.stringify(await aa.snapshot())).toContain("Only workplace A");
    expect(await bb.auditSince(0)).toEqual([]);
    expect((await aa.auditSince(0)).some(row => row.summary.includes("Only workplace A"))).toBe(true);
    expect(workplaces.map(w => w.snapshotHashes())).toEqual(baselines);
    await a.stop();
    await expect(fetch(`${a.urls.slack}/api/health`)).rejects.toThrow();
    expect((await fetch(`${b.urls.slack}/api/health`)).ok).toBe(true);
    expect(await bb.auditSince(0)).toEqual([]);
  } finally { await Promise.all(workplaces.map(w => w.stop())); }
  for (const w of workplaces) {
    await expect(fetch(`${w.urls.slack}/api/health`)).rejects.toThrow();
  }
}, 180_000);
