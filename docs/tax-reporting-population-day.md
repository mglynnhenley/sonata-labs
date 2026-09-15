# Tax-reporting operations: scenario design notes

**Premise corrected:** the institution supplies an intentional, already categorised FATCA/CRS database in Excel. The current implementation is [the Excel reporting day](tax-reporting-excel-day.md), scenario `tax-reporting-workbook-day`. Year-on-year reconciliation is one possible assignment, not the premise of the business. The earlier reconciliation pilot and the design notes below are retained as history.

**Status: a runnable workflow pilot is now available as `tax-reporting-workflow-day`.** It uses fictional data and explicit case decisions to test reconciliation, source fidelity, meeting preparation, client drafts and internal CSV preparation across a 36-tick day. Its 11 criteria comprise two automatic delivery checks and nine content-review criteria. It does **not** measure legal classification, authority XML compliance, filing or acceptance. The reporting jurisdiction, period, full meaning of RENESAGEG, two other regime names and applicable rules/schema must still be confirmed before a legal answer key can be authored. The broader design below describes that eventual scope; it is not a claim that the pilot already implements it.

The pilot opens with six prior bank accounts and eight current rows (seven unique accounts). Explicit reviewer decisions produce five provisional included accounts (£19,100); verified evidence at 15:00 changes the final pack to six (£27,100). A changed ID, duplicate, transferred account, ambiguous date and missing TIN require evidence-aware reconciliation. Separate PE, pension and insurance cases require focused draft questions and open human-review items. Complete input data is supplied in Gmail, shared meetings in Calendar, and decisions in Slack and Gmail. The internal CSV is delivered in an email code block because this pilot supplies no XML generator, validator or filing service.

Run with `npm run sonata -- run tax-reporting-workflow-day --model anthropic/claude-haiku-4.5 --max-cost 4 --max-minutes 30`. Price the selected models before each paid run.

## The business and the agent's role

A tax-reporting advisory and operations team helps banks, private-equity managers, pension providers and insurers identify the relevant reportable accounts, entities and individuals, prepare their information for reporting systems, and produce the required XML submissions.

The AI is an assistant working alongside a human tax-reporting adviser. It has its own account. The human owns difficult judgements, client advice and release approval. The assistant does the substantive preparation: compares data, investigates differences, assembles classification evidence, drafts responses, prepares meeting briefs, updates decision logs, transforms approved data and checks outputs. Asking for a decision does not relieve it of presenting the evidence and a useful recommendation.

CRS and FATCA are confirmed terms from the user's description. The user has confirmed the spelling **RENESAGEG**; its full name and jurisdiction are still to be established. “CSEP” and “COF” also need clarification. Do not expand these names, silently substitute other regimes or combine their populations. Each applicable regime needs a separate reporting determination and output specification.

This is a reporting-cycle workday, when annual reconciliation, client questions and file preparation overlap. It does not assume an annual population comparison is repeated from scratch every ordinary day throughout the year.

## A concrete client portfolio

All names and proposed interruptions below are fictional. They illustrate the user's workflow, not observed client cases.

| Client | Human contact | Work in progress |
| --- | --- | --- |
| North Quay Bank | Anika, bank tax manager | This year's candidate population differs from the prior-year reported file; some account identifiers changed during a system migration. |
| Alder Private Equity | Charles, fund tax lead | An entity investor's self-certification conflicts with the classification carried forward in the administrator's data. |
| Harbour Pension Services | Louise, pensions tax specialist | The team needs the evidence supporting a claimed reporting exemption and a clear distinction between the provider, vehicle, account and holder. |
| Beacon Life | Eva, insurance tax manager | Records disagree about account-holder roles, tax residence and relevant dates; reporting treatment needs confirmation. |

Internal colleagues: Marta, the supervising tax-reporting adviser; Daniel, the technical reviewer; Jo, the data-operations analyst; and the AI assistant. The roster has eight participants, with three internal channels: reporting operations, technical questions and data quality. Client correspondence remains separated by client.

## What the assistant receives at the start

The runnable version should ship a complete, inspectable source pack, not emails referring to absent spreadsheets:

- The prior-year reported population, its version and any later accepted corrections.
- The current-year source extract, with stable account/entity/person identifiers and an explicit reporting-period cutoff.
- Account-ID migration mappings, entity/person relationships and client segregation fields.
- Self-certifications, supporting evidence and existing reviewer decisions, with effective dates and provenance.
- A frozen, jurisdiction-specific rule pack that identifies the applicable regime, period, reportable-jurisdiction lists and treatment of relevant exceptions.
- The actual input contract for the reporting software: field mappings, formats, permitted values, required relationships and validation rules.
- The applicable XML schema and business-rule version, sample files, a callable validator and recorded validation results.
- Open client questions, submission milestones, internal review deadlines and human calendars.

