import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_INTERVENTION_CONFIG,
  MOON_SURVIVAL,
  audienceForMode,
  buildIdentities,
  identityFor,
  normalizeInterventionMode,
  protectedEndMs,
} from "@gdm/shared";
import type {
  ContributionClassification,
  ContributionShare,
  InterventionConfig,
  InterventionLog,
  InterventionTarget,
  Message,
} from "@gdm/shared";
import type { TimelineEvent } from "../matrix/matrix-bot.service";
import type { SessionRuntime } from "../sessions/session-runtime";
import { CONTRIBUTION_CLASSIFIER } from "../classifier/contribution-classifier.token";
import type { ContributionClassifier } from "../classifier/contribution-classifier";

/**
 * Extension point for the intervention logic — THIS IS WHERE THE RULES GO.
 *
 * `onEvent` is called for every timeline event in an active session's room,
 * EXCEPT the bot's own events — it observes the discussion (recording,
 * classification). `onWindowElapsed` is called by the session service each
 * time a contribution window closes (every `contributionWindowMinutes`) and
 * is where nudges are decided: at most one per window.
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
  onWindowElapsed?(
    runtime: SessionRuntime,
    windowEndMs: number,
  ): Promise<void> | void;
}

interface RuleState {
  /**
   * When the last nudge was sent (any target, any audience) — the
   * contribution-tracker reset point: messages older than this never count
   * toward dominance again ("back to 20-20-20").
   */
  lastInterventionAtMs?: number;
  /** userId -> epoch ms until which the invite grace period suppresses flags. */
  inviteGraceUntilByUser: Record<string, number>;
  /** Event time that opened the current grace period for each user. */
  inviteGraceStartedAtByUser: Record<string, number>;
}

type LlmMode = "off" | "active";

const STATE_KEY = "contributionBotRules";
const CLASSIFICATION_WAIT_MS = 2_000;

interface PendingClassification {
  eventTs: number;
  request: Promise<void>;
}

/** Tuning knobs for one rule-engine instance (used by the comparison mode). */
export interface RuleEngineOptions {
  /** Where this engine keeps its reset/grace state on the runtime. */
  stateKey?: string;
  /** Force the detection arm, overriding condition config and env. */
  forceLlmMode?: LlmMode;
  /**
   * Deliver nudges publicly as this named comparison bot ("a" / "b") instead
   * of the primary bot, ignoring the condition's delivery audience.
   */
  deliverAs?: string;
}

/**
 * Deterministic turn-equalization logic for the current study design.
 *
 * The bot evaluates at the end of every contribution window (every
 * `contributionWindowMinutes`): a participant dominates once their dominance
 * score over that window crosses the condition threshold, and at most one
 * nudge is sent per window. Rule-based detection scores message count + word
 * count; with `llmMode: "active"` the score becomes the composite `0.90 ×
 * contribution share + 0.10 × mean meaningfulness` (study protocol).
 * Detection is identical across delivery conditions — only public vs. private
 * delivery differs.
 */
@Injectable()
export class ContributionBotRules implements BotRules {
  private readonly log = new Logger("ContributionBotRules");

  constructor(
    @Optional()
    @Inject(CONTRIBUTION_CLASSIFIER)
    private readonly classifier?: ContributionClassifier,
    private readonly options: RuleEngineOptions = {},
  ) {}

  async onEvent(runtime: SessionRuntime, event: TimelineEvent): Promise<void> {
    if (event.type !== "m.room.message") return;

    const config = normalizeConfig(runtime.condition.config);
    const llmMode = this.options.forceLlmMode ?? resolveLlmMode(config);
    if (llmMode === "off" || !this.classifier) return;
    const participantIds = await this.getParticipantIds(runtime);
    const state = getRuleState(runtime, this.options.stateKey ?? STATE_KEY);
    await this.classifyMessage(runtime, event, config, llmMode, participantIds, state);
  }

