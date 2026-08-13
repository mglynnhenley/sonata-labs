// Acceptance harness: drive the running sandbox the way a real agent would.
//
//   PORT=3800 npm run smoke
//
// Requires the server to be running on $PORT and a seeded page.
//
// The other clones drive their smoke through the vendor's official JavaScript
// SDK with only the base URL overridden. LinkedIn publishes no official
// JavaScript SDK that this repo installs, so this harness speaks the wire
// protocol directly with fetch — which is what an SDK would do anyway, and it
// means the checks below assert the actual bytes: the `x-restli-id` header, the
// EMPTY 201 body on a post create, the 204s. An SDK's interpretation of those
// would hide exactly the details this clone exists to get right.
//
// It resets to the snapshot first, so it is repeatable — and therefore destroys
// whatever world is currently loaded. Never point it at a twin mid-episode.

const PORT = process.env.PORT || "3800";
// 127.0.0.1, not localhost: Node's fetch resolves localhost to ::1 first while
// the Next dev server listens on IPv4 only, and the resulting ECONNREFUSED reads
// as "the twin is down" when it is running fine.
const ROOT_URL = process.env.SANDBOX_ROOT_URL || `http://127.0.0.1:${PORT}`;
const TOKEN = process.env.SANDBOX_TOKEN || "sandbox-token";
const VERSION = "202506";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    if (detail !== undefined) console.log("      detail:", JSON.stringify(detail)?.slice(0, 300));
  }
}

interface CallOptions {
  method?: string;
  body?: unknown;
  token?: string;
  /** Rest.li method discriminator, e.g. PARTIAL_UPDATE. */
  restliMethod?: string;
  /** Set false to omit LinkedIn-Version — the header gate's own test. */
  versioned?: boolean;
}

interface Reply {
  status: number;
  headers: Headers;
  body: Record<string, unknown>;
  text: string;
}

async function call(path: string, opts: CallOptions = {}): Promise<Reply> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${opts.token ?? TOKEN}`,
    "x-restli-protocol-version": "2.0.0",
  };
  if (path.startsWith("/rest/") && opts.versioned !== false) headers["linkedin-version"] = VERSION;
  if (opts.restliMethod) headers["x-restli-method"] = opts.restliMethod;
  if (opts.body !== undefined) headers["content-type"] = "application/json";

  const res = await fetch(`${ROOT_URL}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = {};
  }
  return { status: res.status, headers: res.headers, body, text };
}

/** LinkedIn wants the URN percent-encoded in a path segment. */
const seg = (urn: string) => encodeURIComponent(urn);

// A two-author world for the last block. The demo seed cannot express it: every
// post in it belongs to the owner or to the page they administer, so a draft
// there is always the caller's own and `viewContext=AUTHOR` never has to decide
// whose it is. Wire-seeded worlds routinely do have another member's draft.
const OTHER_AUTHOR_ID = "dK7mQv2XbT";
const OTHER_AUTHOR_URN = `urn:li:person:${OTHER_AUTHOR_ID}`;
const PAGE_DRAFT_URN = "urn:li:share:7490000000000000001";
const OTHER_DRAFT_URN = "urn:li:share:7490000000000000003";
const OWNER_EMAIL = "sandbox.user@gmail.com";
const OTHER_EMAIL = "priya@acme.co";

const OTHER_AUTHORS_DRAFT_SEED = {
  twin: "linkedin",
  seed: {
    world: {
      business: { name: "Acme" },
      cast: [
        { id: "p1", name: "Sandbox User", email: OWNER_EMAIL },
        { id: "p2", name: "Priya Nair", email: OTHER_EMAIL },
      ],
      mailboxOwner: OWNER_EMAIL,
    },
    nowISO: "2026-07-27T09:00:00Z",
    ownerEmail: OWNER_EMAIL,
    organization: { id: "7412903", name: "Acme", vanityName: "acme-co" },
    members: [
      { email: OWNER_EMAIL, personId: "sHq2WpRk9L" },
      { email: OTHER_EMAIL, personId: OTHER_AUTHOR_ID },
    ],
    posts: [
      {
        id: "7490000000000000001",
        authorKind: "organization",
        commentary: "The page's own unpublished draft.",
        visibility: "PUBLIC",
        lifecycleState: "DRAFT",
        publishedISO: "2026-07-27T09:00:00Z",
      },
      {
        id: "7490000000000000002",
        authorKind: "member",
        authorEmail: OTHER_EMAIL,
        commentary: "Priya's published post.",
        visibility: "PUBLIC",
        lifecycleState: "PUBLISHED",
        publishedISO: "2026-07-27T10:00:00Z",
      },
      {
        id: "7490000000000000003",
        authorKind: "member",
        authorEmail: OTHER_EMAIL,
        commentary: "Priya's unpublished draft, which is nobody else's business.",
        visibility: "PUBLIC",
        lifecycleState: "DRAFT",
        publishedISO: "2026-07-27T11:00:00Z",
      },
    ],
  },
};

