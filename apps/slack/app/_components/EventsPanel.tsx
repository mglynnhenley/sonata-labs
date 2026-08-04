"use client";

import { useEffect, useState } from "react";

// Event subscriptions + delivery log. Event-driven agents are the category that
// simply cannot run without this, so it gets first-class visibility.

interface Subscription {
  id: string;
  url: string;
  events: string[];
  delivered: number;
  failed: number;
  lastError: string | null;
  active: boolean;
}

interface Delivery {
  id: string;
  url: string;
  eventType: string;
  ts: number;
  status: "ok" | "failed" | "verifying";
  attempts: number;
  detail: string;
}

export function EventsPanel() {
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [secret, setSecret] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const d = (await fetch("/api/sandbox/events", { cache: "no-store" }).then((r) =>
        r.json(),
      )) as { subscriptions: Subscription[]; deliveries: Delivery[]; signing_secret: string };
      setSubs(d.subscriptions);
      setDeliveries(d.deliveries);
      setSecret(d.signing_secret);
    } catch {
      // server restarting
    }
  };

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, []);

  const subscribe = async () => {
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    const res = (await fetch("/api/sandbox/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: url.trim() }),
    }).then((r) => r.json())) as {
      ok: boolean;
      error?: string;
      subscription?: { lastError: string | null };
    };
    if (!res.ok) setError(res.subscription?.lastError ?? res.error ?? "subscription failed");
    else setUrl("");
    await load();
    setBusy(false);
  };

  const unsubscribe = async (id: string) => {
    setBusy(true);
    await fetch(`/api/sandbox/events?id=${id}`, { method: "DELETE" });
    await load();
    setBusy(false);
  };

  return (
    <div className="border-t border-[#e8e8e8] bg-white px-5 py-3">
      <div className="flex items-baseline justify-between">
        <div>
          <h3 className="text-[14px] font-black text-[#1d1c1d]">Event subscriptions</h3>
          <p className="text-[12px] text-[#616061]">
            Signed webhook delivery, so event-driven agents work. Verify with{" "}
            <code className="rounded bg-[#f6f6f6] px-1 font-mono text-[11px]">
              X-Slack-Signature
            </code>{" "}
            and secret <code className="font-mono text-[11px]">{secret}</code>.
          </p>
        </div>
      </div>

      <div className="mt-2 flex gap-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void subscribe()}
          placeholder="https://your-agent.example/slack/events"
          className="min-w-0 flex-1 rounded-[4px] border border-[#c9c9c9] px-2 py-[5px] text-[13px] outline-none focus:border-[#1264a3]"
        />
        <button
          onClick={() => void subscribe()}
          disabled={busy || !url.trim()}
          className="rounded-[4px] bg-[#007a5a] px-3 py-[5px] text-[13px] font-bold text-white transition hover:bg-[#148567] disabled:opacity-50"
        >
          Subscribe
        </button>
      </div>
      {error && <p className="mt-1 text-[12px] text-[#e01e5a]">{error}</p>}

      {subs.length > 0 && (
        <ul className="mt-2 space-y-1">
          {subs.map((s) => (
            <li
              key={s.id}
              className="flex items-center gap-2 rounded-[4px] border border-[#e8e8e8] px-2 py-[5px] text-[12px]"
            >
              <span
                className={`size-[7px] shrink-0 rounded-full ${
                  s.active ? "bg-[#2bac76]" : "bg-[#e01e5a]"
                }`}
                title={s.active ? "verified" : "handshake failed"}
              />
              <code className="min-w-0 flex-1 truncate font-mono">{s.url}</code>
              <span className="shrink-0 text-[#616061]">
                {s.delivered} ok
                {s.failed > 0 && <span className="text-[#e01e5a]"> · {s.failed} failed</span>}
              </span>
              <button
                onClick={() => void unsubscribe(s.id)}
                className="shrink-0 rounded px-1 text-[#616061] hover:bg-[#f6f6f6]"
                title="Unsubscribe"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      {deliveries.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[12px] font-semibold text-[#616061]">
            {deliveries.length} delivery attempt(s)
          </summary>
          <ul className="mt-2 max-h-[140px] space-y-1 overflow-y-auto">
            {[...deliveries].reverse().map((d) => (
              <li key={d.id} className="flex items-center gap-2 text-[12px]">
                <span
                  className={`size-[7px] shrink-0 rounded-full ${
                    d.status === "ok" ? "bg-[#2bac76]" : "bg-[#e01e5a]"
                  }`}
                />
                <code className="font-mono">{d.eventType}</code>
                <span className="text-[#616061]">
                  {d.detail}
                  {d.attempts > 1 && ` · ${d.attempts} attempts`}
                </span>
                <span className="ml-auto tabular-nums text-[11px] text-[#9b9b9b]">
                  {new Date(d.ts).toLocaleTimeString("en-US", { hour12: false })}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
