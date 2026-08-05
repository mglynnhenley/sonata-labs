import { PageSkeleton } from "../_components/PageSkeleton";

export default function RunsLoading() {
  return (
    <PageSkeleton
      label="Loading runs"
      rows={[{ height: 300 }, { height: 88 }, { height: 88 }]}
    />
  );
}
