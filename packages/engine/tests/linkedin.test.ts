import { describe, it, expect } from "vitest";
import type { LinkedInSnapshot } from "@sonata/core";
import { diffLinkedIn, renderLinkedInDiff } from "../src/adapters/linkedin";

// The LinkedIn diff, offline. This is the half of the adapter an old artifact is
// re-judged through months after the twin that produced it stopped running, so
// it is held to two captures and no server; the live half is exercised against a
// twin on 3800.

type Post = LinkedInSnapshot["posts"][number];
type Comment = LinkedInSnapshot["comments"][number];

const PAGE = "urn:li:organization:1400361";

const snap = (posts: Post[], comments: Comment[] = []): LinkedInSnapshot => ({
  twin: "linkedin",
  capturedAt: 0,
  posts,
  comments,
});

const post = (over: Partial<Post> & { postUrn: string }): Post => ({
  author: PAGE,
  commentary: "We are hiring two dispatchers.",
  lifecycleState: "PUBLISHED",
  commentCount: 0,
  reactionCount: 0,
  ...over,
});

const comment = (over: Partial<Comment> & { commentUrn: string; postUrn: string }): Comment => ({
  actor: "urn:li:person:dana",
  text: "Are these remote roles?",
  isReply: false,
  ...over,
});

describe("linkedin diff", () => {
  it("reads a draft going live as a publication, not an edit", () => {
    const before = snap([post({ postUrn: "urn:li:activity:1", lifecycleState: "DRAFT" })]);
    const after = snap([post({ postUrn: "urn:li:activity:1" })]);
    const diff = diffLinkedIn(before, after);
    expect(diff.posted).toEqual([
      { postUrn: "urn:li:activity:1", author: PAGE, commentary: "We are hiring two dispatchers." },
    ]);
    expect(diff.edited).toEqual([]);
  });

  it("separates a rewrite from a publication", () => {
    const before = snap([post({ postUrn: "urn:li:activity:1" })]);
    const after = snap([post({ postUrn: "urn:li:activity:1", commentary: "Now remote-first." })]);
    expect(diffLinkedIn(before, after).edited).toEqual([
      { postUrn: "urn:li:activity:1", commentary: "Now remote-first." },
    ]);
  });

  it("carries an unattributable reaction as one row per arrival", () => {
    const before = snap([post({ postUrn: "urn:li:activity:1", reactionCount: 1 })]);
    const after = snap([post({ postUrn: "urn:li:activity:1", reactionCount: 4 })]);
    const diff = diffLinkedIn(before, after);
    // Three rows, because the count is the only fact the capture holds, and
    // blank fields because this surface never says who reacted to a post.
    expect(diff.reactionsAdded).toHaveLength(3);
    expect(new Set(diff.reactionsAdded.map((r) => r.actor))).toEqual(new Set([""]));
    // Named by the post's own words: a URN tells a judge nothing about which
    // post the engagement landed on.
    expect(renderLinkedInDiff(diff)).toContain(
      '3 reaction(s) arrived on "We are hiring two dispatchers."',
    );
  });

  it("reports a post that left the finder as deleted", () => {
    const before = snap([post({ postUrn: "urn:li:activity:1" })]);
    // The words come off the BEFORE capture: a deleted post is gone from the
    // later one, and "- deleted urn:li:activity:1" names nothing a reader knows.
    expect(diffLinkedIn(before, snap([])).deleted).toEqual([
      { postUrn: "urn:li:activity:1", commentary: "We are hiring two dispatchers." },
    ]);
  });

  it("does not call a post deleted when the capture window was full", () => {
    // Fifty is the per-author cap, so a fifty-post window means older posts fell
    // out of the capture rather than off the page — unknowable, and reporting it
    // as destruction would put a deletion the agent never made in front of the
    // judge.
    const full = Array.from({ length: 50 }, (_, i) => post({ postUrn: `urn:li:activity:${i}` }));
    const before = snap([...full, post({ postUrn: "urn:li:activity:older" })]);
    expect(diffLinkedIn(before, snap(full)).deleted).toEqual([]);
  });

  it("counts a post as touched when the only thing that moved was a comment on it", () => {
    const posts = [post({ postUrn: "urn:li:activity:1" }), post({ postUrn: "urn:li:activity:2" })];
    const after = snap(posts, [
      comment({ commentUrn: "urn:li:comment:(urn:li:activity:1,9)", postUrn: "urn:li:activity:1" }),
    ]);
    const diff = diffLinkedIn(snap(posts), after);
    expect(diff.commented).toHaveLength(1);
    expect(diff.unchangedCount).toBe(1);
  });

  it("counts the untouched and never lists them", () => {
    const posts = [post({ postUrn: "urn:li:activity:1" }), post({ postUrn: "urn:li:activity:2" })];
    expect(diffLinkedIn(snap(posts), snap(posts))).toEqual({
      twin: "linkedin",
      posted: [],
      edited: [],
      deleted: [],
      commented: [],
      reactionsAdded: [],
      unchangedCount: 2,
    });
  });

  it("renders as prose a person can check", () => {
    const before = snap([post({ postUrn: "urn:li:activity:1" })]);
    const after = snap(
      [post({ postUrn: "urn:li:activity:1" }), post({ postUrn: "urn:li:activity:2", commentary: "Update." })],
      // Realistic comment ids: the twin mints equal-width snowflakes, so the
      // lexical sort below is creation order, and an answer renders under the
      // question it answers.
      [
        comment({
          commentUrn: "urn:li:comment:(urn:li:activity:1,7490331947831091876)",
          postUrn: "urn:li:activity:1",
        }),
        comment({
          commentUrn: "urn:li:comment:(urn:li:activity:1,7493636870121413426)",
          postUrn: "urn:li:activity:1",
          actor: PAGE,
          text: "Yes — remote-first.",
          isReply: true,
        }),
      ],
    );
    // Every actor and every post named the way a reader knows them. The URNs are
    // still in the diff for anything that needs to address a post; they are just
    // not what a judge is asked to reason about.
    expect(renderLinkedInDiff(diffLinkedIn(before, after))).toBe(
      [
        '+ published as the company page: "Update."',
        '+ dana commented on "We are hiring two dispatchers.": "Are these remote roles?"',
        '+ the company page replied under "We are hiring two dispatchers.": "Yes — remote-first."',
        "0 post(s) untouched",
      ].join("\n"),
    );
  });
});
