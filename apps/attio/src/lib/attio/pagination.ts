// Attio pages with plain `limit`/`offset`, so there is no opaque page-token
// helper here even though the sibling clones have one — minting a token would
// be a shape no Attio client knows how to send back.
//
// Call sites pass the vendor's real defaults: records/query and tasks are
// (500, 1000); notes is (10, 50), which really is that small.

export function clampLimit(
  raw: string | number | null | undefined,
  def: number,
  max: number,
): number {
  if (raw === null || raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

export function parseOffset(raw: string | number | null | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}
