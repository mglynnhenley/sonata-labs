import { Card } from "@sonata/ui";
import { MODEL_ROLES, ROLE_LABELS, type ModelRole } from "@/lib/models";
import { ROUTES } from "@/lib/routes";
import { buttonClasses } from "@sonata/ui";
import type { Overview } from "@/lib/overview";

// The rail's second card. Every number on this page is a number *some model*
// produced, and until now the page never said which — you had to open Settings
// to find out what setup the dashboard was reporting on. The payload already
// carried it; nothing here is new data.

export type UnderTestProps = {
  models: Record<ModelRole, string>;
};

/** "anthropic/claude-haiku-4.5" → "claude-haiku-4.5". The vendor prefix is the
 *  same on almost every row, so it costs a line and says nothing. */
function short(slug: string): string {
  const slash = slug.indexOf("/");
  return slash === -1 ? slug : slug.slice(slash + 1);
}

export function UnderTest({ models }: UnderTestProps) {
  return (
    <Card
      title="Under test"
      subtitle="The setup these numbers came out of"
      actions={
        <a href={ROUTES.settings} className={buttonClasses("ghost", "sm")}>
          Change
        </a>
      }
    >
      <dl className="flex flex-col gap-3 pt-1">
        {MODEL_ROLES.map((role) => (
          <div key={role} className="flex items-baseline justify-between gap-3">
            <dt className="text-sn-base text-sn-muted">{ROLE_LABELS[role]}</dt>
            <dd
              className="min-w-0 truncate font-mono text-sn-sm text-sn-ink"
              title={models[role]}
            >
              {short(models[role])}
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
