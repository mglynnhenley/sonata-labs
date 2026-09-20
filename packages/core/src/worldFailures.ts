import type { TickRecord } from "./types/run";

/** Engine-authored failures only. Never interpret an agent's words as a harness fault. */
export function worldFailures(ticks: TickRecord[]): Array<{ tick: number; simTimeISO: string; message: string }> {
  return ticks.flatMap(t => {
    const failed = t.directorEvents.filter(event => event.error);
    const messages = failed.map(event => `${event.id}: ${event.error}`);
    for (const note of t.notes) {
      if (/^director call failed\b/.test(note) ||
          (/^event \S+:/.test(note) && !failed.some(event => note.startsWith(`event ${event.id}:`)))) messages.push(note);
    }
    return messages.map(message => ({ tick: t.tick, simTimeISO: t.simTimeISO, message }));
  });
}