  /** Evaluate the closed window and nudge (at most once per window). */
  async onWindowElapsed(
    runtime: SessionRuntime,
    windowEndMs: number,
  ): Promise<void> {
    const config = normalizeConfig(runtime.condition.config);
    const llmMode = this.options.forceLlmMode ?? resolveLlmMode(config);
    if (!isInsideInterventionWindow(runtime, windowEndMs, config)) return;
    const participantIds = await this.getParticipantIds(runtime);
    if (participantIds.length < 2) return;
    const state = getRuleState(runtime, this.options.stateKey ?? STATE_KEY);

    // Warm-up messages never count, even if a window overlaps the warm-up
    // (the timer grid normally starts at warm-up end; this is the backstop
    // for restored checkpoints or skewed boundaries).
    const warmupEndMs =
      runtime.startedAtMs + config.protectedStartMinutes * 60_000;
    const split = contributionSplit(
      runtime.messages,
      runtime.contributionClassifications,
      participantIds,
      config,
      windowEndMs,
      llmMode,
      Math.max(state.lastInterventionAtMs ?? 0, warmupEndMs),
    );
    const targets = split
      .filter((entry) => entry.dominanceScore >= config.contributionThreshold)
      .filter((entry) => !isInInviteGrace(state, entry.userId, windowEndMs))
      .sort(
        (a, b) => b.dominanceScore - a.dominanceScore || b.score - a.score,
      );
    if (targets.length === 0) return;

    const mode = config.interventionMode;
    // Comparison bots follow the condition's delivery audience too — a
    // private 2-bot test must stay private (only the target sees A and B).
    const audience = audienceForMode(mode);
    if (audience === "none") return;
    const target = targets[0];
    const quietMembers = quietestMembers(split, target, config.contributionThreshold);
    // Rotate per detection arm so each comparison bot cycles its own variants.
    const nudgeIndex = runtime.interventions.filter(
      (item) => item.llmMode === llmMode,
    ).length;
    const message = buildMessage(target, nudgeIndex);

    if (this.options.deliverAs) {
      await runtime.postAs(
        this.options.deliverAs,
        message,
        audience === "private" ? target.userId : undefined,
      );
    } else if (audience === "public") {
      await runtime.post(message);
    } else {
      await runtime.postPrivate(target.userId, message);
    }
    // Stamp the contribution-tracker reset point.
    state.lastInterventionAtMs = windowEndMs;
    runtime.recordIntervention(
      buildLog(runtime, config, llmMode, audience, split, target, quietMembers, message),
    );
  }

  private async classifyMessage(
    runtime: SessionRuntime,
    event: TimelineEvent,
    config: InterventionConfig,
    llmMode: LlmMode,
    participantIds: string[],
    state: RuleState,
  ): Promise<void> {
    if (llmMode === "off" || !this.classifier) return;
    const messageIndex = runtime.messages.findIndex(
      (message) => message.id === event.eventId,
    );
    const message = runtime.messages[messageIndex];
    if (!message || runtime.contributionClassifications.some((c) => c.messageId === message.id)) {
      return;
    }
    const classification = await this.classifier.classify(message, {
      priorMessages: runtime.messages.slice(0, messageIndex),
      taskItems: MOON_SURVIVAL.items.map((item) => item.label),
      participantIds,
    });
    if (!classification) return;
    runtime.recordClassification(classification);
    // Self-correction reward: inviting others suppresses being flagged for a
    // moment.
    if (classification.invitesParticipation.value) {
      const previousStart =
        state.inviteGraceStartedAtByUser[message.senderId] ??
        Number.NEGATIVE_INFINITY;
      // Classifications finish concurrently and may resolve out of order.
      // Keep the newest invitation, never whichever request happened to end last.
      if (event.ts >= previousStart) {
        state.inviteGraceStartedAtByUser[message.senderId] = event.ts;
        state.inviteGraceUntilByUser[message.senderId] =
          event.ts + config.inviteGraceSeconds * 1000;
      }
    }
  }

