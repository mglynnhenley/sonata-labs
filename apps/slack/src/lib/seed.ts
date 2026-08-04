import type { Database } from "better-sqlite3";
import { insertUser } from "./store/users";
import { insertConversation, addMember } from "./store/conversations";
import { insertMessage } from "./store/messages";
import { addReaction } from "./store/reactions";
import { addPin } from "./store/pins";
import { insertFile, linkFileToMessage } from "./store/files";
import { setSelf } from "./store/meta";
import { msToTs } from "./slack/ts";

// Synthetic workspace so the API/UI can be developed and verified without a
// real Slack workspace. Mirrors what the sync CLI would produce: raw_json per
// resource (messages stored WITHOUT reactions/thread stats — those live in
// their tables and are overlaid on read), members, reactions, pins, one file.
//
// Ids are fixed (realistic Slack shape, deterministic) and everything is
// anchored to a fixed BASE date so seeds are reproducible run-to-run.

export const TEAM_ID = "T0ACMESAND1";
export const TEAM_NAME = "Acme";
export const TEAM_DOMAIN = "acme-sandbox";

// Anchor: 2026-07-28T09:00:00Z.
export const BASE = Date.UTC(2026, 6, 28, 9, 0, 0);
const MIN = 60_000;

export const ME = "U0MATILDA01";

interface SeedUser {
  id: string;
  name: string;
  real: string;
  title: string;
  tz?: string;
  bot?: boolean;
  admin?: boolean;
  owner?: boolean;
}

const USERS: SeedUser[] = [
  { id: ME, name: "matilda", real: "Matilda Glynn-Henley", title: "Platform Engineer", admin: true },
  { id: "U0PRIYA0001", name: "priya", real: "Priya Nair", title: "Engineering Manager", admin: true, owner: true },
  { id: "U0JORDAN001", name: "jordan", real: "Jordan Ellis", title: "Frontend Engineer" },
  { id: "U0SAM000001", name: "sam", real: "Sam Okafor", title: "Backend Engineer" },
  { id: "U0DANA00001", name: "dana", real: "Dana Whitfield", title: "Product Designer", tz: "America/New_York" },
  { id: "U0CHEN00001", name: "chen", real: "Chen Wei", title: "Data Engineer", tz: "Asia/Shanghai" },
  { id: "U0ALEX00001", name: "alex", real: "Alex Romero", title: "SRE" },
  { id: "U0DEPLOYB01", name: "deploybot", real: "Deploy Bot", title: "", bot: true },
];

const BOT_ID = "B0DEPLOYB01"; // deploybot's bot_id (bot messages carry both)

export const CH_GENERAL = "C0GENERAL01";
export const CH_RANDOM = "C0RANDOM001";
export const CH_ENG = "C0ENGINEER1";
export const CH_LEADERSHIP = "G0LEADERSH1";
export const DM_PRIYA = "D0MPRIYA001";
export const DM_JORDAN = "D0MJORDAN01";
export const MPIM = "G0MPIM00001";

const EVERYONE = USERS.map((u) => u.id);

interface SeedChannel {
  id: string;
  name?: string;
  kind: "public" | "private" | "im" | "mpim";
  topic?: string;
  purpose?: string;
  general?: boolean;
  creator?: string;
  members: string[];
  im_user?: string; // im counterpart
  createdDaysAgo: number;
}

