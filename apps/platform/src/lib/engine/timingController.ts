import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { Session } from "@sonata/engine/session";

interface ControlAddress { url: string; token: string }
interface GatewayEvent {
  kind: "request" | "completion";
  actionId: string;
  operation?: string;
  workUnits?: number;
}

/** Trusted host bridge. Requests remain frozen in the gateway until admitted,
 * and responses remain there until the engine has captured their audit rows. */
export function startTimingController(options: {
  control: ControlAddress;
  session: Session;
  ledgerPath: string;
  onFailure: (error: Error) => void;
}) {
  const abort = new AbortController();
  const admitted = new Set<string>();
  let failure: Error | undefined;
  let closing: Promise<void> | undefined;
  let stopped = false;

  async function request(path: string, body?: unknown) {
    const response = await fetch(`${options.control.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${options.control.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(path === "/close" ? 135_000 : 125_000)]),
    });
    if (!response.ok) throw new Error(`Timing controller ${path} failed (${response.status}).`);
    return response.status === 204 ? null : await response.json();
  }

  const pump = (async () => {
    while (!stopped) {
      const event = await request("/next") as GatewayEvent | { kind: "closed"; fault?: string } | null;
      if (!event) continue;
      if (event.kind === "closed") {
        if (event.fault) throw new Error(`Timing gateway closed with missing evidence: ${event.fault}`);
        if (!closing) throw new Error("Timing gateway closed before the engine ended admission.");
        return;
      }
      if (typeof event.actionId !== "string" || !["request", "completion"].includes(event.kind)) {
        throw new Error("Invalid timing gateway event.");
      }
      appendFileSync(options.ledgerPath, JSON.stringify({ ...event, recordedAt: Date.now() }) + "\n", { mode: 0o600 });
      if (event.kind === "request") {
        if (!Number.isSafeInteger(event.workUnits) || event.workUnits! < 0 || typeof event.operation !== "string") {
          throw new Error("Invalid timing gateway work charge.");
        }
        // OAuth refresh is bounded transport maintenance. All business
        // operations, including reads, have positive gateway-owned charges.
        const decision = event.workUnits === 0
          ? { accepted: !closing && options.session.status().status === "running" }
          : await options.session.beginAction({ actionId: event.actionId, workUnits: event.workUnits!, operation: event.operation });
        if (decision.accepted && event.workUnits !== 0) admitted.add(event.actionId);
        await request("/decision", { actionId: event.actionId, accepted: decision.accepted });
      } else {
        if (admitted.delete(event.actionId)) await options.session.completeAction(event.actionId);
        await request("/ack", { actionId: event.actionId });
      }
    }
  })().catch((error: unknown) => {
    if (stopped) return;
    failure = error instanceof Error ? error : new Error(String(error));
    options.onFailure(failure);
  });

  return {
    close(): Promise<void> {
      // The pump stays alive through close: an admitted mutation must be
      // acknowledged before the gateway can certify that it has drained.
      return closing ??= (async () => {
        if (failure) throw failure;
        const deadline = Date.now() + 130_000;
        while (true) {
          const evidence = await request("/close", {});
          if (failure || evidence?.fault || !evidence?.closed) {
            throw failure ?? new Error(evidence?.fault ?? "Timing gateway did not close admission.");
          }
          if (evidence.drained) return;
          if (Date.now() >= deadline) throw new Error("Timing gateway did not confirm its final drain.");
          await delay(25, undefined, { signal: abort.signal });
        }
      })();
    },
    async stop() { stopped = true; abort.abort(); await pump; },
  };
}
