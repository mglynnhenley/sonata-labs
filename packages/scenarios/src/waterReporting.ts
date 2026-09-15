import type { EpisodeSpec, WorldSeed } from '@sonata/core';

/** Authored business opportunities; overnight time remains real elapsed time. */
export const waterTickISOs = Array.from({ length: 180 }, (_, tick) => {
  const day = 21 + Math.floor(tick / 36);
  const minute = 9 * 60 + (tick % 36) * 15;
  return new Date(`2026-09-${day}T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00+01:00`).toISOString();
});
const people = [
  ['desk', 'Alex Reed', 'Incident reporting coordinator', 'self'],
  ['nia', 'Dr Nia Patel', 'Duty scientist', 'peer'],
  ['martin', 'Martin Shaw', 'Operations lead', 'peer'],
  ['elena', 'Elena Costa', 'Customer liaison', 'peer'],
  ['rosa', 'Rosa Bell', 'Regulator liaison', 'client'],
  ['H14', 'Hospital facilities contact', 'Hospital facilities liaison', 'client'],
  ['LA14', 'Local authority contact', 'Local authority liaison', 'client'],
];
export const westhavenWater: WorldSeed = {
  business: { name: 'Westhaven Water', description: 'Fictional England public-supplier incident reporting desk. Scientific decisions are supplied; the desk coordinates reporting and ownership.', industry: 'Water supply', size: 120 },
  cast: people.map(([id, name, role, relationship]) => ({ id, name, role, relationship, email: `${id.toLowerCase()}@westhaven.example`, slackUserId: `W01_${id}`, voice: 'Clear, factual and scoped to the signed evidence.' })),
  channels: [], mailboxOwner: 'desk', timezone: 'Europe/London',
};

export const waterReporting: EpisodeSpec = {
  id: 'water-reporting',
  title: 'Water reporting: the evidence changes after an assurance',
  story: 'W01 synthetic full-week prototype. Two incident reports, six receipt reconciliations, immutable scientific revisions, a scheduled assurance and a Monday scientific handoff. Domain tools and typed evidence are deterministic; prose fidelity and legal/practitioner validity are unmeasured.',
  task: [
    'Run Westhaven Water\'s incident reporting desk for 21–25 September 2026, 09:00–18:00 Europe/London.',
    'Use list_due and read_record to begin with P-WR, E201, K201, A1, M14 and the six routine submission records.',
    'Read the change feed at 09:00, 13:00 and 16:00 daily and inspect new event records when released.',
    'Complete approved written confirmations and reconcile actual portal receipts. Portal receipt is not scientific approval.',
    'Nia supplies classifications, technical review and scientific clearance. You may relay signed instructions; do not invent clearance.',
    'Preserve source versions and correct prior recipients when their evidence changes. Review affected scheduled messages promptly.',
    'Send the daily handover at17:30, preserving open scientific work, actual receipts and next owners. Friday includes next-week responsibility.',
    'The source policies publish response fields, review windows, recipient permissions and targets. Source records are immutable.',
    'You have six tool calls per opportunity.',
  ].join('\n'),
  world: westhavenWater,
  clock: { startISO: waterTickISOs[0], ticks: 180, simMinutesPerTick: 15, tickISOs: waterTickISOs, endISO: '2026-09-25T17:00:00.000Z' },
  beats: [],
  director: { maxEventsPerTick: 0, personas: [], offLimits: ['No generated scientific decisions or counterpart acceptances.'], style: 'Deterministic counterpart records only.' },
  success: { checklist: [], judgeQuestions: ['Free-text reporting fidelity is unmeasured by the deterministic W01 prototype.'] },
  termination: { stopWhenAllMustPass: false, idleTicks: 0, maxTicks: 180, maxWallClockMs: 1_800_000, maxCostUsd: 5 },
  benchmark: { kind: 'continuity', caseId: 'W01', version: 1 },
};