const CHANNELS: SeedChannel[] = [
  {
    id: CH_GENERAL,
    name: "general",
    kind: "public",
    general: true,
    topic: "Company-wide announcements and work-based matters",
    purpose: "This channel is for workspace-wide communication and announcements.",
    creator: "U0PRIYA0001",
    members: EVERYONE,
    createdDaysAgo: 400,
  },
  {
    id: CH_RANDOM,
    name: "random",
    kind: "public",
    topic: "Non-work banter and water cooler conversation",
    purpose: "A place for non-work-related flimflam.",
    creator: "U0PRIYA0001",
    members: EVERYONE,
    createdDaysAgo: 400,
  },
  {
    id: CH_ENG,
    name: "engineering",
    kind: "public",
    topic: "Ship it | Deploy window: weekdays 10–16 UTC",
    purpose: "Engineering discussion, incidents, PRs, deploys.",
    creator: ME,
    members: [ME, "U0PRIYA0001", "U0JORDAN001", "U0SAM000001", "U0CHEN00001", "U0ALEX00001", "U0DEPLOYB01"],
    createdDaysAgo: 350,
  },
  {
    id: CH_LEADERSHIP,
    name: "leadership",
    kind: "private",
    topic: "Managers + leads",
    purpose: "Private channel for leadership coordination.",
    creator: "U0PRIYA0001",
    members: ["U0PRIYA0001", ME],
    createdDaysAgo: 300,
  },
  { id: DM_PRIYA, kind: "im", members: [ME, "U0PRIYA0001"], im_user: "U0PRIYA0001", createdDaysAgo: 380 },
  { id: DM_JORDAN, kind: "im", members: [ME, "U0JORDAN001"], im_user: "U0JORDAN001", createdDaysAgo: 200 },
  {
    id: MPIM,
    name: "mpdm-matilda--priya--jordan-1",
    kind: "mpim",
    members: [ME, "U0PRIYA0001", "U0JORDAN001"],
    createdDaysAgo: 90,
  },
];

interface SeedMsg {
  user: string; // seed user id ('bot' messages use deploybot)
  minutesAgo: number;
  text: string;
  threadKey?: string; // this message roots a thread
  replyTo?: string; // reply into that thread
  reactions?: Array<{ name: string; users: string[] }>;
  pin?: boolean;
  file?: boolean; // attach the seed file to this message
}

