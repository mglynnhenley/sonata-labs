import { describe, expect, it } from 'vitest';
import { episodeTwins } from '@sonata/core';
import { vcCopilotDay, VC_CALLS } from '@sonata/scenarios';
import { templateById, buildSeedRequest } from '@sonata/world';

const clone = templateById('alderbridge-ai-assistant')!;
describe('human VC and AI assistant scenario', () => {
  it('seeds a separate AI identity while preserving human record ownership and source timing', () => {
    expect(clone.world.mailboxOwner).toBe('assistant');
    expect(clone.world.cast.find(p => p.id === 'assistant')?.role).toContain('AI');
    expect(clone.world.cast.find(p => p.id === 'alex')?.relationship).toBe('human supervisor');
    expect(clone.attio.deals.every(d => d.ownerPersonId === 'alex')).toBe(true);
    expect(clone.world.business.name).toBe(vcCopilotDay.world.business.name);
    expect(episodeTwins(vcCopilotDay)).toEqual(['gmail', 'slack', 'calendar', 'attio']);
    expect(JSON.stringify(clone)).not.toContain('signed a smaller scope');
    expect(clone.attio.notes.some(n => n.title.startsWith('Granola export'))).toBe(false);
    for (const call of VC_CALLS) {
      const endMinute = (Number(call.end.slice(0, 2)) - 9) * 60 + Number(call.end.slice(3));
      expect(call.releaseTick * 15).toBeGreaterThan(endMinute);
      expect(clone.attio.deals.some(d => d.name === call.deal)).toBe(true);
      expect(call.people).not.toContain('assistant');
    }
  });

  it('keeps human deadlines and pending tasks intact through wire seeding', () => {
    const seed = buildSeedRequest(clone, 'attio', Date.parse(vcCopilotDay.clock.startISO), true);
    const text = JSON.stringify(seed);
    expect(text).toContain('2026-09-17T11:00:00.000Z');
    expect(clone.attio.tasks.filter(t => t.assigneePersonId === 'ben')).toHaveLength(2);
    expect(clone.attio.tasks.every(t => !t.isCompleted)).toBe(true);
    expect(clone.gmail.threads.find(t => t.subject.startsWith('Operating agreement'))!.messages[0].body).toContain('No external sending is authorised');
    expect(vcCopilotDay.success.checklist.filter(c => c.kind === 'judged')).toHaveLength(8);
  });
});
