# Colleague context: recipient observations v1

Implemented as the first stage of the [realism plan](benchmark-realism-plan.md). New run artifacts carry `worldContextVersion: "recipient-observations-v1"`; older results retain their original semantics. Compare runs within a context version. No paid model run was used to validate this change.

The engine now gives colleagues released communications with an explicit audience. A persona's access to Gmail or Slack does not grant access to every conversation on that app. Being mentioned in message text does not grant access either.

The existing twin adapters read delivered Gmail messages, Slack messages and their channel membership, and supported Calendar event changes. Both hosted runs and external sessions use the same observation reader. Message contents come from application records, not guessed audit summaries or private model reasoning. Draft recipients do not receive drafts. Bcc membership can permit receipt without revealing the Bcc list in colleague context.

Scripted emails, Slack messages and calendar invitations carry their authored participants when they are delivered. Failed injections do not become colleague knowledge. The existing tick ordering, delayed replies, meeting blocks and event limits are preserved. Observations are saved in tick artifacts separately from agent steps; reads add no agent audit actions.

Colleague prompts no longer receive the future schedule, the global scenario narrative, other personas' briefs or global `offLimits` text that may name private facts. Adaptive wording uses the same recipient filtering and cannot expose unrestricted checker quotes. Business metadata, the roster and a person's own brief remain authored initial context: scenario authors must keep these appropriate for that person. Global `offLimits` is not an enforceable business permission system; move public behavioural instructions into suitable persona briefs and implement consequential authority checks in case rules.

Missing communication records produce observation-gap notes. The judge receives those gaps and instructions to distinguish simulator failures from agent inaction. Agent and judge prompts also recognise required review requests and drafts as appropriate assistance when the task calls for them. Existing scoring formulae are unchanged.

The live verification also exposed a health-contract mismatch: Slack reports `{ok: true}`, while the engine expected `{status: "ok"}`. The shared health reader now recognises both forms and continues to reject error responses.

## Limits and next changes

- This is a communication boundary, not the planned persistent case state or review-authority engine. Colleagues still rely on a bounded recent history and the existing pending-reply ledger.
- Initial private knowledge is not automatically reconstructed from every seeded record. Persona briefs need appropriate initial facts; arbitrary business documents are not broadly exposed to colleagues.
- Scripted-event visibility follows authored membership. Dynamic access grants/revocations for world events and noncommunication records need a further access-state model.
- App records are read at the next poll. A message deleted or edited before then may be unavailable or reflect the later version. Immutable action-time communication capture is a follow-up requirement for stronger reproducibility.
- Only supported communication actions become observations. Workbook changes, drafts, reactions and private record edits do not automatically notify colleagues. Unsupported custom adapters need an observation reader; known communication actions missing one are recorded as gaps.
- Long context is explicitly shortened in prompts. The complete captured observation remains in the run artifact; the model is instructed not to equate omitted text with missing work.
- External reasoning, reads, complete tool arguments and agent-side model costs remain unavailable unless the external harness supplies them. Equal colleague message evidence does not make the full traces equivalent.

Next: prove the serial Inspect integration through the existing session path while auditing clock/wake behaviour and report evidence, then package per-run environments. Enforce agent/control execution boundaries before unrestricted or external harness access. The [realism plan](benchmark-realism-plan.md#delivery-order) is the source of delivery order and acceptance checks. Persistent case state and a branching evidence/review workflow follow; hosting reuses the same simulation implementation. Keep required tax decisions as practitioner-supplied case facts rather than inventing legal rules.
