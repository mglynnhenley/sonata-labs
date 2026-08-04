import type { TwinHttp } from "./http";

// The two things everything Slack-shaped needs, in one place so the adapter and
// the agent's tools cannot drift into two different ideas of what "#ops" means.
//
// Slack reports failure as HTTP 200 with `{ok: false, error}`, so a raw client
// would have every caller checking a flag; and its API only ever accepts channel
// *ids*, while beats, criteria and agents all write channel names. Both wrinkles
// are absorbed here.

export interface SlackChannel {
  id?: string;
  name?: string;
  purpose?: { value?: string };
  is_private?: boolean;
  is_archived?: boolean;
  num_members?: number;
}

export interface SlackClient {
  call<T>(method: string, args?: Record<string, unknown>): Promise<T>;
  listChannels(): Promise<SlackChannel[]>;
  /** Accepts an id, a name, or "#name". Unknown names pass through unchanged. */
  resolveChannel(ref: string): Promise<string>;
}

/** Slack ids are a letter class plus uppercase alphanumerics: C…, D…, G…. */
const CHANNEL_ID = /^[CDG][A-Z0-9]{2,}$/;

export function createSlackClient(http: TwinHttp, limit = 200): SlackClient {
  const ids = new Map<string, string>();

  const client: SlackClient = {
    async call<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
      const res = await http.post<T & { ok?: boolean; error?: string }>(`/api/${method}`, args);
      if (res.ok === false) throw new Error(`slack ${method}: ${res.error ?? "not ok"}`);
      return res;
    },

    async listChannels(): Promise<SlackChannel[]> {
      const res = await client.call<{ channels?: SlackChannel[] }>("conversations.list", {
        types: "public_channel,private_channel",
        exclude_archived: false,
        limit,
      });
      const channels = res.channels ?? [];
      for (const c of channels) if (c.id && c.name) ids.set(c.name.toLowerCase(), c.id);
      return channels;
    },

    async resolveChannel(ref: string): Promise<string> {
      if (CHANNEL_ID.test(ref)) return ref;
      const name = ref.replace(/^#/, "").toLowerCase();
      // One roster fetch per run, refreshed only when a name is not yet known —
      // which is also what picks up a channel the agent created mid-day.
      if (!ids.has(name)) await client.listChannels();
      return ids.get(name) ?? ref;
    },
  };
  return client;
}
