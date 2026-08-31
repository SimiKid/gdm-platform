import type { Briefing, RankingTask } from "./models.js";

/**
 * The "Survival on the Moon" exercise — the single source of truth for the
 * briefing and the rankable items. Used by the Session Manager to seed
 * sessions and by the participant frontend for the individual ranking during
 * onboarding, so the survey and the chat always show the same items.
 */

export const MOON_SURVIVAL_BRIEFING: Briefing = {
  title: "Task: Survival on the Moon",
  html:
    "<p>As part of a space crew, you are ready to land on the lighted surface " +
    "of the moon where you planned to meet up with the mothership. Due to " +
    "mechanical problems, your ship was forced to crash-land about 200 miles " +
    "(320 km) from the calculated location. Much of the onboard equipment " +
    "was damaged. Your survival depends on reaching the mothership, so you " +
    "must choose the most critical items for the journey.</p>",
};

export const MOON_SURVIVAL: RankingTask = {
  id: "moon-survival",
  title:
    "Rank the items below by importance for reaching the mothership. " +
    "Most important item = 1, least important item = 10.",
  items: [
    { id: "matches", label: "Box of matches" },
    { id: "food", label: "Food concentrate" },
    { id: "parachute", label: "Parachute silk" },
    { id: "heater", label: "Portable heating unit" },
    { id: "pistols", label: "Two .45 caliber pistols" },
    { id: "oxygen", label: "Two 100-lb tanks of oxygen" },
    { id: "map", label: "Stellar map" },
    { id: "raft", label: "Life raft" },
    { id: "compass", label: "Magnetic compass" },
    { id: "firstaid", label: "First aid kit with injection needles" },
  ],
};

/**
 * NASA's expert ranking for the moon-survival items (1 = most important).
 * Used to score individual and group rankings for analysis: the standard
 * error score is the sum over items of |assigned rank − expert rank|
 * (0 = perfect agreement, 50 = fully reversed for the current 10 items).
 */
export const MOON_SURVIVAL_EXPERT_RANKING: Record<string, number> = {
  oxygen: 1,
  map: 2,
  food: 3,
  firstaid: 4,
  parachute: 5,
  raft: 6,
  pistols: 7,
  heater: 8,
  compass: 9,
  matches: 10,
};