// Per-channel scripts. minutesAgo is back from BASE; keep each list roughly
// newest-last for readability (insert order is sorted oldest-first anyway).
const SCRIPTS: Record<string, SeedMsg[]> = {
  [CH_GENERAL]: [
    {
      user: "U0PRIYA0001",
      minutesAgo: 60 * 24 * 30,
      text: "Welcome to the Acme workspace! :wave: Please set your display name and add yourself to <#C0ENGINEER1> if you write code. Handbook is pinned in this channel.",
      pin: true,
      reactions: [{ name: "wave", users: [ME, "U0JORDAN001", "U0SAM000001", "U0DANA00001"] }],
    },
    { user: "U0DANA00001", minutesAgo: 60 * 24 * 6, text: "New brand colors are live in Figma — feedback welcome until Friday." },
    {
      user: "U0PRIYA0001",
      minutesAgo: 60 * 24 * 3,
      text: "Reminder: quarterly all-hands on Thursday at 4pm UTC. Agenda doc in the calendar invite.",
      reactions: [{ name: "thumbsup", users: [ME, "U0SAM000001"] }, { name: "calendar", users: ["U0DANA00001"] }],
    },
    {
      user: "U0PRIYA0001",
      minutesAgo: 60 * 30,
      text: "Team offsite planning time! :tada: Vote in the thread — Lisbon or Copenhagen?",
      threadKey: "offsite",
      reactions: [{ name: "tada", users: [ME, "U0JORDAN001", "U0DANA00001", "U0CHEN00001"] }],
    },
    { user: "U0JORDAN001", minutesAgo: 60 * 29, text: "Lisbon! Pastel de nata is a serious argument.", replyTo: "offsite" },
    { user: ME, minutesAgo: 60 * 28, text: "Lisbon +1 — also direct flights for everyone except Chen.", replyTo: "offsite" },
    { user: "U0CHEN00001", minutesAgo: 60 * 20, text: "Copenhagen has better bike infrastructure but Lisbon works for me :+1:", replyTo: "offsite" },
    { user: "U0DANA00001", minutesAgo: 60 * 6, text: "Lisbon it is then? I'll start a doc for logistics.", replyTo: "offsite" },
    { user: "U0ALEX00001", minutesAgo: 60 * 5, text: "Status page got a fresh coat of paint — uptime badges now update every minute." },
    {
      user: "U0PRIYA0001",
      minutesAgo: 45,
      text: "Heads up: sandbox demo for the board is tomorrow 10am. <@U0MATILDA01> will drive.",
      reactions: [{ name: "eyes", users: ["U0JORDAN001", "U0SAM000001"] }],
    },
  ],
  [CH_ENG]: [
    { user: "U0SAM000001", minutesAgo: 60 * 24 * 5, text: "Migrated the billing service to the new queue. Throughput up ~40%, p99 down to 120ms." },
    {
      user: "U0DEPLOYB01",
      minutesAgo: 60 * 24 * 5 + 30,
      text: "Deploy `billing-service@2.14.0` to production: SUCCESS (build 4021, 6m12s)",
      reactions: [{ name: "rocket", users: ["U0SAM000001", ME] }],
    },
    { user: "U0CHEN00001", minutesAgo: 60 * 24 * 4, text: "Nightly ETL now writes to the new warehouse schema. Old tables freeze on the 1st — migrate your dashboards." },
    {
      user: "U0ALEX00001",
      minutesAgo: 60 * 24 * 2,
      text: ":rotating_light: Elevated 5xx on api-gateway since 14:02 UTC. Investigating in thread.",
      threadKey: "incident",
      reactions: [{ name: "eyes", users: [ME, "U0SAM000001", "U0PRIYA0001"] }],
    },
    { user: "U0ALEX00001", minutesAgo: 60 * 24 * 2 - 6, text: "Correlates with the 13:58 deploy of `edge-router@1.9.0`. Rolling back now.", replyTo: "incident" },
    { user: "U0DEPLOYB01", minutesAgo: 60 * 24 * 2 - 10, text: "Rollback `edge-router@1.8.3` to production: SUCCESS (build 4055, 3m41s)", replyTo: "incident" },
    { user: "U0ALEX00001", minutesAgo: 60 * 24 * 2 - 15, text: "Error rate back to baseline. Root cause: connection pool exhaustion from the new keep-alive settings. Postmortem doc tomorrow.", replyTo: "incident" },
    {
      user: ME,
      minutesAgo: 60 * 24 * 2 - 20,
      text: "Nice catch. Let's add a canary stage for edge-router deploys — it bypasses the standard bake right now.",
      replyTo: "incident",
      reactions: [{ name: "hundred", users: ["U0ALEX00001", "U0PRIYA0001"] }],
    },
    {
      user: "U0ALEX00001",
      minutesAgo: 60 * 24 * 1,
      text: "Postmortem for yesterday's gateway incident attached. Action items assigned inline.",
      file: true,
      reactions: [{ name: "pray", users: ["U0SAM000001"] }],
    },
    {
      user: "U0JORDAN001",
      minutesAgo: 60 * 8,
      text: "PR up for the checkout flow rewrite: `acme/web#4821`. It's big — review in thread, please.",
      threadKey: "pr4821",
    },
    { user: ME, minutesAgo: 60 * 7, text: "First pass done. Main note: the price fetch races cart hydration — needs to await the hydration promise.", replyTo: "pr4821" },
    { user: "U0JORDAN001", minutesAgo: 60 * 6, text: "Good catch, that explains the flaky test. Fixed + regression test added.", replyTo: "pr4821" },
    { user: "U0SAM000001", minutesAgo: 60 * 3, text: "API side LGTM. Ship it :shipit:", replyTo: "pr4821", reactions: [{ name: "shipit", users: ["U0JORDAN001"] }] },
    { user: "U0DEPLOYB01", minutesAgo: 90, text: "Deploy `web@5.2.1` to staging: SUCCESS (build 4102, 4m03s)" },
    { user: "U0CHEN00001", minutesAgo: 30, text: "Anyone else seeing slow queries on the replica since this morning? ~2x latency on the orders table." },
  ],
  [CH_RANDOM]: [
    { user: "U0JORDAN001", minutesAgo: 60 * 24 * 4, text: "The office coffee machine has achieved sentience. It refused to make decaf this morning. Respect." },
    {
      user: "U0DANA00001",
      minutesAgo: 60 * 24 * 4 + 10,
      text: "it knows decaf is a lie",
      reactions: [{ name: "joy", users: [ME, "U0JORDAN001", "U0SAM000001"] }],
    },
    { user: "U0CHEN00001", minutesAgo: 60 * 24 * 3, text: "Sourdough starter update, week 3: it bubbles. I am a father." },
    { user: "U0SAM000001", minutesAgo: 60 * 24 * 1, text: "Lunch spot poll: ramen, tacos, or that new Georgian place?" },
    { user: ME, minutesAgo: 60 * 23, text: "Georgian. Khachapuri is non-negotiable.", reactions: [{ name: "drooling_face", users: ["U0SAM000001", "U0DANA00001"] }] },
    { user: "U0DANA00001", minutesAgo: 60 * 4, text: "Friday playlist duty is mine this week. Requests open for the next hour. Choose wisely." },
  ],
  [CH_LEADERSHIP]: [
    { user: "U0PRIYA0001", minutesAgo: 60 * 24 * 7, text: "Q3 headcount approved: two backend, one SRE. Job specs by Friday?" },
    { user: ME, minutesAgo: 60 * 24 * 7 + 30, text: "I'll draft the SRE spec — reusing most of the last one with the on-call section updated." },
    { user: "U0PRIYA0001", minutesAgo: 60 * 24 * 2, text: "Board wants a live demo of the sandbox next week, not slides. Can we have the activity panel polished by then?" },
    { user: ME, minutesAgo: 60 * 24 * 2 + 20, text: "Yes — reset + live feed are solid. I'll rehearse the demo flow Wednesday." },
  ],
  [DM_PRIYA]: [
    { user: "U0PRIYA0001", minutesAgo: 60 * 26, text: "Got 10 minutes before standup? Want to sync on the board demo narrative." },
    { user: ME, minutesAgo: 60 * 25, text: "Sure — grabbing coffee, call in 5." },
    { user: "U0PRIYA0001", minutesAgo: 60 * 24, text: "Perfect. Also: your promo packet cleared the committee. Announcing Friday :shushing_face:", reactions: [{ name: "tada", users: [ME] }] },
    { user: ME, minutesAgo: 60 * 23, text: "!!! Thank you. Keeping a straight face until Friday will be hard." },
  ],
  [DM_JORDAN]: [
    { user: "U0JORDAN001", minutesAgo: 60 * 24 * 1, text: "That race condition you spotted saved my week. How did you even see that in a 3k-line diff?" },
    { user: ME, minutesAgo: 60 * 22, text: "Honestly? I grep for `await` next to `useEffect` first thing in every review :sweat_smile:" },
    { user: "U0JORDAN001", minutesAgo: 60 * 21, text: "Stealing that. Adding it to the review checklist." },
  ],
  [MPIM]: [
    { user: "U0PRIYA0001", minutesAgo: 60 * 24 * 3, text: "Secret planning: Sam's 5-year anniversary is next month. Ideas?" },
    { user: "U0JORDAN001", minutesAgo: 60 * 24 * 3 + 15, text: "Custom mechanical keyboard? He's been eyeing one for months." },
    { user: ME, minutesAgo: 60 * 24 * 3 + 25, text: "Perfect. I know his layout preferences from the office peripherals order. On it." },
  ],
};

