import { PageSkeleton } from "../../_components/PageSkeleton";

// A finished run carries its whole day plus the trace behind the cost
// breakdown, which runs to megabytes of JSON. Parsing it is the slowest read in
// the product, and it happens between the click and the first pixel.

export default function RunDetailLoading() {
  return (
    <PageSkeleton
      label="Loading this run"
      rows={[{ height: 180 }, { height: 112, columns: 3 }, { height: 320 }]}
    />
  );
}
