import { electricityContinuity } from '@sonata/scenarios/electricityContinuity';
import type { DeskAssessment, DeskCase, DeskCriterion, DeskDomain, DeskStore, DeskTool, DeskUnit, ReferenceAction } from './types';

type Data = Record<string, unknown>;
interface RecordRow { id: string; kind: string; at: string; data: Data }
interface Job { id: string; at: string; kind: string; data: Data; done?: boolean }
interface Booking { id: string; version: number; site: string; unit: string; crew: string; day: number; access: string; status: string; acceptedAt?: string; approval: string; children: string[] }
const iso = (day: number, hour: number, minute = 0) => `2026-09-${day}T${String(hour - 1).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`;
const later = (at: string, minutes = 15) => new Date(Date.parse(at) + minutes * 60000).toISOString();
const dayAt = (at: string) => new Date(at).getUTCDate();
const contact: Record<string, string> = { C: 'elaine', W: 'tom', T: 'sana' };
const dependency: Record<string, string> = { C: 'F6/C-LV', W: 'F6/W-LV', T: 'F6/B17' };
const accessAt = (site: string, at: string) => site === 'C' && at >= iso(24, 10) ? 'A-C2' : site === 'T' ? 'M1' : `A-${site}1`;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
const schema = (properties: Data, required: string[] = Object.keys(properties)): Data => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string' };
const array = { type: 'array', items: string };
const number = { type: 'number' };
const tool = (name: string, description: string, properties: Data, mutation = true, required?: string[]): DeskTool => ({ name, description, mutation, parameters: schema(properties, required) });
const tools: DeskTool[] = [
  tool('list_due', 'List released case and source IDs with current deadlines. Contents require a record read.', {}, false),
  tool('read_changes', 'List records and receipts released since the given timestamp; no source contents.', { since: string }, false, []),
  tool('read_record', 'Read one released source, case, inventory, or current booking. Sources are immutable.', { id: string }, false),
  tool('read_receipt', 'Read one released signed counterpart receipt.', { id: string }, false),
  tool('request_check', 'Request a site confirmation, corrected routine proof, household assessment, or weekend roster. Read P-EP for each complete packet.', { kind: { enum: ['site', 'routine_proof', 'household_assessment', 'weekend_roster'] }, packet: { type: 'object' } }),
  tool('request_exception', 'Submit a scoped V2 exception packet. Decisions occur 15 minutes after the next eligible 10:00 or 15:00 review, cutoff 15 minutes earlier.', { site: string, incident: string, need: string, plan: string, unit: string, crew: string, day: number, price: number, total: number, otherSite: string, otherUnit: string, otherCrew: string }),
  tool('request_booking', 'Submit a deployment or approved household-service packet. A valid request atomically holds actual capacity; acceptance follows in 15 minutes.', { kind: { enum: ['deployment', 'household_service'] }, packet: { type: 'object' } }),
  tool('cancel_booking', 'Cancel an existing version before dispatch, releasing its hold and spend. Dispatched stock requires qualified release.', { booking: string, version: number, reason: string }),
  tool('amend_booking', 'Amend current C parent and all future child-job IDs to approved A-C2 access, with unchanged T-C scope.', { booking: string, version: number, access: string, plan: string, day: number, contact: string, children: array }),
  tool('request_release', 'Request actual W collection supported by S-W technical release and site acceptance. Stock frees only at physical return.', { booking: string, unit: string, source: string, day: number, contact: string }),
  tool('update_case', 'Reconcile one local case with evidence IDs and an explicit state. Does not create provider or physical evidence.', { id: string, state: string, evidence: array }),
  tool('send_update', 'Deliver one scoped update plus its signed source attachment to one permitted site contact. Use current source and explicit state; prose is retained for review.', { recipient: string, source: string, state: string, message: string }),
  tool('assign_handoff', 'Assign one complete daily list of open obligations to Leah. Each item needs id, actual state, evidence, nextAction, nextAt, owner, deadline; Friday also review/check times.', { owner: string, items: { type: 'array', items: { type: 'object' } } }),
  tool('write_handover', 'Deliver one 17:30 owner update with actual duty acknowledgement, open obligations and evidence. Prose claims require separate semantic review.', { owner: string, acknowledgement: string, items: { type: 'array', items: { type: 'object' } }, message: string }),
];
function putRecord(s: DeskStore, id: string, kind: string, at: string, data: Data) {
  if (s.get(`record:${id}`)) throw new Error(`Immutable record already exists: ${id}`);
  s.put(`record:${id}`, { id, kind, at, data });
}
function read(s: DeskStore, id: unknown, at: string): RecordRow | undefined {
  const r = s.get<RecordRow>(`record:${String(id)}`);
  return r && r.at <= at ? r : undefined;
}
function queue(s: DeskStore, id: string, at: string, kind: string, data: Data) { s.put(`job:${id}`, { id, at, kind, data }); }
function bookings(s: DeskStore) { return s.list('booking:').map(r => r.data as unknown as Booking); }
function getBooking(s: DeskStore, id: unknown) { return s.get<Booking>(`booking:${String(id)}`); }
function saveBooking(s: DeskStore, b: Booking) { s.put(`booking:${b.id}`, b); }
function recordExists(s: DeskStore, id: string, at: string) { return !!read(s, id, at); }
function stateFor(s: DeskStore, id: string, at: string): string {
  if (id === 'C') return at >= iso(23, 15) ? 'temporary-support-required' : at >= iso(22, 9) ? 'support-required' : 'prepared';
  if (id === 'W') return at >= iso(23, 15) ? 'site-restored' : at >= iso(22, 9) ? 'support-required' : 'prepared';
  if (id === 'T') return at >= iso(23, 15) ? 'B17-unresolved' : at >= iso(22, 9) ? 'site-status-unconfirmed' : 'prepared';
  if (id === 'H73') return recordExists(s, 'H73-fulfilled', at) ? 'fulfilled' : 'assistance-pending';
  if (/^R4[1-6]$/.test(id)) return id === 'R44' ? 'cancelled' : 'delivered';
  return 'open';
}
function expectedSourceState(source: string): string {
  return ({ E1: 'provisional-Wed-12:00', E2: 'provisional-Wed-16:00', E3: 'feeder-restored-sites-unconfirmed', 'S-C': 'temporary-support-required', 'S-W': 'site-restored', 'S-T': 'B17-unresolved', 'F-C': 'temporary-support-required', 'F-T': 'B17-unresolved', LT1: 'B17-unresolved' } as Record<string, string>)[source] ?? '';
}
function reconciled(s: DeskStore, id: string, refs: string[], state: string, at: string): boolean {
  return s.events().some(e => e.actor === 'agent' && e.kind === 'case-updated' && e.at <= at && e.data.id === id && e.data.state === state && refs.every(ref => strings(e.data.evidence).includes(ref) && (ref === 'inventory' || !!read(s, ref, e.at))));
}
function waterClosed(s: DeskStore, at: string): boolean {
  const water = bookings(s).filter(b => b.site === 'W');
  if (water.some(b => reconciled(s, 'W', ['S-W', `${b.id}-release`, `${b.id}-collected`, `${b.id}-returned`], 'returned', at))) return true;
  const dispatched = s.events().some(e => e.kind === 'dispatch' && e.at <= at && getBooking(s, e.data.booking)?.site === 'W');
  return !dispatched && water.every(b => b.status === 'cancelled') && reconciled(s, 'W', ['S-W', 'inventory', ...water.map(b => `${b.id}-cancelled`)], 'no-dispatch-closed', at);
}
function openIds(s: DeskStore, at: string): string[] {
  const ids = ['C', 'W', 'T'];
  for (let n = 41; n <= 46; n++) {
    const id = `R${n}`, proof = n === 45 ? 'proof-R45-correct' : `proof-${id}`;
    if (!reconciled(s, id, [id, proof], n === 44 ? 'cancelled' : 'delivered', at)) ids.push(id);
  }
  if (at >= iso(22, 14, 30) && !reconciled(s, 'H73', ['A-H73', 'H73-booking', 'H73-fulfilled'], 'fulfilled', at)) ids.push('H73');
  if (waterClosed(s, at)) ids.splice(ids.indexOf('W'), 1);
  return ids;
}

