import { PageSkeleton } from "./_components/PageSkeleton";

// Home waits on all three clones answering their health endpoints before it can
// render, and a clone that is mid-compile takes the full timeout — so returning
// to Home from anywhere else can sit for a second or two with the previous page
// still on screen. This is what fills it.

export default function HomeLoading() {
  return (
    <PageSkeleton
      label="Loading the overview"
      rows={[
        { height: 128 },
        { height: 116, columns: 4 },
        { height: 200 },
      ]}
    />
  );
}
