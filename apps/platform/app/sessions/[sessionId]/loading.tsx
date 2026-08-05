import { PageSkeleton } from "../../_components/PageSkeleton";

// "Start the world" navigates straight here, so this stands in for the one
// moment that matters: the twins are being reset and reloaded, which takes a
// few seconds. It has to be the shape of the live view — the agent panel, the
// clock, then the day.

export default function LiveSessionLoading() {
  return (
    <PageSkeleton
      label="Opening the session"
      rows={[{ height: 200 }, { height: 200 }, { height: 420 }]}
    />
  );
}
