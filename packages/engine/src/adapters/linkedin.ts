import {
  emailOf,
  owner,
  resolveTwinApiUrl,
  type AgentTrace,
  type BeatBody,
  type EpisodeSpec,
  type InjectContext,
  type InjectedRef,
  type JudgeStep,
  type LinkedInDiff,
  type LinkedInSnapshot,
  type PersonRef,
  type TwinAdapter,
  type TwinAuditRow,
  type TwinDiff,
  type TwinHealth,
  type TwinSnapshot,
} from "@sonata/core";
import { createTwinHttp, TwinHttpError, type TwinHttpOptions } from "../http";
import { projectTwinTrace } from "../project";
import { auditViaActivity, byKey, clip, healthViaApi, resetViaApi } from "./shared";

// The LinkedIn twin, behind @sonata/core's TwinAdapter.
//
// Capture goes through the versioned /rest surface the agent uses — the author
// finder, socialMetadata, the comments finder — so a snapshot can only ever see
// what the agent could have changed. `diff` and `renderDiff` are pure, so a
// finished run can be re-diffed months later with nothing running.
//
// Two things about this surface shape everything below:
//
//   - One numeric id backs a post's share, ugcPost and activity URNs, and the
//     twin accepts all three everywhere. The snapshot therefore stores exactly
//     one spelling — the ACTIVITY urn, which is what socialMetadata echoes and
//     what every comment URN embeds. A snapshot keyed on two spellings of one
//     post reports it as created and deleted in the same diff.
//   - A comment is where the work lands. Answering the customer nobody answered
//     is this clone's headline task, and an answer is a REPLY, so the capture
//     descends one level into every thread that has one.

/** Posts captured per author. A company page's feed is unbounded; a day is not. */
const MAX_POSTS_PER_AUTHOR = 50;

/** Comment digests in one snapshot, across every post. */
const MAX_COMMENTS = 300;

/** The comments finder's page, and its documented cap. */
const COMMENT_PAGE = 100;

const MAX_TEXT = 240;

const REST = "/rest";

/** Reaction vocabulary, as the twin and the real API both spell it. */
export type LinkedInReactionType =
  | "LIKE"
  | "PRAISE"
  | "EMPATHY"
  | "INTEREST"
  | "APPRECIATION"
  | "ENTERTAINMENT";

// ---------------------------------------------------------------------------
// Beats.
//
// `BeatBody` in @sonata/core has no LinkedIn arm yet, so these live here and are
// exported for core to absorb — see the adapter's report. Everything below is
// structurally what core's other beat bodies look like, and `inject` narrows a
// `BeatBody` through the union of the two, so the day core grows the arm this
// file keeps compiling unchanged.
// ---------------------------------------------------------------------------

export interface LinkedInPostPayload {
  /**
   * The member publishing it. Omitted means the COMPANY PAGE publishes — the
   * actor an agent's own posts carry, and the one a story usually wants. It is
   * an absence rather than a sentinel string because a `PersonRef` is a string
   * too, and `"organization" | PersonRef` erases to `string`.
   */
  from?: PersonRef;
  commentary: string;
  visibility?: "PUBLIC" | "CONNECTIONS" | "LOGGED_IN";
}

export interface LinkedInCommentPayload {
  /** The beat whose post this comments on. */
  postRef?: string;
  /** The beat whose comment this answers. Threads are one level deep. */
  parentRef?: string;
  /** Omitted means the company page answered — see `LinkedInPostPayload.from`. */
  from?: PersonRef;
  text: string;
}

export interface LinkedInReactionPayload {
  /** The beat whose post or comment is being reacted to. */
  entityRef: string;
  from?: PersonRef;
  reactionType?: LinkedInReactionType;
}

export type LinkedInBeatBody =
  | { twin: "linkedin"; kind: "post"; payload: LinkedInPostPayload }
  | { twin: "linkedin"; kind: "comment"; payload: LinkedInCommentPayload }
  | { twin: "linkedin"; kind: "reaction"; payload: LinkedInReactionPayload };

/**
 * The one place the two unions meet, and the reason it is a function: a beat
 * arrives typed as core's `BeatBody`, which cannot yet be a LinkedIn beat, so
 * the widening has to happen at a parameter — where the declared type is the
 * union of both and the check below is a real check rather than a cast that
 * would go on compiling after core grows the arm and the shapes drift.
 */