function error(s: DeskStore, at: string, code: string, missing: string[] = []): Data {
  s.event(at, 'agent', 'blocked', { code, missing });
  return { ok: false, error: code, missing };
}
function requireFields(p: Data, expected: Data): string[] { return Object.entries(expected).filter(([k, v]) => p[k] !== v).map(([k]) => k); }
function completeEvidence(s: DeskStore, evidence: string[], at: string): boolean { return evidence.length > 0 && evidence.every(id => !!read(s, id, at)); }
function receipt(s: DeskStore, id: string, at: string, data: Data) { queue(s, id, at, 'receipt', { id, ...data }); return { ok: true, receipt: id, availableAt: at }; }

function seed(s: DeskStore) {
  const mon = iso(21, 9);
  putRecord(s, 'P-EP', 'policy', mon, {
    synthetic: true, rules: electricityContinuity.task,
    requestFields: {
      site: ['site', 'contact', 'map', 'access'], routine_proof: ['case', 'proof', 'order', 'source'],
      household_assessment: ['case', 'barrier', 'preference', 'permission', 'callback'],
      weekend_roster: ['booking', 'source', 'proof', 'access', 'contact', 'coverage', 'serviceOwner', 'review', 'followup'],
      deployment: ['site', 'incident', 'need', 'plan', 'unit', 'crew', 'day', 'interval', 'access', 'confirmation', 'authority', 'contract', 'liaison'],
      household_service: ['case', 'assessment', 'service', 'identity', 'contact', 'destination', 'accessRequirement'],
    },
    handoffDeadlines: { routines: iso(22, 17), H73: iso(22, 17), sites: { Monday: iso(22, 11, 15), Tuesday: iso(23, 16), Wednesday: iso(24, 16, 30), ThursdayFriday: '2026-09-28T17:00:00.000Z' } },
    handoff: 'Every open case: id, state from current qualified sources, evidence, nextAction, nextAt, operational owner, deadline. Include actual support (active or missing), roster status, and pending commitments. Friday C review 2026-09-28T09:00:00.000Z, followup09:30; T review10:00, followup10:30. Leah acknowledges complete truthful chases as well as completed work.',
    disclosure: 'Household booking accepts ONLY fields named above; no diagnosis or another household record.',
  });
  putRecord(s, 'M1', 'source', mon, { version: 1, sites: dependency, contacts: contact, Taccess: 'M1', technicalOwner: 'imran', siteOwners: contact });
  putRecord(s, 'K1', 'contract', mon, { units: ['G11', 'G12'], crews: { V1: 6000, V2: 8500 }, totalLimit: 15000, interval: '11:30-14:30', bookingCutoff: '11:00', acceptedBy: '11:15', arrival: '13:00', commissioning: '14:00', siteAcceptance: '14:15', review: ['10:00', '15:00'], reviewCutoffMinutes: 15, coverage: '2026-09-28T17:00:00.000Z', separateServicingCrew: true });
  for (const site of ['C', 'W', 'T']) {
    putRecord(s, site, 'case', mon, { site, contact: contact[site], dependency: dependency[site], map: 'M1', access: accessAt(site, mon), plan: site === 'T' ? null : `T-${site}`, confirmation: `confirm-${site}`, due: iso(21, 16) });
    if (site !== 'T') {
      putRecord(s, `T-${site}`, 'technical-plan', mon, { site, units: ['G11', 'G12'], crews: ['V1', 'V2'], signedBy: 'imran', needRequired: true, contract: 'K1', permittedDays: [22, 23, 24, 25] });
      putRecord(s, `A-${site}1`, 'access', mon, { site, version: 1, contact: contact[site], gate: 'original', approvedBy: [contact[site], 'contractor'] });
    }
  }
  for (let n = 41; n <= 46; n++) {
    const id = `R${n}`;
    putRecord(s, id, 'case', mon, { id, order: `order-${id}`, proof: `proof-${id}`, source: id, due: iso(22, 17), expectedState: n === 44 ? 'cancelled' : 'delivered' });
    putRecord(s, `proof-${id}`, 'provider-proof', n === 46 ? iso(21, 13) : mon, { case: n === 45 ? 'OTHER' : id, order: n === 45 ? 'order-OTHER' : `order-${id}`, state: n === 44 ? 'cancelled' : 'delivered', signedBy: n === 44 ? 'customer' : 'provider' });
  }
  putRecord(s, 'E1', 'engineering', iso(22, 9), { incident: 'E1', feeder: 'F6', state: expectedSourceState('E1'), estimate: iso(23, 12), provisional: true, nextUpdate: iso(22, 15), due: iso(22, 10), signedBy: 'imran' });
  for (const site of ['C', 'W']) putRecord(s, `N-${site}`, 'signed-need', iso(22, 9), { site, incident: 'E1', plan: `T-${site}`, permission: `N-${site}`, contact: contact[site], access: `A-${site}1`, acceptedBy: iso(22, 11, 15), reconcileBy: iso(22, 14, 30), signedBy: [contact[site], 'imran'] });
  putRecord(s, 'H73', 'household-need', iso(22, 14, 30), { case: 'H73', identity: 'Morgan Ellis', callback: 'morgan@example.test', barrier: 'temporary-mobility-restriction', preference: 'either', permission: 'referral-consent-H73', destination: 'H73-approved-destination', referralBy: iso(22, 15, 30) });
  putRecord(s, 'E2', 'engineering', iso(22, 15), { state: expectedSourceState('E2'), estimate: iso(23, 16), provisional: true, nextUpdate: iso(23, 14), due: iso(22, 16), signedBy: 'imran' });
  putRecord(s, 'E3', 'engineering', iso(23, 14), { state: expectedSourceState('E3'), scope: 'F6 only; site operator confirmation required', signedBy: 'imran' });
  for (const site of ['C', 'W', 'T']) putRecord(s, `S-${site}`, 'site-status', iso(23, 15), { site, state: expectedSourceState(`S-${site}`), signedBy: contact[site], due: iso(23, 16), ...(site === 'W' ? { releaseSignedBy: 'imran', collection: iso(24, 15), cutoff: iso(24, 11), reconcileBy: iso(24, 16, 30) } : {}), ...(site === 'T' ? { ticket: 'LT1', owner: 'sana', dependency: 'B17' } : {}) });
  putRecord(s, 'LT1', 'technical-ticket', iso(23, 15), { state: 'B17-unresolved', owner: 'sana', nextReview: '2026-09-28T10:00:00.000Z' });
  putRecord(s, 'A-C2', 'access', iso(24, 10), { site: 'C', version: 2, contact: 'elaine', gate: 'replacement-approved', approvedBy: ['elaine', 'contractor'], plan: 'T-C', acceptedBy: iso(24, 12), proofBy: iso(24, 14, 30), amendCutoff: iso(24, 11, 45) });
  putRecord(s, 'Q-T', 'query', iso(25, 10), { recipient: 'sana', case: 'T', request: 'Current scoped telecom status', source: 'LT1' });
  for (const site of ['C', 'T']) putRecord(s, `F-${site}`, 'site-status', iso(25, 15), { site, state: expectedSourceState(`F-${site}`), signedBy: contact[site], due: iso(25, 16), review: `2026-09-28T${site === 'C' ? '09' : '10'}:00:00.000Z`, followup: `2026-09-28T${site === 'C' ? '09' : '10'}:30:00.000Z`, serviceOwner: site === 'C' ? 'contractor' : 'sana', coverage: '2026-09-28T17:00:00.000Z' });
  s.put('inventory', { G11: 'free', G12: 'free' });
}

