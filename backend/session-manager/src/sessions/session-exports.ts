import {
  DEFAULT_INTERVENTION_CONFIG,
  isServiceUser,
  normalizeInterventionMode,
} from "@gdm/shared";
import type {
  ClassifierRating,
  ContributionAggregate,
  Session,
} from "@gdm/shared";
import type { EtherpadService } from "../etherpad/etherpad.service";
import { toCsv } from "../reports/csv";
import { meanMeaningfulnessScore } from "../reports/equality";

/**
 * Row builders of the identifying legacy exports (`/sessions/export*`).
 * Pure functions over already filtered sessions; SessionsService loads the
 * sessions and stamps `generatedAt`.
 */

type EtherpadDocument = Awaited<ReturnType<EtherpadService["documents"]>>[number];

/** One Etherpad document as the JSON bundle exports it. */
export function bundlePad(d: EtherpadDocument) {
  return { id: d.id, phase: d.phase, deadline: d.deadline, state: d.state, text: d.text, revision: d.revision,
    capturedAt: d.capturedAt, sessionId: d.sessionId, participantId: d.participantId, conditionId: d.conditionId, roundId: d.roundId, error: d.error };
}

/** Overview: one row per session with its activity counts. */
export function sessionsCsv(sessions: Session[]): string {
  const rows = [
    [
      "session_id",
      "condition_id",
      "condition_name",
      "round",
      "status",
      "participant_count",
      "message_count",
      "reaction_count",
      "ranking_edit_count",
      "intervention_count",
      "created_at",
      "started_at",
      "completed_at",
    ],
    ...sessions.map((session) => [
      session.id,
      session.condition.id,
      session.condition.name,
      String(session.roundId),
      session.status,
      String(session.participants.length),
      String(session.chat.messages.length),
      String(
        session.chat.messages.reduce(
          (sum, message) => sum + message.reactions.length,
          0,
        ),
      ),
      String(session.rankingHistory?.length ?? 0),
      String(session.interventions.length),
      session.createdAt,
      session.startedAt ?? "",
      session.completedAt ?? "",
    ]),
  ];
  return toCsv(rows);
}

/**
 * Per-session settings snapshot for researcher analysis: one row per session
 * carrying its condition and intervention configuration. Standard CSV format
 * (dot decimals, comma-delimited), consistent with the other exports.
 */
export function sessionSettingsCsv(sessions: Session[]): string {
  const rows = [
    [
      "session_id",
      "status",
      "round_id",
      "condition_id",
      "condition_name",
      "goal",
      "group_size",
      "duration_minutes",
      "llm_mode",
      "workspace_mode",
      "intervention_mode",
      "protected_start_minutes",
      "protected_end_minutes",
      "contribution_threshold",
      "contribution_window_minutes",
      "score_weight_words",
      "score_weight_messages",
      "dominance_weight_share",
      "dominance_weight_meaningfulness",
      "final_group_ranking",
      "room_id",
      "created_at",
      "started_at",
      "completed_at",
    ],
    ...sessions.map((session) => {
      // Old sessions may predate some config keys; merge defaults so every
      // column is populated.
      const config = {
        ...DEFAULT_INTERVENTION_CONFIG,
        ...session.condition.config,
      };
      const scoreWeights = {
        ...DEFAULT_INTERVENTION_CONFIG.scoreWeights,
        ...config.scoreWeights,
      };
      const dominanceWeights = {
        ...DEFAULT_INTERVENTION_CONFIG.dominanceWeights,
        ...config.dominanceWeights,
      };
      return [
        session.id,
        session.status,
        String(session.roundId),
        session.condition.id,
        session.condition.name,
        String(session.condition.goal),
        String(session.condition.groupSize),
        String(session.durationMinutes),
        config.llmMode ?? "off",
        config.workspaceMode ?? "ranking",
        // Fold retired tone suffixes (e.g. "public-neutral") onto the
        // canonical baseline/public/private axis, matching the stored type.
        normalizeInterventionMode(config.interventionMode),
        String(config.protectedStartMinutes),
        String(config.protectedEndMinutes),
        String(config.contributionThreshold),
        String(config.contributionWindowMinutes),
        String(scoreWeights.words),
        String(scoreWeights.messages),
        String(dominanceWeights.share),
        String(dominanceWeights.meaningfulness),
        config.workspaceMode === "etherpad" ? "" : session.ranking.order.join("|"),
        session.roomId ?? "",
        session.createdAt,
        session.startedAt ?? "",
        session.completedAt ?? "",
      ];
    }),
  ];
  return toCsv(rows);
}