/** The control plane, which takes the same token under a different header. */
async function control(
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${ROOT_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-sandbox-token": TOKEN },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/**
 * A director's beat. The refusal checks need a post the owner did NOT write, and
 * the seed has none — every seeded post belongs to the owner or to the page they
 * administer, which is exactly why the missing permission gate went unnoticed.
 */
async function inject(body: unknown): Promise<Record<string, unknown>> {
  return (await control("/api/sandbox/inject", body)).body;
}

/**
 * The newest audit row id. Every mutation writes one inside its own transaction,
 * so "this id did not move" is the only way to assert that a call did NOT log —
 * asking whether the rows that exist look like writes cannot fail, because
 * `logAction` is only ever reached from `runMutation` in the first place.
 */
async function maxActionId(): Promise<number> {
  const res = await fetch(`${ROOT_URL}/api/activity?limit=1`);
  const body = (await res.json()) as { actions: Array<{ id: number }> };
  return body.actions[0]?.id ?? 0;
}

async function main(): Promise<void> {
  console.log(`\n\x1b[1mLinkedIn sandbox smoke — ${ROOT_URL}\x1b[0m`);

  const reset = await fetch(`${ROOT_URL}/api/sandbox/reset`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-sandbox-token": TOKEN },
    body: JSON.stringify({ note: "smoke" }),
  });
  check("reset to snapshot", reset.status === 200, await reset.text().catch(() => ""));

  // audit.db survives a reset, so every id assertion below is relative to this
  // line rather than to an empty log — otherwise a previous run's rows would
  // answer for this one.
  const startActionId = await maxActionId();

  // --- identity and discovery -----------------------------------------------

  const me = await call("/v2/userinfo");
  check("/v2/userinfo returns a bare person id", typeof me.body.sub === "string", me.body);
  check("sub is not a URN — the agent builds one", !String(me.body.sub).includes("urn:"), me.body);
  const personUrn = `urn:li:person:${String(me.body.sub)}`;

  const acls = await call(
    `/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED`,
  );
  const aclElements = (acls.body.elements ?? []) as Array<Record<string, string>>;
  check("organizationAcls finds a page the owner administers", aclElements.length > 0, acls.body);
  const orgUrn = aclElements[0]?.organization;
  check("the ACL carries both organization spellings", orgUrn === aclElements[0]?.organizationTarget);
  check(
    "organizationAcls omits paging.total, as LinkedIn does",
    !("total" in ((acls.body.paging ?? {}) as Record<string, unknown>)),
    acls.body.paging,
  );
  if (!orgUrn) throw new Error("no organization ACL — run `npm run seed`");

  const orgId = orgUrn.split(":").pop() ?? "";
  const org = await call(`/rest/organizations/${orgId}`);
  check("the organization URN resolves to a company", org.body.localizedName === "Acme", org.body);
  check("its id comes back as a NUMBER", typeof org.body.id === "number", org.body);

  // --- reads -----------------------------------------------------------------

  const feed = await call(
    `/rest/posts?q=author&author=${seg(orgUrn)}&count=5&sortBy=LAST_MODIFIED`,
  );
  const elements = (feed.body.elements ?? []) as Array<Record<string, unknown>>;
  check("the author finder returns the page's posts", elements.length > 0, feed.body.paging);
  check(
    "publishedAt is a NUMBER, not an ISO string",
    elements.every((e) => typeof e.publishedAt === "number"),
    elements[0],
  );
  check(
    "newest first",
    elements.every(
      (e, i) => i === 0 || (e.lastModifiedAt as number) <= (elements[i - 1].lastModifiedAt as number),
    ),
    elements.map((e) => e.lastModifiedAt),
  );
  check(
    "READER never sees the draft",
    elements.every((e) => e.lifecycleState === "PUBLISHED"),
    elements.map((e) => e.lifecycleState),
  );
  check(
    "posts omit paging.total, as LinkedIn does",
    !("total" in ((feed.body.paging ?? {}) as Record<string, unknown>)),
    feed.body.paging,
  );

  const asAuthor = await call(
    `/rest/posts?q=author&author=${seg(orgUrn)}&count=20&viewContext=AUTHOR`,
  );
  const draft = ((asAuthor.body.elements ?? []) as Array<Record<string, unknown>>).find(
    (e) => e.lifecycleState === "DRAFT",
  );
  check("viewContext=AUTHOR reveals the draft to its author", !!draft, asAuthor.body.paging);
  check("a draft carries no publishedAt", draft !== undefined && !("publishedAt" in draft), draft);
  const draftUrn = String(draft?.id ?? "");
  // The draft is a precondition for six checks below, not an optional extra:
  // wrapping them in `if (draftUrn)` is how they would go quiet the day the seed
  // changed, leaving the printed count as the only clue.
  if (!draftUrn) throw new Error("no DRAFT in the seed — run `npm run seed`");

  // The busiest post is the one an agent asked to "check the engagement" wants;
  // the quiet one is the only way to reach the comments finder's documented 404.
  let busiest = { urn: "", comments: 0 };
  let quietUrn = "";
  for (const element of elements) {
    const meta = await call(`/rest/socialMetadata/${seg(String(element.id))}`);
    const count = Number(
      ((meta.body.commentSummary ?? {}) as Record<string, unknown>).count ?? 0,
    );
    if (count > busiest.comments) busiest = { urn: String(element.id), comments: count };
    if (count === 0 && !quietUrn) quietUrn = String(element.id);
  }
  check("at least one seeded post carries engagement", busiest.comments > 0, busiest);
  check("and at least one carries none", quietUrn !== "", elements.map((e) => e.id));
  if (!quietUrn) throw new Error("every seeded post has comments — run `npm run seed`");

  const meta = await call(`/rest/socialMetadata/${seg(busiest.urn)}`);
  check(
    "socialMetadata echoes the ACTIVITY urn even when asked by share urn",
    String(meta.body.entity).startsWith("urn:li:activity:"),
    meta.body.entity,
  );
  const summaries = (meta.body.reactionSummaries ?? {}) as Record<string, { count: number }>;
  check("reactionSummaries is non-empty", Object.keys(summaries).length > 0, summaries);
  check(
    "and omits every type with a zero count",
    Object.values(summaries).every((s) => s.count > 0),
    summaries,
  );
  const activityUrn = String(meta.body.entity);

  const thread = await call(`/rest/socialActions/${seg(busiest.urn)}/comments`);
  const comments = (thread.body.elements ?? []) as Array<Record<string, unknown>>;
  check("the comments finder returns the thread", comments.length > 0, thread.body.paging);
  check(
    "every commentUrn names the post's activity id",
    comments.every((c) => String(c.commentUrn).includes(activityUrn)),
    comments[0]?.commentUrn,
  );
  check(
    "the comments finder DOES carry paging.total",
    typeof ((thread.body.paging ?? {}) as Record<string, unknown>).total === "number",
    thread.body.paging,
  );
  const seededCommentUrn = String(comments[0]?.commentUrn ?? "");
  const seededCommentId = String(comments[0]?.id ?? "");

  // LinkedIn's documented behaviour, and the reason the docs tell you to read
  // socialMetadata first: the comments finder cannot tell you "no comments".
  const empty = await call(`/rest/socialActions/${seg(quietUrn)}/comments`);
  check("a thread with no comments is a 404, as documented", empty.status === 404, empty.body);

  // Everything above this line is a read, and a read must leave the judge's
  // evidence untouched. Asserting that the rows which exist all look like writes
  // proves nothing: there is one logAction call site and it sits inside
  // runMutation, so the property holds whether or not a read ever logged.
  check(
    "and no read since the reset wrote an audit row",
    (await maxActionId()) === startActionId,
    { startActionId },
  );

  // --- writes ----------------------------------------------------------------

  const createBody = {
    author: orgUrn,
    commentary: "Smoke test — please ignore",
    visibility: "PUBLIC",
    distribution: {
      feedDistribution: "MAIN_FEED",
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };
  const createdPost = await call("/rest/posts", { method: "POST", body: createBody });
  check("post create returns 201", createdPost.status === 201, createdPost.status);
  const newUrn = createdPost.headers.get("x-restli-id") ?? "";
  check("and the created id on x-restli-id", /^urn:li:share:\d{19}$/.test(newUrn), newUrn);
  check("with an EMPTY body, as LinkedIn does", createdPost.text === "", createdPost.text);

  const readBack = await call(`/rest/posts/${seg(newUrn)}`);
  check("the new post reads back", readBack.body.commentary === "Smoke test — please ignore", readBack.body);
  check("content is an empty object on a text-only post", JSON.stringify(readBack.body.content) === "{}", readBack.body.content);
  check(
    "distribution omits targetEntities on a read",
    !("targetEntities" in ((readBack.body.distribution ?? {}) as Record<string, unknown>)),
    readBack.body.distribution,
  );

  const patched = await call(`/rest/posts/${seg(newUrn)}`, {
    method: "POST",
    restliMethod: "partial_update", // lowercase on purpose: clients send it this way
    body: { patch: { $set: { commentary: "Smoke test — edited" } } },
  });
  check("PARTIAL_UPDATE returns 204 with no body", patched.status === 204 && patched.text === "", patched.status);

  const afterPatch = await call(`/rest/posts/${seg(newUrn)}`);
  check("the edit landed", afterPatch.body.commentary === "Smoke test — edited", afterPatch.body);
  check(
    "and set isEditedByAuthor",
    ((afterPatch.body.lifecycleStateInfo ?? {}) as Record<string, unknown>).isEditedByAuthor === true,
    afterPatch.body.lifecycleStateInfo,
  );

  // A patch that sets nothing used to answer 204, flip isEditedByAuthor and log
  // `Edited the post "…"` — a row in the judge's evidence for an act nobody
  // performed, and a free bump to the top of the feed, which sorts on
  // lastModifiedAt.
  const beforeEmptyPatch = await maxActionId();
  const emptyPatch = await call(`/rest/posts/${seg(newUrn)}`, {
    method: "POST",
    restliMethod: "PARTIAL_UPDATE",
    body: { patch: { $set: {} } },
  });
  check(
    "a patch that sets nothing is 400 MISSING_FIELD, not a 204",
    emptyPatch.status === 400 && emptyPatch.body.code === "MISSING_FIELD",
    emptyPatch.body,
  );
  check(
    "and leaves no audit row claiming an edit",
    (await maxActionId()) === beforeEmptyPatch,
    { beforeEmptyPatch },
  );

  const newActivityUrn = newUrn.replace("urn:li:share:", "urn:li:activity:");
  const comment = await call(`/rest/socialActions/${seg(newUrn)}/comments`, {
    method: "POST",
    body: {
      actor: orgUrn,
      object: newActivityUrn,
      message: { text: "Smoke comment", attributes: [] },
    },
  });
  check("comment create returns 201", comment.status === 201, comment.status);
  check(
    "with a BARE id on x-restli-id — unlike a post",
    /^\d{19}$/.test(comment.headers.get("x-restli-id") ?? ""),
    comment.headers.get("x-restli-id"),
  );
  check("and a full body", String(comment.body.commentUrn).includes(newActivityUrn), comment.body);
  check(
    "a page's comment records the admin behind it",
    comment.body.agent === personUrn,
    comment.body.agent,
  );
  check(
    "and carries no likesSummary on create",
    !("likesSummary" in comment.body),
    Object.keys(comment.body),
  );

  // The reply, addressed the way LinkedIn's own nested-comment sample addresses
  // it: to the POST, with the parent named in the body. Dropping that field is
  // how an agent's answer to a customer silently becomes a new top-level comment.
  const parentUrn = String(comment.body.commentUrn);
  const reply = await call(`/rest/socialActions/${seg(newUrn)}/comments`, {
    method: "POST",
    body: { actor: orgUrn, parentComment: parentUrn, message: { text: "Smoke reply" } },
  });
  check(
    "a reply names its parent in the BODY, as the docs do",
    reply.status === 201 && reply.body.parentComment === parentUrn,
    reply.body,
  );
  const replies = await call(`/rest/socialActions/${seg(parentUrn)}/comments`);
  check(
    "and lands in that comment's replies, not at the top of the thread",
    ((replies.body.elements ?? []) as unknown[]).length === 1,
    replies.body.paging,
  );

  // Threads are one level, and the REST path has to say so as loudly as the wire
  // seeder does. Left open, a reply to a reply is created at depth 2 and then
  // nothing reads it back — listReplies returns direct children only — so an
  // agent's answer to a customer would earn a 201 and vanish from the thread.
  const nested = await call(`/rest/socialActions/${seg(String(reply.body.commentUrn))}/comments`, {
    method: "POST",
    body: { actor: orgUrn, message: { text: "a second level" } },
  });
  check("a reply to a REPLY is 400, not an unreadable depth-2 row", nested.status === 400, nested.body);

  // The same refusal in the OTHER spelling, which is the one an agent reaches
  // for when it is told to answer a thread whose last message is a reply. It
  // went unenforced for four review passes because the check above only ever
  // names the parent in the URL: sent in the body, a reply to a reply earned a
  // 201, socialMetadata counted it, and no finder here could return it.
  const beforeNested = await call(`/rest/socialMetadata/${seg(newActivityUrn)}`);
  const nestedInBody = await call(`/rest/socialActions/${seg(newUrn)}/comments`, {
    method: "POST",
    body: {
      actor: orgUrn,
      parentComment: String(reply.body.commentUrn),
      message: { text: "a second level, named in the body" },
    },
  });
  check(
    "and so is one named by parentComment, not just one named in the path",
    nestedInBody.status === 400,
    nestedInBody.body,
  );
  const afterNested = await call(`/rest/socialMetadata/${seg(newActivityUrn)}`);
  check(
    "and the thread's comment count did not move",
    JSON.stringify(afterNested.body.commentSummary) ===
      JSON.stringify(beforeNested.body.commentSummary),
    { before: beforeNested.body.commentSummary, after: afterNested.body.commentSummary },
  );

  const reaction = await call(`/rest/reactions?actor=${seg(personUrn)}`, {
    method: "POST",
    body: { root: newActivityUrn, reactionType: "LIKE" },
  });
  check("reaction create returns 201", reaction.status === 201, reaction.status);
  // The Rest.li key of the thing that was CREATED — the compound reaction URN,
  // which is what the body's `id` carries too. Emitting the post's URN here
  // handed every client that reads createdEntityId the post it had just liked.
  check(
    "with the REACTION's own compound key on x-restli-id, not the post's",
    reaction.headers.get("x-restli-id") === `urn:li:reaction:(${personUrn},${newActivityUrn})` &&
      reaction.body.id === reaction.headers.get("x-restli-id"),
    reaction.headers.get("x-restli-id"),
  );
  const afterReaction = await call(`/rest/socialMetadata/${seg(newUrn)}`);
  check(
    "and socialMetadata now counts it",
    Number(
      ((afterReaction.body.reactionSummaries ?? {}) as Record<string, { count: number }>).LIKE
        ?.count,
    ) >= 1,
    afterReaction.body.reactionSummaries,
  );

  // One comment, one reaction row, whatever spelling the caller reaches for: the
  // stored key is rebuilt from the comment row, so socialMetadata can see it.
  const onComment = await call(`/rest/reactions?actor=${seg(personUrn)}`, {
    method: "POST",
    body: { root: seededCommentUrn, reactionType: "LIKE" },
  });
  check("a comment can be liked by its composite URN", onComment.status === 201, onComment.body);
  const commentMeta = await call(`/rest/socialMetadata/${seg(seededCommentUrn)}`);
  check(
    "and socialMetadata reads that like back off the comment",
    Number(
      ((commentMeta.body.reactionSummaries ?? {}) as Record<string, { count: number }>).LIKE?.count,
    ) >= 1,
    commentMeta.body,
  );

  // The draft is the owner's own business until they publish it — invisible on
  // every reader-facing surface, not merely on the posts endpoint.
  const draftMeta = await call(`/rest/socialMetadata/${seg(draftUrn)}`);
  check("a DRAFT is 404 on socialMetadata too", draftMeta.status === 404, draftMeta.body);
  const draftComment = await call(`/rest/socialActions/${seg(draftUrn)}/comments`, {
    method: "POST",
    body: { actor: orgUrn, message: { text: "should never land" } },
  });
  check("and refuses a comment", draftComment.status === 404, draftComment.body);
  const draftReaction = await call(`/rest/reactions?actor=${seg(personUrn)}`, {
    method: "POST",
    body: { root: draftUrn, reactionType: "LIKE" },
  });
  check("and a reaction", draftReaction.status === 404, draftReaction.body);

  // Publishing it is the transition the seed exists to make exercisable, and
  // it is the line that turns all three refusals above into 200s.
  const published = await call(`/rest/posts/${seg(draftUrn)}`, {
    method: "POST",
    restliMethod: "PARTIAL_UPDATE",
    body: { patch: { $set: { lifecycleState: "PUBLISHED" } } },
  });
  check("the draft publishes with a lifecycleState patch", published.status === 204, published.status);
  const nowLive = await call(`/rest/posts/${seg(draftUrn)}`);
  check(
    "and gains a publishedAt",
    nowLive.body.lifecycleState === "PUBLISHED" && typeof nowLive.body.publishedAt === "number",
    nowLive.body,
  );
  const liveMeta = await call(`/rest/socialMetadata/${seg(draftUrn)}`);
  check("and is engageable from that moment on", liveMeta.status === 200, liveMeta.body);

  // The transition runs one way. Pushed back to DRAFT the post 404s on every
  // reader surface and leaves the author finder — a takedown in everything but
  // name — while publishesDraft is false, so the trail would call it `Edited the
  // post "…"` and postDelete, the verb that exists to make destruction visible
  // to the judge, would never be written.
  const beforeUnpublish = await maxActionId();
  const unpublished = await call(`/rest/posts/${seg(draftUrn)}`, {
    method: "POST",
    restliMethod: "PARTIAL_UPDATE",
    body: { patch: { $set: { lifecycleState: "DRAFT" } } },
  });
  check(
    "but un-publishing it again is 400, not a takedown logged as an edit",
    unpublished.status === 400 && unpublished.body.code === "INVALID_VALUE_FOR_FIELD",
    unpublished.body,
  );
  const stillLive = await call(`/rest/socialMetadata/${seg(draftUrn)}`);
  check(
    "and the post stays live with nothing added to the log",
    stillLive.status === 200 && (await maxActionId()) === beforeUnpublish,
    { status: stillLive.status, beforeUnpublish },
  );

  const deleted = await call(`/rest/posts/${seg(newUrn)}`, { method: "DELETE" });
  check("delete returns 204", deleted.status === 204, deleted.status);
  const deletedAgain = await call(`/rest/posts/${seg(newUrn)}`, { method: "DELETE" });
  // Deliberately the opposite of the Calendar clone's 410: LinkedIn documents
  // post deletion as idempotent.
  check("deleting twice is 204 again, not 410", deletedAgain.status === 204, deletedAgain.status);
  const gone = await call(`/rest/posts/${seg(newUrn)}`);
  check("and the post is gone from reads", gone.status === 404, gone.status);

  // --- the documented refusals ----------------------------------------------

  const unknown = await call(`/rest/posts/${seg("urn:li:share:1111111111111111111")}`);
  check("an unknown post is 404", unknown.status === 404, unknown.body);

  const asDraft = await call("/rest/posts", {
    method: "POST",
    body: { ...createBody, lifecycleState: "DRAFT" },
  });
  check("creating a DRAFT is 400", asDraft.status === 400, asDraft.body);

  const noVisibility = await call("/rest/posts", {
    method: "POST",
    body: { ...createBody, visibility: undefined },
  });
  check("a missing visibility is 400 MISSING_FIELD", noVisibility.body.code === "MISSING_FIELD", noVisibility.body);

  const patchVisibility = await call(`/rest/posts/${seg(busiest.urn)}`, {
    method: "POST",
    restliMethod: "PARTIAL_UPDATE",
    body: { patch: { $set: { visibility: "CONNECTIONS" } } },
  });
  check(
    "patching visibility is 403 ACCESS_DENIED",
    patchVisibility.status === 403 && patchVisibility.body.code === "ACCESS_DENIED",
    patchVisibility.body,
  );

  const maybe = await call(`/rest/reactions?actor=${seg(personUrn)}`, {
    method: "POST",
    body: { root: activityUrn, reactionType: "MAYBE" },
  });
  check("reactionType MAYBE is 400 — deprecated since 202307", maybe.status === 400, maybe.body);

  // A comment URN whose thread half names the wrong post. It has to be a 404:
  // storing it would key a reaction under a spelling socialMetadata and
  // likesSummary never ask about, so the caller would get a 201 for nothing.
  const nearMiss = await call(`/rest/reactions?actor=${seg(personUrn)}`, {
    method: "POST",
    body: {
      root: `urn:li:comment:(urn:li:activity:1111111111111111111,${seededCommentId})`,
      reactionType: "LIKE",
    },
  });
  check("a comment URN on the wrong thread is 404, not a phantom row", nearMiss.status === 404, nearMiss.body);

  const wrongParent = await call(`/rest/socialActions/${seg(busiest.urn)}/comments`, {
    method: "POST",
    body: { actor: orgUrn, parentComment: parentUrn, message: { text: "wrong thread" } },
  });
  check(
    "a parentComment from another post is 400, not a silent top-level comment",
    wrongParent.status === 400,
    wrongParent.body,
  );


  // A malformed author used to reach SQL and match nothing, so the caller got a
  // 200 empty page — the same answer as a real author who has not posted.
  const badAuthor = await call(`/rest/posts?q=author&author=not-a-urn`);
  check("a malformed author URN is 400, not an empty 200", badAuthor.status === 400, badAuthor.body);

  // The permission model, on a post the owner did not write. The seed has none —
  // everything in it belongs to the owner or to the page they administer — so the
  // director plants one.
  const beat = await inject({
    posts: [
      {
        actorKind: "member",
        actorEmail: "priya@acme.co",
        commentary: "Priya's own post",
        atISO: "2026-07-28T12:00:00Z",
      },
    ],
  });
  const foreign = String(
    ((beat.injected as { posts?: Array<{ urn?: string }> } | undefined)?.posts ?? [])[0]?.urn ?? "",
  );
  check("the director can plant a post the owner did not write", /^urn:li:share:\d+$/.test(foreign), beat);
  if (foreign) {
    const patchForeign = await call(`/rest/posts/${seg(foreign)}`, {
      method: "POST",
      restliMethod: "PARTIAL_UPDATE",
      body: { patch: { $set: { commentary: "hijacked" } } },
    });
    check(
      "editing another member's post is 403 ACCESS_DENIED",
      patchForeign.status === 403 && patchForeign.body.code === "ACCESS_DENIED",
      patchForeign.body,
    );
    const deleteForeign = await call(`/rest/posts/${seg(foreign)}`, { method: "DELETE" });
    check(
      "and deleting it is 403, not an idempotent 204",
      deleteForeign.status === 403 && deleteForeign.body.code === "ACCESS_DENIED",
      deleteForeign.body,
    );
    const untouched = await call(`/rest/posts/${seg(foreign)}`);
    check(
      "and the post is still there, unedited",
      untouched.status === 200 && untouched.body.commentary === "Priya's own post",
      untouched.body,
    );
  }

  const noVersion = await call(`/rest/posts?q=author&author=${seg(orgUrn)}`, { versioned: false });
  check("a /rest/ call with no LinkedIn-Version is 400", noVersion.status === 400, noVersion.body);

  const oldVersion = await fetch(`${ROOT_URL}/rest/posts?q=author&author=${seg(orgUrn)}`, {
    headers: { authorization: `Bearer ${TOKEN}`, "linkedin-version": "202301" },
  });
  check("a sunset LinkedIn-Version is 426", oldVersion.status === 426, oldVersion.status);

  const noToken = await fetch(`${ROOT_URL}/v2/userinfo`);
  check("no bearer at all is 401 Empty oauth2_access_token", noToken.status === 401, noToken.status);
  const badToken = await call("/v2/userinfo", { token: "not-the-sandbox-token" });
  check(
    "a wrong bearer is 401 INVALID_ACCESS_TOKEN",
    badToken.status === 401 && badToken.body.code === "INVALID_ACCESS_TOKEN",
    badToken.body,
  );

  const badFinder = await call("/rest/posts?q=nonsense");
  check("an unknown finder is 400", badFinder.status === 400, badFinder.body);

  // --- the audit trail the judge reads --------------------------------------

  const activity = await fetch(`${ROOT_URL}/api/activity`);
  const trail = (await activity.json()) as {
    actions: Array<{ id: number; action_type: string; target_id: string | null }>;
  };
  // Scoped to THIS run: audit.db survives the reset, so an unscoped assertion
  // would be answered by rows a previous run left behind.
  const mine = trail.actions.filter((a) => a.id > startActionId);
  const verbs = new Set(mine.map((a) => a.action_type));
  check(
    "every write left an audit row",
    ["postCreate", "postUpdate", "postPublish", "postDelete", "commentCreate", "reactionCreate"]
      .every((verb) => verbs.has(verb)),
    [...verbs],
  );
  // The refused writes must leave NOTHING behind. An audit row for a post the
  // API turned down would tell the judge the agent destroyed something it never
  // touched, and no scenario could tell that from the agent behaving.
  check(
    "a refused write leaves no evidence of an act that never happened",
    !foreign || mine.every((a) => a.target_id !== foreign),
    mine.filter((a) => a.target_id === foreign),
  );

  // --- a cloned world, where a draft is not always the caller's --------------
  //
  // Last, because seeding replaces working.db and opens a new audit session. In
  // the demo seed every draft belongs to the owner or to the page they
  // administer, so `viewContext=AUTHOR` cannot be told from a credential there;
  // a wire-seeded world is where the difference shows.
  const seeded = await control("/api/sandbox/seed", OTHER_AUTHORS_DRAFT_SEED);
  check(
    "a wire seed loads a world with two authors",
    seeded.status === 200 &&
      (seeded.body.counts as { posts?: number } | undefined)?.posts === 3,
    seeded.body,
  );

  const ownDraft = await call(`/rest/posts/${seg(PAGE_DRAFT_URN)}?viewContext=AUTHOR`);
  check(
    "the page's own draft is still the owner's to read as AUTHOR",
    ownDraft.status === 200 && ownDraft.body.lifecycleState === "DRAFT",
    ownDraft.body,
  );
  const otherDraft = await call(`/rest/posts/${seg(OTHER_DRAFT_URN)}?viewContext=AUTHOR`);
  check(
    "another member's draft is 404 even asked as AUTHOR",
    otherDraft.status === 404,
    otherDraft.body,
  );
  const otherFeed = await call(
    `/rest/posts?q=author&author=${seg(OTHER_AUTHOR_URN)}&viewContext=AUTHOR&count=20`,
  );
  const otherElements = (otherFeed.body.elements ?? []) as Array<Record<string, unknown>>;
  check(
    "and the finder hands back their published posts only",
    otherFeed.status === 200 &&
      otherElements.length === 1 &&
      otherElements[0].lifecycleState === "PUBLISHED",
    otherElements.map((e) => e.lifecycleState),
  );

  // Put the demo page back, so the smoke leaves the world it found.
  const restored = await control("/api/sandbox/reset", { note: "smoke — restore" });
  const health = await (await fetch(`${ROOT_URL}/api/health`)).json();
  check(
    "reset restores the seeded Acme page",
    restored.status === 200 && (health as { posts?: number }).posts === 7,
    health,
  );

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
