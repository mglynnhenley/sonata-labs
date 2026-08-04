export type ClassValue = string | number | false | null | undefined;

/**
 * Join class names. Deliberately not tailwind-merge: every component puts the
 * caller's `className` last, and keeps its own variant classes narrow enough
 * that overriding one is a matter of passing the utility you want.
 */
export function cn(...values: ClassValue[]): string {
  let out = "";
  for (const value of values) {
    if (!value && value !== 0) continue;
    out = out ? `${out} ${value}` : String(value);
  }
  return out;
}
