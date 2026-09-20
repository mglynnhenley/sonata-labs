import type { EpisodeRun } from "@sonata/core";
import type { RunDetail } from "../../../app/api/_lib/types";
import type { RunPoll, RunView, StartEpisodeInput } from "./episode";

function base() { return process.env.SONATA_PLATFORM_URL || "http://localhost:3000"; }
async function request(route: string, init?: RequestInit) {
  let response: Response;
  try { response = await fetch(`${base()}${route}`, { ...init, headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(30000) }); }
  catch { throw new Error(`Cannot reach Sonata at ${base()}. Start it with npm run sonata -- up.`); }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Sonata returned HTTP ${response.status}.`);
  return body;
}
function view(doc: RunDetail): RunView {
  return { ...doc, episodeId: doc.specId, title: doc.specTitle, tick: doc.tickCount,
    lastEvent: null, error: doc.error ?? null, live: ["queued", "running", "judging"].includes(doc.status) };
}
export async function startRemoteEpisode(input: StartEpisodeInput): Promise<RunView> {
  const { runId } = await request("/api/runs", { method: "POST", body: JSON.stringify(input) });
  const { run } = await request(`/api/runs/${encodeURIComponent(runId)}?full=1`);
  return view(run);
}
export async function remoteStatus(runId: string, sinceTick = 0): Promise<RunPoll> {
  const poll = await request(`/api/runs/${encodeURIComponent(runId)}?sinceTick=${sinceTick}`);
  return { ...poll, run: view(poll.run) };
}
export async function cancelRemote(runId: string): Promise<void> {
  await request(`/api/runs/${encodeURIComponent(runId)}`, { method: "PATCH", body: JSON.stringify({ command: "abort" }) });
}
export async function remoteArtifact(runId: string): Promise<EpisodeRun> {
  return request(`/api/runs/${encodeURIComponent(runId)}/artifact`);
}
export async function waitRemote(runId: string): Promise<EpisodeRun> {
  while ((await remoteStatus(runId)).run.live) await new Promise(resolve => setTimeout(resolve, 600));
  return remoteArtifact(runId);
}