const FILE_ID = "F0POSTMORT1";

function userRaw(u: SeedUser): string {
  return JSON.stringify({
    id: u.id,
    team_id: TEAM_ID,
    name: u.name,
    deleted: false,
    real_name: u.real,
    tz: u.tz ?? "Europe/London",
    tz_label: u.tz === "Asia/Shanghai" ? "China Standard Time" : u.tz === "America/New_York" ? "Eastern Daylight Time" : "British Summer Time",
    tz_offset: u.tz === "Asia/Shanghai" ? 28800 : u.tz === "America/New_York" ? -14400 : 3600,
    profile: {
      real_name: u.real,
      real_name_normalized: u.real,
      display_name: u.name,
      display_name_normalized: u.name,
      title: u.title,
      status_text: "",
      status_emoji: "",
      image_24: `https://sandbox.local/avatars/${u.name}_24.png`,
      image_48: `https://sandbox.local/avatars/${u.name}_48.png`,
      image_72: `https://sandbox.local/avatars/${u.name}_72.png`,
      team: TEAM_ID,
    },
    is_admin: !!u.admin,
    is_owner: !!u.owner,
    is_bot: !!u.bot,
    is_app_user: false,
    updated: Math.floor(BASE / 1000) - 86400 * 30,
    ...(u.bot ? { profile_bot_id: BOT_ID } : {}),
  });
}