// ── messages ───────────────────────────────────────────────────────

/** Chat logs across sessions, one row per message. */
export function messageRows(sessions: Session[]) {
  return sessions.flatMap((session) =>
    session.chat.messages.map((message) => ({
      sessionId: session.id,
      conditionId: session.condition.id,
      conditionName: session.condition.name,
      roundId: session.roundId,
      ...message,
    })),
  );
}

export function messagesCsv(messages: ReturnType<typeof messageRows>): string {
  const rows = [
    [
      "session_id",
      "condition_id",
      "condition_name",
      "round",
      "message_id",
      "timestamp",
      "sender_id",
      "recipient_id",
      "text",
      "reaction_count",
      "reaction_keys",
    ],
    ...messages.map((m) => [
      m.sessionId,
      m.conditionId,
      m.conditionName,
      String(m.roundId),
      m.id,
      m.timestamp,
      m.senderId,
      m.recipientId ?? "",
      m.text,
      String(m.reactions.length),
      m.reactions.map((reaction) => reaction.key).join("|"),
    ]),
  ];
  return toCsv(rows);
}

// ── interventions ──────────────────────────────────────────────────

/** Bot nudge events across sessions, one row per intervention. */
export function interventionRows(sessions: Session[]) {
  return sessions.flatMap(
    (session) =>
      session.interventions.map((intervention) => ({
        conditionName: session.condition.name,
        roundId: session.roundId,
        ...intervention,
      })),
  );
}

export function interventionsCsv(
  interventions: ReturnType<typeof interventionRows>,
): string {
  const rows = [
    [
      "session_id",
      "condition_id",
      "condition_name",
      "round",
      "timestamp",
      "mode",
      "audience",
      "trigger",
      "threshold",
      "llm_mode",
      "targets",
      "quiet_members",
      "message",
    ],
    ...interventions.map((i) => [
      i.sessionId,
      i.conditionId,
      i.conditionName,
      String(i.roundId),
      i.timestamp,
      i.mode,
      i.audience,
      i.trigger,
      String(i.threshold),
      i.llmMode ?? "off",
      i.targets.map((target) => target.identityName).join("|"),
      i.quietMembers.map((member) => member.identityName).join("|"),
      i.message,
    ]),
  ];
  return toCsv(rows);
}

// ── surveys ────────────────────────────────────────────────────────

/** Survey responses across sessions, one row per participant and kind. */
export function surveyRows(sessions: Session[]) {
  return sessions.flatMap((session) =>
    session.participants.flatMap((participant) =>
      (
        [
          ["entry", participant.entrySurvey],
          ["exit", participant.exitSurvey],
        ] as const
      )
        .filter(([, survey]) => survey !== undefined)
        .map(([kind, survey]) => ({
          sessionId: session.id,
          conditionId: session.condition.id,
          conditionName: session.condition.name,
          roundId: session.roundId,
          participantId: participant.id,
          participantName: participant.name,
          trackingToken: participant.trackingToken,
          recruitmentSource: participant.recruitmentSource,
          prolificPid: participant.prolific?.participantId ?? "",
          prolificStudyId: participant.prolific?.studyId ?? "",
          prolificSessionId: participant.prolific?.sessionId ?? "",
          participantCompletedAt: participant.completedAt ?? "",
          kind,
          submittedAt: survey?.submittedAt ?? "",
          answers: survey?.answers ?? {},
        })),
    ),
  );
}

export function surveysCsv(surveys: ReturnType<typeof surveyRows>): string {
  const rows = [
    [
      "session_id",
      "condition_id",
      "condition_name",
      "round",
      "participant_id",
      "participant_name",
      "tracking_token",
      "recruitment_source",
      "prolific_pid",
      "prolific_study_id",
      "prolific_session_id",
      "participant_completed_at",
      "kind",
      "submitted_at",
      "answers_json",
    ],
    ...surveys.map((s) => [
      s.sessionId,
      s.conditionId,
      s.conditionName,
      String(s.roundId),
      s.participantId,
      s.participantName,
      s.trackingToken,
      s.recruitmentSource,
      s.prolificPid,
      s.prolificStudyId,
      s.prolificSessionId,
      s.participantCompletedAt,
      s.kind,
      s.submittedAt,
      JSON.stringify(s.answers),
    ]),
  ];
  return toCsv(rows);
}

