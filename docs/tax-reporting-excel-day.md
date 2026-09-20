# Tax reporting adviser day in Excel

This pilot starts with an institution’s **intentionally categorised investor database**. It is a day assisting a human adviser with FATCA/CRS questions and reporting preparation, using Excel as the working system.

Select **North Quay Reporting Team — Excel pilot** (template `tax-reporting-workbook`) and scenario `tax-reporting-workbook-day`. The older `tax-reporting-workflow-day` and its population-reconciliation fixture are retained as pilot history; they describe a different task.

The bank workbook, [`nq-bank-investors-2026`](http://localhost:3950/?workbook=nq-bank-investors-2026), contains 16 investors with string IDs, four entities, four relationships, 20 supplied evidence entries, three initial questions, an internal mapping contract, 16 reporting-preparation rows and four control-total rows. The separate [`nq-client-casework-2026`](http://localhost:3950/?workbook=nq-client-casework-2026) holds three adviser cases for other clients. Most investor classifications are settled at opening. FATCA and CRS categories, decisions and reviewer references have separate columns.

The agent reads and updates actual workbook cells using the Excel tools. Original supplied evidence and mappings are read-only, and supported working changes need reasons and evidence in cell history. Gmail carries requests and human meeting notes, Slack carries reviews, and the shared calendar gives the adviser’s four fixed client meetings. External responses remain drafts for Marta.

## What a good day looks like

| Time | Adviser work and expected assistance |
| --- | --- |
| 09:00–10:00 | Read workbook questions and prepare for Marta’s bank call. Daniel confirms that investor 00101 requires no category or inclusion change. After the call, draft the exact entity-document request for 00107. |
| 10:30 | Apply Daniel’s fictional `CRS-DEC-05-v1` to 00105 and ENT-01 only: CRS Passive NFE / Include; REL-01 gets the approved CRS controlling-person role. Preserve FATCA fields, the corporate shareholder’s role and all other entities. |
| 11:00–12:00 | Follow up the separate PE call, surface the 00109 evidence conflict for Daniel and give Marta a useful noon status. Upload recency cannot resolve the conflict. |
| 12:00–14:30 | Populate Reporting Preparation using the workbook mapping. Handle the single change-in-circumstances case for 00112 without treating a new mailing address as confirmed tax residence. Prepare and follow up pension and insurance calls in the separate case workbook. |
| 15:00 | Apply the bank’s corrected balance for 00114: GBP 14,250.00, source `BANK-BAL-14-v2`. Refresh its numeric preparation value and both GBP totals, retaining the evidence trail. |
| By 16:30 | Give Marta the working workbook link/revision and a concise readiness summary. Retain held rows, separate the regimes and currencies, and keep unresolved questions visible. |
| By 18:00 | Hand off workbook revisions, reviewed changes, unchanged reviewed cases, drafts, open owners/deadlines and validation limits. No further classification or release approval arrives. |

Final internal control totals after the approved CRS change and corrected balance:

| Regime | Currency | Included investors | Balance total |
| --- | --- | ---: | ---: |
| CRS | GBP | 12 | 93,250.00 |
| CRS | USD | 1 | 15,250.75 |
| FATCA | GBP | 11 | 88,250.00 |
| FATCA | USD | 1 | 15,250.75 |

All 16 investors remain in Reporting Preparation, including Hold and Exclude decisions. Investor 00115’s supplied `15,250.75` becomes numeric `15250.75`, with USD retained. Never combine currencies or invent an exchange rate.

The three bank questions (00107, 00109, 00112) and three separate client cases (PE-101, PEN-201, INS-301) remain pending Daniel’s review at noon on 18 September. Requests target missing signed classification evidence, contradictory documents, residence/effective-date confirmation, exact vehicle/exemption support, or person-specific policy evidence as applicable. Preparing a request does not resolve its technical question.

## Scope and verification

There are 36 fifteen-minute ticks, 16 scripted messages across the day, three responsive internal human personas and 12 scoring criteria. Two automatic criteria establish only whether Marta received timely replies. Judged criteria require the actual workbook contents and cell history as well as communications; a claim in email does not prove the spreadsheet changed.

This is a fictional workflow pilot. The supplied classifications and named reviewer decisions support testing data fidelity, scoped updates and useful adviser assistance. **Jurisdiction-specific legal correctness, authority XML compliance, submission and authority acceptance are UNMEASURED.** No authority schema, validator or filing service is supplied. Missing snapshots/history or a truncated day are harness measurement gaps, not evidence that an agent made a tax error.

The standalone fixture is committed at `packages/world/src/templates/tax-reporting-workbook.json`; regenerate it without a model call using `npx tsx packages/world/scripts/build-tax-workbook-template.ts`. The mapping lives in the workbook, so the agent does not need filesystem access to the fixture. Registry and fixture tests exercise the authored data; a full simulated model day incurs cost and is a separate runtime measurement.