function channelRaw(c: SeedChannel): string {
  const created = Math.floor((BASE - c.createdDaysAgo * 86400_000) / 1000);
  if (c.kind === "im") {
    return JSON.stringify({
      id: c.id,
      created,
      is_im: true,
      is_org_shared: false,
      user: c.im_user,
      is_user_deleted: false,
      priority: 0,
    });
  }
  return JSON.stringify({
    id: c.id,
    name: c.name,
    is_channel: c.kind === "public",
    is_group: c.kind === "private" || c.kind === "mpim",
    is_im: false,
    is_mpim: c.kind === "mpim",
    is_private: c.kind !== "public",
    created,
    is_archived: false,
    is_general: !!c.general,
    unlinked: 0,
    name_normalized: c.name,
    is_shared: false,
    is_org_shared: false,
    is_pending_ext_shared: false,
    creator: c.creator ?? ME,
    is_ext_shared: false,
    shared_team_ids: [TEAM_ID],
    is_member: true,
  });
}

/** Message raw_json — WITHOUT reactions/thread stats (overlaid live on read). */
function messageRaw(user: SeedUser, text: string, ts: string): string {
  const base: Record<string, unknown> = { type: "message", text, ts, team: TEAM_ID };
  if (user.bot) {
    base.subtype = "bot_message";
    base.bot_id = BOT_ID;
    base.username = user.real;
  } else {
    base.user = user.id;
  }
  return JSON.stringify(base);
}

