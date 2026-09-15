import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ExcelWorkbook } from '@sonata/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Import only after isolating storage. These tests must never open the workbook
// served by the app on 3950 or replace its supplied snapshot.
let store: typeof import('../src/lib/store');
let temporaryRoot: string;
let dataDir: string;

beforeAll(async () => {
  temporaryRoot = mkdtempSync(path.join(tmpdir(), 'sonata-excel-store-test-'));
  dataDir = path.join(temporaryRoot, 'data');
  vi.stubEnv('EXCEL_DATA_DIR', dataDir);
  store = await import('../src/lib/store');
  expect(store.DATA_DIR).toBe(dataDir);
});

beforeEach(() => {
  store.closeDb();
  rmSync(dataDir, { recursive: true, force: true });
  store.seedWorkbooks([workbook()]);
});

afterAll(() => {
  store?.closeDb();
  vi.unstubAllEnvs();
  if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
});

function workbook(): ExcelWorkbook {
  const columns = [
    { key: 'tin', label: 'Tax identifier', type: 'text' as const },
    { key: 'amount', label: 'Reportable amount', type: 'number' as const },
  ];
  return {
    id: 'reporting', title: 'Categorised FATCA CRS', revision: 1,
    sheets: [
      { id: 'source', name: 'Original source', readOnly: true, columns, rows: [{ id: '00101', values: { tin: '00001234', amount: 100 } }] },
      { id: 'proposed', name: 'Proposed updates', columns, rows: [{ id: '00101', values: { tin: '00001234', amount: 100 } }] },
    ],
  };
}

function update(revision = 1, value: string | number = 150) {
  return {
    revision,
    changes: [{ sheetId: 'proposed', rowId: '00101', column: 'amount', value }],
    reason: 'Reconciled the latest statement',
    evidence: 'gmail:statement-42, attachment line 8',
  };
}

