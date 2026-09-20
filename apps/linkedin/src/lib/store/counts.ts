import type { Database } from "better-sqlite3";
import { countComments } from "./comments";
import { countMembers } from "./members";
import { countOrganizations } from "./organizations";
import { countPosts } from "./posts";
import { countReactions } from "./reactions";

// One function so /api/health, reset, snapshot and seed can never disagree about
// what "how much is in here" means.
//
// A deliberate departure from the Calendar clone, which builds `{calendars,
// events}` inline in three places. That is fine for two tables; it is not fine
// for five, and three copies of a five-entry object literal is exactly the
// second implementation AGENTS.md's "one path per job" is about — the failure
// being a health check that reports a seed landed while reset reports it did
// not.
//
// /api/health renders every numeric field as "<n> <key>", so these key names are
// also what a human reads when they ask whether the seed worked.

export interface CloneCounts {
  members: number;
  organizations: number;
  posts: number;
  comments: number;
  reactions: number;
}

export function countAll(db: Database): CloneCounts {
  return {
    members: countMembers(db),
    organizations: countOrganizations(db),
    posts: countPosts(db),
    comments: countComments(db),
    reactions: countReactions(db),
  };
}
