import { Injectable, Logger } from "@nestjs/common";
import type { TimelineEvent } from "../matrix/matrix-bot.service";
import type { SessionRuntime } from "../sessions/session-runtime";

/**
 * Extension point for the intervention logic — THIS IS WHERE THE RULES GO.
 *
 * `onEvent` is called for every timeline event in an active session's room,
 * EXCEPT the bot's own events. It's where the study's rule-based bot lives.
 *
 * Available context:
 *   - runtime.messages   — the discussion so far (accumulated)
 *   - runtime.condition  — the assigned experimental condition (+ its config)
 *   - runtime.state      — a scratchpad for per-session bookkeeping
 *   - runtime.post(text) — send a group message / nudge as the bot
 *   - event              — the incoming event (m.room.message, m.reaction,
 *                          de.gdm.ranking, ...)
 */
export interface BotRules {
  onEvent(runtime: SessionRuntime, event: TimelineEvent): Promise<void> | void;
}

/**
 * Placeholder rules: does nothing yet. Replace with the real interventions.
 *
 * TODO(team): implement rule-based interventions, e.g.
 *   - Non-acknowledgment: track the last-seen time per participant; if someone
 *     proposes a ranking change and nobody responds within N seconds, post a
 *     private nudge asking the others to react.
 *   - Ranking acks: when a `de.gdm.ranking` event arrives, optionally confirm
 *     the change in chat.
 *   - Stall detection: if no message for M seconds, initialise a poll.
 * Behaviour should branch on `runtime.condition` so different conditions get
 * different bot behaviour. Private nudges: post to the room but scoped to one
 * participant (see Message.recipientId semantics in @gdm/shared).
 */
@Injectable()
export class NoopBotRules implements BotRules {
  private readonly log = new Logger("BotRules");

  onEvent(_runtime: SessionRuntime, _event: TimelineEvent): void {
    // Intentionally empty — no interventions yet.
  }
}