// ── contributions ──────────────────────────────────────────────────

/** Per-participant aggregates plus the raw events and classifications. */
export function contributionRecords(sessions: Session[]) {
  return {
    contributions: sessions.flatMap(contributionAggregates),
    behavioralEvents: sessions.flatMap((session) =>
      session.behavioralEvents.map((event) => ({
        sessionId: session.id,
        conditionId: session.condition.id,
        roundId: session.roundId,
        ...event,
      })),
    ),
    classifications: sessions.flatMap((session) =>
      session.contributionClassifications.map((classification) => ({
        sessionId: session.id,
        conditionId: session.condition.id,
        roundId: session.roundId,
        ...classification,
      })),
    ),
  };
}

export function contributionsCsv(contributions: ContributionAggregate[]): string {
  const rows = [
    [
      "session_id",
      "condition_id",
      "round",
      "participant_id",
      "message_count",
      "character_count",
      "reaction_count",
      "ranking_move_count",
      "typing_duration_ms",
      "relevance_mean",
      "coherence_mean",
      "invites_participation_count",
      "meaningfulness_score_mean",
    ],
    ...contributions.map((c) => [
      c.sessionId,
      c.conditionId,
      String(c.roundId),
      c.participantId,
      String(c.messageCount),
      String(c.characterCount),
      String(c.reactionCount),
      String(c.rankingMoveCount),
      String(c.typingDurationMs),
      c.relevanceMean === null ? "" : String(c.relevanceMean),
      c.coherenceMean === null ? "" : String(c.coherenceMean),
      String(c.invitesParticipationCount),
      String(c.meaningfulnessScoreMean),
    ]),
  ];
  return toCsv(rows);
}

function contributionAggregates(session: Session): ContributionAggregate[] {
  const ids = new Set<string>();
  for (const message of session.chat.messages) {
    ids.add(message.senderId);
    for (const reaction of message.reactions) ids.add(reaction.senderId);
  }
  for (const event of session.behavioralEvents) ids.add(event.participantId);
  for (const item of session.contributionClassifications) ids.add(item.senderId);
  // Bot messages are part of the chat log but bots never get a contribution row.
  for (const id of ids) if (isServiceUser(id)) ids.delete(id);

  return [...ids].sort().map((participantId) => {
    const messages = session.chat.messages.filter(
      (message) => message.senderId === participantId,
    );
    const classifications = session.contributionClassifications.filter(
      (item) => item.senderId === participantId,
    );
    return {
      sessionId: session.id,
      conditionId: session.condition.id,
      roundId: session.roundId,
      participantId,
      messageCount: messages.length,
      characterCount: messages.reduce((sum, message) => sum + message.text.length, 0),
      reactionCount: session.chat.messages.reduce(
        (sum, message) =>
          sum + message.reactions.filter((reaction) => reaction.senderId === participantId).length,
        0,
      ),
      rankingMoveCount: session.behavioralEvents.filter(
        (event) => event.participantId === participantId && event.type === "ranking-move",
      ).length,
      typingDurationMs: session.behavioralEvents
        .filter(
          (event) => event.participantId === participantId && event.type === "typing-stop",
        )
        .reduce((sum, event) => sum + (event.durationMs ?? 0), 0),
      relevanceMean: meanRating(classifications.map((item) => item.relevance)),
      coherenceMean: meanRating(classifications.map((item) => item.coherence)),
      invitesParticipationCount: classifications.filter(
        (item) => item.invitesParticipation.value,
      ).length,
      meaningfulnessScoreMean: meanMeaningfulnessScore(classifications) ?? 0,
    };
  });
}

/**
 * Mean of the 1..5 ratings that are actually present. Records written by the
 * pre-v2 boolean classifier (`meaningfulness-v1`) carry no rating and are
 * skipped; they still count toward `meaningfulnessScoreMean`.
 */
function meanRating(ratings: Array<ClassifierRating | undefined>): number | null {
  const values = ratings
    .map((item) => item?.rating)
    .filter((value): value is number => typeof value === "number");
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
