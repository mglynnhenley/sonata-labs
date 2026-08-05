import { PageSkeleton } from "../../_components/PageSkeleton";

// Pressing "Start the day" navigates straight here, so this fallback is the
// first thing a first-time user sees after the one button that matters. It has
// to be the shape of the run view: header, the clock card, then the story.

export default function LiveRunLoading() {
  return (
    <PageSkeleton
      label="Opening the run"
      rows={[{ height: 168 }, { height: 420 }]}
    />
  );
}