describe('workbook storage invariants', () => {
  it('retains the supplied original after proposed edits and refuses edits to source sheets', () => {
    store.mutate('reporting', update(), 'agent');
    expect(store.getWorkbook('reporting', true)).toEqual(workbook());
    expect(store.getWorkbook('reporting').sheets[1].rows[0].values.amount).toBe(150);
    expect(() => store.mutate('reporting', {
      ...update(2), changes: [{ sheetId: 'source', rowId: '00101', column: 'amount', value: 999 }],
    }, 'agent')).toThrow('read-only');
    expect(store.getWorkbook('reporting').sheets[0]).toEqual(workbook().sheets[0]);
    expect(store.history()).toHaveLength(1);
  });

  it('preserves leading zeros and rejects numeric values for identifier text columns', () => {
    expect(store.getWorkbook('reporting').sheets[1].rows[0]).toEqual({ id: '00101', values: { tin: '00001234', amount: 100 } });
    expect(() => store.mutate('reporting', {
      ...update(), changes: [{ sheetId: 'proposed', rowId: '00101', column: 'tin', value: 1234 }],
    }, 'agent')).toThrow('Text columns require strings');
    const invalidSeed = workbook();
    invalidSeed.sheets[1].rows[0].values.tin = 1234;
    expect(() => store.seedWorkbooks([invalidSeed])).toThrow('Text columns require strings');
    expect(store.getWorkbook('reporting')).toEqual(workbook());
    expect(store.history()).toEqual([]);
    expect(store.activity(0)).toEqual([]);
  });

  it('rejects stale revisions without changing workbook, history or audit', () => {
    store.mutate('reporting', update(), 'agent');
    const current = store.snapshotWorkbooks();
    const audit = store.activity(0);
    try {
      store.mutate('reporting', update(1, 999), 'agent');
      throw new Error('Expected a revision conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(store.WorkbookError);
      expect(error).toMatchObject({ status: 409 });
    }
    expect(store.getWorkbook('reporting')).toEqual(current.workbooks[0]);
    expect(store.history()).toEqual(current.changes);
    expect(store.activity(0)).toEqual(audit);
  });

  it('rolls back the entire batch when a later cell is invalid', () => {
    expect(() => store.mutate('reporting', {
      ...update(), changes: [
        ...update().changes,
        { sheetId: 'proposed', rowId: 'missing-row', column: 'amount', value: 250 },
      ],
    }, 'agent')).toThrow('Row or column not found');
    expect(store.getWorkbook('reporting')).toEqual(workbook());
    expect(store.history()).toEqual([]);
    expect(store.activity(0)).toEqual([]);
  });

  it('keeps setup and human edits out of the agent audit while recording human history', () => {
    expect(store.activity(0)).toEqual([]);
    store.mutate('reporting', update(), 'human');
    expect(store.activity(0)).toEqual([]);
    expect(store.history()).toMatchObject([{ actor: 'human', before: 100, after: 150 }]);
    store.mutate('reporting', update(2, 175), 'agent');
    expect(store.activity(0)).toMatchObject([{ action_type: 'updateCells', target_type: 'workbook', target_id: 'reporting' }]);
    expect(store.activity(0)).toHaveLength(1);
    store.seedWorkbooks([workbook()]);
    expect(store.activity(0)).toHaveLength(1);
  });

  it('retains attributable cell values, revision, reason and source evidence in history and audit', () => {
    store.mutate('reporting', update(), 'agent');
    const changes = store.history('reporting');
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      workbookId: 'reporting', revision: 2, actor: 'agent', sheetId: 'proposed', rowId: '00101', column: 'amount',
      before: 100, after: 150, reason: update().reason, evidence: update().evidence,
    });
    expect(Number.isFinite(Date.parse(changes[0].at))).toBe(true);
    const audit = store.activity(0) as Array<{ summary: string; request_json: string }>;
    expect(audit[0].summary).toContain('proposed/00101/amount: 100 → 150');
    expect(audit[0].summary).toContain(update().reason);
    expect(audit[0].summary).toContain(update().evidence);
    expect(JSON.parse(audit[0].request_json)).toEqual(update());
  });

  it('adds an editable row with per-cell history and one agent action', () => {
    const result = store.mutate('reporting', {
      revision: 1, sheetId: 'proposed', values: { tin: '00004567', amount: 75 },
      reason: 'New investor admitted', evidence: 'slack:onboarding-19',
    }, 'agent', true);
    const row = result.workbook.sheets[1].rows[1];
    expect(result.workbook.revision).toBe(2);
    expect(row.values).toEqual({ tin: '00004567', amount: 75 });
    expect(row.id).not.toBe('00101');
    expect(store.getWorkbook('reporting', true)).toEqual(workbook());
    expect(store.history()).toEqual([
      expect.objectContaining({ rowId: row.id, column: 'tin', before: null, after: '00004567', evidence: 'slack:onboarding-19' }),
      expect.objectContaining({ rowId: row.id, column: 'amount', before: null, after: 75, evidence: 'slack:onboarding-19' }),
    ]);
    expect(store.activity(0)).toMatchObject([{ action_type: 'addRow', method: 'POST', target_id: 'reporting' }]);
    expect(store.activity(0)).toHaveLength(1);
  });

  it('restores the supplied snapshot and clears workbook changes while retaining the agent audit', () => {
    store.mutate('reporting', update(), 'agent');
    const audit = store.activity(0);
    expect(store.resetWorkbooks()).toEqual({ workbooks: 1 });
    expect(store.getWorkbook('reporting')).toEqual(workbook());
    expect(store.getWorkbook('reporting', true)).toEqual(workbook());
    expect(store.history()).toEqual([]);
    expect(store.activity(0)).toEqual(audit);
    store.mutate('reporting', update(1, 200), 'agent');
    const after = store.activity(0) as Array<{ id: number }>;
    expect(after).toHaveLength(2);
    expect(store.activity(after[0].id)).toEqual([after[1]]);
  });
});
