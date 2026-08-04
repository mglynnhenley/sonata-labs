import type { Person, PersonRef, WorldSeed } from "./types/world";

// Resolving people. Beats and criteria name people by `Person.id`; twins need
// an email or a Slack id. Every lookup goes through here so the three twins
// cannot drift into three different ideas of who someone is.

/**
 * Find a person by id, email or Slack id — whichever a beat happened to use.
 * Undefined for someone outside the cast (a stranger emailing in), which callers
 * must handle by falling back to the raw ref rather than inventing a person.
 */
export function resolvePerson(world: WorldSeed, ref: PersonRef): Person | undefined {
  const needle = ref.trim().toLowerCase();
  return world.cast.find(
    (p) =>
      p.id.toLowerCase() === needle ||
      p.email.toLowerCase() === needle ||
      p.slackUserId.toLowerCase() === needle,
  );
}

/**
 * The person whose accounts the agent operates. Throws when the seed names an
 * owner who is not in the cast: every twin seeds from that identity, so a
 * dangling owner would produce three subtly different mailboxes.
 */
export function owner(world: WorldSeed): Person {
  const person = resolvePerson(world, world.mailboxOwner);
  if (!person) {
    throw new Error(`WorldSeed.mailboxOwner "${world.mailboxOwner}" is not in the cast`);
  }
  return person;
}

/** Email address for a ref, falling back to the ref itself for outsiders. */
export function emailOf(world: WorldSeed, ref: PersonRef): string {
  return resolvePerson(world, ref)?.email ?? ref;
}

/** Slack user id for a ref, falling back to the ref itself for outsiders. */
export function slackIdOf(world: WorldSeed, ref: PersonRef): string {
  return resolvePerson(world, ref)?.slackUserId ?? ref;
}

/** `"Dana Reyes <dana@acme.com>"` — the form Gmail and the calendar both want. */
export function displayAddress(world: WorldSeed, ref: PersonRef): string {
  const person = resolvePerson(world, ref);
  return person ? `${person.name} <${person.email}>` : ref;
}
