import { IconSearch } from "@sonata/ui";
export const Sizes = () => (
  <div style={{ display: "flex", alignItems: "center", gap: 18, color: "#16181a", fontFamily: "Satoshi, sans-serif" }}>
    {(["xs", "sm", "md", "lg"] as const).map((s) => (
      <span key={s} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
        <IconSearch size={s} />
        <span style={{ fontSize: 10, color: "#8a908d" }}>{s}</span>
      </span>
    ))}
    <span style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, color: "#0e5c55" }}>
      <IconSearch size={32} />
      <span style={{ fontSize: 10, color: "#8a908d" }}>currentColor</span>
    </span>
  </div>
);
