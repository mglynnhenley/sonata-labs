import { apiSend } from "../../api/_lib/client";
import type { EpisodeRecord } from "../../api/_lib/types";

/**
 * Save a shipped day as a scenario of your own.
 *
 * One function because two screens now offer it: the Templates grid, and the
 * composer when nothing shipped resembled the business someone described. They
 * are the same act — deliberately choosing to run one of the five — and the
 * second was never allowed to become a second way of doing it.
 */
export async function episodeFromTemplate(templateId: string): Promise<EpisodeRecord> {
  const { episode } = await apiSend<{ episode: EpisodeRecord }>("/api/episodes", "POST", {
    templateId,
  });
  return episode;
}
