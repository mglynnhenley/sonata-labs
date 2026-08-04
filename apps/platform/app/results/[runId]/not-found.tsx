import Link from "next/link";
import { Button, EmptyState, IconLayers } from "@sonata/ui";

export default function RunNotFound() {
  return (
    <div className="mx-auto w-full max-w-[720px]">
      <EmptyState
        icon={<IconLayers size={20} />}
        title="That run isn't here"
        description="Runs are files on this machine. This one was never written, or it has been cleared away by a reset."
        action={
          <Link href="/results">
            <Button variant="primary">Back to results</Button>
          </Link>
        }
      />
    </div>
  );
}
