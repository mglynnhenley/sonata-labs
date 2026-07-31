"use client";

import { useEffect, useState } from "react";

// Fault-injection controls. Lives beside the activity feed because the two are
// read together: turn a fault on, watch how the agent copes.

export interface ChaosConfig {
  enabled: boolean;
  latencyMs: number;
  jitterMs: number;
  errorRate: number;
  errorCode: string;
  failures: Record<string, string>;
  rateLimit: { enabled: boolean; capacity: number; windowSec: number; retryAfterSec: number };
  seed: number;
}

export interface InjectedFault {
  ts: number;
  method: string;
  kind: "error" | "ratelimited" | "outage" | "latency";
  detail: string;
}

const KIND_TINT: Record<InjectedFault["kind"], string> = {
  error: "bg-[#e01e5a]",
  ratelimited: "bg-[#ecb22e]",
  outage: "bg-[#7c3aed]",
  latency: "bg-[#616061]",
};

// Presets are the point: one click puts the sandbox in a named failure mode.
const PRESETS: Array<{ label: string; hint: string; patch: Partial<ChaosConfig> }> = [
  {
    label: "Aggressive rate limit",
    hint: "5 calls / 60s per method family, Retry-After 5s",
    patch: {
      enabled: true,
      errorRate: 0,
      failures: {},
      rateLimit: { enabled: true, capacity: 5, windowSec: 60, retryAfterSec: 5 },
    },
  },
  {
    label: "Flaky (20% errors)",
    hint: "1 in 5 calls fails with service_unavailable",
    patch: {
      enabled: true,
      errorRate: 0.2,
      errorCode: "service_unavailable",
      failures: {},
      rateLimit: { enabled: false, capacity: 50, windowSec: 60, retryAfterSec: 30 },
    },
  },
  {
    label: "Slow network",
    hint: "600ms + up to 400ms jitter on every call",
    patch: { enabled: true, latencyMs: 600, jitterMs: 400, errorRate: 0, failures: {} },
  },
  {
    label: "Posting is down",
    hint: "chat.postMessage always fails; reads still work",
    patch: {
      enabled: true,
      errorRate: 0,
      failures: { "chat.postMessage": "service_unavailable" },
      rateLimit: { enabled: false, capacity: 50, windowSec: 60, retryAfterSec: 30 },
    },
  },
  {
    label: "Expired token",
    hint: "every method reports token_revoked",
    patch: {
      enabled: true,
      errorRate: 1,
      errorCode: "token_revoked",
      failures: {},
      rateLimit: { enabled: false, capacity: 50, windowSec: 60, retryAfterSec: 30 },
    },
  },
];

export function ChaosPanel() {
  const [config, setConfig] = useState<ChaosConfig | null>(null);
  const [faults, setFaults] = useState<InjectedFault[]>([]);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const res = await fetch("/api/sandbox/chaos", { cache: "no-store" });
      const data = (await res.json()) as { config: ChaosConfig; faults: InjectedFault[] };
      setConfig(data.config);
      setFaults(data.faults);
    } catch {
      // server restarting — keep the last known state
    }
  };

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, []);

  const patch = async (body: Partial<ChaosConfig>) => {
    setBusy(true);
    await fetch("/api/sandbox/chaos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    await load();
    setBusy(false);
  };

  const clear = async () => {
    setBusy(true);
    await fetch("/api/sandbox/chaos", { method: "DELETE" });
    await load();
    setBusy(false);
  };

  if (!config) return null;

  const activeSummary = !config.enabled
    ? "off"
    : [
        config.rateLimit.enabled ? `rate limit ${config.rateLimit.capacity}/${config.rateLimit.windowSec}s` : null,
        config.errorRate > 0 ? `${Math.round(config.errorRate * 100)}% ${config.errorCode}` : null,
        config.latencyMs > 0 ? `+${config.latencyMs}ms` : null,
        Object.keys(config.failures).length ? `${Object.keys(config.failures).length} outage(s)` : null,
      ]
        .filter(Boolean)
        .join(" · ") || "enabled, no faults configured";

  return (
    <div className="border-t border-[#e8e8e8] bg-[#fbfbfb] px-5 py-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-[14px] font-black text-[#1d1c1d]">Fault injection</h3>
          <p className="text-[12px] text-[#616061]">
            A sandbox that never fails teaches false confidence.{" "}
            <span className={config.enabled ? "font-semibold text-[#e01e5a]" : ""}>
              {activeSummary}
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void patch({ enabled: !config.enabled })}
            disabled={busy}
            className={[
              "rounded-[4px] px-3 py-[5px] text-[13px] font-bold transition disabled:opacity-60",
              config.enabled
                ? "bg-[#e01e5a] text-white hover:bg-[#c4184c]"
                : "border border-[#c9c9c9] text-[#1d1c1d] hover:bg-[#f0f0f0]",
            ].join(" ")}
          >
            {config.enabled ? "Faults ON" : "Faults off"}
          </button>
          <button
            onClick={() => void clear()}
            disabled={busy}
            className="rounded-[4px] border border-[#c9c9c9] px-3 py-[5px] text-[13px] font-bold text-[#1d1c1d] transition hover:bg-[#f0f0f0] disabled:opacity-60"
          >
            Clear
          </button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            title={p.hint}
            onClick={() => void patch(p.patch)}
            disabled={busy}
            className="rounded-[12px] border border-[#c9c9c9] bg-white px-3 py-[4px] text-[12px] font-semibold text-[#1d1c1d] transition hover:border-[#1264a3] hover:text-[#1264a3] disabled:opacity-60"
          >
            {p.label}
          </button>
        ))}
      </div>

      {faults.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-[12px] font-semibold text-[#616061]">
            {faults.length} fault(s) injected
          </summary>
          <ul className="mt-2 max-h-[160px] space-y-1 overflow-y-auto">
            {[...faults].reverse().map((f, i) => (
              <li key={i} className="flex items-center gap-2 text-[12px] text-[#1d1c1d]">
                <span className={`size-[7px] shrink-0 rounded-full ${KIND_TINT[f.kind]}`} />
                <code className="font-mono">{f.method}</code>
                <span className="text-[#616061]">
                  {f.kind} · {f.detail}
                </span>
                <span className="ml-auto tabular-nums text-[11px] text-[#9b9b9b]">
                  {new Date(f.ts).toLocaleTimeString("en-US", { hour12: false })}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
