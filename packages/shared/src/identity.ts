export interface Identity {
  name: string;
  color: string;
}

/**
 * Anonymous participant identities. Keep this order in sync with study copy:
 * the first five colors appear in Patricia's current bot examples.
 */
export const PARTICIPANT_PALETTE: Identity[] = [
  { name: "Red", color: "#e03131" },
  { name: "Blue", color: "#1c7ed6" },
  { name: "Green", color: "#2f9e44" },
  { name: "Yellow", color: "#f08c00" },
  { name: "Purple", color: "#7048e8" },
  { name: "Teal", color: "#0ca678" },
  { name: "Pink", color: "#d6336c" },
  { name: "Cyan", color: "#1098ad" },
  { name: "Magenta", color: "#ae3ec9" },
  { name: "Gray", color: "#868e96" },
];

export const FALLBACK_IDENTITY: Identity = {
  name: "Gray",
  color: "#868e96",
};

/** True for the study bot user (its messages render as assistant nudges). */
export function isBot(userId: string): boolean {
  return /_bot[:_]/i.test(userId);
}

/** Bot / orchestrator service accounts that should not get a participant slot. */
export function isServiceUser(userId: string): boolean {
  return /orchestrator/i.test(userId) || isBot(userId);
}

/**
 * Build the userId -> identity map for a room. Sort members deterministically
 * and assign palette entries by position so the result matches across clients.
 */
export function buildIdentities(memberIds: string[]): Map<string, Identity> {
  const sorted = memberIds.filter((id) => !isServiceUser(id)).sort();
  const map = new Map<string, Identity>();
  sorted.forEach((id, i) => {
    map.set(id, PARTICIPANT_PALETTE[i % PARTICIPANT_PALETTE.length]);
  });
  return map;
}

export function identityFor(
  identities: Map<string, Identity>,
  userId: string,
): Identity {
  return identities.get(userId) ?? FALLBACK_IDENTITY;
}
