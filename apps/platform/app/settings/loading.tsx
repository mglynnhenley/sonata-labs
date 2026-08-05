import { PageSkeleton } from "../_components/PageSkeleton";

// Settings blocks on the health of all three clones — a clone that is booting
// takes the full probe timeout, so this page is the one that most often has a
// visible wait in front of it.

export default function SettingsLoading() {
  return (
    <PageSkeleton
      label="Loading settings"
      rows={[{ height: 260 }, { height: 180 }, { height: 132, columns: 3 }]}
    />
  );
}
