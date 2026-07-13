import type { Briefing, RankingTask } from "./models.js";

/**
 * The "Survival on the Moon" exercise — the single source of truth for the
 * briefing and the rankable items. Used by the Session Manager to seed
 * sessions and by the participant frontend for the individual ranking during
 * onboarding, so the survey and the chat always show the same items.
 */

export const MOON_SURVIVAL_BRIEFING: Briefing = {
  title: "Survival on the Moon",
  html:
    "<p>Imagine you are part of a space crew scheduled to rendezvous with a " +
    "mother ship on the lighted surface of the moon. Due to mechanical " +
    "problems, your ship was forced to crash-land about 200 miles (320 km) " +
    "from the rendezvous point. Much of the onboard equipment was damaged. " +
    "Your survival depends on reaching the mother ship, so you must choose " +
    "the most critical items for the journey.</p>",
};

export const MOON_SURVIVAL: RankingTask = {
  id: "moon-survival",
  title:
    "Rank the 15 items by importance for reaching the rendezvous point: " +
    "1 = most important, 15 = least important.",
  items: [
    { id: "matches", label: "Box of matches" },
    { id: "food", label: "Food concentrate" },
    { id: "rope", label: "50 ft nylon rope" },
    { id: "parachute", label: "Parachute silk" },
    { id: "heater", label: "Portable heating unit" },
    { id: "pistols", label: "Two .45 caliber pistols" },
    { id: "milk", label: "One case dehydrated milk" },
    { id: "oxygen", label: "Two 100-lb tanks of oxygen" },
    { id: "map", label: "Stellar map" },
    { id: "raft", label: "Life raft" },
    { id: "compass", label: "Magnetic compass" },
    { id: "water", label: "5 gallons of water" },
    { id: "flares", label: "Signal flares" },
    { id: "firstaid", label: "First aid kit with injection needles" },
    { id: "radio", label: "Solar-powered FM receiver-transmitter" },
  ],
};
