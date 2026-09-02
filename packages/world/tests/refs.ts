import type { GeneratedWorld } from "../src/generate";

/**
 * Every person-reference any twin seed makes, in one list. Cast consistency —
 * "nobody is named who does not exist" — is the invariant the whole package is
 * built to hold, so it is checked the same way for a generated world and for a
 * shipped template.
 */
export function referencedPeople(generated: GeneratedWorld): string[] {
  const refs: string[] = [];
  for (const thread of generated.gmail.threads) {
    refs.push(...thread.participants, ...thread.messages.map((m) => m.fromPersonId));
  }
  for (const channel of generated.slack.channels) {
    refs.push(...channel.members);
    for (const message of channel.messages) {
      refs.push(message.personId, ...(message.threadReplies ?? []).map((r) => r.personId));
    }
  }
  refs.push(...generated.calendar.calendars.map((c) => c.ownerPersonId));
  for (const event of generated.calendar.events) refs.push(...event.attendeePersonIds);

  refs.push(...generated.attio.contacts.map((c) => c.personId));
  for (const deal of generated.attio.deals) {
    refs.push(deal.ownerPersonId, ...deal.contactPersonIds);
  }
  refs.push(...generated.attio.tasks.map((t) => t.assigneePersonId));

  refs.push(...generated.googleDocs.documents.map((d) => d.ownerPersonId));
  return refs;
}
