import "./src/cli/env";
import { completeJson } from "./app/api/_lib/llm";
const mod = await import("./app/api/_lib/draft.js").catch(() => null);
// re-declare via reading the file is awkward; instead call with same shape by importing internals
import { readFileSync } from "node:fs";
const src = readFileSync("./app/api/_lib/draft.ts", "utf8");
const sys = src.split("const SYSTEM = `")[1].split("`;")[0];
const brief = "a 12-person fintech, the week before an audit";
const ticks = 6;
// Rebuild SCHEMA by importing it is not exported; use dynamic eval-free approach: run through draftScenario and inspect offline
try {
  const r = await completeJson<Record<string, unknown>>({
    system: sys,
    user: `Business and day to simulate:\n\n${brief}\n\nThe day runs for ${ticks} ticks, so ticks 0 to ${ticks - 1}.`,
    schema: JSON.parse(readFileSync("/tmp/schema.json", "utf8")),
    schemaName: "sonata_scenario",
    maxTokens: 6000,
  });
  console.log("OK keys", Object.keys(r), "cast", (r as any).cast?.length, "beats", (r as any).episode?.beats?.length, "criteria", (r as any).episode?.criteria?.length, "channels", (r as any).channels?.length);
} catch (e) { console.log("FAILED:", (e as Error).message); }