  private async getParticipantIds(runtime: SessionRuntime): Promise<string[]> {
    try {
      return await runtime.getParticipantUserIds();
    } catch (err) {
      this.log.warn(
        `joined_members failed; falling back to message senders: ${String(err)}`,
      );
      return [...new Set(runtime.messages.map((m) => m.senderId))].sort();
    }
  }
}

function resolveLlmMode(config: InterventionConfig): LlmMode {
  const envMode = process.env.LLM_MODE;
  if (envMode === "off" || envMode === "active") {
    return envMode;
  }
  return config.llmMode ?? "off";
}

function normalizeConfig(
  config: InterventionConfig & Record<string, unknown>,
): InterventionConfig {
  return {
    ...DEFAULT_INTERVENTION_CONFIG,
    ...config,
    // Sessions checkpointed before the tone axis was retired may still carry
    // old mode strings like "public-engaging".
    interventionMode: normalizeInterventionMode(
      config.interventionMode ?? DEFAULT_INTERVENTION_CONFIG.interventionMode,
    ),
    scoreWeights: {
      ...DEFAULT_INTERVENTION_CONFIG.scoreWeights,
      ...config.scoreWeights,
    },
    dominanceWeights: {
      ...DEFAULT_INTERVENTION_CONFIG.dominanceWeights,
      ...config.dominanceWeights,
    },
  };
}

function getRuleState(runtime: SessionRuntime, stateKey: string): RuleState {
  const existing = runtime.state[stateKey] as Partial<RuleState> | undefined;
  const state: RuleState = {
    lastInterventionAtMs: existing?.lastInterventionAtMs,
    inviteGraceUntilByUser: existing?.inviteGraceUntilByUser ?? {},
    inviteGraceStartedAtByUser:
      existing?.inviteGraceStartedAtByUser ?? {},
  };
  runtime.state[stateKey] = state;
  return state;
}

function isInsideInterventionWindow(
  runtime: SessionRuntime,
  nowMs: number,
  config: InterventionConfig,
): boolean {
  const elapsedMs = Math.max(0, nowMs - runtime.startedAtMs);
  const protectedStartMs = config.protectedStartMinutes * 60_000;
  if (elapsedMs < protectedStartMs) return false;

  const wrapUpMs = protectedEndMs(config);
  const totalMs = runtime.durationMinutes * 60_000;
  if (totalMs > 0 && totalMs - elapsedMs <= wrapUpMs) return false;

  return true;
}

function isInInviteGrace(
  state: RuleState,
  userId: string,
  nowMs: number,
): boolean {
  const until = state.inviteGraceUntilByUser[userId];
  if (until === undefined || nowMs >= until) return false;
  const startedAt = state.inviteGraceStartedAtByUser[userId];
  // A message arriving after this boundary must never affect the already
  // closed window, even if its concurrent classification finishes first.
  return startedAt === undefined || startedAt <= nowMs;
}

