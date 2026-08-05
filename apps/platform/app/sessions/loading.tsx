import { PageSkeleton } from "../_components/PageSkeleton";

export default function SessionsLoading() {
  return (
    <PageSkeleton
      label="Loading sessions"
      rows={[{ height: 220 }, { height: 320 }, { height: 180 }]}
    />
  );
}
