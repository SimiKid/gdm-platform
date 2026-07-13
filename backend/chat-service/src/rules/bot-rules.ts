import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_INTERVENTION_CONFIG,
  audienceForMode,
  buildIdentities,
  identityFor,
  toneForMode,
} from "@gdm/shared";
import type {
  ContributionScoreWeights,
  ContributionShare,
  InterventionConfig,
  InterventionLog,
  InterventionMode,
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

interface RuleState {
  lastInterventionAtByTarget: Record<string, number>;
}

const STATE_KEY = "contributionBotRules";

/**
 * Deterministic first-pass intervention logic for the current study design.
 *
 * The study currently has four intervention methods:
 * public/private x neutral/engaging. A participant is considered dominating
 * when their contribution share crosses the condition threshold. Contribution
 * is intentionally simple for now: message count + message length.
 */
@Injectable()
export class ContributionBotRules implements BotRules {
  private readonly log = new Logger("ContributionBotRules");

  constructor(
    @Optional()
    @Inject(CONTRIBUTION_CLASSIFIER)
    private readonly classifier?: ContributionClassifier,
  ) {}

  async onEvent(runtime: SessionRuntime, event: TimelineEvent): Promise<void> {
    if (event.type !== "m.room.message") return;

    const config = normalizeConfig(runtime.condition.config);
    await this.classifyForShadowMode(runtime, event, config);
    if (!isInsideInterventionWindow(runtime, event.ts, config)) return;

    const participantIds = await this.getParticipantIds(runtime);
    if (participantIds.length < 2) return;

    const split = contributionSplit(
      runtime.messages,
      participantIds,
      config.scoreWeights,
      event.ts,
      config.contributionWindowMinutes,
    );
    const targets = split
      .filter((entry) => entry.share >= config.contributionThreshold)
      .sort((a, b) => b.share - a.share || b.score - a.score);
    if (targets.length === 0) return;

    const state = getRuleState(runtime);
    const eligibleTargets = targets.filter((target) =>
      canInterveneForTarget(state, target.userId, event.ts, config),
    );
    if (eligibleTargets.length === 0) return;

    const mode = config.interventionMode;
    const audience = audienceForMode(mode);
    if (audience === "none") return;
    const selectedTargets =
      audience === "private" ? eligibleTargets : [eligibleTargets[0]];
    const quietMembers = quietestMembers(split, selectedTargets);

    if (audience === "public") {
      const message = buildMessage(mode, split, selectedTargets[0], quietMembers);
      await runtime.post(message);
      markIntervened(state, selectedTargets, event.ts);
      runtime.recordIntervention(
        buildLog(runtime, config, split, selectedTargets, quietMembers, message),
      );
      return;
    }

    for (const target of selectedTargets) {
      const message = buildMessage(mode, split, target, quietMembers);
      await runtime.postPrivate(target.userId, message);
      markIntervened(state, [target], event.ts);
      runtime.recordIntervention(
        buildLog(runtime, config, split, [target], quietMembers, message),
      );
    }
  }

  private async classifyForShadowMode(
    runtime: SessionRuntime,
    event: TimelineEvent,
    config: InterventionConfig,
  ): Promise<void> {
    const envMode = process.env.LLM_MODE;
    const mode = envMode === "shadow" || envMode === "off" ? envMode : config.llmMode;
    if (mode !== "shadow" || !this.classifier) return;
    const messageIndex = runtime.messages.findIndex(
      (message) => message.id === event.eventId,
    );
    const message = runtime.messages[messageIndex];
    if (!message || runtime.contributionClassifications.some((c) => c.messageId === message.id)) {
      return;
    }
    const classification = await this.classifier.classify(
      message,
      runtime.messages.slice(0, messageIndex),
    );
    if (!classification) return;
    runtime.recordClassification(classification);
    detectIgnoredContributions(runtime, event.ts, config);
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

function detectIgnoredContributions(
  runtime: SessionRuntime,
  nowMs: number,
  config: InterventionConfig,
): void {
  const graceMs = (config.ignoredGraceSeconds ?? 75) * 1000;
  const minSubsequent = config.ignoredMinSubsequentMessages ?? 2;
  for (const candidate of runtime.contributionClassifications) {
    if (!candidate.substantive || candidate.ignoredInShadow) continue;
    const message = runtime.messages.find((item) => item.id === candidate.messageId);
    if (!message) continue;
    const messageMs = new Date(message.timestamp).getTime();
    if (nowMs - messageMs < graceMs) continue;
    const laterFromOthers = runtime.messages.filter(
      (item) =>
        new Date(item.timestamp).getTime() > messageMs &&
        item.senderId !== message.senderId,
    );
    if (laterFromOthers.length < minSubsequent) continue;
    const acknowledged = runtime.contributionClassifications.some(
      (item) =>
        item.senderId !== message.senderId &&
        item.references.includes(message.id),
    );
    if (acknowledged) continue;
    candidate.ignoredInShadow = true;
    runtime.recordBehavior({
      id: `llm-shadow:${message.id}`,
      type: "llm-shadow-trigger",
      participantId: message.senderId,
      timestamp: new Date(nowMs).toISOString(),
      payload: {
        messageId: message.id,
        subsequentMessages: laterFromOthers.length,
      },
    });
  }
}

function normalizeConfig(
  config: InterventionConfig & Record<string, unknown>,
): InterventionConfig {
  return {
    ...DEFAULT_INTERVENTION_CONFIG,
    ...config,
    scoreWeights: {
      ...DEFAULT_INTERVENTION_CONFIG.scoreWeights,
      ...config.scoreWeights,
    },
  };
}

function getRuleState(runtime: SessionRuntime): RuleState {
  const existing = runtime.state[STATE_KEY] as RuleState | undefined;
  if (existing) return existing;
  const created: RuleState = { lastInterventionAtByTarget: {} };
  runtime.state[STATE_KEY] = created;
  return created;
}

function isInsideInterventionWindow(
  runtime: SessionRuntime,
  nowMs: number,
  config: InterventionConfig,
): boolean {
  const elapsedMs = Math.max(0, nowMs - runtime.startedAtMs);
  const protectedStartMs = config.protectedStartMinutes * 60_000;
  if (elapsedMs < protectedStartMs) return false;

  const protectedEndMs = config.protectedEndMinutes * 60_000;
  const totalMs = runtime.durationMinutes * 60_000;
  if (totalMs > 0 && totalMs - elapsedMs <= protectedEndMs) return false;

  return true;
}

function contributionSplit(
  messages: Message[],
  participantIds: string[],
  weights: ContributionScoreWeights,
  nowMs: number,
  windowMinutes: number,
): ContributionShare[] {
  const identities = buildIdentities(participantIds);
  const cutoffMs = nowMs - windowMinutes * 60_000;
  const byUser = new Map<
    string,
    { messageCount: number; characterCount: number }
  >();

  for (const id of participantIds) {
    byUser.set(id, { messageCount: 0, characterCount: 0 });
  }

  for (const message of messages) {
    const messageMs = new Date(message.timestamp).getTime();
    if (Number.isFinite(messageMs) && messageMs < cutoffMs) continue;
    const stats = byUser.get(message.senderId);
    if (!stats) continue;
    stats.messageCount += 1;
    stats.characterCount += message.text.trim().length;
  }

  const scores = participantIds.map((userId) => {
    const stats = byUser.get(userId) ?? { messageCount: 0, characterCount: 0 };
    const score =
      stats.messageCount * weights.messages +
      stats.characterCount * weights.characters;
    return {
      userId,
      identityName: identityFor(identities, userId).name,
      messageCount: stats.messageCount,
      characterCount: stats.characterCount,
      score,
      share: 0,
    };
  });

  const total = scores.reduce((sum, entry) => sum + entry.score, 0);
  return scores.map((entry) => ({
    ...entry,
    share: total > 0 ? entry.score / total : 0,
  }));
}

function canInterveneForTarget(
  state: RuleState,
  userId: string,
  nowMs: number,
  config: InterventionConfig,
): boolean {
  const last = state.lastInterventionAtByTarget[userId];
  if (last === undefined) return true;
  return nowMs - last >= config.interventionWindowMinutes * 60_000;
}

function markIntervened(
  state: RuleState,
  targets: ContributionShare[],
  nowMs: number,
): void {
  for (const target of targets) {
    state.lastInterventionAtByTarget[target.userId] = nowMs;
  }
}

function quietestMembers(
  split: ContributionShare[],
  targets: ContributionShare[],
): InterventionTarget[] {
  const targetIds = new Set(targets.map((target) => target.userId));
  return split
    .filter((entry) => !targetIds.has(entry.userId))
    .sort(
      (a, b) => a.share - b.share || a.identityName.localeCompare(b.identityName),
    )
    .slice(0, 2)
    .map(toTarget);
}

function buildMessage(
  mode: InterventionMode,
  split: ContributionShare[],
  target: InterventionTarget,
  quietMembers: InterventionTarget[],
): string {
  const status = `Current participation split:\n\n${formatSplit(split)}.`;
  const quiet = formatQuietMembers(quietMembers);

  switch (mode) {
    case "public-neutral":
      return `${status}\n\n@all, consider this info as you continue with your conversations.`;
    case "public-engaging":
      return (
        `${status}\n\n@${target.identityName}, you are the top contributor right now. ` +
        `Now might be a good time to check in with group members who did not contribute as much, such as ${quiet} - you might be missing something useful.`
      );
    case "private-neutral":
      return `${status}\n\n@${target.identityName}, consider this info as you continue.`;
    case "private-engaging":
      return (
        `${status}\n\n@${target.identityName}, you are the top contributor right now. ` +
        `Now might be a good time to check in with group members who did not contribute as much, such as ${quiet} - you might be missing something useful.`
      );
    case "baseline":
      return "";
  }
}

function formatSplit(split: ContributionShare[]): string {
  return split
    .map((entry) => `${entry.identityName}: ${Math.round(entry.share * 100)}%`)
    .join(", ");
}

function formatQuietMembers(quietMembers: InterventionTarget[]): string {
  if (quietMembers.length === 0) return "others";
  if (quietMembers.length === 1) return quietMembers[0].identityName;
  return quietMembers.map((member) => member.identityName).join(" and ");
}

function buildLog(
  runtime: SessionRuntime,
  config: InterventionConfig,
  split: ContributionShare[],
  targets: ContributionShare[],
  quietMembers: InterventionTarget[],
  message: string,
): InterventionLog {
  return {
    id: randomUUID(),
    sessionId: runtime.sessionId,
    roomId: runtime.roomId,
    conditionId: runtime.condition.id,
    mode: config.interventionMode,
    audience: audienceForMode(config.interventionMode),
    tone: toneForMode(config.interventionMode),
    timestamp: new Date().toISOString(),
    trigger: "contribution-threshold",
    threshold: config.contributionThreshold,
    contributionWindowMinutes: config.contributionWindowMinutes,
    contributionSplit: split,
    targets: targets.map(toTarget),
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

@Injectable()
export class NoopBotRules implements BotRules {
  onEvent(_runtime: SessionRuntime, _event: TimelineEvent): void {
    // Intentionally empty — no interventions yet.
  }
}
