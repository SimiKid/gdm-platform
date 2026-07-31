import { MOON_SURVIVAL_EXPERT_RANKING } from "@gdm/shared";

/**
 * NASA error score for a ranking: sum over items of |assigned rank − expert
 * rank|, where the assigned rank of `order[i]` is `i + 1`. 0 = perfect
 * agreement; 112 = fully reversed for the 15 moon-survival items.
 *
 * Returns null unless `order` is exactly a permutation of the expert key's
 * items — partial, duplicated, or unknown-id rankings are not scored (the
 * raw order stays available in the surveys export for anyone who wants to
 * relax this).
 */
export function rankingErrorScore(
  order: string[] | undefined,
  expert: Record<string, number> = MOON_SURVIVAL_EXPERT_RANKING,
): number | null {
  if (!order) return null;
  const itemIds = Object.keys(expert);
  if (order.length !== itemIds.length) return null;
  if (new Set(order).size !== order.length) return null;
  if (order.some((id) => expert[id] === undefined)) return null;
  return order.reduce(
    (sum, id, index) => sum + Math.abs(index + 1 - expert[id]),
    0,
  );
}