function linkedInBeat(body: BeatBody | LinkedInBeatBody): LinkedInBeatBody {
  if (body.twin !== "linkedin") {
    throw new Error(`linkedin adapter cannot inject a ${body.twin} beat`);
  }
  return body;
}

// ---------------------------------------------------------------------------
// Wire shapes, as the twin serves them
// ---------------------------------------------------------------------------

interface PostResource {
  id?: string;
  author?: string;
  commentary?: string;
  lifecycleState?: string;
}

interface CommentResource {
  commentUrn?: string;
  object?: string;
  actor?: string;
  parentComment?: string;
  message?: { text?: string };
}

interface SocialMetadataResource {
  commentSummary?: { count?: number; topLevelCount?: number };
  reactionSummaries?: Record<string, { count?: number }>;
}

interface AclElement {
  organization?: string;
  organizationTarget?: string;
  state?: string;
}

/** Both id spellings collapse onto the activity URN — see the header comment. */
function activityUrnOf(urn: string): string {
  const m = /^urn:li:(?:share|ugcPost|activity):(\d+)$/.exec(urn);
  return m ? `urn:li:activity:${m[1]}` : urn;
}

/**
 * A person id for the LinkedIn seed, derived from the cast's own id.
 *
 * A LinkedIn person id is base64url, so anything outside that alphabet has to
 * go or every URN built from it fails to parse. Two cast ids that collapse to
 * the same string are the twin's 400 — it names both people and says so — which
 * is the right failure: merging two identities silently is how "Priya in the
 * comments" stops being "Priya in the inbox".
 */
export function personIdFor(castId: string): string {
  return castId.replace(/[^A-Za-z0-9_-]+/g, "-");
}

/**
 * A stable numeric id for the company page, derived from the business name.
 *
 * Organization ids are decimal at LinkedIn, so one has to be minted rather than
 * carried over from the cast. Derived rather than constant so two worlds seeded
 * into the same twin get different pages, and deterministic so re-seeding the
 * same world twice produces the same URNs — an artifact from yesterday's run
 * still names the page it named yesterday.
 */
export function organizationIdFor(businessName: string): string {
  let hash = 2166136261;
  for (let i = 0; i < businessName.length; i++) {
    hash = Math.imul(hash ^ businessName.charCodeAt(i), 16777619);
  }
  // Seven digits, like a real page id, and never zero-length.
  return String((hash >>> 0) % 9_000_000 + 1_000_000);
}

