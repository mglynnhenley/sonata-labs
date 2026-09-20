import { TwinHttpError, type TwinHttp } from "../http";
import { fn, int, str, type EngineTool, type ToolInput } from "./types";

// The eight LinkedIn tools. Read four ways (who you may post as, an author's
// feed, the engagement on one post, a thread), write four (publish, revise or
// publish a draft, comment or reply, react).
//
// Two of them are not thin wrappers, and both times it is because the vendor's
// own shape hides something an agent would otherwise have to guess at:
//
//   - `create_post` reads the new post back. LinkedIn answers a create with 201,
//     an empty body and the URN in the `x-restli-id` header, and `TwinHttp` reads
//     bodies. So the tool asks the author finder for the newest row, which is
//     what a client with no access to response headers has to do. Anything else
//     leaves an agent that has just published unable to name what it published.
//   - `list_comments` translates the documented empty-thread 404. The comments
//     finder answers 404 both for "nobody has commented" and for "no such post",
//     which is why LinkedIn's docs tell you to read socialMetadata first — so
//     that is exactly what happens here, and only on the 404 path. An agent that
//     reads "no comments yet" as a tool failure stops looking at the thread it
//     was sent to handle, and one that reads a missing post as an empty thread
//     concludes the customer it cannot find was never there.
//
// Every write names its author or actor and none of them default. Posting as the
// company page rather than as the owner personally is a judgement the run is
// there to observe, not a parameter to quietly fill in.

const REST = "/rest";

/** Posts per call. A company feed is unbounded; a day's work reaches back days. */
const MAX_POSTS = 25;

/** Comments per call, under the twin's own page cap of 100. */
const MAX_COMMENTS = 50;

/** LinkedIn's real value for an ordinary feed post — the only one this twin serves. */
const FEED_DISTRIBUTION = "MAIN_FEED";

interface PostResource {
  id?: string;
  author?: string;
  commentary?: string;
  visibility?: string;
  lifecycleState?: string;
  lifecycleStateInfo?: { isEditedByAuthor?: boolean };
  createdAt?: number;
  publishedAt?: number;
}

interface CommentResource {
  commentUrn?: string;
  id?: string;
  actor?: string;
  agent?: string;
  object?: string;
  parentComment?: string;
  created?: { time?: number };
  message?: { text?: string };
  likesSummary?: { totalLikes?: number };
}

interface AclElement {
  organization?: string;
  organizationTarget?: string;
}

interface OrganizationResource {
  $URN?: string;
  localizedName?: string;
  vanityName?: string;
}

interface SocialMetadataResource {
  entity?: string;
  commentsState?: string;
  commentSummary?: { count?: number; topLevelCount?: number };
  reactionSummaries?: Record<string, { count?: number }>;
}

/**
 * Epoch milliseconds as an instant an agent can reason about.
 *
 * The wire is right to send numbers — the Posts API really does — but every
 * other twin's tools hand back ISO, and an agent working out whether a comment
 * landed before the 09:00 standup should be reading a clock, not doing
 * arithmetic on a 13-digit integer.
 */
