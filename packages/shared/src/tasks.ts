import type { Briefing, RankingTask } from "./models.js";

/**
 * The Expedition-Mars exercise — the single source of truth for the briefing
 * and the rankable items. Used by the Session Manager to seed sessions and by
 * the participant frontend for the individual ranking during onboarding, so
 * the survey and the chat always show the same items.
 */

export const EXPEDITION_MARS_BRIEFING: Briefing = {
  title: "Expedition Mars",
  html:
    "<p>Your crew has crash-landed 200 km from the rendezvous point on Mars. " +
    "Much of the equipment was damaged. Rank the surviving items by how " +
    "critical they are for reaching the rendezvous point. First rank them on " +
    "your own; then discuss in the chat and agree on a shared ranking.</p>",
};

export const EXPEDITION_MARS: RankingTask = {
  id: "expedition-mars",
  title: "Rank the surviving equipment (most to least critical)",
  items: [
    { id: "oxygen", label: "Oxygen tanks" },
    { id: "water", label: "Water (20 litres)" },
    { id: "map", label: "Star map of Mars' constellations" },
    { id: "radio", label: "Solar-powered FM radio" },
    { id: "firstaid", label: "First-aid kit" },
    { id: "food", label: "Case of dehydrated food" },
    { id: "heater", label: "Portable heating unit" },
    { id: "rope", label: "50 m of nylon rope" },
    { id: "flares", label: "Signal flares" },
    { id: "compass", label: "Magnetic compass" },
  ],
};