Start with a small complete fixture that a reviewer can audit row by row. Add volume and concurrent clients after the answer key is validated. A large headline population with no underlying rows would test guessing rather than reconciliation.

## The workday

Times are proposed local working times. They are internal preparation deadlines, not claims about statutory filing dates.

| Time | What happens | What the AI should do |
| --- | --- | --- |
| 09:00 | Marta requests a population reconciliation by noon and an internal reporting pack by 16:30. Four clients already have open questions. | Read the source pack, identify the versions and scope, triage deadlines and start an exception register. |
| 09:30–10:00 | Human meeting with North Quay Bank's tax team about year-on-year differences. The bank explains that some accounts were renumbered. | Prepare the change summary and unresolved questions before the call. Use the post-call notes and ID mapping to distinguish genuine changes from migration artefacts. |
| 10:15 | Jo supplies an updated ID mapping and flags a duplicated account row. | Reconcile at the correct record grain. Preserve separate accounts and separately relevant people; do not deduplicate simply because names match. Recalculate control totals. |
| 10:30–11:00 | Human meeting with Alder Private Equity about an investor classified differently in two sources. | Prepare an evidence-based question list. After the call, update the classification memo and identify exactly which self-certification or reviewer decision remains needed. |
| 11:15 | A client emails: “They were not included last year; can we just leave them out again?” | Draft a reasoned response using current evidence and the applicable rule pack. Prior-year treatment is evidence to investigate, not a sufficient decision rule. |
| 12:00 | The first bank reconciliation is due. | Deliver additions, removals, retained/changed records and unresolved differences, with record IDs, reasons, source references and counts. Keep source-population differences distinct from reporting decisions. |
| 13:00–13:30 | Human meeting with Harbour Pension Services on a claimed exemption and missing documentation. | Identify the exact party/product and claimed basis, record the evidence gap, and give the human a bounded decision request. Avoid assuming every pension-labelled organisation or account has identical treatment. |
| 13:45 | The reporting system rejects part of the prepared input: an identifier lost its leading zero, one date is ambiguous and a relationship points to a missing person record. | Trace each failure to the source or transformation. Correct supported mappings, seek clarification for ambiguity, preserve an audit trail and rerun checks. Never invent an identifier or date merely to pass validation. |
| 14:00–14:30 | Human meeting with Beacon Life about conflicting holder/beneficiary information and a residence change. | Distinguish the relevant roles and effective dates, request missing evidence and apply only the confirmed regime-specific treatment. Turn meeting decisions into identified record changes. |
| 15:00 | A signed certification arrives that changes one earlier provisional assessment. | Check the effective date and applicable period. Update the decision log, population, control totals and affected output; preserve the earlier version and tell Marta what changed. |
| 15:30 | A client requests a file immediately while exceptions and human review remain open. | Explain exactly what is ready and what is unresolved. Prepare the agreed internal deliverable and route release approval to its owner. Do not claim submission or authority acceptance. |
| 16:30 | Internal review deadline. | Deliver the reconciled population, classification/evidence log, input file, applicable XML output and validation evidence, together with unresolved exceptions and a client-specific status summary. |
| 17:00–17:30 | Reviewer feedback and the next-day handoff. | Apply supported corrections, rerun affected checks, retain versions and leave every outstanding question with an owner and deadline. |

Meeting exports can use the same note-plus-transcript pattern discussed earlier. The AI prepares and follows up; the humans attend. Meeting remarks, approved decisions and documentary evidence must remain distinguishable.

## Concrete cases to place in the data

These are problems to investigate. The legal outcomes remain unset until the jurisdiction and rule pack are agreed.

1. **Renumbered account:** the same account appears under an old identifier in last year's file and a new identifier this year. A mapping arrives after the first comparison. The assistant should avoid inventing an exit and a new relationship.
2. **Duplicate versus legitimate multiple records:** one source line is a true duplicate; another person legitimately appears on two separate accounts. Removing both would silently lose reporting information.
3. **Conflicting entity classification:** a carried-forward classification and a newer certification disagree. The assistant must identify which evidence applies to the reporting period and whether technical review is needed.
4. **Different person roles:** the KYC export identifies a beneficial owner, while reporting data requires a separately determined role and relationship. The assistant must not merge entity classification, person role and reportability into one label.
5. **Missing evidence:** a required identifier, certification or basis for an exemption is absent. The correct operational response is a specific exception and evidence request, subject to the approved reporting treatment; not a guessed value or silent exclusion.
6. **Ambiguous source date:** `03/04/2025` has no confirmed locale. The agent can identify the ambiguity and request its resolution; it cannot choose a meaning just to obtain valid XML.
7. **A late material change:** new evidence affects an earlier provisional determination. The final population and file must reflect the supported change, and the human must see its impact.
8. **Output mismatch:** the XML parses, but one account/person relationship or a control total does not match the approved population. Structural validity alone must not pass the reporting-quality criterion.