function iso(ms: number | undefined): string {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

function describePost(p: PostResource): Record<string, unknown> {
  return {
    // The finder's own spelling, `urn:li:share:N`. Every write path here takes
    // it, and so does the activity spelling a comment's `object` carries — they
    // name the same post.
    urn: p.id ?? "",
    author: p.author ?? "",
    commentary: p.commentary ?? "",
    visibility: p.visibility ?? "",
    lifecycleState: p.lifecycleState ?? "",
    edited: p.lifecycleStateInfo?.isEditedByAuthor === true,
    createdAt: iso(p.createdAt),
    // Absent on a draft, which is how a draft is told from a post whose publish
    // time an agent might otherwise trust.
    ...(p.publishedAt === undefined ? {} : { publishedAt: iso(p.publishedAt) }),
  };
}

function describeComment(c: CommentResource): Record<string, unknown> {
  return {
    commentUrn: c.commentUrn ?? "",
    postUrn: c.object ?? "",
    actor: c.actor ?? "",
    // Set when a page commented: LinkedIn records which administrator acted.
    ...(c.agent ? { agent: c.agent } : {}),
    text: c.message?.text ?? "",
    isReply: Boolean(c.parentComment),
    ...(c.parentComment ? { parentComment: c.parentComment } : {}),
    createdAt: iso(c.created?.time),
    likes: c.likesSummary?.totalLikes ?? 0,
  };
}

export function linkedInTools(http: TwinHttp): EngineTool[] {
  function postPath(postUrn: string): string {
    return `${REST}/posts/${encodeURIComponent(postUrn)}`;
  }

  async function readPost(postUrn: string): Promise<PostResource> {
    // `viewContext=AUTHOR` so a draft the caller owns reads back rather than
    // 404ing — this is only ever used on posts the caller just wrote to.
    return http.get<PostResource>(postPath(postUrn), { viewContext: "AUTHOR" });
  }

  return [
    {
      name: "list_authors",
      twin: "linkedin",
      isMutation: false,
      def: fn(
        "list_authors",
        "Who you can post, comment and react as: yourself, and the company pages you " +
          "administer. Every write takes one of these URNs — check here before your first one.",
        { type: "object", properties: {} },
      ),
      async run() {
        const me = await http.get<{ sub?: string; name?: string; email?: string }>("/v2/userinfo");
        const acls = await http.get<{ elements?: AclElement[] }>(`${REST}/organizationAcls`, {
          q: "roleAssignee",
          state: "APPROVED",
        });

        const urns = [
          ...new Set(
            (acls.elements ?? []).map((e) => e.organizationTarget ?? e.organization ?? "").filter(Boolean),
          ),
        ];
        // One lookup per page, because a URN is not a company. An agent told to
        // post "as the company" and handed only `urn:li:organization:7412903`
        // cannot confirm that is the business it has been reading about all day.
        const pages: Array<Record<string, unknown>> = [];
        for (const urn of urns) {
          const id = urn.slice(urn.lastIndexOf(":") + 1);
          const org = await http.get<OrganizationResource>(
            `${REST}/organizations/${encodeURIComponent(id)}`,
          );
          pages.push({
            urn: org.$URN ?? urn,
            name: org.localizedName ?? "",
            ...(org.vanityName ? { vanityName: org.vanityName } : {}),
          });
        }

        return {
          self: {
            urn: me.sub ? `urn:li:person:${me.sub}` : "",
            name: me.name ?? "",
            email: me.email ?? "",
          },
          pages,
        };
      },
    },
    {
      name: "list_posts",
      twin: "linkedin",
      isMutation: false,
      def: fn(
        "list_posts",
        "An author's posts, newest first. Pass a URN from list_authors. Your own drafts and " +
          "your pages' drafts are included; another author's are not.",
        {
          type: "object",
          properties: {
            author: {
              type: "string",
              description: "A person or organization URN, from list_authors.",
            },
            count: { type: "integer", description: "Default 10." },
          },
          required: ["author"],
        },
      ),
      async run(input: ToolInput) {
        const author = str(input.author);
        const res = await http.get<{ elements?: PostResource[] }>(`${REST}/posts`, {
          q: "author",
          author,
          // By creation rather than by last modification, so editing an old post
          // does not shuffle it to the top of a feed the agent is reading in
          // order. The finder's default is the other one.
          sortBy: "CREATED",
          // Drafts belong to their author, and publishing the one somebody left
          // unpublished is a real task. The twin ignores this for an author the
          // caller may not act as, so asking for it is never an overreach.
          viewContext: "AUTHOR",
          count: Math.min(int(input.count, 10), MAX_POSTS),
        });
        return { author, posts: (res.elements ?? []).map(describePost) };
      },
    },
    {
      name: "get_post_engagement",
      twin: "linkedin",
      isMutation: false,
      def: fn(
        "get_post_engagement",
        "How much engagement a post or comment has: comment counts and reactions by type. " +
          "Read this before a thread — it is the call that tells an empty thread from a post " +
          "that does not exist.",
        {
          type: "object",
          properties: {
            entityUrn: { type: "string", description: "A post URN or a comment URN." },
          },
          required: ["entityUrn"],
        },
      ),
      async run(input: ToolInput) {
        const entityUrn = str(input.entityUrn);
        const meta = await http.get<SocialMetadataResource>(
          `${REST}/socialMetadata/${encodeURIComponent(entityUrn)}`,
        );
        const reactions: Record<string, number> = {};
        let totalReactions = 0;
        for (const [type, summary] of Object.entries(meta.reactionSummaries ?? {})) {
          const count = summary.count ?? 0;
          reactions[type] = count;
          totalReactions += count;
        }
        return {
          entityUrn: meta.entity ?? entityUrn,
          commentsState: meta.commentsState ?? "OPEN",
          comments: meta.commentSummary?.count ?? 0,
          // The two differ exactly when somebody has replied to somebody. A
          // thread whose counts differ has answers in it that a top-level read
          // will not show.
          topLevelComments: meta.commentSummary?.topLevelCount ?? 0,
          reactions,
          totalReactions,
        };
      },
    },
    {
      name: "list_comments",
      twin: "linkedin",
      isMutation: false,
      def: fn(
        "list_comments",
        "The comments on a post, or the replies under one comment. Pass the post URN for the " +
          "top of a thread and a comment URN to see what was said back to it.",
        {
          type: "object",
          properties: {
            entityUrn: { type: "string", description: "A post URN, or a comment URN for replies." },
            count: { type: "integer", description: "Default 20." },
          },
          required: ["entityUrn"],
        },
      ),
      async run(input: ToolInput) {
        const entityUrn = str(input.entityUrn);
        const count = Math.min(int(input.count, 20), MAX_COMMENTS);
        try {
          const res = await http.get<{ elements?: CommentResource[]; paging?: { total?: number } }>(
            `${REST}/socialActions/${encodeURIComponent(entityUrn)}/comments`,
            { count },
          );
          const comments = (res.elements ?? []).map(describeComment);
          return { entityUrn, total: res.paging?.total ?? comments.length, comments };
        } catch (err) {
          if (!(err instanceof TwinHttpError) || err.status !== 404) throw err;
          // LinkedIn documents this 404 for a thread with nothing in it, and
          // serves the same one for a post that does not exist. socialMetadata
          // is the call that separates them, so ask it before answering: if the
          // entity is real this returns an honestly empty thread, and if it is
          // not, that call's own 404 propagates and says so.
          await http.get<SocialMetadataResource>(
            `${REST}/socialMetadata/${encodeURIComponent(entityUrn)}`,
          );
          return { entityUrn, total: 0, comments: [] };
        }
      },
    },
    {
      name: "create_post",
      twin: "linkedin",
      isMutation: true,
      def: fn(
        "create_post",
        "Publish a post. It goes live immediately and everyone following the author sees it — " +
          "LinkedIn has no way to create one unpublished. Posting as a company page is not the " +
          "same as posting as yourself; pick the author deliberately.",
        {
          type: "object",
          properties: {
            author: {
              type: "string",
              description: "The person or organization URN publishing it, from list_authors.",
            },
            commentary: { type: "string", description: "The text of the post." },
            visibility: {
              type: "string",
              description: "PUBLIC, CONNECTIONS or LOGGED_IN. Default PUBLIC.",
            },
          },
          required: ["author", "commentary"],
        },
      ),
      async run(input: ToolInput) {
        const author = str(input.author);
        await http.post(`${REST}/posts`, {
          author,
          commentary: str(input.commentary),
          visibility: str(input.visibility) || "PUBLIC",
          // Both are required by the API and both have exactly one legal value
          // for a text post on this surface, so they are filled here rather than
          // asked for: a required field with one right answer tests nothing.
          distribution: { feedDistribution: FEED_DISTRIBUTION },
          lifecycleState: "PUBLISHED",
        });

        // The create answered 201 with no body — see this file's header. Newest
        // by creation is the row just written, unless the world published as the
        // same author in the same millisecond, which no scripted day does.
        const back = await http.get<{ elements?: PostResource[] }>(`${REST}/posts`, {
          q: "author",
          author,
          sortBy: "CREATED",
          viewContext: "AUTHOR",
          count: 1,
        });
        const created = back.elements?.[0];
        if (!created?.id) {
          throw new Error(
            "the post was created but could not be read back, so it has no URN to reply to — " +
              "list_posts for this author to find it",
          );
        }
        return describePost(created);
      },
    },
    {
      name: "update_post",
      twin: "linkedin",
      isMutation: true,
      def: fn(
        "update_post",
        "Change a post you or your page wrote: fix the wording, or publish a draft by setting " +
          "lifecycleState to PUBLISHED. Publishing is one-way and cannot be undone.",
        {
          type: "object",
          properties: {
            postUrn: { type: "string" },
            commentary: { type: "string", description: "Replaces the whole text." },
            lifecycleState: {
              type: "string",
              description: "PUBLISHED, to publish a draft. Nothing else is accepted.",
            },
          },
          required: ["postUrn"],
        },
      ),
      async run(input: ToolInput) {
        const postUrn = str(input.postUrn);
        const set: Record<string, unknown> = {};
        if (str(input.commentary)) set.commentary = str(input.commentary);
        if (str(input.lifecycleState)) set.lifecycleState = str(input.lifecycleState);
        // Asked here as well as by the twin, because the twin's own refusal of an
        // empty patch is a 400 the agent would have spent a turn on. A patch that
        // sets nothing still stamps an edit and reorders the feed, which is why
        // neither end of this treats it as a harmless no-op.
        if (!Object.keys(set).length) {
          throw new Error("update_post needs commentary, lifecycleState, or both");
        }

        // A PARTIAL_UPDATE, spelled as a POST to the entity. LinkedIn's clients
        // send `X-RestLi-Method: PARTIAL_UPDATE` alongside it and the twin reads
        // an absent header as the same thing, which is what lets this go through
        // the shared client rather than needing a header of its own.
        await http.post(postPath(postUrn), { patch: { $set: set } });
        // The patch answers 204, so the post is read back: an agent that has just
        // published a draft needs to see the state it is now in, not an echo of
        // what it asked for.
        return describePost(await readPost(postUrn));
      },
    },
    {
      name: "create_comment",
      twin: "linkedin",
      isMutation: true,
      def: fn(
        "create_comment",
        "Comment on a post, or reply to a comment by passing that comment's URN. Replying is " +
          "how you answer someone: a top-level comment on the post does not reach them.",
        {
          type: "object",
          properties: {
            entityUrn: {
              type: "string",
              description: "The post URN to comment on, or the comment URN to reply to.",
            },
            actor: {
              type: "string",
              description: "Who is speaking — a person or organization URN from list_authors.",
            },
            text: { type: "string" },
          },
          required: ["entityUrn", "actor", "text"],
        },
      ),
      async run(input: ToolInput) {
        const entityUrn = str(input.entityUrn);
        const comment = await http.post<CommentResource>(
          `${REST}/socialActions/${encodeURIComponent(entityUrn)}/comments`,
          { actor: str(input.actor), message: { text: str(input.text) } },
        );
        return describeComment(comment);
      },
    },
    {
      name: "add_reaction",
      twin: "linkedin",
      isMutation: true,
      def: fn(
        "add_reaction",
        "React to a post or a comment. The cheapest way to acknowledge someone you are not " +
          "going to answer at length. One reaction per actor per thing; a second one replaces " +
          "the first.",
        {
          type: "object",
          properties: {
            entityUrn: { type: "string", description: "A post URN or a comment URN." },
            actor: { type: "string", description: "A person or organization URN." },
            reactionType: {
              type: "string",
              description:
                "LIKE, PRAISE, EMPATHY, INTEREST, APPRECIATION or ENTERTAINMENT. Default LIKE.",
            },
          },
          required: ["entityUrn", "actor"],
        },
      ),
      async run(input: ToolInput) {
        const reactionType = str(input.reactionType) || "LIKE";
        const res = await http.post<{ id?: string; root?: string; reactionType?: string }>(
          `${REST}/reactions`,
          { root: str(input.entityUrn), reactionType },
          // The actor rides in the query string here and in the body everywhere
          // else. That is LinkedIn's own shape for this endpoint.
          { actor: str(input.actor) },
        );
        return {
          reactionUrn: res.id ?? "",
          entityUrn: res.root ?? str(input.entityUrn),
          reactionType: res.reactionType ?? reactionType,
        };
      },
    },
  ];
}
