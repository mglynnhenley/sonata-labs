import { Spinner } from "@sonata/ui";

/** The four sizes — xs lives inside chips, lg holds a whole panel. */
export const Sizes = () => (
  <div style={{ display: "flex", gap: 18, alignItems: "center" }}>
    <Spinner size="xs" />
    <Spinner size="sm" />
    <Spinner size="md" />
    <Spinner size="lg" />
  </div>
);

/** currentColor pass-through: it wears whatever the surrounding control wears. */
export const InheritsColor = () => (
  <div style={{ display: "flex", gap: 18, alignItems: "center" }}>
    <span style={{ color: "#0E5C55" }}>
      <Spinner size="md" label="" />
    </span>
    <span style={{ color: "#B26355" }}>
      <Spinner size="md" label="" />
    </span>
    <span style={{ color: "#8A908D" }}>
      <Spinner size="md" label="" />
    </span>
  </div>
);

/** Beside its message — the way it appears while a run is being scored. */
export const WithMessage = () => (
  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
    <Spinner size="sm" label="" />
    <span className="text-sn-muted" style={{ fontSize: 13 }}>
      Scoring run r-0418 — judging 14 criteria…
    </span>
  </div>
);