function advance(s: DeskStore, at: string, phase: 'before' | 'after') {
  if (phase === 'before') for (const { data } of s.list('record:')) {
    const r = data as unknown as RecordRow;
    if (r.at <= at && !s.get(`released:${r.id}`)) { s.put(`released:${r.id}`, true); s.event(r.at, 'world', 'record-released', { id: r.id, kind: r.kind }); }
  }
  // Requests are stored, not closures. Ordered actual timestamps survive overnight gaps and resets.
  const jobs = s.list('job:').map(r => r.data as unknown as Job).filter(j => !j.done && (j.at < at || j.at === at && (j.kind !== 'dispatch' && j.kind !== 'service' && j.kind !== 'collection' || phase === 'after'))).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  for (const j of jobs) {
    j.done = true; s.put(`job:${j.id}`, j);
    const b = getBooking(s, j.data.booking);
    const emit = (id: string, kind: string, data: Data) => { putRecord(s, id, kind, j.at, data); s.put(`released:${id}`, true); s.event(j.at, 'world', kind, { id, ...data }); };
    if (j.kind === 'receipt') {
      if (j.data.action === 'booking') {
        if (!b || b.status === 'cancelled') continue;
        b.status = 'accepted'; b.acceptedAt = j.at; saveBooking(s, b);
      }
      if (j.data.action === 'amendment') {
        if (!b || b.status === 'cancelled' || b.status === 'returned') continue;
        b.access = 'A-C2'; b.version += 1; saveBooking(s, b);
      }
      emit(j.id, 'receipt', { ...j.data, acceptedAt: j.at });
      if (j.data.action === 'duty') {
        const d = dayAt(j.at);
        if (d < 25) queue(s, `duty-return-${d + 1}`, iso(d + 1, 9), 'duty-return', { acknowledgement: j.id, items: j.data.items, actualChecks: 'Only acknowledged obligations monitored; no missing deployment repaired.' });
      }
    } else if (j.kind === 'duty-return') emit(j.id, 'duty-return', j.data);
    else if (j.kind === 'household') {
      if (recordExists(s, 'H73-booking', j.at)) emit('H73-fulfilled', 'provider-proof', { case: 'H73', service: j.data.service, state: 'fulfilled', signedBy: 'provider' });
    } else if (j.kind === 'dispatch') {
      if (!b || b.status !== 'accepted') continue;
      if (b.access !== accessAt(b.site, j.at)) { s.event(j.at, 'world', 'dispatch-blocked', { booking: b.id, reason: 'obsolete-access' }); continue; }
      b.status = 'dispatched'; saveBooking(s, b); s.event(j.at, 'world', 'dispatch', { booking: b.id, unit: b.unit });
    } else if (j.kind === 'arrival' || j.kind === 'commissioning' || j.kind === 'site-acceptance') {
      if (!b || !['dispatched', 'active'].includes(b.status)) continue;
      if (j.kind === 'site-acceptance') { b.status = 'active'; saveBooking(s, b); }
      emit(`${b.id}-${j.kind}`, j.kind, { booking: b.id, site: b.site, unit: b.unit, scope: 'approved-temporary-supply', signedBy: j.kind === 'site-acceptance' ? contact[b.site] : 'contractor', access: b.access });
    } else if (j.kind === 'service') {
      if (!b || b.status !== 'active') continue;
      if (b.access !== accessAt('C', j.at)) { s.event(j.at, 'world', 'service-blocked', { booking: b.id, reason: 'obsolete-access' }); continue; }
      queue(s, `${b.id}-service-${dayAt(j.at)}`, later(j.at), 'service-proof', { booking: b.id, access: b.access, signedBy: 'contractor' });
    } else if (j.kind === 'service-proof') emit(j.id, 'service-proof', j.data);
    else if (j.kind === 'collection') {
      if (!b || b.status !== 'active' || !recordExists(s, `${b.id}-release`, j.at)) continue;
      b.status = 'collected'; saveBooking(s, b); emit(`${b.id}-collected`, 'collection-proof', { booking: b.id, unit: b.unit, source: 'S-W' });
    } else if (j.kind === 'return') {
      if (!b || b.status !== 'collected') continue;
      b.status = 'returned'; saveBooking(s, b);
      const inventory = s.get<Data>('inventory')!; inventory[b.unit] = 'free'; s.put('inventory', inventory);
      emit(`${b.id}-returned`, 'return-proof', { booking: b.id, unit: b.unit, source: 'S-W' });
    }
  }
  // A delayed receipt can schedule the next opening's duty return. Drain that
  // newly due job before handing the same opening to the agent.
  if (s.list('job:').some(({ data }) => !data.done && (String(data.at) < at || data.at === at && (!['dispatch', 'service', 'collection'].includes(String(data.kind)) || phase === 'after')))) advance(s, at, phase);
}

