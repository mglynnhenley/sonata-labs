import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TEMPLATES } from '../app/api/_lib/templates';
import { draftScenario, NoResemblingExample, SCENARIO_SCHEMA } from '../app/api/_lib/draft';
import { completeJson, hasModelAccess } from '../app/api/_lib/llm';
import { putDoc } from '../app/api/_lib/store';

vi.mock('../app/api/_lib/llm', () => ({ completeJson: vi.fn(), hasModelAccess: vi.fn() }));
vi.mock('../app/api/_lib/store', async importOriginal => ({
  ...await importOriginal<typeof import('../app/api/_lib/store')>(), putDoc: vi.fn(), getDoc: vi.fn(),
}));
const brief = 'An investment assistant helping a venture capital fund with founder calls and investment memos.';
const fixture = () => {
  const scenario = structuredClone(TEMPLATES[0]!.scenario);
  scenario.episode.criteria = scenario.episode.criteria.filter(c => c.kind !== 'moved');
  scenario.cast.forEach(p => { p.brief = 'Answer from the supplied evidence without completing the agent’s tasks.'; });
  return scenario;
};
const partial = () => ({ ...fixture(), episode: { title: '', story: '', task: '', beats: [], criteria: [] } });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(hasModelAccess).mockReturnValue(true);
});

describe('incomplete scenario recovery', () => {
  it('completes a missing workday without replacing the business or losing the user brief', async () => {
    const outline = partial();
    vi.mocked(completeJson).mockResolvedValueOnce(outline).mockResolvedValueOnce(fixture().episode);
    const result = await draftScenario(brief, 24);
    expect(result.draft.offline).toBe(false);
    expect(result.draft.brief).toBe(brief);
    expect(result.seed.business).toEqual(outline.business);
    expect(result.seed.cast.map(p => p.name)).toEqual(expect.arrayContaining(outline.cast.map(p => p.name)));
    expect(result.spec.beats.length).toBeGreaterThanOrEqual(3);
    expect(result.spec.success.checklist.length).toBeGreaterThanOrEqual(2);
    expect(completeJson).toHaveBeenCalledTimes(2);
    const repair = vi.mocked(completeJson).mock.calls[1]![0];
    expect(repair.schemaName).toBe('sonata_episode_repair');
    expect(repair.user).toContain(brief);
    expect(repair.user).toContain(outline.owner);
    expect(putDoc).toHaveBeenCalledTimes(1);
  });

  it('stops after one incomplete-day repair and does not blame working model access', async () => {
    vi.mocked(completeJson).mockResolvedValueOnce(partial()).mockResolvedValueOnce(partial().episode);
    await expect(draftScenario(brief, 24)).rejects.toThrow('After one automatic completion attempt');
    expect(completeJson).toHaveBeenCalledTimes(2);
    expect(putDoc).not.toHaveBeenCalled();
    const error = new NoResemblingExample('The model returned no events or grading criteria');
    expect(error.message).not.toContain('Restore model access');
    expect(error.message).not.toContain('5 shipped');
    expect(error.message).toContain('open a saved scenario');
  });

  it('reports a failed repair accurately and never saves the empty preview', async () => {
    vi.mocked(completeJson).mockResolvedValueOnce(partial()).mockRejectedValueOnce(new Error('Provider temporarily unavailable'));
    await expect(draftScenario(brief, 24)).rejects.toThrow('automatic completion attempt failed: Provider temporarily unavailable');
    expect(completeJson).toHaveBeenCalledTimes(2);
    expect(putDoc).not.toHaveBeenCalled();
  });

  it('does not add a repair call to valid generations or request one without access', async () => {
    vi.mocked(completeJson).mockResolvedValueOnce(fixture());
    await draftScenario(brief, 24);
    expect(completeJson).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
    vi.mocked(hasModelAccess).mockReturnValue(false);
    await expect(draftScenario(brief, 24)).rejects.toThrow('OPENROUTER_API_KEY is not set');
    expect(completeJson).not.toHaveBeenCalled();
    expect(putDoc).not.toHaveBeenCalled();
  });

  it('requires nonempty events and criteria in the wire schema too', () => {
    const schema = SCENARIO_SCHEMA as { properties: { episode: { properties: { beats: { minItems: number }; criteria: { minItems: number } } } } };
    expect(schema.properties.episode.properties.beats.minItems).toBe(3);
    expect(schema.properties.episode.properties.criteria.minItems).toBe(2);
  });
});