export function seedDatabase(db: Database): void {
  const byId = new Map(USERS.map((u) => [u.id, u]));

  const seed = db.transaction(() => {
    setSelf(db, {
      teamId: TEAM_ID,
      teamName: TEAM_NAME,
      teamDomain: TEAM_DOMAIN,
      userId: ME,
      userName: "matilda",
    });

    for (const u of USERS) {
      const raw = userRaw(u);
      insertUser(db, {
        id: u.id,
        teamId: TEAM_ID,
        name: u.name,
        realName: u.real,
        displayName: u.name,
        tz: u.tz ?? "Europe/London",
        isBot: !!u.bot,
        isAdmin: !!u.admin,
        isOwner: !!u.owner,
        updated: Math.floor(BASE / 1000) - 86400 * 30,
        profileJson: JSON.stringify(JSON.parse(raw).profile),
        rawJson: raw,
      });
    }

    for (const c of CHANNELS) {
      const created = Math.floor((BASE - c.createdDaysAgo * 86400_000) / 1000);
      const lastSet = created + 86400;
      insertConversation(db, {
        id: c.id,
        name: c.name ?? null,
        isChannel: c.kind === "public",
        isGroup: c.kind === "private" || c.kind === "mpim",
        isIm: c.kind === "im",
        isMpim: c.kind === "mpim",
        isPrivate: c.kind !== "public",
        isGeneral: !!c.general,
        creator: c.kind === "im" ? null : c.creator ?? ME,
        created,
        topicJson: c.topic
          ? JSON.stringify({ value: c.topic, creator: c.creator ?? ME, last_set: lastSet })
          : null,
        purposeJson: c.purpose
          ? JSON.stringify({ value: c.purpose, creator: c.creator ?? ME, last_set: lastSet })
          : null,
        rawJson: channelRaw(c),
      });
      for (const m of c.members) addMember(db, c.id, m);
    }

    // Seed file (small text payload, linked below).
    const fileCreated = Math.floor((BASE - 60 * 24 * MIN) / 1000);
    insertFile(db, {
      id: FILE_ID,
      user: "U0ALEX00001",
      name: "postmortem-gateway-2026-07-26.md",
      title: "Postmortem: api-gateway elevated 5xx",
      mimetype: "text/markdown",
      filetype: "markdown",
      size: 2148,
      created: fileCreated,
      urlPrivate: `https://sandbox.local/files/${FILE_ID}/postmortem-gateway-2026-07-26.md`,
      permalink: `https://sandbox.local/files/${FILE_ID}`,
      data: Buffer.from(
        [
          "# Postmortem: api-gateway elevated 5xx (2026-07-26)",
          "",
          "## Impact",
          "14:02–14:39 UTC. ~4.1% of API requests returned 502/504.",
          "",
          "## Root cause",
          "edge-router@1.9.0 changed keep-alive defaults, exhausting the upstream connection pool.",
          "",
          "## Action items",
          "- [ ] Canary stage for edge-router deploys (owner: matilda)",
          "- [ ] Pool saturation alert at 80% (owner: alex)",
          "- [ ] Load test keep-alive changes in staging (owner: sam)",
        ].join("\n"),
        "utf8",
      ),
      rawJson: JSON.stringify({
        id: FILE_ID,
        created: fileCreated,
        name: "postmortem-gateway-2026-07-26.md",
        title: "Postmortem: api-gateway elevated 5xx",
        mimetype: "text/markdown",
        filetype: "markdown",
        pretty_type: "Markdown",
        user: "U0ALEX00001",
        size: 2148,
        mode: "hosted",
        is_public: true,
        url_private: `https://sandbox.local/files/${FILE_ID}/postmortem-gateway-2026-07-26.md`,
        permalink: `https://sandbox.local/files/${FILE_ID}`,
      }),
    });

    // Messages: oldest-first per channel so thread roots exist before replies.
    let seq = 0;
    for (const [channelId, script] of Object.entries(SCRIPTS)) {
      const threadRoots = new Map<string, string>(); // threadKey -> root ts
      const ordered = [...script].sort((a, b) => b.minutesAgo - a.minutesAgo);
      for (const m of ordered) {
        const user = byId.get(m.user)!;
        const ts = msToTs(BASE - m.minutesAgo * MIN, seq++);
        const rootTs = m.replyTo ? threadRoots.get(m.replyTo) ?? null : null;
        insertMessage(db, {
          channelId,
          ts,
          threadTs: m.threadKey ? ts : rootTs,
          user: user.bot ? null : user.id,
          botId: user.bot ? BOT_ID : null,
          subtype: user.bot ? "bot_message" : null,
          text: m.text,
          hasFiles: !!m.file,
          rawJson: messageRaw(user, m.text, ts),
          isSandboxCreated: false,
        });
        if (m.threadKey) threadRoots.set(m.threadKey, ts);
        for (const r of m.reactions ?? []) {
          for (const u of r.users) addReaction(db, channelId, ts, r.name, u);
        }
        if (m.pin) addPin(db, channelId, ts, "U0PRIYA0001", Math.floor((BASE - m.minutesAgo * MIN) / 1000) + 60);
        if (m.file) linkFileToMessage(db, channelId, ts, FILE_ID);
      }
    }
  });

  seed();
}
