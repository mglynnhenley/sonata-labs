import { PageSkeleton } from "../../_components/PageSkeleton";

// One centred column, not the two-up grid the scenarios list uses — otherwise
// this route inherits its parent's fallback and the layout jumps on arrival.

export default function NewScenarioLoading() {
  return (
    <div className="mx-auto w-full max-w-[820px]">
      <PageSkeleton label="Opening the scenario composer" rows={[{ height: 480 }]} />
    </div>
  );
}