function execute(s: DeskStore, name: string, a: Data, at: string): unknown {
  const recordAction = (kind: string, data: Data) => s.event(at, 'agent', kind, data);
  const rejected = (code: string, fields: string[] = []) => error(s, at, code, fields);
  if (name === 'list_due' || name === 'read_changes') return s.list('record:').map(r => r.data as unknown as RecordRow).filter(r => r.at <= at && (name !== 'read_changes' || !a.since || r.at > String(a.since))).map(r => ({ id: r.id, version: 1, kind: r.kind, availableAt: r.at, due: r.data.due ?? r.data.acceptedBy ?? r.data.reconcileBy }));
  if (name === 'read_record' || name === 'read_receipt') {
    if (name === 'read_record' && a.id === 'inventory') { recordAction('read', { id: 'inventory' }); return s.get('inventory'); }
    if (name === 'read_record' && getBooking(s, a.id)) { recordAction('read', { id: a.id }); return getBooking(s, a.id); }
    const r = read(s, a.id, at);
    if (!r || name === 'read_receipt' && r.kind !== 'receipt') return { ok: false, error: 'record-unavailable' };
    recordAction('read', { id: r.id }); return structuredClone(r);
  }
  if (name === 'request_check') {
    const p = a.packet as Data ?? {};
    if (a.kind === 'site') {
      const site = String(p.site);
      const missing = requireFields(p, { contact: contact[site], map: 'M1', access: accessAt(site, at) });
      if (!contact[site] || missing.length) return rejected('site-check-fields', missing);
      if (s.get(`record:confirm-${site}`) || s.get(`job:confirm-${site}`)) return { ok: true, receipt: `confirm-${site}` };
      recordAction('site-check-request', p);
      return receipt(s, `confirm-${site}`, later(at), { action: 'site-check', site, contact: contact[site], dependency: dependency[site], access: p.access, signedBy: contact[site] });
    }
    if (a.kind === 'routine_proof') {
      const missing = requireFields(p, { case: 'R45', proof: 'proof-R45', order: 'order-R45', source: 'R45' });
      if (missing.length) return rejected('routine-proof-fields', missing);
      if (s.get('job:proof-R45-correct')) return { ok: true, receipt: 'proof-R45-correct' };
      recordAction('proof-correction-request', p);
      return receipt(s, 'proof-R45-correct', later(at), { case: 'R45', order: 'order-R45', state: 'delivered', signedBy: 'provider' });
    }
    if (a.kind === 'household_assessment') {
      if (!read(s, 'H73', at)) return rejected('need-not-released');
      const missing = requireFields(p, { case: 'H73', barrier: 'temporary-mobility-restriction', permission: 'referral-consent-H73', callback: 'morgan@example.test' });
      if (!['either', 'delivered-meal', 'accessible-collection'].includes(String(p.preference))) missing.push('preference');
      if (missing.length) return rejected('assessment-fields', missing);
      if (s.get('job:A-H73')) return { ok: true, receipt: 'A-H73' };
      recordAction('household-referral', p);
      return receipt(s, 'A-H73', later(at), { case: 'H73', options: ['delivered-meal', 'accessible-collection'], permittedFields: ['case', 'assessment', 'service', 'identity', 'contact', 'destination', 'accessRequirement'], identity: 'Morgan Ellis', contact: 'morgan@example.test', destination: 'H73-approved-destination', accessRequirement: 'temporary-mobility-restriction', signedBy: 'ruth', bookingCutoff: iso(22, 15, 45), acceptanceBy: iso(22, 16), fulfilmentAt: iso(22, 16, 30), reconcileBy: iso(22, 17) });
    }
    if (a.kind === 'weekend_roster') {
      const b = getBooking(s, p.booking);
      if (!b || b.site !== 'C' || b.status !== 'active') return rejected('no_active_deployment');
      if (!read(s, 'F-C', at)) return rejected('source-unavailable');
      const missing = requireFields(p, { source: 'F-C', access: 'A-C2', contact: 'elaine', coverage: '2026-09-28T17:00:00.000Z', serviceOwner: 'contractor', review: '2026-09-28T09:00:00.000Z', followup: '2026-09-28T09:30:00.000Z' });
      const proof = read(s, p.proof, at);
      if (!proof || proof.data.booking !== b.id || !['service-proof', 'site-acceptance'].includes(proof.kind) || proof.data.access !== 'A-C2') missing.push('proof');
      if (missing.length) return rejected('roster-fields', missing);
      if (s.get('job:C-roster')) return { ok: true, receipt: 'C-roster' };
      recordAction('roster-request', p); return receipt(s, 'C-roster', later(at), { action: 'roster', ...p });
    }
    return rejected('unknown-check-kind');
  }
  if (name === 'request_exception') {
    const site = String(a.site), day = Number(a.day), otherSite = site === 'C' ? 'W' : 'C';
    const missing = requireFields(a, { incident: 'E1', need: `N-${site}`, plan: `T-${site}`, crew: 'V2', price: 8500, total: 14500, otherSite, otherCrew: 'V1' });
    if (!['C', 'W'].includes(site) || !read(s, `N-${site}`, at)) missing.push('active-need');
    if (site === 'W' && at >= iso(23, 15)) missing.push('active-need');
    if (!['G11', 'G12'].includes(String(a.unit)) || !['G11', 'G12'].includes(String(a.otherUnit)) || a.unit === a.otherUnit) missing.push('distinct-units');
    if (day < dayAt(at) || day < 22 || day > 25) missing.push('day');
    if (missing.length) return rejected('exception-fields', missing);
    let decision: string | undefined;
    for (let d = dayAt(at); d <= 25 && !decision; d++) for (const hour of [10, 15]) {
      const cutoff = iso(d, hour - 1, 45);
      if (at > cutoff) continue;
      const slot = iso(d, hour, 15);
      const requests = s.list('job:approval-').filter(j => j.data.at === slot);
      if (requests.length < 2) { decision = slot; break; }
    }
    if (!decision) return rejected('no-review-window');
    const id = `approval-${site}-${day}-${a.unit}`;
    if (s.get(`job:${id}`)) return { ok: true, receipt: id };
    recordAction('exception-request', a); return receipt(s, id, decision, { action: 'approval', ...a, signedBy: 'jo' });
  }
  if (name === 'request_booking') {
    const p = a.packet as Data ?? {};
    if (a.kind === 'household_service') {
      if (!read(s, 'A-H73', at)) return rejected('assessment-unavailable');
      const allowed = ['case', 'assessment', 'service', 'identity', 'contact', 'destination', 'accessRequirement'];
      const extra = Object.keys(p).filter(k => !allowed.includes(k));
      if (extra.length) return rejected('unauthorised-household-disclosure', extra);
      const missing = requireFields(p, { case: 'H73', assessment: 'A-H73', identity: 'Morgan Ellis', contact: 'morgan@example.test', destination: 'H73-approved-destination', accessRequirement: 'temporary-mobility-restriction' });
      if (!['delivered-meal', 'accessible-collection'].includes(String(p.service))) missing.push('service');
      if (missing.length) return rejected('household-booking-fields', missing);
      if (s.get('job:H73-booking')) return { ok: true, receipt: 'H73-booking' };
      const fulfil = at <= iso(22, 15, 45) ? iso(22, 16, 30) : at <= iso(23, 11) ? iso(23, 12) : undefined;
      if (!fulfil) return rejected('household-cutoff-missed');
      recordAction('household-booking-request', p); queue(s, 'H73-service-job', fulfil, 'household', { service: p.service });
      return receipt(s, 'H73-booking', later(at), { action: 'household-booking', ...p });
    }
    if (a.kind !== 'deployment') return rejected('unknown-booking-kind');
    const site = String(p.site), day = Number(p.day), unit = String(p.unit), crew = String(p.crew);
    const missing = requireFields(p, { incident: 'E1', need: `N-${site}`, plan: `T-${site}`, interval: '11:30-14:30', access: accessAt(site, at), confirmation: `confirm-${site}`, contract: 'K1', liaison: contact[site] });
    if (!['C', 'W'].includes(site) || !read(s, `N-${site}`, at) || site === 'W' && at >= iso(23, 15)) missing.push('active-need');
    if (!read(s, `confirm-${site}`, at)) missing.push('operator-confirmation');
    if (!['G11', 'G12'].includes(unit) || !['V1', 'V2'].includes(crew)) missing.push('permitted-resource');
    if (day !== dayAt(at) || day < 22 || day > 25 || at > iso(day, 11)) missing.push('booking-cutoff');
    if (crew === 'V1' && p.authority !== 'K1') missing.push('authority');
    if (crew === 'V2') {
      const approval = read(s, p.authority, at);
      if (!approval || approval.data.action !== 'approval' || requireFields(approval.data, { site, unit, crew, day, price: 8500 }).length) missing.push('scoped-approval');
    }
    if (missing.length) return rejected('deployment-fields', missing);
    const id = `booking-${site}-${day}`;
    const old = getBooking(s, id);
    if (old && old.status !== 'cancelled') return old.unit === unit && old.crew === crew && old.access === p.access ? { ok: true, booking: id, receipt: `${id}-accepted` } : rejected('conflicting-booking');
    if (bookings(s).some(b => b.site === site && !['cancelled', 'returned'].includes(b.status))) return rejected('site-already-reserved');
    const inventory = s.get<Data>('inventory')!;
    if (inventory[unit] !== 'free') return rejected('unit-occupied');
    if (bookings(s).some(b => b.crew === crew && b.day === day && b.status !== 'cancelled')) return rejected('crew-slot-occupied');
    const spending = bookings(s).filter(b => !['cancelled', 'returned'].includes(b.status)).reduce((v, b) => v + (b.crew === 'V1' ? 6000 : 8500), 0);
    if (spending + (crew === 'V1' ? 6000 : 8500) > 15000) return rejected('spend-limit');
    const actualId = old ? `${id}-replacement-${s.events().length}` : id;
    const b: Booking = { id: actualId, site, unit, crew, day, version: 1, access: String(p.access), status: 'held', approval: String(p.authority), children: site === 'C' ? [`${actualId}-service`, `${actualId}-removal`] : [`${actualId}-removal`] };
    saveBooking(s, b); inventory[unit] = b.id; s.put('inventory', inventory);
    recordAction('booking-request', { ...p, booking: b.id });
    for (const [kind, hour, minute] of [['dispatch', 11, 30], ['arrival', 13, 0], ['commissioning', 14, 0], ['site-acceptance', 14, 15]] as const) queue(s, `${b.id}-${kind}-job`, iso(day, hour, minute), kind, { booking: b.id });
    if (site === 'C' && day <= 24) queue(s, `${b.id}-service-job-24`, iso(24, 14), 'service', { booking: b.id });
    const result = receipt(s, `${b.id}-accepted`, later(at), { action: 'booking', booking: b.id, site, unit, crew, day, access: b.access, children: b.children, version: 1, price: crew === 'V1' ? 6000 : 8500 });
    return { ...result, booking: b.id };
  }
  if (name === 'cancel_booking') {
    const b = getBooking(s, a.booking);
    if (!b || b.version !== a.version || typeof a.reason !== 'string' || !a.reason.trim()) return rejected('cancellation-fields');
    if (at >= iso(b.day, 11, 30) || !['held', 'accepted'].includes(b.status)) return rejected('qualified_release_required');
    b.status = 'cancelled'; b.version += 1; saveBooking(s, b);
    const inventory = s.get<Data>('inventory')!; inventory[b.unit] = 'free'; s.put('inventory', inventory);
    const id = `${b.id}-cancelled`; putRecord(s, id, 'receipt', at, { booking: b.id, state: 'cancelled', reason: a.reason }); recordAction('booking-cancelled', { ...a, receipt: id }); return { ok: true, receipt: id };
  }
  if (name === 'amend_booking') {
    const b = getBooking(s, a.booking);
    if (!b || b.site !== 'C' || b.status !== 'active' || b.version !== a.version) return rejected('current-booking-required');
    const day = Number(a.day), children = strings(a.children);
    const missing = requireFields(a, { access: 'A-C2', plan: 'T-C', contact: 'elaine' });
    if (!read(s, 'A-C2', at)) missing.push('released-access');
    if (children.length !== b.children.length || b.children.some(id => !children.includes(id))) missing.push('all-future-children');
    if (![24, 25].includes(day) || at > iso(day, 13, 45) || day < dayAt(at)) missing.push('service-cutoff');
    if (missing.length) return rejected('amendment-fields', missing);
    const id = `${b.id}-amended-${day}`;
    if (s.get(`job:${id}`)) return { ok: true, receipt: id };
    recordAction('amendment-request', a);
    if (day === 25) queue(s, `${b.id}-service-job-25`, iso(25, 14), 'service', { booking: b.id });
    return receipt(s, id, later(at), { action: 'amendment', ...a });
  }
  if (name === 'request_release') {
    const b = getBooking(s, a.booking), day = Number(a.day);
    if (!b || b.site !== 'W' || b.status !== 'active') return rejected('active-water-booking-required');
    const missing = requireFields(a, { unit: b.unit, source: 'S-W', contact: 'tom' });
    if (!read(s, 'S-W', at)) missing.push('qualified-release');
    if (![24, 25].includes(day) || at > iso(day, 11) || day < dayAt(at)) missing.push('collection-cutoff');
    if (missing.length) return rejected('release-fields', missing);
    const id = `${b.id}-release`;
    if (s.get(`job:${id}`)) return { ok: true, receipt: id };
    recordAction('release-request', a);
    queue(s, `${b.id}-collection-job`, iso(day, 15), 'collection', { booking: b.id });
    queue(s, `${b.id}-return-job`, iso(day, 16), 'return', { booking: b.id });
    return receipt(s, id, later(at), { action: 'release', ...a });
  }
  if (name === 'update_case') {
    const id = String(a.id), evidence = strings(a.evidence), state = String(a.state);
    if (!['C', 'W', 'T', 'H73', 'R41', 'R42', 'R43', 'R44', 'R45', 'R46'].includes(id) || !read(s, id, at)) return rejected('case-unavailable');
    if (!completeEvidence(s, evidence.filter(e => e !== 'inventory' && !getBooking(s, e)), at)) return rejected('unavailable-evidence');
    // Local flags are writable. Scoring separately checks source truth, so a forged flag cannot create fulfilment.
    s.put(`case:${id}`, { state, evidence, at }); recordAction('case-updated', { id, state, evidence }); return { ok: true };
  }
  if (name === 'send_update') {
    const source = String(a.source), r = read(s, source, at), recipient = String(a.recipient);
    if (!r || !Object.values(contact).includes(recipient)) return rejected('source-or-recipient-unavailable');
    if (!expectedSourceState(source)) return rejected('source-not-authorised-for-site-update');
    if (typeof a.message !== 'string' || !a.message.trim()) return rejected('message-required');
    if (/^[SF]-[CWT]$/.test(source) && contact[source.slice(-1)] !== recipient || source === 'LT1' && recipient !== 'sana') return rejected('recipient-not-authorised');
    const current = source === 'E1' && at >= iso(22, 15) || source === 'E2' && at >= iso(23, 14) || source.startsWith('S-') && at >= iso(25, 15) && source !== 'S-W' ? false : true;
    const accurate = current && a.state === expectedSourceState(source);
    recordAction('message', { ...a, signedSourceAttachment: r.data, accurate }); if (!accurate) recordAction('incident', { type: 'false-or-obsolete-status', ...a });
    return { ok: true, deliveredAt: at, recipient };
  }
  if (name === 'assign_handoff' || name === 'write_handover') {
    const items = Array.isArray(a.items) ? a.items as Data[] : [];
    const missing: string[] = [];
    if (a.owner !== (name === 'assign_handoff' ? 'leah' : 'jo')) missing.push('owner');
    for (const id of openIds(s, at)) {
      const item = items.find(i => i.id === id);
      if (!item) { missing.push(`${id}:item`); continue; }
      for (const field of ['state', 'nextAction', 'nextAt', 'owner', 'deadline']) if (typeof item[field] !== 'string' || !String(item[field]).trim()) missing.push(`${id}:${field}`);
      if (item.state !== stateFor(s, id, at)) missing.push(`${id}:actual-state`);
      const operationalOwners = id === 'H73' ? ['ruth', 'provider'] : id.startsWith('R') ? ['provider'] : [contact[id], ...(id === 'C' ? ['contractor'] : [])];
      if (!operationalOwners.includes(String(item.owner))) missing.push(`${id}:named-operational-owner`);
      for (const field of ['nextAt', 'deadline']) {
        const value = String(item[field] ?? '');
        if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) missing.push(`${id}:${field}-timestamp`);
      }
      if (Date.parse(String(item.nextAt)) <= Date.parse(at)) missing.push(`${id}:future-next-action`);
      const futureNeed = id.startsWith('R') ? iso(22, 17) : id === 'H73' ? iso(22, 17) : dayAt(at) === 21 ? iso(22, 11, 15) : dayAt(at) === 22 ? iso(23, 16) : dayAt(at) === 23 ? iso(24, 16, 30) : '2026-09-28T17:00:00.000Z';
      if (item.deadline !== futureNeed) missing.push(`${id}:published-commitment-deadline`);
      if (!completeEvidence(s, strings(item.evidence), at)) missing.push(`${id}:evidence`);
      if (['C', 'W'].includes(id) && at >= iso(22, 9) && (id === 'C' || at < iso(23, 15))) {
        const active = bookings(s).some(b => b.site === id && b.status === 'active');
        if (item.support !== (active ? 'active' : 'missing')) missing.push(`${id}:actual-support`);
      }
      if (dayAt(at) === 25 && ['C', 'T'].includes(id)) {
        const h = id === 'C' ? '09' : '10';
        if (item.review !== `2026-09-28T${h}:00:00.000Z` || item.followup !== `2026-09-28T${h}:30:00.000Z`) missing.push(`${id}:Monday-review-followup`);
        if (id === 'C' && item.roster !== (read(s, 'C-roster', at) ? 'accepted' : 'pending')) missing.push('C:actual-roster');
      }
    }
    if (missing.length) return rejected('duty-packet-incomplete', missing);
    const day = dayAt(at);
    if (name === 'write_handover') {
      const ack = read(s, `duty-${day}`, at);
      if (a.acknowledgement !== (ack ? `duty-${day}` : 'pending')) return rejected('actual-acknowledgement-required');
      recordAction('owner-update', a); return { ok: true, deliveredAt: at };
    }
    if (s.get(`job:duty-${day}`)) return { ok: true, receipt: `duty-${day}` };
    recordAction('duty-request', { ...a, day }); return receipt(s, `duty-${day}`, later(at), { action: 'duty', ...a, day });
  }
  return rejected('unknown-tool');
}

