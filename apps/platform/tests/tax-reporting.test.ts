import { describe, expect, it } from 'vitest';
import { taxReportingDay, TAX_CURRENT, TAX_PRIOR } from '@sonata/scenarios';
import { episodeTwins } from '@sonata/core';
import { templateById } from '@sonata/world';

// Independent arithmetic controls: wrong ground truth must not become an agent failure.
describe('tax reporting workflow fixture', () => {
  const world = templateById('tax-reporting-workflow')!;
  it('has a complete source population and consistent reporting control totals', () => {
    const unique = new Map(TAX_CURRENT.map(row => [row[0], row]));
    const value = (row: string[]) => Number(row[4].replaceAll('.', '').replace(',', '.'));
    expect(TAX_PRIOR).toHaveLength(6);
    expect(TAX_PRIOR.reduce((sum, row) => sum + Number(row[2]), 0)).toBe(21000);
    expect(TAX_CURRENT).toHaveLength(8);
    expect(unique.size).toBe(7);
    expect([...unique.values()].reduce((sum, row) => sum + value(row), 0)).toBe(33100);
    const provisional = ['00901', '00102', '00103', '00105', '00107'];
    expect(provisional.reduce((sum, id) => sum + value(unique.get(id)!), 0)).toBe(19100);
    expect([...provisional, '00108'].reduce((sum, id) => sum + value(unique.get(id)!), 0)).toBe(27100);
  });
  it('supplies initial inputs and calendars without revealing the late certification', () => {
    expect(world.world).toEqual(taxReportingDay.world);
    const bodies = world.gmail.threads.flatMap(t => t.messages.map(m => m.body)).join('\n');
    expect(bodies).toContain(JSON.stringify(TAX_CURRENT));
    expect(bodies).toContain('client_id,account_id,holder_name,tin,date_of_birth,currency,balance,decision_ref');
    expect(JSON.stringify(world)).not.toContain('H0008');
    expect(JSON.stringify(world)).not.toContain('1985-04-03');
    expect(episodeTwins(taxReportingDay)).toContain('calendar');
    const late = taxReportingDay.beats.find(b => b.ref === 'tax-late-cert')!;
    expect(late.tick).toBe(24);
    expect(JSON.stringify(late)).toContain('H0008');
  });
  it('makes legal and XML measurement limits explicit to both agent and judge', () => {
    expect(taxReportingDay.task).toContain('outside this workflow pilot');
    expect(taxReportingDay.success.judgeQuestions.join(' ')).toContain('UNMEASURED');
    expect(taxReportingDay.success.checklist.filter(c => c.kind === 'judged')).toHaveLength(9);
  });
});
