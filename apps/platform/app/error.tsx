"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button, EmptyState, IconAlert, IconArrowRight } from "@sonata/ui";
import { ROUTES } from "@/lib/routes";

// The catch-all for a page that throws while it renders. Without it, one bad
// artifact or a locked platform.db takes the whole dashboard to Next's default
// error screen — in production a bare "Application error", which tells a user
// nothing and offers them nowhere to go.
//
// Everything here is recoverable: the pages read from disk and from a local
// database on every request, so `reset()` genuinely is worth pressing, and the
// rest of the product is still fine. Say both of those things.

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // The stack belongs in the terminal, not on the page — this is the copy the
  // person running Sonata actually needs, and they own the console.
  useEffect(() => {
    console.error("[sonata] page failed to render", error);
  }, [error]);

  return (
    <div className="mx-auto w-full max-w-[720px]">
      <EmptyState
        icon={<IconAlert size={20} />}
        title="This page didn't load"
        description="Something went wrong reading the data behind it. Nothing has been lost — runs and scenarios are files and rows on this machine, and the rest of the dashboard is still working."
        hints={[
          "Try again first: the page is read fresh every time, so a transient failure clears",
          "If it keeps happening, the full error is in the terminal running the dashboard",
        ]}
        action={
          <Button variant="primary" onClick={reset}>
            Try again
          </Button>
        }
        secondaryAction={
          <Link href={ROUTES.home}>
            <Button variant="ghost" iconRight={<IconArrowRight size={14} />}>
              Back to the overview
            </Button>
          </Link>
        }
      />

      {/* One line, no stack: enough to search the terminal for, and nothing a
          screenshot could leak. */}
      <p className="mt-5 text-center text-[12px] leading-[18px] text-sn-subtle">
        {error.message || "No message was reported."}
        {error.digest ? (
          <>
            {" · "}
            <span data-numeric>{error.digest}</span>
          </>
        ) : null}
      </p>
    </div>
  );
}