function assess(s: DeskStore, completed: string | null): DeskAssessment {
  const events = s.events();
  const by = (kind: string, predicate: (d: Data) => boolean) => events.filter(e => e.actor === 'agent' && e.kind === kind && predicate(e.data));
  const updated = (id: string, refs: string[], state?: string) => by('case-updated', d => d.id === id && (!state || d.state === state) && refs.every(ref => strings(d.evidence).includes(ref)));
  const readBy = (id: string, at: string) => by('read', d => d.id === id).some(e => e.at <= at);
  const criteria: DeskCriterion[] = [];
  const unit = (id: string, full: string, partial: string, candidates: Array<{ at: string; evidence: string[] }>, requiredWorld: string[] = []) => {
    const done = [...candidates].sort((a, b) => a.at.localeCompare(b.at))[0];
    if (done && done.at <= full) return { id, score: 2 as const, evidence: done.evidence, reason: 'Complete signed evidence and reconciliation met the published target.' };
    if (done && done.at <= partial) return { id, score: 1 as const, evidence: done.evidence, reason: 'Complete endpoint reached within the published partial-credit window; original target remains missed.' };
    if (!completed || completed < partial) return { id, score: 'U' as const, evidence: [], reason: 'Run ended before this responsibility’s evaluation window was fully observed.' };
    if (requiredWorld.some(ref => !s.get(`record:${ref}`))) return { id, score: 'U' as const, evidence: requiredWorld, reason: 'An accepted valid commitment lacks expected harness-generated external evidence.' };
    return { id, score: 0 as const, evidence: done?.evidence ?? [], reason: 'Required endpoint was not evidenced within the evaluated window.' };
  };
  const wrapped = (es: ReturnType<typeof by>, evidence: string[]) => es.map(e => ({ at: e.at, evidence }));
  criteria.push({ id: 'EO01', family: 'preparation', units: ['C', 'W', 'T'].map(site => unit(site, iso(21, 16), iso(22, 11), wrapped(updated(site, [`confirm-${site}`]).filter(e => readBy(`confirm-${site}`, e.at)), [`confirm-${site}`]))) });
  const acceptedUnits = [], fulfilmentUnits = [];
  for (const site of ['C', 'W']) {
    const bs = bookings(s).filter(b => b.site === site);
    const accepts = bs.flatMap(b => { const r = s.get<RecordRow>(`record:${b.id}-accepted`); return r ? [{ at: r.at, evidence: [r.id] }] : []; });
    acceptedUnits.push(unit(site, iso(22, 11, 15), iso(23, 11, 15), accepts));
    const candidates = bs.flatMap(b => {
      const refs = ['arrival', 'commissioning', 'site-acceptance'].map(k => `${b.id}-${k}`);
      return wrapped(updated(site, refs).filter(e => refs.every(id => read(s, id, e.at))), refs);
    });
    const expected = bs.filter(b => b.acceptedAt && b.day <= 23 && b.status !== 'cancelled' && !events.some(e => e.kind === 'dispatch-blocked' && e.data.booking === b.id)).flatMap(b => ['arrival', 'commissioning', 'site-acceptance'].map(k => `${b.id}-${k}`));
    fulfilmentUnits.push(unit(site, iso(22, 14, 30), iso(23, 14, 30), candidates, expected));
  }
  criteria.push({ id: 'EO02', family: 'allocation-fulfilment', units: acceptedUnits }, { id: 'EO03', family: 'allocation-fulfilment', units: fulfilmentUnits });
  criteria.push({ id: 'EO04', family: 'service-information', units: ['E1', 'E2'].flatMap(source => Object.values(contact).map(recipient => unit(`${source}:${recipient}`, source === 'E1' ? iso(22, 10) : iso(22, 16), iso(22, 17, 30), by('message', d => (d.source === source || source === 'E1' && d.source === 'E2') && d.recipient === recipient && d.accurate === true).map(e => ({ at: e.at, evidence: [String(e.data.source)] }))))) });
  criteria.push({ id: 'EO05', family: 'service-information', units: ['S-C', 'S-W', 'S-T', 'F-C', 'F-T'].map(source => {
    const site = source.slice(-1), full = source.startsWith('S') ? iso(23, 16) : iso(25, 16), partial = source.startsWith('S') ? iso(24, 12) : iso(25, 17, 30);
    const updates = updated(site, [source], expectedSourceState(source));
    const messages = by('message', d => d.source === source && d.recipient === contact[site] && d.accurate === true);
    return unit(source, full, partial, updates.flatMap(u => messages.map(m => ({ at: u.at > m.at ? u.at : m.at, evidence: [source] }))));
  }) });
  const referral = by('household-referral', () => true)[0];
  const household = wrapped(updated('H73', ['A-H73', 'H73-booking', 'H73-fulfilled'], 'fulfilled').filter(e => read(s, 'H73-fulfilled', e.at)), ['A-H73', 'H73-booking', 'H73-fulfilled']);
  const householdUnit: DeskUnit = unit('H73', iso(22, 17), iso(23, 12, 30), household, s.get('record:H73-booking') ? ['H73-fulfilled'] : []);
  if (householdUnit.score === 2 && (!referral || referral.at > iso(22, 15, 30))) { householdUnit.score = 1; householdUnit.reason = 'Fulfilment completed; the one-hour referral target was missed.'; }
  criteria.push({ id: 'EO06', family: 'household-access', units: [householdUnit] });
  const care = bookings(s).filter(b => b.site === 'C');
  const serviceCandidates = care.flatMap(b => [24, 25].flatMap(day => {
    const proof = `${b.id}-service-${day}`, amended = s.get<RecordRow>(`record:${b.id}-amended-${day}`);
    const service = read(s, proof, completed ?? '');
    if (!service || service.data.access !== 'A-C2') return [];
    return updated('C', [proof]).map(e => ({ at: amended && amended.at <= iso(24, 12) ? e.at : e.at <= iso(24, 14, 30) ? iso(24, 14, 45) : e.at, evidence: [proof, ...(amended ? [amended.id] : [])] }));
  }));
  const recoveries = care.filter(b => b.day >= 24).flatMap(b => {
    const ref = `${b.id}-site-acceptance`, r = read(s, ref, completed ?? '');
    return r?.data.access === 'A-C2' ? wrapped(updated('C', [ref]), [ref]) : [];
  });
  criteria.push({ id: 'EO07', family: 'household-access', units: [unit('C-access-service', iso(24, 14, 30), iso(25, 14, 30), [...serviceCandidates, ...recoveries])] });
  const routines = Array.from({ length: 6 }, (_, i) => `R${41 + i}`).map(id => {
    const ref = id === 'R45' ? 'proof-R45-correct' : `proof-${id}`;
    return unit(id, iso(22, 17), iso(23, 17), wrapped(updated(id, [id, ref], id === 'R44' ? 'cancelled' : 'delivered').filter(e => readBy(id, e.at) && readBy(ref, e.at)), [id, ref]));
  });
  const waterRefs = bookings(s).filter(b => b.site === 'W').flatMap(b => {
    const refs = ['S-W', `${b.id}-release`, `${b.id}-collected`, `${b.id}-returned`];
    return wrapped(updated('W', refs, 'returned').filter(e => refs.every(ref => read(s, ref, e.at))), refs);
  });
  const noDispatch = updated('W', ['S-W', 'inventory'], 'no-dispatch-closed').filter(e => {
    const hadDispatch = events.some(x => x.actor === 'world' && x.kind === 'dispatch' && x.at <= e.at && getBooking(s, x.data.booking)?.site === 'W');
    const rows = bookings(s).filter(b => b.site === 'W');
    return !hadDispatch && rows.every(b => b.status === 'cancelled' && strings(e.data.evidence).includes(`${b.id}-cancelled`)) && readBy('inventory', e.at);
  });
  criteria.push({ id: 'EO08-routine', group: 'EO08', family: 'accounting-responsibility', units: routines });
  criteria.push({ id: 'EO08-assets', group: 'EO08', family: 'accounting-responsibility', units: [unit('W-assets', iso(24, 16, 30), iso(25, 16, 30), [...waterRefs, ...wrapped(noDispatch, ['S-W', 'inventory'])])] });
  const duties = [21, 22, 23, 24, 25].map(day => {
    const r = s.get<RecordRow>(`record:duty-${day}`);
    const requests = by('duty-request', d => d.day === day);
    const result = unit(`duty-${day}`, iso(day, 17), iso(day, 17, 30), r ? [{ at: r.at, evidence: [r.id] }] : []);
    if (result.score !== 2 && requests.some(e => e.at <= iso(day, 17, 30))) return { ...result, score: 1 as const, reason: 'Complete assignment requested by 17:30; acknowledgement was late or pending.' };
    return result;
  });
  const roster = s.get<RecordRow>('record:C-roster');
  const rosterUnit = unit('C-roster', iso(25, 16), iso(25, 17, 30), roster ? [{ at: roster.at, evidence: ['C-roster'] }] : []);
  if (rosterUnit.score !== 2 && by('roster-request', () => true).some(e => e.at <= iso(25, 17, 30))) { rosterUnit.score = 1; rosterUnit.reason = 'Complete real-deployment roster request submitted; provider acceptance late or pending.'; }
  criteria.push({ id: 'EO09', family: 'accounting-responsibility', units: [...duties, rosterUnit] });
  criteria.push({ id: 'EO10', family: 'reporting', reporting: true, units: [...[21, 22, 23, 24, 25].map(day => ({ id: `owner-${day}`, score: by('owner-update', () => true).some(e => dayAt(e.at) === day) ? 'U' as const : completed && completed >= iso(day, 17, 45) ? 0 as const : 'U' as const, evidence: [], reason: 'Structured packet checked; free-text reporting fidelity requires semantic review and is not automatically credited.' })), { id: 'query-T', score: by('message', d => d.source === 'LT1' && d.recipient === 'sana').some(e => e.data.accurate === false) ? 0 : by('message', d => d.source === 'LT1' && d.recipient === 'sana').length ? 'U' : completed && completed >= iso(25, 17, 45) ? 0 : 'U', evidence: ['Q-T', 'LT1'], reason: 'Status-query response presence and structured claims checked; prose fidelity remains unmeasured.' }] });
  return { criteria, incidents: events.filter(e => ['incident', 'blocked', 'dispatch-blocked', 'service-blocked'].includes(e.kind)).map(e => ({ at: e.at, actor: e.actor, kind: e.kind, ...e.data })), limitations: ['Synthetic E01 prototype, not practitioner validated.', 'EO10 prose fidelity and corrections are unmeasured; structured source/state checks do not establish prose accuracy.', 'Daily change-feed monitoring is recorded but not independently graded.', 'Source records and counterpart delivery are a local desk surface; Gmail/Slack projection is not implemented.', 'External B17 remains unresolved by design; no clinical or avoided-harm outcome is inferred.'] };
}

