import { describe, it, expect } from 'vitest';
import type { DirectorContext } from '../src/director';
import { createDirector, personSystemPrompt, rewritePrompt } from '../src/director';
import { bodyObservation, observeActions } from '../src/observations';
import { colleagueHistory } from '../src/timeline';
import { createGmailAdapter } from '../src/adapters/gmail';
import { createSlackAdapter } from '../src/adapters/slack';
import { createCalendarAdapter } from '../src/adapters/calendar';
import { auditRow, fakeAdapter, fetchFake, spec, world } from './fixtures';

const context = (over: Partial<DirectorContext> = {}): DirectorContext => ({
  tick: 1, simTimeISO: '2026-08-04T09:15:00Z', simTimeLabel: '09:15', history: [], deltas: [], beatsThisTick: [], ...over,
});
const company = () => spec({ director: { ...spec().director, personas: [
  { personId: 'dana', responsiveness: 0.8, replyDelayTicks: 0, surfaces: ['gmail', 'slack'] },
  { personId: 'sam', responsiveness: 0.8, replyDelayTicks: 0, surfaces: ['gmail', 'slack'] },
] } });
const delivered = (id: number, to: string[], text: string) => auditRow({ id, twin: 'gmail',
  summary: 'Sent a message', observation: { audience: ['priya', ...to], actor: 'priya', text } });
function recorder() {
  const prompts: string[] = [];
  return { prompts, complete: async <T>(o: { system?: string; prompt: string }) => {
    prompts.push(`${o.system}\n${o.prompt}`); return { events: [] } as T;
  } };
}

