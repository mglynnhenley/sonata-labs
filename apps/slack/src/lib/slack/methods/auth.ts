import { ok } from "../envelope";
import type { MethodHandler } from "../route-helpers";

// auth.test — agents call this first to learn their own identity; the answer
// comes from meta (recorded by seed/sync) and must round-trip consistently.
export const authTest: MethodHandler = ({ self }) =>
  ok({
    url: `https://${self.teamDomain}.slack.com/`,
    team: self.teamName,
    user: self.userName,
    team_id: self.teamId,
    user_id: self.userId,
    is_enterprise_install: false,
  });
