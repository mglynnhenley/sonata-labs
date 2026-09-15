import { resolvePerson, type BeatBody, type WorldSeed, type WorldObservation, type TwinAuditRow, type TwinAdapter } from '@sonata/core';

/** Resolve explicit identities, never names mentioned inside message prose. */
export function audienceIds(world: WorldSeed, identities: string[]): string[] {
  return [...new Set(identities.flatMap(identity => {
    const person = resolvePerson(world, identity) ?? world.cast.find(p => p.slackUserId === identity);
    return person ? [person.id] : [];
  }))];
}

export function emailAudience(world: WorldSeed, headers: string[]): string[] {
  // Match addresses in provider headers, including display-name forms. The
  // audience is used for filtering and is never rendered as a recipient list.
  const addresses = headers.flatMap(h => h.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+/gi) ?? []);
  return audienceIds(world, addresses);
}

export function bodyObservation(body: BeatBody, world: WorldSeed): WorldObservation | undefined {
  if (body.twin === 'gmail') {
    const p = body.payload;
    return { audience: audienceIds(world, [p.from, ...p.to, ...(p.cc ?? [])]), actor: resolvePerson(world, p.from)?.id,
      text: `${p.subject}\n${p.body}` };
  }
  if (body.twin === 'slack' && body.kind === 'message') {
    const p = body.payload;
    const channel = world.channels.find(c => c.id === p.channel || c.name === p.channel.replace(/^#/, ''));
    const dm = resolvePerson(world, p.channel);
    // Scenario channels use the authored membership. Live agent posts use the
    // adapter's actual channel membership instead.
    const audience = channel ? channel.members : dm ? [p.from, dm.id] : [];
    return { audience: audienceIds(world, audience), actor: resolvePerson(world, p.from)?.id,
      text: p.text, ...(channel ? { channelId: channel.id } : {}) };
  }
  if (body.twin === 'calendar' && body.kind === 'invite') {
    const p = body.payload;
    return { audience: audienceIds(world, [p.organizer, ...p.attendees]), actor: resolvePerson(world, p.organizer)?.id,
      text: `${p.title}\n${p.startISO}–${p.endISO}\n${p.description ?? ''}` };
  }
  // A mutation is not automatically a communication to the whole company.
  return undefined;
}

export async function observeActions(adapter: TwinAdapter, rows: TwinAuditRow[], world: WorldSeed): Promise<TwinAuditRow[]> {
  for (const row of rows) {
    if (!adapter.observe) {
      if (!row.observation && ["send", "draftSend", "post", "update", "eventInsert", "eventPatch", "eventUpdate", "eventDelete"].includes(row.actionType ?? "")) {
        row.observationError = `Harness observation gap: ${row.twin} action ${row.id} has no observation reader; withheld.`;
      }
      continue;
    }
    delete row.observation;
    delete row.observationError;
    try { row.observation = await adapter.observe(row, world); }
    catch { row.observationError = `Harness observation gap: could not resolve ${row.twin} action ${row.id} for colleague context; withheld.`; }
  }
  return rows;
}
