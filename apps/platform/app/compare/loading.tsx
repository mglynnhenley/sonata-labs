import { PageSkeleton } from "../_components/PageSkeleton";

export default function CompareLoading() {
  return (
    <PageSkeleton
      label="Loading the benchmark"
      rows={[{ height: 44 }, { height: 260 }, { height: 320 }]}
    />
  );
}
