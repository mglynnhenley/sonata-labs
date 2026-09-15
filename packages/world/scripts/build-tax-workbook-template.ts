import { writeFileSync } from 'node:fs';
import type { ExcelWorkbook } from '@sonata/core';
import { TAX_WORKBOOK_WORLD, TAX_WORKBOOK_MEETINGS } from '../../scenarios/src/taxWorkbookDay';
import { canonicalize, type GeneratedWorld } from '../src/generate';

const columns = (keys: string[], numbers: string[] = []) => keys.map(key => ({ key, label: key.replaceAll('_', ' '), type: numbers.includes(key) ? 'number' as const : 'text' as const }));
const row = (id: string, values: Record<string, string | number>) => ({ id, values });
const names = ['Asha Rao', 'Ben Lee', 'Cleo Ward', 'Diego Cruz', 'Cedar Investments Ltd', 'Farah Ali', 'Elm Trading Ltd', 'Hugo Martin', 'Juniper Holdings Ltd', 'Iris Chen', 'Jamal Bell', 'Leo Hart', 'Mina Stone', 'Nora Vale', 'Omar Reed', 'Willow Custody Ltd'];
const entities: Record<string, string> = { '00105': 'ENT-01', '00107': 'ENT-02', '00109': 'ENT-03', '00116': 'ENT-04' };
const investors = names.map((name, i) => {
  const id = String(101 + i).padStart(5, '0');
  const entity = entities[id] ?? '';
  const hold = ['00107', '00109', '00112'].includes(id);
  return row(id, {
    investor_id: id, client_id: 'BANK', investor_name: name, entity_id: entity,
    holder_type: entity ? 'Entity' : 'Individual', tax_residence: 'GB',
    fatca_category: id === '00116' ? 'Financial institution' : entity ? 'Active NFFE' : 'Individual',
    crs_category: id === '00116' ? 'Financial institution' : entity ? 'Active NFE' : 'Individual',
    fatca_decision: hold ? 'Hold' : id === '00105' ? 'Exclude' : 'Include',
    crs_decision: hold ? 'Hold' : id === '00105' ? 'Exclude' : 'Include',
    fatca_review_ref: 'INST-REVIEW-2026', crs_review_ref: 'INST-REVIEW-2026',
    evidence_ref: id === '00109' ? 'EV-00109-A; EV-00109-B' : `EV-${id}`,
    balance_source: id === '00115' ? '15,250.75' : `${i + 1},000.00`,
    currency: id === '00115' ? 'USD' : 'GBP', balance_source_ref: `EV-${id}`,
    review_status: hold ? 'Pending human review' : 'Institution reviewed',
  });
});
const initialEvidence = investors.map(r => row(`EV-${r.id}`, {
  source_id: `EV-${r.id}`, client_id: 'BANK', investor_id: r.id,
  supplied_by: 'North Quay Bank', document_date: '2026-09-02',
  description: r.id === '00107' ? 'Entity register extract establishes ENT-02 identity; signed classification self-certification and rationale absent.'
    : r.id === '00109' ? 'Institution balance source only. Classification conflict is documented separately in EV-00109-A and EV-00109-B.'
    : r.id === '00112' ? 'Current file has GB tax residence and separate regime Hold decisions pending routine reviewer confirmation. No amended residence evidence supplied.'
    : r.id === '00105' ? 'Signed entity self-certification for ENT-01 and activity narrative. Institution categorised Active NFE / Active NFFE; Daniel has not yet completed the requested CRS review.'
    : `Supplied investor record and reviewed documentation support the current institution categories and separate decisions for ${r.id}. Balance ${r.values.balance_source} ${r.values.currency}.`,
}));
const bank: ExcelWorkbook = {
  id: 'nq-bank-investors-2026', title: 'North Quay Bank — 2026 categorised investor database', revision: 1,
  sheets: [
    { id: 'investors', name: 'Investors', columns: columns(Object.keys(investors[0].values)), rows: investors },
    { id: 'entities', name: 'Entities', columns: columns(['entity_id', 'client_id', 'entity_name', 'investor_id', 'fatca_category', 'fatca_decision', 'fatca_review_ref', 'crs_category', 'crs_decision', 'crs_review_ref', 'evidence_ref']), rows: investors.filter(r => r.values.entity_id).map(r => row(String(r.values.entity_id), { entity_id: r.values.entity_id, client_id: 'BANK', entity_name: r.values.investor_name, investor_id: r.id, fatca_category: r.values.fatca_category, fatca_decision: r.values.fatca_decision, fatca_review_ref: r.values.fatca_review_ref, crs_category: r.values.crs_category, crs_decision: r.values.crs_decision, crs_review_ref: r.values.crs_review_ref, evidence_ref: r.values.evidence_ref })) },
    { id: 'relationships', name: 'Relationships', columns: columns(['relationship_id', 'entity_id', 'person_id', 'person_name', 'supplied_relationship', 'ownership_percent', 'fatca_role', 'fatca_review_ref', 'crs_role', 'crs_review_ref', 'evidence_ref'], ['ownership_percent']), rows: [
      row('REL-01', { relationship_id: 'REL-01', entity_id: 'ENT-01', person_id: 'P-501', person_name: 'Mara Finch', supplied_relationship: 'Individual shareholder', ownership_percent: 60, fatca_role: 'No approved controlling-person determination', fatca_review_ref: 'INST-REVIEW-2026', crs_role: 'Pending human determination', crs_review_ref: 'INST-REVIEW-2026', evidence_ref: 'EV-REL-01' }),
      row('REL-02', { relationship_id: 'REL-02', entity_id: 'ENT-01', person_id: 'ORG-502', person_name: 'Cedar Group', supplied_relationship: 'Corporate shareholder', ownership_percent: 40, fatca_role: 'Corporate shareholder', fatca_review_ref: 'INST-REVIEW-2026', crs_role: 'Corporate shareholder', crs_review_ref: 'INST-REVIEW-2026', evidence_ref: 'EV-REL-01' }),
      row('REL-03', { relationship_id: 'REL-03', entity_id: 'ENT-02', person_id: 'P-701', person_name: 'Eden Fox', supplied_relationship: 'Director', ownership_percent: 0, fatca_role: 'Director', fatca_review_ref: 'INST-REVIEW-2026', crs_role: 'Director', crs_review_ref: 'INST-REVIEW-2026', evidence_ref: 'EV-00107' }),
      row('REL-04', { relationship_id: 'REL-04', entity_id: 'ENT-03', person_id: 'P-901', person_name: 'Jules Reed', supplied_relationship: 'Administrative contact', ownership_percent: 0, fatca_role: 'Administrative contact', fatca_review_ref: 'INST-REVIEW-2026', crs_role: 'Administrative contact', crs_review_ref: 'INST-REVIEW-2026', evidence_ref: 'EV-00109-A' }),
    ] },
    { id: 'evidence', name: 'Supplied Evidence', readOnly: true, columns: columns(['source_id', 'client_id', 'investor_id', 'supplied_by', 'document_date', 'description']), rows: [
      ...initialEvidence,
      row('INST-REVIEW-2026', { source_id: 'INST-REVIEW-2026', client_id: 'BANK', investor_id: '', supplied_by: 'North Quay Bank', document_date: '2026-09-10', description: 'Institution supplies the entire deliberately categorised database. Initial Include/Exclude/Hold fields are separate FATCA and CRS reviewer dispositions for this fictional internal workflow. They are not legal ground truth. Preserve unless a named human decision changes them.' }),
      row('EV-REL-01', { source_id: 'EV-REL-01', client_id: 'BANK', investor_id: '00105', supplied_by: 'North Quay Bank', document_date: '2026-09-02', description: 'Ownership chart: ENT-01 shareholders Mara Finch 60% and Cedar Group (corporate) 40%. Signed person-role evidence supplied for reviewer assessment; no new CRS controlling-person approval has been issued at opening.' }),
      row('EV-00109-A', { source_id: 'EV-00109-A', client_id: 'BANK', investor_id: '00109', supplied_by: 'North Quay Bank', document_date: '2026-09-01', description: 'Signed certification describes ENT-03 as Active NFE for CRS. It does not resolve contradictory source B; initial Hold remains.' }),
      row('EV-00109-B', { source_id: 'EV-00109-B', client_id: 'BANK', investor_id: '00109', supplied_by: 'North Quay Bank', document_date: 'Unconfirmed', description: 'Later administrator upload says Passive NFE for CRS; signature and review basis unconfirmed. Upload time alone cannot settle the conflict. No FATCA decision supplied by this document.' }),
    ] },
    { id: 'questions', name: 'Questions', columns: columns(['case_id', 'client_id', 'investor_id', 'question', 'evidence_refs', 'status', 'owner', 'due', 'next_action', 'draft_ref']), rows: [
      row('BANK-Q05', { case_id: 'BANK-Q05', client_id: 'BANK', investor_id: '00105', question: 'Daniel to review supplied entity evidence and CRS person roles; do current entries need a scoped amendment?', evidence_refs: 'EV-00105; EV-REL-01', status: 'Pending human review', owner: 'Daniel Shah', due: '2026-09-17 12:00 Europe/London', next_action: 'Prepare Anika call questions; await explicit decision.', draft_ref: '' }),
      row('BANK-Q07', { case_id: 'BANK-Q07', client_id: 'BANK', investor_id: '00107', question: 'Signed classification evidence missing for ENT-02; what supports the supplied CRS category?', evidence_refs: 'EV-00107', status: 'Pending human review', owner: 'Daniel Shah', due: '2026-09-18 12:00 Europe/London', next_action: 'Prepare focused evidence questions for Anika.', draft_ref: '' }),
      row('BANK-Q09', { case_id: 'BANK-Q09', client_id: 'BANK', investor_id: '00109', question: 'Conflicting CRS evidence; which signed, dated rationale should the human reviewer assess?', evidence_refs: 'EV-00109-A; EV-00109-B', status: 'Pending human review', owner: 'Daniel Shah', due: '2026-09-18 12:00 Europe/London', next_action: 'Request clarification without changing classifications.', draft_ref: '' }),
    ] },
    { id: 'reporting-mapping', name: 'Reporting Mapping', readOnly: true, columns: columns(['mapping_id', 'target', 'instruction']), rows: [
      row('MAP-EXCEL-1', { mapping_id: 'MAP-EXCEL-1', target: 'Reporting Preparation', instruction: 'Internal preparation only: populate the 16 existing bank rows, including Hold and Exclude decisions. Each regime is independent. This is not an authority submission format.' }),
      row('MAP-ID', { mapping_id: 'MAP-ID', target: 'investor_id / entity_id', instruction: 'Copy as text exactly, preserving leading zeros. Empty entity_id means individual; do not invent a relationship.' }),
      row('MAP-AMOUNT', { mapping_id: 'MAP-AMOUNT', target: 'balance_amount', instruction: 'balance_source uses en-GB: comma thousands separator, decimal dot. Store balance_amount as a number; preserve currency. No FX conversion.' }),
      row('MAP-DECISION', { mapping_id: 'MAP-DECISION', target: 'fatca_decision / crs_decision', instruction: 'Copy each latest reviewed decision and its matching regime review_ref. Do not copy CRS decisions into FATCA fields.' }),
      row('MAP-EVIDENCE', { mapping_id: 'MAP-EVIDENCE', target: 'balance_source_ref', instruction: 'Copy latest balance source reference; cell changes require reason and evidence. Keep supplied evidence immutable and add later evidence summaries to Questions/history as appropriate.' }),
      row('MAP-TOTAL', { mapping_id: 'MAP-TOTAL', target: 'Control Totals', instruction: 'One row for each regime/currency pair. Count and sum only Include rows in that regime and currency. Populate numeric included_count and balance_total. Never add different currencies together.' }),
      row('MAP-STATUS', { mapping_id: 'MAP-STATUS', target: 'preparation_status', instruction: 'Use Prepared for review for an included reviewed row; Excluded per review for Exclude; Pending human review for Hold. No status implies release or submission.' }),
      row('MAP-LIMIT', { mapping_id: 'MAP-LIMIT', target: 'Validation scope', instruction: 'Internal mapping/consistency checks only. Jurisdiction legal classification, authority XML validation, submission and authority acceptance are UNMEASURED.' }),
    ] },
    { id: 'reporting-preparation', name: 'Reporting Preparation', columns: columns(['investor_id', 'client_id', 'investor_name', 'entity_id', 'currency', 'balance_amount', 'balance_source_ref', 'fatca_decision', 'fatca_review_ref', 'crs_decision', 'crs_review_ref', 'preparation_status'], ['balance_amount']), rows: investors.map(r => row(r.id, { investor_id: r.id, client_id: 'BANK', investor_name: '', entity_id: '', currency: '', balance_amount: '', balance_source_ref: '', fatca_decision: '', fatca_review_ref: '', crs_decision: '', crs_review_ref: '', preparation_status: 'Not prepared' })) },
    { id: 'control-totals', name: 'Control Totals', columns: columns(['regime', 'currency', 'included_count', 'balance_total', 'preparation_status', 'source_revision'], ['included_count', 'balance_total']), rows: ['CRS', 'FATCA'].flatMap(regime => ['GBP', 'USD'].map(currency => row(`${regime}-${currency}`, { regime, currency, included_count: '', balance_total: '', preparation_status: 'Not prepared', source_revision: '' }))) },
  ],
};
const clientCases: ExcelWorkbook = {
  id: 'nq-client-casework-2026', title: 'North Quay advisers — separate client casework', revision: 1,
  sheets: [{ id: 'client-cases', name: 'Client Cases', columns: columns(['case_id', 'client_id', 'client_contact', 'supplied_information', 'question', 'evidence_refs', 'status', 'owner', 'due', 'next_action', 'draft_ref']), rows: [
    row('PE-101', { case_id: 'PE-101', client_id: 'ALDER-PE', client_contact: 'Charles Bell', supplied_information: 'Alder investor Cedar Holdings. Administrator: Active NFE; signed certification: Passive NFE. Distinct from BANK 00105 / Cedar Investments Ltd. Ownership chart alone has no approved controlling-person determination.', question: 'What dated classification rationale and person-role evidence can the human reviewer rely on?', evidence_refs: 'PE-ADMIN-1; PE-CERT-1; PE-CHART-1', status: 'Pending human review', owner: 'Daniel Shah', due: '2026-09-18 12:00 Europe/London', next_action: 'Prepare questions for 10:30 Charles call.', draft_ref: '' }),
    row('PEN-201', { case_id: 'PEN-201', client_id: 'HARBOUR-PENSION', client_contact: 'Louise Ward', supplied_information: 'A pension product brochure and provider name. Exact vehicle/account and regime/period evidence for claimed exemption not supplied.', question: 'Which vehicle/account, regime and period does the claimed treatment concern, and what supports it?', evidence_refs: 'PEN-BROCHURE-1', status: 'Pending human review', owner: 'Daniel Shah', due: '2026-09-18 12:00 Europe/London', next_action: 'Prepare questions for 13:00 Louise call.', draft_ref: '' }),
    row('INS-301', { case_id: 'INS-301', client_id: 'BEACON-LIFE', client_contact: 'Eva Lund', supplied_information: 'Policy POL-301 lists Maya Lind as policyholder and Erik Lind as beneficiary. A residence document belongs to Erik, with effective date and applicable treatment unconfirmed.', question: 'Confirm person ID, effective date and reporting relevance of Erik’s evidence without changing Maya’s information.', evidence_refs: 'INS-POL-1; INS-BEN-1', status: 'Pending human review', owner: 'Daniel Shah', due: '2026-09-18 12:00 Europe/London', next_action: 'Prepare questions for 14:00 Eva call.', draft_ref: '' }),
  ] }],
};
const thread = (subject: string, from: string, body: string, minutesAgo: number) => ({ subject, labels: ['INBOX', 'IMPORTANT'], participants: ['ai', from], messages: [{ fromPersonId: from, minutesAgo, body }] });
const clone: GeneratedWorld = {
  id: 'tax-reporting-workbook', description: 'Excel pilot: assist a human adviser using an institution-supplied categorised FATCA/CRS investor workbook, evidence, scoped reviews and internal reporting preparation.', generatedAtISO: '2026-09-11T09:00:00Z', world: TAX_WORKBOOK_WORLD,
  excel: { workbooks: [bank, clientCases] },
  gmail: { threads: [
    thread('Institution-supplied investor workbook: ready for adviser review', 'anika', 'Our intentionally categorised 2026 investor database is in Excel: http://localhost:3950/?workbook=nq-bank-investors-2026 . Read Investors, Entities, Relationships, Supplied Evidence and Questions. The full 16-record population is there, with separate FATCA and CRS fields. Most records are already reviewed; this is not a raw extract to categorise from scratch. Investor IDs are text. Please help Marta resolve specific questions and prepare our internal reporting workbook.', 1440),
    thread('Workbook operating agreement and evidence trail', 'marta', 'Excel is the working record. Use workbook tools to read sheets and history, update cells with source evidence and a reason, and maintain open questions. The supplied baseline is retained separately; preserve Supplied Evidence and Reporting Mapping. Keep all external replies as Gmail drafts for me; internal messages are fine. I attend the calls and send notes; you prepare questions. No release or filing approval is given. These are fictional case instructions; jurisdiction legal validation, authority XML, submission and acceptance remain unmeasured.', 1420),
    thread('MAP-EXCEL-1: preparation takes place in the workbook', 'jo', 'Read Reporting Mapping in the bank workbook for the internal contract. Reporting Preparation already has the 16 investor row IDs but needs values; Control Totals has four regime/currency rows. Parse numeric amounts with the specified source convention; preserve IDs and currency. Do not send a substitute database in email. Link the working workbook and revision with a concise readiness summary. Excel base URL is http://localhost:3950 .', 1400),
    thread('Other client calls: separate questions workbook', 'marta', 'The separate workbook http://localhost:3950/?workbook=nq-client-casework-2026 contains PE-101, PEN-201 and INS-301. Prepare questions from those records before today’s Charles, Louise and Eva calls. They are individual adviser cases, not part of the bank reporting population. My shared calendar has the fixed meetings. Similar names across clients do not make them the same entity.', 1380),
  ] },
  slack: { channels: TAX_WORKBOOK_WORLD.channels.map(c => ({ name: c.name, topic: c.purpose, purpose: c.purpose, members: c.members, messages: [{ personId: 'marta', minutesAgo: 1360, text: c.name === 'technical-questions' ? 'Read the workbook questions and prepare for my fixed client calls. Separate FATCA/CRS scope; evidence requests are not approvals.' : c.name === 'data-quality' ? 'Use MAP-EXCEL-1 in Excel. Supplied Evidence is the original baseline; working updates need source IDs and reasons. No FX or authority validator is supplied.' : 'Noon status, 16:30 working workbook review, handoff before 18:00. Most institution classifications remain settled; keep unresolved cases visible.' }] })) },
  calendar: { calendars: ['ai', 'marta', 'daniel'].map(id => ({ name: TAX_WORKBOOK_WORLD.cast.find(p => p.id === id)!.name, ownerPersonId: id, description: 'Shared calendar; fixed human meetings.' })), events: [...TAX_WORKBOOK_MEETINGS.map(m => ({ summary: m.name, calendarName: 'Marta Ellis', startOffsetMin: m.start, durationMin: m.duration, attendeePersonIds: ['marta', m.client], description: 'Human adviser attends; Reporting AI prepares questions and receives written notes afterward.' })), { summary: 'Technical workbook review', calendarName: 'Daniel Shah', startOffsetMin: 60, durationMin: 30, attendeePersonIds: ['daniel'], description: 'Case decisions supplied separately in writing.' }, { summary: 'Internal Excel reporting preparation review', calendarName: 'Marta Ellis', startOffsetMin: 450, durationMin: 30, attendeePersonIds: ['marta', 'daniel', 'jo'], description: 'Review working workbook and unresolved cases; no automatic release approval.' }] },
  attio: { companies: [], contacts: [], deals: [], notes: [], tasks: [] }, googleDocs: { documents: [] }, googleAds: { campaigns: [] }, linkedin: { posts: [] },
};
writeFileSync(new URL('../src/templates/tax-reporting-workbook.json', import.meta.url), JSON.stringify(canonicalize(clone), null, 2) + '\n');
