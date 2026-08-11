import type { Check } from "./diagnose";

// Printing. Plain text, one column of marks, every continuation line indented
// under the thing it belongs to — the same shape the platform CLI prints in.

export function say(line = ""): void {
  process.stdout.write(`${line}\n`);
}

const WIDTH = 96;
const TITLE_WIDTH = 18;

/** Wrap on spaces so a long fix stays readable in an 80-column terminal. */
export function wrap(text: string, indent: string, width = WIDTH): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word;
    if (indent.length + candidate.length > width && current) {
      lines.push(indent + current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(indent + current);
  return lines;
}

const MARK: Record<Check["status"], string> = { ok: "ok  ", warn: "warn", fail: "FAIL" };

export function printCheck(check: Check): void {
  const title = check.title.padEnd(TITLE_WIDTH);
  const head = `  ${MARK[check.status]}  ${title} `;
  const detail = wrap(check.detail, " ".repeat(head.length));
  say(head + (detail[0] ?? "").trimStart());
  for (const line of detail.slice(1)) say(line);

  const indent = " ".repeat(head.length);
  if (check.status !== "ok") for (const line of wrap(`fix: ${check.fix}`, indent)) say(line);
  if (check.note) for (const line of wrap(`(${check.note})`, indent)) say(line);
}

export function heading(title: string): void {
  say();
  say(title);
}