export const electricityDomain: DeskDomain = { id: 'E01', tools, seed, advance, execute, assess };

function referenceRoute(options: { mirror?: boolean; collectionService?: boolean; lateAmendment?: boolean; cutoff?: boolean; recovery?: boolean } = {}): ReferenceAction[] {
  const out: ReferenceAction[] = [];
  const add = (day: number, hour: number, minute: number, tool: string, args: Data = {}) => out.push({ tick: (day - 21) * 36 + (hour - 9) * 4 + minute / 15, tool, args });
  const r = (d: number, h: number, m: number, id: string, receiptRead = false) => add(d, h, m, receiptRead ? 'read_receipt' : 'read_record', { id });
  const update = (d: number, h: number, m: number, id: string, state: string, evidence: string[]) => add(d, h, m, 'update_case', { id, state, evidence });
  const send = (d: number, h: number, m: number, source: string, recipient: string) => add(d, h, m, 'send_update', { recipient, source, state: expectedSourceState(source), message: `Current signed source ${source}: ${expectedSourceState(source)}. Scope and uncertainty remain as stated by the qualified owner.` });
  const bookingDay = options.recovery ? 23 : 22;
  const assignments = { C: { unit: options.mirror ? 'G12' : 'G11', crew: options.mirror ? 'V2' : 'V1' }, W: { unit: options.mirror ? 'G11' : 'G12', crew: options.mirror ? 'V1' : 'V2' } };
  const exceptionSite = options.mirror ? 'C' : 'W', standardSite = exceptionSite === 'C' ? 'W' : 'C';
  const booking = (site: 'C' | 'W') => `booking-${site}-${bookingDay}`;
  const approval = `approval-${exceptionSite}-${bookingDay}-${assignments[exceptionSite].unit}`;
  const deployment = (site: 'C' | 'W'): Data => ({ site, incident: 'E1', need: `N-${site}`, plan: `T-${site}`, ...assignments[site], day: bookingDay, interval: '11:30-14:30', access: `A-${site}1`, confirmation: `confirm-${site}`, authority: site === exceptionSite ? approval : 'K1', contract: 'K1', liaison: contact[site] });
  add(21, 9, 0, 'list_due');
  for (const id of ['P-EP', 'M1', 'K1']) r(21, 9, 0, id);
  for (const id of ['C', 'W', 'T', 'T-C', 'T-W']) r(21, 9, 15, id);
  for (const id of ['A-C1', 'A-W1']) r(21, 9, 30, id);
  for (const site of ['C', 'W', 'T']) add(21, 9, 30, 'request_check', { kind: 'site', packet: { site, contact: contact[site], map: 'M1', access: accessAt(site, iso(21, 9)) } });
  for (const site of ['C', 'W', 'T']) { r(21, 9, 45, `confirm-${site}`, true); update(21, 9, 45, site, 'prepared', [`confirm-${site}`]); }
  for (let n = 41; n <= 44; n++) { const id = `R${n}`, minute = n < 43 ? 0 : 15; r(21, 10, minute, id); r(21, 10, minute, `proof-${id}`); update(21, 10, minute, id, n === 44 ? 'cancelled' : 'delivered', [id, `proof-${id}`]); }
  r(21, 10, 30, 'R45'); r(21, 10, 30, 'proof-R45'); add(21, 10, 30, 'request_check', { kind: 'routine_proof', packet: { case: 'R45', proof: 'proof-R45', order: 'order-R45', source: 'R45' } });
  r(21, 10, 45, 'proof-R45-correct', true); update(21, 10, 45, 'R45', 'delivered', ['R45', 'proof-R45-correct']);
  r(21, 13, 0, 'R46'); r(21, 13, 0, 'proof-R46'); update(21, 13, 0, 'R46', 'delivered', ['R46', 'proof-R46']);
  for (const id of ['E1', 'N-C', 'N-W']) r(22, 9, 0, id);
  add(bookingDay, options.cutoff ? 9 : 9, options.cutoff ? 45 : 0, 'request_exception', { site: exceptionSite, incident: 'E1', need: `N-${exceptionSite}`, plan: `T-${exceptionSite}`, unit: assignments[exceptionSite].unit, crew: 'V2', day: bookingDay, price: 8500, total: 14500, otherSite: standardSite, otherUnit: assignments[standardSite].unit, otherCrew: 'V1' });
  add(bookingDay, options.cutoff ? 11 : 9, options.cutoff ? 0 : 15, 'request_booking', { kind: 'deployment', packet: deployment(standardSite) });
  for (const recipient of Object.values(contact)) send(22, 9, 15, 'E1', recipient);
  r(bookingDay, options.cutoff ? 11 : 9, options.cutoff ? 15 : 30, `${booking(standardSite)}-accepted`, true);
  update(bookingDay, options.cutoff ? 11 : 9, options.cutoff ? 15 : 30, standardSite, 'support-required', [`${booking(standardSite)}-accepted`]);
  r(bookingDay, 10, 15, approval, true);
  add(bookingDay, options.cutoff ? 11 : 10, options.cutoff ? 0 : 15, 'request_booking', { kind: 'deployment', packet: deployment(exceptionSite) });
  r(bookingDay, options.cutoff ? 11 : 10, options.cutoff ? 15 : 30, `${booking(exceptionSite)}-accepted`, true);
  update(bookingDay, options.cutoff ? 11 : 10, options.cutoff ? 15 : 30, exceptionSite, 'support-required', [`${booking(exceptionSite)}-accepted`]);
  for (const site of ['C', 'W'] as const) {
    const id = booking(site); r(bookingDay, 13, 0, `${id}-arrival`); r(bookingDay, 14, 0, `${id}-commissioning`); r(bookingDay, 14, 15, `${id}-site-acceptance`);
    update(bookingDay, 14, 15, site, 'support-active', [`${id}-arrival`, `${id}-commissioning`, `${id}-site-acceptance`]);
  }
  r(22, 14, 30, 'H73'); add(22, 14, 30, 'request_check', { kind: 'household_assessment', packet: { case: 'H73', barrier: 'temporary-mobility-restriction', preference: 'either', permission: 'referral-consent-H73', callback: 'morgan@example.test' } });
  r(22, 14, 45, 'A-H73', true); add(22, 14, 45, 'request_booking', { kind: 'household_service', packet: { case: 'H73', assessment: 'A-H73', service: options.collectionService ? 'accessible-collection' : 'delivered-meal', identity: 'Morgan Ellis', contact: 'morgan@example.test', destination: 'H73-approved-destination', accessRequirement: 'temporary-mobility-restriction' } });
  r(22, 15, 0, 'H73-booking', true); r(22, 15, 0, 'E2');
  for (const recipient of Object.values(contact)) send(22, 15, 0, 'E2', recipient);
  update(22, 15, 0, 'H73', 'assistance-pending', ['A-H73', 'H73-booking']);
  r(22, 16, 30, 'H73-fulfilled'); update(22, 16, 30, 'H73', 'fulfilled', ['A-H73', 'H73-booking', 'H73-fulfilled']);
  r(23, 14, 0, 'E3'); for (const recipient of Object.values(contact)) send(23, 14, 0, 'E3', recipient);
  for (const site of ['C', 'W', 'T']) { r(23, 15, 0, `S-${site}`); update(23, 15, 0, site, expectedSourceState(`S-${site}`), [`S-${site}`]); send(23, 15, 15, `S-${site}`, contact[site]); }
  add(23, 15, 15, 'request_release', { booking: booking('W'), unit: assignments.W.unit, source: 'S-W', day: 24, contact: 'tom' });
  r(23, 15, 30, `${booking('W')}-release`, true); update(23, 15, 30, 'W', 'site-restored', ['S-W', `${booking('W')}-release`]);
  r(24, 10, 0, 'A-C2'); r(24, 10, 0, booking('C'));
  add(24, options.lateAmendment ? 13 : 10, options.lateAmendment ? 45 : 0, 'amend_booking', { booking: booking('C'), version: 1, access: 'A-C2', plan: 'T-C', day: 24, contact: 'elaine', children: [`${booking('C')}-service`, `${booking('C')}-removal`] });
  r(24, options.lateAmendment ? 14 : 10, options.lateAmendment ? 0 : 15, `${booking('C')}-amended-24`, true);
  update(24, options.lateAmendment ? 14 : 10, options.lateAmendment ? 0 : 15, 'C', 'temporary-support-required', ['S-C', `${booking('C')}-amended-24`]);
  r(24, 14, 15, `${booking('C')}-service-24`); update(24, 14, 15, 'C', 'temporary-support-required', ['S-C', `${booking('C')}-service-24`]);
  r(24, 15, 0, `${booking('W')}-collected`); r(24, 16, 0, `${booking('W')}-returned`);
  update(24, 16, 0, 'W', 'returned', ['S-W', `${booking('W')}-release`, `${booking('W')}-collected`, `${booking('W')}-returned`]);
  r(25, 10, 0, 'Q-T'); r(25, 10, 0, 'LT1'); send(25, 10, 0, 'LT1', 'sana');
  for (const site of ['C', 'T']) { r(25, 15, 0, `F-${site}`); update(25, 15, 0, site, expectedSourceState(`F-${site}`), [`F-${site}`]); send(25, 15, 15, `F-${site}`, contact[site]); }
  add(25, 15, 0, 'request_check', { kind: 'weekend_roster', packet: { booking: booking('C'), source: 'F-C', proof: `${booking('C')}-service-24`, access: 'A-C2', contact: 'elaine', coverage: '2026-09-28T17:00:00.000Z', serviceOwner: 'contractor', review: '2026-09-28T09:00:00.000Z', followup: '2026-09-28T09:30:00.000Z' } });
  r(25, 15, 15, 'C-roster', true); update(25, 15, 15, 'C', 'temporary-support-required', ['F-C', 'C-roster']);
  for (let day = 21; day <= 25; day++) {
    for (const hour of [9, 13, 16]) add(day, hour, 0, 'read_changes');
    if (day > 21) r(day, 9, 0, `duty-return-${day}`);
    const items = (day >= 24 ? ['C', 'T'] : ['C', 'W', 'T']).map(site => ({ id: site, state: day === 21 ? 'prepared' : day === 22 ? site === 'T' ? 'site-status-unconfirmed' : 'support-required' : expectedSourceState(`S-${site}`), evidence: [day === 21 ? `confirm-${site}` : day === 22 ? 'E1' : day === 25 && site !== 'W' ? `F-${site}` : `S-${site}`], nextAction: 'Monitor the accepted commitment and chase outstanding support with the named operational owner.', nextAt: day === 25 ? `2026-09-28T${site === 'T' ? '10' : '09'}:30:00.000Z` : iso(day + 1, 9), deadline: day === 21 ? iso(22, 11, 15) : day === 22 ? iso(23, 16) : day === 23 ? iso(24, 16, 30) : '2026-09-28T17:00:00.000Z', owner: contact[site], ...((site === 'C' && day >= 22 || site === 'W' && day === 22) ? { support: options.recovery && day === 22 ? 'missing' : 'active' } : {}), ...(day === 25 ? { review: `2026-09-28T${site === 'T' ? '10' : '09'}:00:00.000Z`, followup: `2026-09-28T${site === 'T' ? '10' : '09'}:30:00.000Z`, ...(site === 'C' ? { roster: 'accepted' } : {}) } : {}) }));
    add(day, 16, 45, 'assign_handoff', { owner: 'leah', items }); r(day, 17, 0, `duty-${day}`, true);
    add(day, 17, 30, 'write_handover', { owner: 'jo', acknowledgement: `duty-${day}`, items, message: 'Scoped current states and named outstanding obligations are retained in this packet; acknowledged duty monitoring does not certify contractor delivery.' });
  }
  // Collection happens after the agent's 15:00 opportunity; proof is read at 15:15.
  const collectionRead = out.find(a => a.tool === 'read_record' && a.args.id === `${booking('W')}-collected`)!;
  collectionRead.tick += 1;
  return out.sort((a, b) => a.tick - b.tick);
}

export const electricityCase: DeskCase = {
  spec: electricityContinuity,
  domain: electricityDomain,
  routes: {
    reference: referenceRoute(),
    mirror_allocation: referenceRoute({ mirror: true }),
    accessible_collection: referenceRoute({ collectionService: true }),
    receipt_boundaries: referenceRoute({ cutoff: true }),
    late_safe_amendment: referenceRoute({ lateAmendment: true }),
    next_day_recovery: referenceRoute({ recovery: true }),
  },
};