function vanityNameFor(businessName: string): string {
  return businessName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export interface LinkedInAdapterOptions extends Omit<TwinHttpOptions, "baseUrl"> {
  baseUrl?: string;
}

export function createLinkedInAdapter(opts: LinkedInAdapterOptions = {}): TwinAdapter {
  const baseUrl = resolveTwinApiUrl("linkedin", process.env, { override: opts.baseUrl });
  // Through createTwinHttp, which knows this twin refuses any /rest call with no
  // LinkedIn-Version header.
  const http = createTwinHttp("linkedin", { ...opts, baseUrl });

  /** The owner's own person URN, as the agent reads it off /v2/userinfo. */
  async function ownerUrn(): Promise<string> {
    const me = await http.get<{ sub?: string }>("/v2/userinfo");
    if (!me.sub) throw new Error("linkedin /v2/userinfo returned no sub — is the twin seeded?");
    return `urn:li:person:${me.sub}`;
  }

  /** The pages the owner may act as, discovered the way an agent discovers them. */
  async function adminPages(): Promise<string[]> {
    const res = await http.get<{ elements?: AclElement[] }>(`${REST}/organizationAcls`, {
      q: "roleAssignee",
      state: "APPROVED",
    });
    const urns = (res.elements ?? [])
      .map((e) => e.organizationTarget ?? e.organization ?? "")
      .filter(Boolean);
    return [...new Set(urns)];
  }

  /** A post, alongside the one thing about its thread the row cannot hold. */
  interface CapturedPost {
    post: LinkedInSnapshot["posts"][number];
    /** `count > topLevelCount`, i.e. somebody answered somebody in this thread. */
    hasReplies: boolean;
  }

  async function capturePosts(author: string): Promise<CapturedPost[]> {
    const res = await http.get<{ elements?: PostResource[] }>(`${REST}/posts`, {
      q: "author",
      author,
      // Sorted by creation, not by last modification: the default ordering moves
      // a post every time it is edited, so two snapshots of an untouched feed
      // could hold different windows and the cap would read as a deletion.
      sortBy: "CREATED",
      // The owner's drafts are part of what the agent can change — publishing the
      // one the CEO left is a lifecycle move the diff has to be able to see — and
      // the twin only honours this for an author the caller may act as, which is
      // exactly the set being asked about here.
      viewContext: "AUTHOR",
      // Capped rather than paged: two snapshots ship inside every run artifact
      // and live there forever, and this window is newest-first, so what it sheds
      // is what an agent working today is least likely to have touched.
      count: MAX_POSTS_PER_AUTHOR,
    });

    const out: CapturedPost[] = [];
    for (const p of res.elements ?? []) {
      if (!p.id) continue;
      const postUrn = activityUrnOf(p.id);
      const lifecycleState = p.lifecycleState ?? "PUBLISHED";
      // A draft has no engagement and no reader but its author: socialMetadata
      // answers 404 for one, so asking would turn a legitimate state into an
      // error. Zero is the true count either way.
      const engagement =
        lifecycleState === "DRAFT"
          ? { comments: 0, reactions: 0, topLevel: 0 }
          : await captureEngagement(postUrn);
      out.push({
        post: {
          postUrn,
          author: p.author ?? "",
          commentary: clip(p.commentary ?? "", MAX_TEXT),
          lifecycleState,
          commentCount: engagement.comments,
          reactionCount: engagement.reactions,
        },
        hasReplies: engagement.comments > engagement.topLevel,
      });
    }
    return out;
  }

  /**
   * The engagement on one post, in the single call LinkedIn provides for it —
   * and the call its own docs tell you to make before the comments finder, since
   * that finder cannot tell an empty thread from a post that does not exist.
   */
  async function captureEngagement(postUrn: string): Promise<{
    comments: number;
    reactions: number;
    topLevel: number;
  }> {
    const meta = await http.get<SocialMetadataResource>(
      `${REST}/socialMetadata/${encodeURIComponent(postUrn)}`,
    );
    return {
      comments: meta.commentSummary?.count ?? 0,
      // Summed across types: the snapshot has one number for a post's reactions,
      // so which flavour they were does not survive the capture.
      reactions: Object.values(meta.reactionSummaries ?? {}).reduce(
        (sum, r) => sum + (r.count ?? 0),
        0,
      ),
      topLevel: meta.commentSummary?.topLevelCount ?? 0,
    };
  }

  function digest(c: CommentResource, postUrn: string): LinkedInSnapshot["comments"][number] {
    return {
      commentUrn: c.commentUrn ?? "",
      postUrn,
      actor: c.actor ?? "",
      text: clip(c.message?.text ?? "", MAX_TEXT),
      isReply: Boolean(c.parentComment),
    };
  }

  /**
   * Comments under a post or a comment. LinkedIn answers 404 rather than an
   * empty page when there are none — documented behaviour, not a fault — and
   * under a comment that is simply "nobody replied to this one", which is the
   * common case and must not abort a snapshot.
   */
  async function commentsUnder(entityUrn: string, count: number): Promise<CommentResource[]> {
    try {
      const res = await http.get<{ elements?: CommentResource[] }>(
        `${REST}/socialActions/${encodeURIComponent(entityUrn)}/comments`,
        { count: Math.min(COMMENT_PAGE, count) },
      );
      return res.elements ?? [];
    } catch (err) {
      if (err instanceof TwinHttpError && err.status === 404) return [];
      throw err;
    }
  }

  async function captureThread(
    postUrn: string,
    hasReplies: boolean,
    budget: number,
  ): Promise<LinkedInSnapshot["comments"]> {
    const out = (await commentsUnder(postUrn, budget)).map((c) => digest(c, postUrn));

    // One extra call per top-level comment, and only when socialMetadata has
    // already said the thread is deeper than its top level — the two counts
    // differ exactly when replies exist. Worth the calls: an agent's answer to a
    // customer IS a reply, so a capture that stopped at the top level would miss
    // the artifact the run is about.
    if (hasReplies) {
      for (const parent of [...out]) {
        if (out.length >= budget) break;
        const replies = await commentsUnder(parent.commentUrn, budget - out.length);
        for (const r of replies) out.push(digest(r, postUrn));
      }
    }
    return out;
  }

  /** One beat into the page. The route batches, but a beat is one thing. */
  async function injected(request: Record<string, unknown>): Promise<{
    posts: Array<{ id?: string }>;
    comments: Array<{ commentUrn?: string; postUrn?: string }>;
    reactions: Array<{ entityUrn?: string; actorUrn?: string }>;
  }> {
    try {
      const res = await http.post<{
        injected?: {
          posts?: Array<{ id?: string }>;
          comments?: Array<{ commentUrn?: string; postUrn?: string }>;
          reactions?: Array<{ entityUrn?: string; actorUrn?: string }>;
        };
      }>("/api/sandbox/inject", request);
      return {
        posts: res.injected?.posts ?? [],
        comments: res.injected?.comments ?? [],
        reactions: res.injected?.reactions ?? [],
      };
    } catch (err) {
      if (err instanceof TwinHttpError && err.status === 404) {
        throw new Error(
          "The linkedin twin has no POST /api/sandbox/inject route. Scripted beats and " +
            "director events need it: the /rest write paths post as the owner and log an " +
            "audit row, which would put a customer's comment in the agent's record.",
        );
      }
      throw err;
    }
  }

  /**
   * The actor half of a beat, in the twin's own two-field spelling. An absent
   * `from` is the company page; a ref outside the cast keeps its raw value so
   * the twin refuses it by name rather than posting as somebody else.
   */
  function actorOf(ctx: InjectContext, from: PersonRef | undefined): Record<string, string> {
    return from
      ? { actorKind: "member", actorEmail: emailOf(ctx.world, from) }
      : { actorKind: "organization" };
  }

  return {
    name: "linkedin",
    baseUrl,

    health(): Promise<TwinHealth> {
      return healthViaApi(http, "linkedin");
    },

    async snapshot(): Promise<TwinSnapshot> {
      // Every author the owner can write as, which is the whole of what the
      // agent could have changed: their own feed, and the pages they administer.
      const authors = [await ownerUrn(), ...(await adminPages())];

      const captured: CapturedPost[] = [];
      for (const author of authors) captured.push(...(await capturePosts(author)));

      const comments: LinkedInSnapshot["comments"] = [];
      for (const { post, hasReplies } of captured) {
        if (comments.length >= MAX_COMMENTS || post.commentCount === 0) continue;
        comments.push(
          ...(await captureThread(post.postUrn, hasReplies, MAX_COMMENTS - comments.length)),
        );
      }

      return {
        twin: "linkedin",
        capturedAt: Date.now(),
        posts: captured.map((c) => c.post),
        comments,
      };
    },

    diff(before: TwinSnapshot, after: TwinSnapshot): TwinDiff {
      return diffLinkedIn(before as LinkedInSnapshot, after as LinkedInSnapshot);
    },

    renderDiff(diff: TwinDiff): string {
      return renderLinkedInDiff(diff as LinkedInDiff);
    },

    async inject(body: BeatBody, ctx: InjectContext): Promise<InjectedRef> {
      const beat = linkedInBeat(body);

      // Everything the world does goes through the sandbox route, never /rest:
      // those endpoints attribute the write to the mailbox owner and log an audit
      // row, and the engine reads that log to decide what the AGENT did.
      if (beat.kind === "post") {
        const p = beat.payload;
        const res = await injected({
          posts: [
            {
              ...actorOf(ctx, p.from),
              commentary: p.commentary,
              ...(p.visibility ? { visibility: p.visibility } : {}),
              atISO: ctx.atISO,
            },
          ],
        });
        const id = res.posts[0]?.id;
        if (!id) throw new Error("linkedin inject returned no post id");
        // The activity spelling, so a later comment or reaction beat resolves to
        // the URN both of those routes canonicalise to anyway.
        return { twin: "linkedin", id: `urn:li:activity:${id}` };
      }

      if (beat.kind === "comment") {
        const p = beat.payload;
        const parent = p.parentRef ? ctx.resolve(p.parentRef) : undefined;
        const post = p.postRef ? ctx.resolve(p.postRef) : undefined;
        // A comment must land on something. Unlike a Gmail follow-up, which can
        // post standalone when its ref is missing, an orphan comment has nowhere
        // to go — so this is loud rather than silently top-level.
        if (!parent && !post) {
          throw new Error(
            `comment targets "${p.parentRef ?? p.postRef ?? "nothing"}", which nothing created`,
          );
        }
        const res = await injected({
          comments: [
            {
              ...actorOf(ctx, p.from),
              ...(parent ? { parentCommentUrn: parent.id } : { postUrn: post?.id }),
              text: p.text,
              atISO: ctx.atISO,
            },
          ],
        });
        const created = res.comments[0];
        if (!created?.commentUrn) throw new Error("linkedin inject returned no comment urn");
        return {
          twin: "linkedin",
          id: created.commentUrn,
          ...(created.postUrn ? { containerId: activityUrnOf(created.postUrn) } : {}),
        };
      }

      const p = beat.payload;
      const target = ctx.resolve(p.entityRef);
      if (!target) throw new Error(`reaction targets "${p.entityRef}", which nothing created`);
      const res = await injected({
        reactions: [
          {
            ...actorOf(ctx, p.from),
            entityUrn: target.id,
            reactionType: p.reactionType ?? "LIKE",
            atISO: ctx.atISO,
          },
        ],
      });
      // A reaction has no identity of its own here either: it belongs to the post
      // or comment it decorates, so the handle points back at that.
      return { twin: "linkedin", id: res.reactions[0]?.entityUrn ?? target.id };
    },

    /**
     * Seeds the cast, the company page and the owner's administrator role — no
     * posts, the same deal the other twins get. The page's history is
     * @sonata/world's job; an `EpisodeSpec` carries none, so inventing one here
     * would invent a different one per run.
     */
    async seed(spec: EpisodeSpec): Promise<void> {
      try {
        await http.post("/api/sandbox/seed", seedBodyFor(spec));
      } catch (err) {
        if (err instanceof TwinHttpError && err.status === 404) {
          throw new Error(
            "The linkedin twin has no POST /api/sandbox/seed route, so the world could not be " +
              "loaded into it. Seed it out of band and run with seedWorld: false.",
          );
        }
        throw err;
      }
    },

    reset(): Promise<void> {
      return resetViaApi(http, "episode reset");
    },

    auditSince(sinceId: number): Promise<TwinAuditRow[]> {
      return auditViaActivity(http, "linkedin", sinceId, { sinceId, limit: 1000 });
    },

    projectTrace(trace: AgentTrace): JudgeStep[] {
      return projectTwinTrace(trace, "linkedin");
    },
  };
}

/**
 * The body `POST /api/sandbox/seed` takes here.
 *
 * Deliberately not `seedBodyFor` from ./shared: that helper knows three twins
 * and falls through to Slack's shape, which this twin answers with a 400. Every
 * cast member gets a LinkedIn identity because a commenter the page has never
 * heard of is refused by name, and the owner gets the page: a page nobody
 * administers cannot be posted to, which would make the headline task
 * impossible.
 */
export function seedBodyFor(spec: EpisodeSpec): Record<string, unknown> {
  const world = spec.world;
  const me = owner(world);
  return {
    twin: "linkedin",
    seed: {
      world,
      nowISO: new Date(Date.parse(spec.clock.startISO) || Date.now()).toISOString(),
      promoteToSnapshot: true,
      ownerEmail: me.email,
      organization: {
        id: organizationIdFor(world.business.name),
        name: world.business.name,
        vanityName: vanityNameFor(world.business.name),
      },
      members: world.cast.map((p) => ({ email: p.email, personId: personIdFor(p.id) })),
      posts: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Diff — pure. Keyed by the activity URN for a post and by the composite URN for
// a comment: both survive an edit, a publish and a reply, which is exactly the
// set of changes this surface can record.
// ---------------------------------------------------------------------------

const byPost = byKey<{ postUrn: string }>((p) => p.postUrn);

export function diffLinkedIn(before: LinkedInSnapshot, after: LinkedInSnapshot): LinkedInDiff {
  const beforePosts = new Map(before.posts.map((p) => [p.postUrn, p]));
  const afterPosts = new Map(after.posts.map((p) => [p.postUrn, p]));

  const posted: LinkedInDiff["posted"] = [];
  const edited: LinkedInDiff["edited"] = [];
  const deleted: LinkedInDiff["deleted"] = [];
  const reactionsAdded: LinkedInDiff["reactionsAdded"] = [];
  /** Posts something in this diff mentions — see `unchangedCount` below. */
  const touched = new Set<string>();

  for (const p of after.posts) {
    const prev = beforePosts.get(p.postUrn);
    // A draft becoming published is reported as a publication, not as an edit.
    // Publishing the draft the CEO left is the act a criterion asks about, and
    // filing it under `edited` would render it as a typo fix.
    if (!prev || (prev.lifecycleState === "DRAFT" && p.lifecycleState !== "DRAFT")) {
      posted.push({ postUrn: p.postUrn, author: p.author, commentary: p.commentary });
      touched.add(p.postUrn);
    } else if (prev.commentary !== p.commentary) {
      // Compared on the digest both snapshots stored, so an edit that changes
      // only the tail of a post longer than MAX_TEXT does not register. The
      // alternative is carrying 3000 characters per post in every artifact
      // forever; the bound is stated here because a judge reads silence in a
      // diff as "nothing happened".
      edited.push({ postUrn: p.postUrn, commentary: p.commentary });
      touched.add(p.postUrn);
    }

    if (prev && p.reactionCount > prev.reactionCount) {
      // One row per reaction that arrived, every one of them anonymous.
      //
      // There is no reactions finder on this surface — socialMetadata answers
      // with counts, and a `LinkedInSnapshot` post carries a single number — so
      // who reacted, and with which of the six flavours, is not something the
      // capture could have known. The length of this list is the only fact
      // there is, and it is left as the length rather than folded into a field:
      // the judge prompt writes its own renderer over `LinkedInDiff`, and a
      // count smuggled into `actor` would be printed there as somebody's name.
      for (let i = prev.reactionCount; i < p.reactionCount; i++) {
        reactionsAdded.push({ entityUrn: p.postUrn, actor: "", reactionType: "" });
      }
      touched.add(p.postUrn);
    }
  }

  // Gone from the finder entirely — the twin tombstones a delete, so this is the
  // only trace destruction leaves. Each author's window is capped independently,
  // so a full window means older posts fell out of it rather than off the page;
  // that eviction is unknowable from here and is left out rather than reported
  // as a deletion.
  const atCap = new Set(
    [...countBy(after.posts, (p) => p.author)]
      .filter(([, n]) => n >= MAX_POSTS_PER_AUTHOR)
      .map(([author]) => author),
  );
  for (const p of before.posts) {
    if (!afterPosts.has(p.postUrn) && !atCap.has(p.author)) {
      deleted.push({ postUrn: p.postUrn });
      touched.add(p.postUrn);
    }
  }

  const beforeComments = new Set(before.comments.map((c) => c.commentUrn));
  const commented: LinkedInDiff["commented"] = [];
  for (const c of after.comments) {
    if (beforeComments.has(c.commentUrn)) continue;
    commented.push({
      commentUrn: c.commentUrn,
      postUrn: c.postUrn,
      actor: c.actor,
      text: c.text,
      isReply: c.isReply,
    });
    touched.add(c.postUrn);
  }

  return {
    twin: "linkedin",
    posted: posted.sort(byPost),
    edited: edited.sort(byPost),
    deleted: deleted.sort(byPost),
    commented: commented.sort(byKey((c) => `${c.postUrn} ${c.commentUrn}`)),
    reactionsAdded: reactionsAdded.sort(byKey((r) => r.entityUrn)),
    // Counted, never listed, like every other twin's diff — and counted over
    // posts rather than comments, because a post is what this surface leaves
    // alone. "Untouched" means nothing in this diff mentions it: not published,
    // not edited, not deleted, no new comment on it and no new reaction. That is
    // the question a `untouched` criterion is really asking.
    unchangedCount: after.posts.filter((p) => !touched.has(p.postUrn)).length,
  };
}

function countBy<T>(items: T[], key: (item: T) => string): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

export function renderLinkedInDiff(diff: LinkedInDiff): string {
  const lines: string[] = [];
  for (const p of diff.posted) lines.push(`+ published as ${p.author}: "${p.commentary}"`);
  for (const p of diff.edited) lines.push(`~ edited ${p.postUrn}: "${p.commentary}"`);
  for (const c of diff.commented) {
    lines.push(
      c.isReply
        ? `+ ${c.actor} replied under ${c.postUrn}: "${c.text}"`
        : `+ ${c.actor} commented on ${c.postUrn}: "${c.text}"`,
    );
  }
  // Grouped back up for the reader: the diff holds one row per reaction because
  // that is the only place the number can live, but "four reactions arrived" is
  // the sentence a person checks, not four identical lines.
  for (const [entityUrn, n] of countBy(diff.reactionsAdded, (r) => r.entityUrn)) {
    lines.push(`~ ${n} reaction(s) arrived on ${entityUrn}, from nobody the API will name`);
  }
  for (const p of diff.deleted) lines.push(`- deleted ${p.postUrn}`);
  lines.push(`${diff.unchangedCount} post(s) untouched`);
  return lines.join("\n");
}
