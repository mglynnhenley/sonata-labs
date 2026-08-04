import type { SlackSeedUser } from "./types";

// Every row carries a `raw_json` copy of the resource the Web API returns, and
// reads shape that plus the live columns (see store/*.ts). Injected and seeded
// resources have to carry the same raw_json a synced one would, or an agent
// could spot the difference through users.info / conversations.info.

/** Message raw_json — WITHOUT reactions/thread stats, which are overlaid on read. */
export function messageRawJson(args: {
  user: string;
  text: string;
  ts: string;
  teamId: string;
}): string {
  return JSON.stringify({
    type: "message",
    user: args.user,
    text: args.text,
    ts: args.ts,
    team: args.teamId,
  });
}

export function userRawJson(u: SlackSeedUser, handle: string, teamId: string, updated: number): string {
  return JSON.stringify({
    id: u.id,
    team_id: teamId,
    name: handle,
    deleted: false,
    real_name: u.realName,
    tz: u.tz ?? "Europe/London",
    tz_label: "British Summer Time",
    tz_offset: 3600,
    profile: {
      real_name: u.realName,
      real_name_normalized: u.realName,
      display_name: handle,
      display_name_normalized: handle,
      title: u.title ?? "",
      email: u.email ?? "",
      status_text: "",
      status_emoji: "",
      image_24: `https://sandbox.local/avatars/${handle}_24.png`,
      image_48: `https://sandbox.local/avatars/${handle}_48.png`,
      image_72: `https://sandbox.local/avatars/${handle}_72.png`,
      team: teamId,
    },
    is_admin: !!u.isAdmin,
    is_owner: !!u.isOwner,
    is_bot: !!u.isBot,
    is_app_user: false,
    updated,
  });
}

export function channelRawJson(args: {
  id: string;
  name: string;
  isPrivate: boolean;
  isGeneral: boolean;
  creator: string;
  created: number;
  teamId: string;
}): string {
  return JSON.stringify({
    id: args.id,
    name: args.name,
    is_channel: !args.isPrivate,
    is_group: args.isPrivate,
    is_im: false,
    is_mpim: false,
    is_private: args.isPrivate,
    created: args.created,
    is_archived: false,
    is_general: args.isGeneral,
    unlinked: 0,
    name_normalized: args.name,
    is_shared: false,
    is_org_shared: false,
    is_pending_ext_shared: false,
    creator: args.creator,
    is_ext_shared: false,
    shared_team_ids: [args.teamId],
    is_member: true,
  });
}
