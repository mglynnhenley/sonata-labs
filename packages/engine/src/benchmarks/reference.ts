import type { AgentStep } from '@sonata/core';
import type { Agent } from '../agent';
import type { EngineTool } from '../tools/types';
import { recordAgentSummary, recordToolCall, withTick } from '../trace';
import type { ReferenceAction } from '@sonata/desks';

/** Deterministic reference policy, driven by runEpisode exactly like a model agent.
 * This verifies the environment. It is never represented as a model result. */
export function createReferenceAgent(actions: ReferenceAction[], tools: EngineTool[]): Agent {
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  const counts = new Map<number, number>();
  for (const action of actions) {
    const count = (counts.get(action.tick) ?? 0) + 1;
    if (count > 6) throw new Error(`Reference exceeds six calls at tick ${action.tick}`);
    if (!byName.has(action.tool)) throw new Error(`Unknown reference tool ${action.tool}`);
    counts.set(action.tick, count);
  }
  let seq = 0;
  return {
    async act(ctx) {
      const steps: AgentStep[] = [];
      await withTick(ctx.tick, async () => {
        for (const action of actions.filter(action => action.tick === ctx.tick)) {
          const tool = byName.get(action.tool)!;
          const startedAt = Date.now();
          let result: unknown;
          let error: string | undefined;
          try { result = await tool.run(structuredClone(action.args)); }
          catch (err) { error = err instanceof Error ? err.message : String(err); result = { error }; }
          const endedAt = Date.now();
          recordToolCall({ name: action.tool, args: action.args, result, isMutation: tool.isMutation, startedAt, endedAt, ...(error ? { error } : {}) });
          steps.push({ kind: 'tool', seq: seq++, at: endedAt, twin: null, name: action.tool,
            args: action.args, resultSummary: JSON.stringify(result), isMutation: tool.isMutation, ...(error ? { error } : {}) });
        }
      });
      return steps;
    },
    async wrapUp() {
      const text = 'Executed an authored reference policy to verify the environment; no model was evaluated.';
      recordAgentSummary(text);
      return text;
    },
  };
}
