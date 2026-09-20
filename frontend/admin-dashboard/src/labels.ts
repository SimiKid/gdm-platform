import type { SessionStatus } from "@gdm/shared";

/** Researcher-facing wording for backend session states (wireframe: lobby/active). */
export const STATUS_LABEL: Record<SessionStatus, string> = {
  waiting: "lobby",
  provisioning: "starting",
  running: "active",
  completed: "completed",
  aborted: "aborted",
};
