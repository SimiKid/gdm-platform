/**
 * Move (or insert) `id` so it sits before the item currently at `index`, or at
 * the end when `index` is null or past the end.
 *
 * Anchoring on the item rather than the index matters: removing the dragged
 * item first shifts the indexes, which would land downward drags one slot low.
 * Returns null when the item is dropped onto itself (a no-op).
 */
export function insertBeforeAnchor(
  order: string[],
  id: string,
  index: number | null,
): string[] | null {
  const anchor = index === null || index >= order.length ? null : order[index];
  if (anchor === id) return null;
  const next = order.filter((itemId) => itemId !== id);
  const at = anchor === null ? next.length : next.indexOf(anchor);
  next.splice(at < 0 ? next.length : at, 0, id);
  return next;
}