describe('colleague knowledge boundary', () => {
  it('does not expose another Gmail conversation, even when its prose names the colleague', async () => {
    const model = recorder(); const director = createDirector({ spec: company(), complete: model.complete });
    await director.react(context({ deltas: [delivered(1, ['dana'], 'Please check CASE-A'), delivered(2, ['sam'], 'Dana must never hear SECRET-B')] }));
    expect(model.prompts).toHaveLength(2);
    const dana = model.prompts.find(p => p.includes('YOU ARE Dana Reyes'))!;
    expect(dana).toContain('CASE-A'); expect(dana).not.toContain('SECRET-B');
  });
  it('does not wake an unaddressed colleague just because they are mentioned', async () => {
    const model = recorder(); const director = createDirector({ spec: company(), complete: model.complete });
    await director.react(context({ deltas: [delivered(1, ['sam'], 'Dana is reviewing another case')] }));
    expect(model.prompts).toHaveLength(1); expect(model.prompts[0]).toContain('YOU ARE Sam Okafor');
  });
  it('withholds legacy history, missing audiences and future events', async () => {
    const model = recorder(); const director = createDirector({ spec: company(), complete: model.complete });
    await director.react(context({ deltas: [delivered(1, ['dana'], 'Hello'), { ...delivered(2, ['dana'], 'secret'), observation: undefined, summary: 'LEGACY-SECRET' }],
      history: [{ tick: 0, simTimeISO: '2026-08-04T09:00:00Z', twin: 'gmail', source: 'world', text: 'HISTORY-SECRET' }],
      upcoming: [{ twin: 'gmail', line: 'FUTURE-SECRET' }] }));
    expect(model.prompts.join('')).not.toMatch(/LEGACY-SECRET|HISTORY-SECRET|FUTURE-SECRET/);
  });
  it('does not expose the scenario narrative, global secrets or another persona brief', () => {
    const s = company(); s.story = 'STORY-SECRET'; s.director.offLimits = ['GLOBAL-SECRET']; s.director.personas[1].brief = 'PEER-SECRET';
    const prompt = personSystemPrompt(s, { person: world.cast[1], persona: s.director.personas[0] });
    expect(prompt).not.toMatch(/STORY-SECRET|GLOBAL-SECRET|PEER-SECRET/);
  });
  it('releases scripted evidence to explicit recipients and does not grant access to failed events', async () => {
    const model = recorder(); const director = createDirector({ spec: company(), complete: model.complete });
    const observation = bodyObservation({ twin: 'gmail', kind: 'email', payload: { from: 'priya', to: ['dana'], subject: 'Released', body: 'DOCUMENT-A' } }, world)!;
    await director.react(context({ beatsThisTick: [{ beatId: 'one', twin: 'gmail', kind: 'email', summary: 'Released', observation },
      { beatId: 'two', twin: 'gmail', kind: 'email', summary: 'Failed', observation: { ...observation, text: 'FAILED-SECRET' }, error: 'injection failed' }] }));
    expect(model.prompts).toHaveLength(1); expect(model.prompts[0]).toContain('DOCUMENT-A'); expect(model.prompts[0]).not.toContain('FAILED-SECRET');
  });
  it('supports explicit forwarding without exposing other private history', async () => {
    const model = recorder(); const director = createDirector({ spec: company(), complete: model.complete });
    const original = delivered(1, ['sam'], 'Original private discussion');
    await director.react(context({ history: [{ tick: 0, simTimeISO: '2026-08-04T09:00:00Z', source: 'agent', twin: 'gmail', text: original.observation!.text, observation: original.observation }],
      deltas: [delivered(2, ['dana'], 'Forwarded extract: approved amount 1200')] }));
    expect(model.prompts[0]).toContain('approved amount 1200'); expect(model.prompts[0]).not.toContain('Original private discussion');
  });
  it('does not leak private checker evidence through adaptive rewrites', () => {
    const prompt = rewritePrompt({ beatId: 'x', personId: 'dana', twin: 'gmail', authored: 'Please update me', facts: [], saw: 'CHECKER-SECRET', sawOn: 'gmail',
      wrote: [{ twin: 'gmail', source: 'send', text: 'TOOL-SECRET', tick: 0 }], tick: 1, simTimeLabel: '09:15',
      observations: [{ twin: 'gmail', observation: { audience: ['sam'], text: 'SAM-SECRET' } }, { twin: 'gmail', observation: { audience: ['dana'], text: 'VISIBLE' } }] },
    { person: world.cast[1], persona: company().director.personas[0] });
    expect(prompt).toContain('VISIBLE'); expect(prompt).not.toMatch(/CHECKER-SECRET|TOOL-SECRET|SAM-SECRET/);
  });
  it('does not fabricate a conversation when a delivered record cannot be read', async () => {
    const adapter = fakeAdapter('gmail'); adapter.observe = async () => { throw new Error('404'); };
    const rows = await observeActions(adapter, [{ ...delivered(1, ['dana'], 'unused'), observation: undefined }], world);
    expect(rows[0].observation).toBeUndefined(); expect(rows[0].observationError).toContain('withheld');
    const model = recorder(); await createDirector({ spec: company(), complete: model.complete }).react(context({ deltas: rows }));
    expect(model.prompts).toHaveLength(0);
  });
  it('keeps only released observations in colleague history, and honours a zero budget', () => {
    const tick = { tick: 1, simTimeISO: '2026-08-04T09:15:00Z', startedAt: 0, endedAt: 1, beatsFired: [], directorEvents: [], notes: [],
      agentSteps: [{ kind: 'thought' as const, seq: 0, at: 0, text: 'PRIVATE-REASONING' }], observedActions: [delivered(1, ['dana'], 'Hello')] };
    expect(colleagueHistory([tick], 40)).toHaveLength(1); expect(JSON.stringify(colleagueHistory([tick], 40))).not.toContain('PRIVATE-REASONING');
    expect(colleagueHistory([tick], 0)).toEqual([]);
  });
});