function contributionSplit(
  messages: Message[],
  classifications: ContributionClassification[],
  participantIds: string[],
  config: InterventionConfig,
  nowMs: number,
  llmMode: LlmMode,
  trackerResetAtMs: number | undefined,
): ContributionShare[] {
  const identities = buildIdentities(participantIds);
  const windowCutoffMs = nowMs - config.contributionWindowMinutes * 60_000;
  const byUser = new Map<
    string,
    { messageCount: number; wordCount: number; meaningfulness: number[] }
  >();

  for (const id of participantIds) {
    byUser.set(id, { messageCount: 0, wordCount: 0, meaningfulness: [] });
  }

  const scoreByMessageId = new Map(
    classifications.map((item) => [item.messageId, item.meaningfulnessScore]),
  );
  for (const message of messages) {
    const messageMs = new Date(message.timestamp).getTime();
    if (Number.isFinite(messageMs)) {
      // Only the just-closed window counts: nothing older than the window,
      // nothing that arrived after its end.
      if (messageMs < windowCutoffMs || messageMs > nowMs) continue;
      // Tracker reset: everything up to and including the nudge moment is
      // wiped — everyone restarts at parity and dominance must re-emerge.
      if (trackerResetAtMs !== undefined && messageMs <= trackerResetAtMs) continue;
    }
    const stats = byUser.get(message.senderId);
    if (!stats) continue;
    stats.messageCount += 1;
    stats.wordCount += countWords(message.text);
    const meaningfulness = scoreByMessageId.get(message.id);
    if (meaningfulness !== undefined) stats.meaningfulness.push(meaningfulness);
  }

  const scores = participantIds.map((userId) => {
    const stats = byUser.get(userId)!;
    const score =
      stats.messageCount * config.scoreWeights.messages +
      stats.wordCount * config.scoreWeights.words;
    const meaningfulnessScore =
      stats.meaningfulness.length > 0
        ? stats.meaningfulness.reduce((sum, value) => sum + value, 0) /
          stats.meaningfulness.length
        : 0;
    return {
      userId,
      identityName: identityFor(identities, userId).name,
      messageCount: stats.messageCount,
      wordCount: stats.wordCount,
      score,
      share: 0,
      meaningfulnessScore,
      dominanceScore: 0,
    };
  });

  const total = scores.reduce((sum, entry) => sum + entry.score, 0);
  return scores.map((entry) => {
    const share = total > 0 ? entry.score / total : 0;
    const dominanceScore =
      llmMode === "active"
        ? config.dominanceWeights.share * share +
          config.dominanceWeights.meaningfulness * entry.meaningfulnessScore
        : share;
    return { ...entry, share, dominanceScore };
  });
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function quietestMembers(
  split: ContributionShare[],
  target: ContributionShare,
  threshold: number,
): InterventionTarget[] {
  return split
    .filter(
      (entry) =>
        entry.userId !== target.userId && entry.dominanceScore < threshold,
    )
    .sort(
      (a, b) => a.share - b.share || a.identityName.localeCompare(b.identityName),
    )
    .slice(0, 2)
    .map(toTarget);
}

/**
 * Study-protocol nudge texts. Identical for private and public delivery to
 * avoid confounds, and they reveal ONLY the top contributor's percentage —
 * never the other members' shares.
 */
const NUDGE_TEMPLATES: ReadonlyArray<(name: string, pct: number) => string> = [
  (name, pct) =>
    `@${name}, you've brought a lot of energy to this — ${pct}% of the airtime so far! Might be a good moment to hear from the others, too.`,
  (name, pct) =>
    `@${name}, you're leading the discussion right now at ${pct}% of the messages. Curious what the rest of the group thinks — want to pull them in?`,
  (name, pct) =>
    `Nice momentum, @${name} — you're at ${pct}% of the conversation so far. The group might benefit from a few more voices in the mix.`,
  (name, pct) =>
    `@${name}, you've been really active — ${pct}% of the airtime! Worth checking in with the quieter folks before you move on?`,
  (name, pct) =>
    `@${name}, you've carried a good chunk of this discussion (${pct}%). Maybe toss the next question over to someone else in the group?`,
];

/**
 * Rotates deterministically through the template variants per nudge, so
 * repeated interventions do not read like a stuck bot and every session's
 * wording stays reproducible from its intervention log.
 */
function buildMessage(target: ContributionShare, nudgeIndex: number): string {
  const template = NUDGE_TEMPLATES[nudgeIndex % NUDGE_TEMPLATES.length];
  return template(target.identityName, Math.round(target.share * 100));
}

function buildLog(
  runtime: SessionRuntime,
  config: InterventionConfig,
  llmMode: LlmMode,
  audience: "public" | "private",
  split: ContributionShare[],
  target: ContributionShare,
  quietMembers: InterventionTarget[],
  message: string,
): InterventionLog {
  return {
    id: randomUUID(),
    sessionId: runtime.sessionId,
    roomId: runtime.roomId,
    conditionId: runtime.condition.id,
    mode: config.interventionMode,
    audience,
    timestamp: new Date().toISOString(),
    trigger: "contribution-threshold",
    threshold: config.contributionThreshold,
    llmMode,
    contributionWindowMinutes: config.contributionWindowMinutes,
    contributionSplit: split,
    targets: [toTarget(target)],
    quietMembers,
    message,
  };
}

function toTarget(entry: ContributionShare): InterventionTarget {
  return {
    userId: entry.userId,
    identityName: entry.identityName,
  };
}

/**
 * The rules implementation wired into the Chat Service. Normal sessions run a
 * single engine that follows the condition config. When a condition sets
 * `comparisonMode: true` (pilot/user-testing only), BOTH detection arms run
 * side by side with independent reset/grace state:
 *
 *   - "Assistant A" (`gdm_bot_a_…`) — rule-based detection
 *   - "Assistant B" (`gdm_bot_b_…`) — rule-based + LLM meaningfulness
 *
 * Both follow the condition's delivery audience: public conditions show A and
 * B to everyone, private conditions show both only to the nudged member.
 */
@Injectable()
export class StudyBotRules implements BotRules {
  private readonly single: ContributionBotRules;
  private readonly ruleArm: ContributionBotRules;
  private readonly llmArm: ContributionBotRules;
  private readonly pending = new WeakMap<
    SessionRuntime,
    Map<string, PendingClassification>
  >();

  constructor(
    @Optional()
    @Inject(CONTRIBUTION_CLASSIFIER)
    classifier?: ContributionClassifier,
  ) {
    this.single = new ContributionBotRules(classifier);
    this.ruleArm = new ContributionBotRules(classifier, {
      stateKey: `${STATE_KEY}:A`,
      forceLlmMode: "off",
      deliverAs: "a",
    });
    this.llmArm = new ContributionBotRules(classifier, {
      stateKey: `${STATE_KEY}:B`,
      forceLlmMode: "active",
      deliverAs: "b",
    });
  }

  async onEvent(runtime: SessionRuntime, event: TimelineEvent): Promise<void> {
    const engine =
      runtime.condition.config.comparisonMode === true
        ? this.llmArm
        : this.single;
    const entries =
      this.pending.get(runtime) ?? new Map<string, PendingClassification>();
    this.pending.set(runtime, entries);
    const request = engine.onEvent(runtime, event).finally(() => {
      if (entries.get(event.eventId)?.request === request) {
        entries.delete(event.eventId);
      }
    });
    entries.set(event.eventId, { eventTs: event.ts, request });
    await request;
  }

  async onWindowElapsed(
    runtime: SessionRuntime,
    windowEndMs: number,
  ): Promise<void> {
    if (runtime.condition.config.comparisonMode === true) {
      // Assistant A has no network classifier dependency and therefore sends
      // at the fixed boundary. Assistant B gets a short, bounded chance to
      // include classifications still in flight for this closed window.
      await this.ruleArm.onWindowElapsed(runtime, windowEndMs);
      await this.waitForWindowClassifications(runtime, windowEndMs);
      await this.llmArm.onWindowElapsed(runtime, windowEndMs);
      return;
    }
    await this.waitForWindowClassifications(runtime, windowEndMs);
    await this.single.onWindowElapsed(runtime, windowEndMs);
  }

  private async waitForWindowClassifications(
    runtime: SessionRuntime,
    windowEndMs: number,
  ): Promise<void> {
    const entries = this.pending.get(runtime);
    if (!entries || entries.size === 0) return;
    const config = normalizeConfig(runtime.condition.config);
    const windowStartMs =
      windowEndMs - config.contributionWindowMinutes * 60_000;
    const requests = [...entries.values()]
      .filter(
        ({ eventTs }) =>
          eventTs >= windowStartMs && eventTs <= windowEndMs,
      )
      .map(({ request }) => request);
    if (requests.length === 0) return;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled(requests),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, CLASSIFICATION_WAIT_MS);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

@Injectable()
export class NoopBotRules implements BotRules {
  onEvent(_runtime: SessionRuntime, _event: TimelineEvent): void {
    // Intentionally empty — no interventions yet.
  }
}
