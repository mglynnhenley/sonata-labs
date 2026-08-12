import Link from "next/link";
import { buttonClasses, EmptyState, IconPlay } from "@sonata/ui";

export default function SessionNotFound() {
  return (
    <div className="mx-auto w-full max-w-[720px]">
      <EmptyState
        icon={<IconPlay size="lg" />}
        title="That session isn't here"
        description="Sessions are kept on this machine, in this workspace's platform.db. This one was never started, or it belongs to a different workspace. Start a new day and point your agent at it."
        action={
          <Link href="/sessions" className={buttonClasses("primary", "md")}>
            Start a session
          </Link>
        }
      />
    </div>
  );
}
