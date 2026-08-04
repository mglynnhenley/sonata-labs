import type { TwinName } from "@sonata/core";
import type { OpenAI } from "../llm";

// One tool, as the agent sees it and as the trace records it.
//
// `twin` is on every tool because a run spans three surfaces and every question
// worth asking afterwards is per-surface: which twin did it work in, did it
// answer the email but never tell the channel, does this finding cite a Slack
// step or a Gmail one. `isMutation` is what separates "it looked" from "it acted"
// — only mutations leave audit rows behind, so for reads the trace is the only
// record they happened at all.

export type ToolInput = Record<string, unknown>;

export interface EngineTool {
  name: string;
  /** Null for harness-local tools, which touch no twin — escalation, notes. */
  twin: TwinName | null;
  isMutation: boolean;
  def: OpenAI.ChatCompletionTool;
  run(args: ToolInput): Promise<unknown>;
}

export function fn(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
): OpenAI.ChatCompletionTool {
  return { type: "function", function: { name, description, parameters } };
}

export function str(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}

export function int(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : fallback;
}

export function strList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(str).filter(Boolean);
  return typeof v === "string" && v.trim() ? [v] : [];
}
