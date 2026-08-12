import Link from "next/link";
import { buttonClasses, EmptyState, IconPlay } from "@sonata/ui";

export default function LiveRunNotFound() {
  return (
    <div className="mx-auto w-full max-w-[720px]">
      <EmptyState
        icon={<IconPlay size="lg" />}
        title="That run isn't here"
        description="Runs live on this machine. This one was never started, or it was cleared away by a reset. Start a new day and it will be here in seconds."
        action={
          <Link href="/runs" className={buttonClasses("primary", "md")}>
            Start a run
          </Link>
        }
      />
    </div>
  );
}
