import { signBody, SIGNING_SECRET } from "./signing";
import { newId } from "../slack/ids";

// Event subscriptions + delivery. Mutations call emit(); the bus wraps each
// event in Slack's `event_callback` envelope, signs it, and POSTs it to every
// subscriber whose filter matches. Delivery is fire-and-forget with retries, so
// a slow or broken subscriber can never block (or fail) the API call that
// produced the event — same as real Slack.

export interface Subscription {
  id: string;
  url: string;
  /** Event types to deliver; empty = all. */
  events: string[];
  createdAt: number;
  /** Delivery stats, surfaced in the UI. */
  delivered: number;
  failed: number;
  lastError: string | null;
  lastDeliveryAt: number | null;
  active: boolean;
}

export interface DeliveryRecord {
  id: string;
  subscriptionId: string;
  url: string;
  eventType: string;
  ts: number;
  status: "ok" | "failed" | "verifying";
  attempts: number;
  detail: string;
  payload: unknown;
}

export interface SlackEvent {
  type: string;
  [k: string]: unknown;
}

interface BusState {
  subs: Map<string, Subscription>;
  deliveries: DeliveryRecord[];
  teamId: string;
}

const g = globalThis as unknown as { __slackSandboxEventBus?: BusState };
if (!g.__slackSandboxEventBus) {
  g.__slackSandboxEventBus = { subs: new Map(), deliveries: [], teamId: "T00000000" };
}
const state = g.__slackSandboxEventBus;

export function setTeamId(teamId: string): void {
  state.teamId = teamId;
}

export function listSubscriptions(): Subscription[] {
  return [...state.subs.values()].sort((a, b) => a.createdAt - b.createdAt);
}

export function getSubscription(id: string): Subscription | undefined {
  return state.subs.get(id);
}

export function removeSubscription(id: string): boolean {
  return state.subs.delete(id);
}

export function recentDeliveries(limit = 100): DeliveryRecord[] {
  return state.deliveries.slice(-limit);
}

export function clearDeliveries(): void {
  state.deliveries = [];
}

function record(d: DeliveryRecord): void {
  state.deliveries.push(d);
  if (state.deliveries.length > 300) {
    state.deliveries.splice(0, state.deliveries.length - 300);
  }
}

/**
 * Register a subscriber. Performs Slack's url_verification handshake first:
 * we POST {type:"url_verification", challenge} and the endpoint must echo the
 * challenge back (as raw text or {challenge}). A subscriber that fails the
 * handshake is registered inactive with the reason recorded.
 */
export async function addSubscription(
  url: string,
  events: string[] = [],
): Promise<Subscription> {
  const sub: Subscription = {
    id: newId("S"),
    url,
    events,
    createdAt: Date.now(),
    delivered: 0,
    failed: 0,
    lastError: null,
    lastDeliveryAt: null,
    active: false,
  };

  const challenge = newId("C") + newId("H");
  const body = JSON.stringify({ type: "url_verification", token: "sandbox", challenge });
  try {
    const res = await post(url, body, "url_verification");
    const text = await res.text();
    let echoed: string | undefined;
    try {
      echoed = (JSON.parse(text) as { challenge?: string }).challenge;
    } catch {
      echoed = text.trim();
    }
    if (res.ok && echoed === challenge) {
      sub.active = true;
    } else {
      sub.lastError = `url_verification failed (status ${res.status}, challenge ${
        echoed === challenge ? "ok" : "mismatch"
      })`;
    }
  } catch (e) {
    sub.lastError = `url_verification unreachable: ${e instanceof Error ? e.message : String(e)}`;
  }

  state.subs.set(sub.id, sub);
  return sub;
}

function post(url: string, body: string, kind: string): Promise<Response> {
  const timestampSec = Math.floor(Date.now() / 1000);
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": String(timestampSec),
      "x-slack-signature": signBody(body, timestampSec, SIGNING_SECRET),
      "x-sandbox-event-kind": kind,
    },
    body,
    signal: AbortSignal.timeout(5000),
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Emit an event to all matching subscribers. Returns immediately — delivery
 * happens in the background so a subscriber can never stall a mutation.
 */
export function emit(event: SlackEvent, opts: { eventTs?: string } = {}): void {
  const targets = [...state.subs.values()].filter(
    (s) => s.active && (s.events.length === 0 || s.events.includes(event.type)),
  );
  if (!targets.length) return;

  const envelope = {
    token: "sandbox",
    team_id: state.teamId,
    api_app_id: "A0SANDBOX01",
    event,
    type: "event_callback",
    event_id: newId("Ev"),
    event_time: Math.floor(Date.now() / 1000),
    event_context: opts.eventTs ?? "",
  };
  const body = JSON.stringify(envelope);

  for (const sub of targets) {
    void deliver(sub, body, event.type, envelope);
  }
}

/** Deliver with bounded retries and exponential backoff (Slack retries 3x). */
async function deliver(
  sub: Subscription,
  body: string,
  eventType: string,
  payload: unknown,
): Promise<void> {
  const maxAttempts = 3;
  let lastDetail = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await post(sub.url, body, "event_callback");
      if (res.ok) {
        sub.delivered += 1;
        sub.lastDeliveryAt = Date.now();
        sub.lastError = null;
        record({
          id: newId("D"),
          subscriptionId: sub.id,
          url: sub.url,
          eventType,
          ts: Date.now(),
          status: "ok",
          attempts: attempt,
          detail: `HTTP ${res.status}`,
          payload,
        });
        return;
      }
      lastDetail = `HTTP ${res.status}`;
    } catch (e) {
      lastDetail = e instanceof Error ? e.message : String(e);
    }
    if (attempt < maxAttempts) await sleep(200 * 2 ** (attempt - 1));
  }

  sub.failed += 1;
  sub.lastError = lastDetail;
  sub.lastDeliveryAt = Date.now();
  record({
    id: newId("D"),
    subscriptionId: sub.id,
    url: sub.url,
    eventType,
    ts: Date.now(),
    status: "failed",
    attempts: maxAttempts,
    detail: lastDetail,
    payload,
  });
}
