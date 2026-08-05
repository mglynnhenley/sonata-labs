import { PageSkeleton } from "../_components/PageSkeleton";

export default function ScenariosLoading() {
  return (
    <PageSkeleton
      label="Loading scenarios"
      rows={[{ height: 190, columns: 2 }, { height: 190, columns: 2 }]}
    />
  );
}
