import { PageSkeleton } from "../_components/PageSkeleton";

export default function ConnectLoading() {
  return (
    <PageSkeleton
      label="Loading the connection details"
      rows={[
        { height: 130, columns: 3 },
        { height: 132, columns: 3 },
        { height: 240 },
      ]}
    />
  );
}
