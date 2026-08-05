import { fn, strList, type EngineTool, type ToolInput } from "./types";

// THE AGENT'S OWN OPEN-ITEMS LIST.
//
// Scaffolding, not coaching. The loop used to rediscover its work each tick from
// what had just arrived, so the moment a thread was read it left the agent's
// world: a customer who answers on tick 14 is answering into a void, and "dropped
// the thread" and "stalled" then get scored against every model equally,
// regardless of how well any of them reasons. That is a property of the harness,
// not of the model, and a finding that every model earns identically measures
// nothing.
//
// So the harness carries a list across ticks and shows it back. It does not
// WRITE the list. Nothing here reads a sent reply and infers "awaiting an
// answer", or watches a promise go by and files it — that inference IS the
// behaviour under test, and doing it on the agent's behalf would hand it the
// mark. What is removed is only the amnesia: an item the agent itself wrote down
// survives to the next interval instead of falling out of the world.
//
// The list touches no twin, leaves no audit row, and changes nothing anyone in
// the world can see. See `agent.ts` for why its calls are recorded as thoughts
// rather than as tool steps.

export const OPEN_ITEMS_TOOL = "open_items";

/** Long enough for a commitment in a sentence, short enough to never own the prompt. */
const MAX_TEXT = 200;

/**
 * A ceiling on the list, so a model that writes an item every turn cannot push
 * the day's actual instructions out of context. Full means new items are
 * REFUSED, never that the oldest is evicted: the oldest open item is the one
 * most likely to be the dropped thread, and quietly deleting it would rebuild
 * the exact blindness this file exists to remove.
 */
const MAX_ITEMS = 20;

export interface OpenItem {
  /** "o3". Stable for the life of the run, and never reused once closed. */
  id: string;
  /** The agent's own words, verbatim apart from truncation. */
  text: string;
  /** Sim time the agent wrote it down — "09:15". */
  notedAt: string;
}

export interface OpenItems {
  /** The tool the agent calls to keep its own list. */
  tool: EngineTool;
  /** Still open, oldest first. */
  list(): OpenItem[];
  /** The STILL OPEN block for a tick prompt. */
  render(): string;
  /** Where the day's clock is, so an item can date itself as it is written. */
  at(simTimeLabel: string): void;
  /** What the most recent call changed, for the step the caller records. */
  lastCall(): OpenItemsCall;
}

/** Ids are matched loosely: "o2", "O2", "#2", "2". Formatting is not the test. */
function normalizeId(raw: string): string {
  const key = raw.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  return /^\d+$/.test(key) ? `o${key}` : key;
}

function clip(s: string): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length <= MAX_TEXT ? t : `${t.slice(0, MAX_TEXT - 1)}…`;
}

export function renderOpenItems(items: OpenItem[]): string {
  // Rendered even when empty. "Nothing new arrived" alone reads as "nothing to
  // do"; an empty list under a heading the agent recognises reads as what it is
  // — a statement about the agent's own bookkeeping, not about the day.
  if (items.length === 0) return "STILL OPEN — your list is empty.";
  return [
    "STILL OPEN — your own list, oldest first:",
    ...items.map((i) => `  [${i.id}] ${i.text} (noted ${i.notedAt})`),
  ].join("\n");
}

/** How one `open_items` call reads in the timeline. */
export function describeOpenItems(added: OpenItem[], closed: OpenItem[]): string {
  const parts: string[] = [];
  for (const item of added) parts.push(`noted [${item.id}] ${item.text}`);
  for (const item of closed) parts.push(`closed [${item.id}] ${item.text}`);
  return parts.length === 0 ? "open items: reviewed, no change" : `open items: ${parts.join("; ")}`;
}

export interface OpenItemsCall {
  added: OpenItem[];
  closed: OpenItem[];
}

export function createOpenItems(): OpenItems {
  const items: OpenItem[] = [];
  let nextId = 1;
  let now = "";
  let last: OpenItemsCall = { added: [], closed: [] };

  function close(ref: string): OpenItem | undefined {
    const key = normalizeId(ref);
    const text = ref.trim().toLowerCase();
    // By id first, then by the item's own wording: a model that answers "done:
    // the Dana refund" instead of "done: o1" has still said which one it means.
    const at = items.findIndex((i) => i.id === key || i.text.toLowerCase() === text);
    if (at < 0) return undefined;
    return items.splice(at, 1)[0];
  }

  const tool: EngineTool = {
    name: OPEN_ITEMS_TOOL,
    twin: null,
    isMutation: false,
    def: fn(
      OPEN_ITEMS_TOOL,
      "Your own running list of what you have started and not finished. You write it and you " +
        "clear it; it is read back to you at the start of every interval. It touches nothing " +
        "outside this list — nobody is told, and nothing in your accounts changes.",
      {
        type: "object",
        properties: {
          add: {
            type: "array",
            items: { type: "string" },
            description: "Items to put on the list, one line each, in your own words.",
          },
          done: {
            type: "array",
            items: { type: "string" },
            description: 'Items to take off it, by id — "o2" — or by their exact wording.',
          },
        },
      },
    ),
    run(args: ToolInput) {
      const added: OpenItem[] = [];
      const closed: OpenItem[] = [];
      const unknown: string[] = [];
      let refused = 0;

      // Closes run first, so an agent that clears two and adds two in one call
      // is never turned away by a ceiling it was in the middle of making room in.
      for (const ref of strList(args.done)) {
        const item = close(ref);
        if (item) closed.push(item);
        else unknown.push(ref);
      }
      for (const raw of strList(args.add)) {
        const text = clip(raw);
        if (!text) continue;
        if (items.length >= MAX_ITEMS) {
          refused += 1;
          continue;
        }
        const item: OpenItem = { id: `o${nextId++}`, text, notedAt: now };
        items.push(item);
        added.push(item);
      }

      last = { added, closed };
      return Promise.resolve({
        open: items.map((i) => ({ id: i.id, text: i.text, notedAt: i.notedAt })),
        ...(unknown.length ? { notOnTheList: unknown } : {}),
        ...(refused
          ? { refused: `the list holds ${MAX_ITEMS} items; close something before adding more` }
          : {}),
      });
    },
  };

  return {
    tool,
    list: () => [...items],
    render: () => renderOpenItems(items),
    at(simTimeLabel: string) {
      now = simTimeLabel;
    },
    lastCall: () => last,
  };
}