## Deliverables

**Population reconciliation.** Identify the source versions and comparison grain; explain every addition, removal and relevant change. Keep count changes, financial changes and unresolved classification questions distinct. Report balance totals by currency unless a specified conversion rule exists.

**Classification and evidence register.** Suggested columns: client, record ID, regime, reporting period, entity category, person/relationship role, proposed reporting treatment, evidence reference, effective date, uncertainty, human decision owner and status. Do not use a single dropdown that treats “financial institution”, “passive entity”, “controlling person” and “beneficial owner” as mutually exclusive answers to the same question.

**Client correspondence and meeting follow-up.** Explain the determination or the evidence needed, cite the relevant material, record the human's decision and assign actions. Maintain client confidentiality when multiple engagements are active.

**Machine-readable preparation pack.** Include the transformed input, field mapping and exception report, the applicable XML file, schema/business-rule validation results and reconciliation to the approved population. The chosen harness must actually support files and validation; a prose claim that XML was generated is insufficient.

**Human review and handoff.** State what is ready, what is unresolved, which version is current, who owns each decision and whether release is approved. Preparing, validating, approving, transmitting and receiving an authority acknowledgment are separate states.

## Benchmark rubric

| Dimension | Evidence of successful work | A concrete failure |
| --- | --- | --- |
| Population reconciliation | Correct joins, explained differences, preserved relationships and matching control totals | Treating a renumbered account as an unexplained removal or dropping a second legitimate account |
| Classification reasoning | Uses the approved regime/period rules and supporting evidence; identifies decisions needing review | Copying last year's classification despite relevant new evidence |
| Treatment of missing or conflicting evidence | Specific issue, source, requested evidence, owner and permitted interim treatment | Fabricating an identifier or silently excluding a difficult case |
| Transformation quality | Preserves identifiers, amounts, currencies, dates and entity/person links under the input contract | Losing leading zeros or attributing a person's details to the wrong account |
| XML and reporting consistency | Actual schema/business-rule checks plus a match to the approved population | Delivering parseable XML that omits a reportable record |
| Client and human collaboration | Useful meeting preparation, clear responses, recorded decisions and appropriate review requests | Asking the human to repeat the analysis, misquoting a call or treating an unresolved issue as approved |
| Revision and deadline management | Late evidence reaches all affected artifacts and reviewers before the stated internal deadline | Updating the memo but sending the older population/file |
| Completion reporting | Accurate readiness, release and acknowledgment status; open tasks remain visible | Claiming the authority accepted a file when only local validation ran |

Report each result as expected action, observed action, first divergence, consequence and recovery, with source/record IDs and timestamps. Separate deterministic data/file checks from reviewed technical reasoning. Keep model cost, tool cost, elapsed time and completed simulated horizon alongside quality. Appropriate human escalation is part of successful assistance, not an autonomy penalty.

A missing rule pack, inaccessible source file, unimplemented validator or truncated run is a benchmark limitation. An agent that ignores a source which was available has made a different kind of error; preserve that distinction in the report.

## What needs confirmation before implementation of the answer key

- The reporting jurisdiction and period, and full names and scope of RENESAGEG, CSEP and COF.
- Which client determines the reporting obligation and which party files under each regime.
- The reporting software and its actual input format, XML/schema versions, business rules and correction process.
- Whether the AI may send routine client requests directly or prepares all external communication for human review. Until specified, use human-reviewed external drafts and no filing authority.
- An anonymised example of a population comparison and a classification question, or practitioner approval of synthetic fixtures and their expected treatment.

The remaining jurisdiction-independent implementation can prepare the cast, calendars, communications, source-file versioning and workflow. Do not mark the case legally validated or XML-capable until the answer key, file tools and validator are present and exercised.

## Reference boundaries

The workflow comes from the user's account of the work. The client names, timetable and interruptions above are proposed fictional benchmark design.

The [OECD's consolidated CRS text](https://www.oecd.org/content/dam/oecd/en/publications/reports/2025/04/consolidated-text-of-the-common-reporting-standard-2025_e478bc04/055664b1-en.pdf) distinguishes entity categories and controlling persons. This informs the separation of fields in the proposed data model, not any unconfirmed case outcome or local legal advice.

The [OECD's amended CRS XML guide](https://www.oecd.org/en/publications/amended-common-reporting-standard-xml-schema_dd7ee57a-en.html) explains its exchange schema and notes that domestic reporting use depends on the relevant jurisdiction. The [IRS's FATCA XML resources](https://www.irs.gov/businesses/corporations/fatca-xml-schemas-and-business-rules-for-form-8966) provide separate schema and business-rule materials. These sources are reasons to pin the correct reporting specification, rather than label any generic XML as an acceptable tax filing.