describe('provider observations', () => {
  it('reads actual sent Gmail recipients and body; drafts do not notify their intended recipients', async () => {
    const fake = fetchFake({ '/gmail/v1/users/me/messages/m1': { payload: { mimeType: 'text/plain', headers: [
      { name: 'From', value: 'Priya <priya@northwind.test>' }, { name: 'To', value: 'Dana <dana@acme.test>' },
      { name: 'Bcc', value: 'sam@northwind.test' }, { name: 'Subject', value: 'Case review' },
    ], body: { data: Buffer.from('Please check the attached case').toString('base64url') } } } });
    const adapter = createGmailAdapter({ baseUrl: 'http://gmail.test', oauth: false, fetchImpl: fake.fetch });
    const observation = await adapter.observe!(auditRow({ id: 1, twin: 'gmail', targetId: 'm1' }), world);
    expect(observation?.audience).toEqual(['priya', 'dana', 'sam']); expect(observation?.text).toContain('Please check');
    expect(observation?.text).not.toContain('sam@');
    expect(await adapter.observe!(auditRow({ id: 2, twin: 'gmail', actionType: 'draftCreate' }), world)).toBeUndefined();
  });
  it('uses actual Slack membership, including later pages, rather than the persona app list', async () => {
    const fakeFetch: typeof fetch = async (url, init) => {
      const args = JSON.parse(String(init?.body ?? '{}'));
      const response = String(url).endsWith('/conversations.replies') ? { ok: true, messages: [{ ts: '123.456', user: 'U01PRIYA', text: 'Private request' }] } :
        args.cursor ? { ok: true, members: ['U03SAM'], response_metadata: {} } : { ok: true, members: ['U01PRIYA'], response_metadata: { next_cursor: 'next' } };
      return new Response(JSON.stringify(response), { status: 200 });
    };
    const adapter = createSlackAdapter({ baseUrl: 'http://slack.test', fetchImpl: fakeFetch });
    const observation = await adapter.observe!(auditRow({ id: 1, twin: 'slack', actionType: 'post', targetId: 'C_PRIVATE/123.456' }), world);
    expect(observation?.audience).toEqual(['priya', 'sam']); expect(observation?.audience).not.toContain('dana');
  });
  it('restricts calendar updates to organizer and attendees', async () => {
    const fake = fetchFake({ '/calendar/v3/calendars/primary/events/e1': { summary: 'Private review', organizer: { email: 'priya@northwind.test' }, attendees: [{ email: 'sam@northwind.test', responseStatus: 'accepted' }] } });
    const adapter = createCalendarAdapter({ baseUrl: 'http://calendar.test', fetchImpl: fake.fetch });
    const observation = await adapter.observe!(auditRow({ id: 1, twin: 'calendar', actionType: 'eventPatch', targetId: 'e1', endpoint: '/calendar/v3/calendars/primary/events/e1' }), world);
    expect(observation?.audience).toEqual(['priya', 'sam']); expect(observation?.text).toContain('accepted');
  });
});

describe('live clone health contract', () => {
  it('accepts the Slack ok field without treating an error response as healthy', async () => {
    const good = createSlackAdapter({ baseUrl: 'http://slack.test', fetchImpl: fetchFake({ '/api/health': { ok: true, users: 8 } }).fetch });
    const bad = createSlackAdapter({ baseUrl: 'http://slack.test', fetchImpl: fetchFake({ '/api/health': { ok: false, error: 'database unavailable' } }).fetch });
    expect((await good.health()).ok).toBe(true);
    expect((await bad.health()).ok).toBe(false);
  });
});


it("observes Bcc-only delivery without exposing the hidden address in the message", async () => {
  const fake = fetchFake({ "/gmail/v1/users/me/messages/m1": { payload: { mimeType: "text/plain", headers: [
    { name: "From", value: "priya@northwind.test" }, { name: "Bcc", value: "sam@northwind.test" },
  ], body: { data: Buffer.from("Private note").toString("base64url") } } } });
  const adapter = createGmailAdapter({ baseUrl: "http://gmail.test", oauth: false, fetchImpl: fake.fetch });
  const observation = await adapter.observe!(auditRow({ id: 1, twin: "gmail", targetId: "m1" }), world);
  expect(observation?.audience).toEqual(["priya", "sam"]);
  expect(observation?.text).toContain("Private note");
  expect(observation?.text).not.toContain("sam@");
});
