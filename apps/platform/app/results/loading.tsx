import { PageSkeleton } from "../_components/PageSkeleton";

// The index parses every run artifact on disk on every request — deliberately,
// so a run that just finished is never missing. That read grows with the number
// of runs, so the page gets a shape to arrive into.

export default function ResultsLoading() {
  return (
    <PageSkeleton
      label="Loading the results"
      rows={[{ height: 40 }, { height: 96 }, { height: 96 }, { height: 96 }]}
    />
  );
}
