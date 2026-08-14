import { NextResponse } from "next/server";
import { BadRequestError, requireSandboxToken } from "@/lib/sandbox/auth";
import { liveDb } from "@/lib/sandbox/live";
import {
  injectComment,
  injectPost,
  injectReaction,
  type InjectCommentSpec,
  type InjectPostSpec,
  type InjectReactionSpec,
  type InjectedComment,
  type InjectedPost,
  type InjectedReaction,
} from "@/lib/sandbox/inject";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The director's hand on the company page: someone posts, someone comments,
// engagement arrives.
//
// Deliberately NOT audit-logged — injection is scenario setup, not agent
// behaviour, and the judge reads the audit log to score the agent. Injected rows
// carry is_sandbox_created = 0 so they are indistinguishable from seed.
//
// Reads through liveDb(), not getDb(): a `npm run seed` between beats replaces
// working.db out of process, and the long-lived handle would go on writing into
// the file nobody can see any more.

interface InjectBody {
  posts?: InjectPostSpec[];
  comments?: InjectCommentSpec[];
  reactions?: InjectReactionSpec[];
}

export async function POST(req: Request) {
  const denied = requireSandboxToken(req);
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => ({}))) as InjectBody;
    const posts = body.posts ?? [];
    const comments = body.comments ?? [];
    const reactions = body.reactions ?? [];
    if (!posts.length && !comments.length && !reactions.length) {
      return NextResponse.json({ ok: false, error: "nothing to inject" }, { status: 400 });
    }

    const db = liveDb();
    const injectedPosts: InjectedPost[] = [];
    const injectedComments: InjectedComment[] = [];
    const injectedReactions: InjectedReaction[] = [];

    // One transaction for the whole beat: half a beat is a world nobody wrote.
    const apply = db.transaction(() => {
      for (const spec of posts) injectedPosts.push(injectPost(db, spec));
      for (const spec of comments) injectedComments.push(injectComment(db, spec));
      for (const spec of reactions) injectedReactions.push(injectReaction(db, spec));
    });
    apply();

    // The minted ids go back so the engine can thread the next beat onto them.
    return NextResponse.json({
      ok: true,
      injected: {
        posts: injectedPosts,
        comments: injectedComments,
        reactions: injectedReactions,
      },
    });
  } catch (err) {
    const status = err instanceof BadRequestError ? 400 : 500;
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status });
  }
}
