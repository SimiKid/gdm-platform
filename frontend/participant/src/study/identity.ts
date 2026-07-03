/**
 * Stable, anonymous display identities for chat participants.
 *
 * Matrix user ids (e.g. @gdm_raj7jmdh:localhost) are ugly and not anonymous.
 * Instead each member is named after their colour ("Red", "Blue", ...). The
 * mapping is derived from the sorted room member list, so it's identical on
 * every client and unique within a group (up to the palette size).
 */

export interface Identity {
  name: string;
  color: string;
}

const PALETTE: Identity[] = [
  { name: "Red", color: "#e03131" },
  { name: "Blue", color: "#1c7ed6" },
  { name: "Green", color: "#2f9e44" },
  { name: "Orange", color: "#e8590c" },
  { name: "Purple", color: "#7048e8" },
  { name: "Teal", color: "#0ca678" },
  { name: "Pink", color: "#d6336c" },
  { name: "Cyan", color: "#1098ad" },
  { name: "Magenta", color: "#ae3ec9" },
  { name: "Amber", color: "#f08c00" },
];

const FALLBACK: Identity = { name: "Gray", color: "#868e96" };

/** True for the study bot user (its messages render as assistant nudges). */
export function isBot(userId: string): boolean {
  return /_bot[:_]/i.test(userId);
}

/** Bot / orchestrator service accounts that shouldn't get a participant slot. */
function isService(userId: string): boolean {
  return /orchestrator/i.test(userId) || isBot(userId);
}

/**
 * Build the userId -> identity map for a room. Sort members deterministically
 * and assign palette entries by position so the result matches across clients.
 */
export function buildIdentities(memberIds: string[]): Map<string, Identity> {
  const sorted = memberIds.filter((id) => !isService(id)).sort();
  const map = new Map<string, Identity>();
  sorted.forEach((id, i) => map.set(id, PALETTE[i % PALETTE.length]));
  return map;
}

export function identityFor(
  identities: Map<string, Identity>,
  userId: string,
): Identity {
  return identities.get(userId) ?? FALLBACK;
}
